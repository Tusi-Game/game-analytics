import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AppConfigModule } from '../config/app-config.module';
import { SecurityModule } from '../security/security.module';
import { WorkersModule } from '../workers/workers.module';
import { ColdStorageConfigService } from './cold-storage-config.service';
import { S3ClientService } from './s3-client.service';
import { NightlyShipmentService } from './nightly-shipment.service';
import { ColdStorageWorker } from './cold-storage.worker';
import { UploadStatusReadModel } from './upload-status.read-model';

/**
 * 008-cold-storage — the raw day-file lifecycle AFTER 002 writes the file:
 * nightly seal-drive + enumerate → decode-verify gate (R6) → upload → verify →
 * record (UPLOAD_BOOKKEEPING) → retention-delete, plus S3-side raw expiry and the
 * ops upload-status read-model.
 *
 * Imports:
 *   - WorkersModule  → the exported {@link RawFileService} (sealFile/decodeCheck/
 *     filePathFor/rootDir). 008 CALLS its exported surface; it never touches an
 *     open file or modifies 002's rawfile internals.
 *   - DatabaseModule → the DataSource + auto-loaded UploadBookkeepingEntity.
 *   - AppConfigModule → GameConfigService (the §6 knob reader).
 *   - SecurityModule → SecretCryptoService (in-worker credential decrypt).
 *
 * The BullMQ queue + worker connection come from the GLOBAL QueueModule (no
 * import needed). Registered in AppModule after WorkersModule.
 */
@Module({
  imports: [DatabaseModule, AppConfigModule, SecurityModule, WorkersModule],
  providers: [
    ColdStorageConfigService,
    S3ClientService,
    NightlyShipmentService,
    UploadStatusReadModel,
    ColdStorageWorker,
  ],
  exports: [NightlyShipmentService, UploadStatusReadModel, ColdStorageConfigService, ColdStorageWorker],
})
export class ColdStorageModule {}
