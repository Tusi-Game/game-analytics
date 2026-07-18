import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { QueueModule } from '../queue/queue.module';
import { AppConfigModule } from '../config/app-config.module';
import { DirtyRegistry } from './flush/dirty-registry';
import { FlushService } from './flush/flush.service';
import { FlushJobService } from './flush/flush-job.service';
import {
  IngestKernel,
  NAME_CAP_GATE,
  TYPED_VALIDATOR,
  DURABLE_IMMEDIATE_HOOK,
  HOT_UPDATE_HOOK,
  PII_SCRUB_PORT,
} from './kernel/ingest-kernel';
import { SecurityModule } from '../security/security.module';
import { KernelPiiScrubAdapter } from '../security/kernel-pii-scrub.adapter';
import {
  GenericHotUpdateHook,
  NoopDurableImmediateHook,
  PermissiveTypedValidator,
  FLOOR_PROVIDER,
} from './kernel/default-hooks';
import { KindDispatchValidator, KindDispatchDurableHook, KindDispatchHotHook } from './kernel/kind-dispatch';
import { RAW_APPEND_PORT, ACK_PORT } from './kernel/unit3-ports';
import { RawFileService, RAW_FILE_OPTIONS, type RawFileServiceOptions } from './rawfile/raw-file.service';
import { WorkerAckPort } from './kernel/ack.port';
import { PostgresFloorProvider } from './kernel/postgres-floor.provider';
import { RedisNameCapGate } from './kernel/redis-name-cap.gate';
import { HotBucketWriter } from './kernel/hot-bucket.writer';
import { ExceptionTallyWriter } from './kernel/exception-tally.writer';
import { IngestWorker } from './ingest.worker';
import { LastUsedFlushService } from '../operator/last-used-flush.service';

/**
 * Worker bounded context — Unit 3 fills the Unit-2 SEAMS with the real hot path:
 *   RAW_APPEND_PORT  → {@link RawFileService} (fsync'd group-commit day-file writer)
 *   ACK_PORT         → {@link WorkerAckPort} (per-record ack; BullMQ job ack on return)
 *   FLOOR_PROVIDER   → {@link PostgresFloorProvider} (last-flushed absolute floor)
 *   NAME_CAP_GATE    → {@link RedisNameCapGate} (per-game distinct-name budget, R3)
 *
 * ---- Stage-C KIND-DISPATCH seam (shared substrate for 003/004/006) --------
 * The three per-kind step-3/7/8 seams are now DISPATCHERS, not single bindings:
 *   TYPED_VALIDATOR  → {@link KindDispatchValidator}  (per-kind step-3 validate;
 *                      fallback = PermissiveTypedValidator — generic/unregistered
 *                      typed kinds behave exactly as before)
 *   DURABLE_IMMEDIATE_HOOK → {@link KindDispatchDurableHook} (per-kind step-7;
 *                      fallback = Noop — generic has no durable work, Q1;
 *                      returns the delegate's DurableWrittenToken verbatim so
 *                      durable ≺ hot stays compile-enforced)
 *   HOT_UPDATE_HOOK  → {@link KindDispatchHotHook} (generic cat/cnt/rank base
 *                      ALWAYS runs, THEN the routed story's accumulators; fallback
 *                      = generic base only)
 * A story (003/004/006) plugs in ADDITIVELY via the KIND_*_REGISTRATION
 * multi-provider tokens — no conflicting edit to these single bindings.
 *
 * Also registers the BullMQ ingest worker + the repeatable flush job
 * ({@link IngestWorker}) and the flush-job orchestration ({@link FlushJobService}).
 */
@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, QueueModule, AppConfigModule, SecurityModule],
  providers: [
    // Flush engine (§3.2 / §3.2.1) + job orchestration.
    DirtyRegistry,
    FlushService,
    FlushJobService,
    // Op-order kernel (§3.1) + real hooks / ports.
    IngestKernel,
    GenericHotUpdateHook,
    HotBucketWriter,
    ExceptionTallyWriter,
    // Stage-C kind-dispatch seam: the default (fallback) hooks are concrete
    // providers so the dispatchers can inject them, plus the three dispatchers
    // themselves. Story modules add their per-kind triples via the
    // KIND_*_REGISTRATION multi-provider tokens (additive, collision-free).
    PermissiveTypedValidator,
    NoopDurableImmediateHook,
    KindDispatchValidator,
    KindDispatchDurableHook,
    KindDispatchHotHook,
    // Raw-file writer options from config (cold-storage toggle, dir, codec).
    {
      provide: RAW_FILE_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RawFileServiceOptions => ({
        dir: config.get<string>('RAW_FILE_DIR'),
        coldStorageEnabled: config.get<boolean>('COLD_STORAGE_ENABLED') ?? true,
      }),
    },
    RawFileService,
    WorkerAckPort,
    PostgresFloorProvider,
    RedisNameCapGate,
    // Security: default-deny PII scrub adapter (step 3 / pre-step-4). The
    // PiiScrubService it wraps comes from the global SecurityModule.
    KernelPiiScrubAdapter,
    // Seam bindings (real implementations).
    { provide: RAW_APPEND_PORT, useExisting: RawFileService },
    { provide: ACK_PORT, useExisting: WorkerAckPort },
    { provide: FLOOR_PROVIDER, useExisting: PostgresFloorProvider },
    { provide: NAME_CAP_GATE, useExisting: RedisNameCapGate },
    // Stage-C: the kernel's three per-kind seams now resolve to the DISPATCHERS.
    // Fallbacks inside each dispatcher preserve today's exact generic behavior
    // when no story is registered for a kind (zero regression).
    { provide: TYPED_VALIDATOR, useExisting: KindDispatchValidator },
    { provide: DURABLE_IMMEDIATE_HOOK, useExisting: KindDispatchDurableHook },
    { provide: HOT_UPDATE_HOOK, useExisting: KindDispatchHotHook },
    { provide: PII_SCRUB_PORT, useExisting: KernelPiiScrubAdapter },
    // R7 (011): last-use flush half — drains the resolver's Redis coalesce into
    // credential child-table last_used_at on the flush cadence. Provided here
    // (needs only DataSource + REDIS_CLIENT, both global) so IngestWorker can
    // drive it WITHOUT importing OperatorModule (avoids a workers→operator cycle).
    LastUsedFlushService,
    // The BullMQ worker + repeatable flush registration.
    IngestWorker,
  ],
  exports: [
    DirtyRegistry,
    FlushService,
    FlushJobService,
    IngestKernel,
    RawFileService,
    // Exported so the ingest door's backpressure shedder can write the
    // arrival-day `rate_limited` tally (Unit 4) via the same class-M path.
    ExceptionTallyWriter,
    FLOOR_PROVIDER,
  ],
})
export class WorkersModule {}
