/**
 * S3-compatible object client for cold storage (T-07.5–07.7, T-07.23).
 *
 * Uses `@aws-sdk/client-s3` v3 driven by `endpoint` + `forcePathStyle: true` so
 * it targets ANY S3-compatible endpoint (MinIO / Arvan / generic S3) under
 * network restrictions — no hard AWS dependency, sanctions-safe (P4).
 *
 * Credentials come from the per-game envelope-encrypted `cold_storage_credentials`
 * (decrypted IN-WORKER via {@link SecretCryptoService}, T-07.6) or, when a game
 * has none, from platform-level `MINIO_*` env (dev/default). The plaintext is a
 * JSON envelope: `{ endpoint, accessKey, secretKey, region?, bucket? }`.
 *
 * Responsibilities:
 *   - idempotent PUT at the deterministic object_ref (S3 objects are PUT-replace,
 *     so a retried/overlapping upload is overwrite-idempotent, T-07.7);
 *   - read-back verify of size + checksum before the caller records the row
 *     (verify-then-record, T-07.13);
 *   - S3-side raw expiry (list + delete objects older than `raw_retention_days`),
 *     SCOPED to the raw bucket/prefix — NEVER the PITR backup bucket (T-07.23/28).
 *
 * NO S3 object-level encryption in v1 (only the credentials envelope is
 * encrypted; object SSE is bucket/target config, not app-level).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { SecretCryptoService } from '../security/secret-crypto.service';

/** Plaintext shape of the decrypted `cold_storage_credentials` envelope. */
export interface ColdStorageCredentials {
  /** S3-compatible endpoint URL (e.g. `http://minio:9000`). */
  endpoint: string;
  /** Access key id. */
  accessKey: string;
  /** Secret access key. */
  secretKey: string;
  /** Optional region (S3-compatible targets often ignore it; default us-east-1). */
  region?: string;
  /** Optional default bucket carried in the envelope. */
  bucket?: string;
}

/** Resolved connection target for one upload/expiry operation. */
export interface S3Target {
  /** The resolved credentials (per-game decrypted, or platform env fallback). */
  credentials: ColdStorageCredentials;
  /** The bucket to write to (per-game config wins over the envelope's default). */
  bucket: string;
}

/** The verify-read-back result the shipment job asserts before recording. */
export interface VerifyResult {
  ok: boolean;
  size: number;
  checksum: string;
}

@Injectable()
export class S3ClientService {
  private readonly logger = new Logger(S3ClientService.name);
  /** One S3Client per endpoint+accessKey — cheap to reuse across a run. */
  private readonly clients = new Map<string, S3Client>();

  constructor(
    private readonly crypto: SecretCryptoService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Resolve the connection target for a game: decrypt the per-game credentials
   * envelope in-worker, or fall back to the platform `MINIO_*` env. `bucket`
   * (per-game config) overrides the envelope's default bucket.
   */
  resolveTarget(credentialsCipher: string | undefined, bucket: string | undefined): S3Target {
    let credentials: ColdStorageCredentials;
    if (credentialsCipher !== undefined && credentialsCipher.trim() !== '') {
      const plaintext = this.crypto.decrypt(credentialsCipher);
      credentials = JSON.parse(plaintext) as ColdStorageCredentials;
    } else {
      // Platform-level default (dev / no per-game override). Never plaintext creds
      // in GAME.config — this branch is env-only, which is the operator's secret
      // mount, not the DB.
      const endpointHost = this.config.get<string>('MINIO_ENDPOINT') ?? 'localhost';
      const endpointPort = this.config.get<string>('MINIO_PORT') ?? '9000';
      credentials = {
        endpoint: `http://${endpointHost}:${endpointPort}`,
        accessKey: this.config.get<string>('MINIO_ACCESS_KEY') ?? 'minioadmin',
        secretKey: this.config.get<string>('MINIO_SECRET_KEY') ?? 'minioadmin',
      };
    }
    const resolvedBucket = bucket ?? credentials.bucket ?? this.config.get<string>('MINIO_BUCKET') ?? 'analytics-raw';
    return { credentials, bucket: resolvedBucket };
  }

  /** Get-or-create the S3Client for a target (path-style for MinIO/Arvan). */
  private clientFor(credentials: ColdStorageCredentials): S3Client {
    const key = `${credentials.endpoint}::${credentials.accessKey}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new S3Client({
        endpoint: credentials.endpoint,
        region: credentials.region ?? 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: credentials.accessKey,
          secretAccessKey: credentials.secretKey,
        },
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /**
   * Idempotent PUT: write `body` to `objectRef` in `target.bucket`. A re-PUT to
   * the same ref is a full overwrite (S3 objects are PUT-replace) so an
   * overlapping/retried upload is overwrite-idempotent (T-07.7).
   */
  async put(target: S3Target, objectRef: string, body: Buffer): Promise<void> {
    const client = this.clientFor(target.credentials);
    await client.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: objectRef,
        Body: body,
        ContentLength: body.length,
      }),
    );
  }

  /**
   * Read the stored object back and verify size + checksum against the local
   * file's integrity ref (T-07.13). Returns `ok=false` (never throws on a plain
   * mismatch) so the caller can decline to record the row and let the file survive
   * for the next run.
   */
  async verify(
    target: S3Target,
    objectRef: string,
    expectedSize: number,
    expectedChecksum: string,
  ): Promise<VerifyResult> {
    const client = this.clientFor(target.credentials);
    // Read the object body back fully and re-checksum end-to-end (a HEAD alone
    // would only prove existence + declared size; we re-hash to catch corruption).
    const res = await client.send(new GetObjectCommand({ Bucket: target.bucket, Key: objectRef }));
    const body = res.Body;
    if (body === undefined) {
      return { ok: false, size: 0, checksum: '' };
    }
    const bytes = await streamToBuffer(body as AsyncIterable<Uint8Array>);
    const size = bytes.length;
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const ok = size === expectedSize && checksum === expectedChecksum;
    if (!ok) {
      this.logger.warn(
        `[s3] verify mismatch for ${objectRef}: size ${size}/${expectedSize} checksum ${checksum.slice(0, 12)}/${expectedChecksum.slice(0, 12)}`,
      );
    }
    return { ok, size, checksum };
  }

  /**
   * S3-side raw expiry (T-07.23): delete objects under `prefix` in
   * `target.bucket` whose LastModified is older than `cutoff`. SCOPED to the raw
   * bucket/prefix so it can NEVER touch PITR-backup objects (which live in a
   * separate bucket — T-07.28). Returns the deleted object keys.
   *
   * We use list+delete (portable across every S3-compatible target) rather than a
   * native bucket lifecycle rule, which not all targets support identically.
   */
  async expireOlderThan(target: S3Target, prefix: string, cutoff: Date): Promise<string[]> {
    const client = this.clientFor(target.credentials);
    const deleted: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: target.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of page.Contents ?? []) {
        if (obj.Key === undefined || obj.LastModified === undefined) {
          continue;
        }
        if (obj.LastModified.getTime() < cutoff.getTime()) {
          await client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: obj.Key }));
          deleted.push(obj.Key);
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return deleted;
  }

  /** Close all cached clients (shutdown / test teardown). */
  destroyClients(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
  }
}

/** Drain an async byte stream into one Buffer. */
async function streamToBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
