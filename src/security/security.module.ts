import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretCryptoService, SECRET_MASTER_KEY } from './secret-crypto.service';
import { SubjectHashService } from './subject-hash.service';
import { PiiScrubService } from './pii-scrub.service';

/**
 * Security substrate (FR-029, ops-envelope §9). Provides the envelope-encryption
 * service (reversible-secret crypto with an out-of-DB master key), the per-game
 * keyed `subject_ref` hasher (lawful pseudonymization for the erasure ledger),
 * and the default-deny PII scrubber. Global so any bounded context can inject
 * them (the ingest worker uses the scrubber, the GDPR module uses the hasher).
 *
 * The PII scrub ADAPTER that binds to the kernel seam lives in WorkersModule
 * (co-located with the kernel wiring); PiiScrubService is exported here so both
 * modules share one instance.
 */
@Global()
@Module({
  providers: [
    {
      // The raw master-key material — from ConfigService; a Docker-secret file
      // mount can be read into SECRET_MASTER_KEY at boot by the operator.
      provide: SECRET_MASTER_KEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string => config.get<string>('SECRET_MASTER_KEY') ?? '',
    },
    SecretCryptoService,
    SubjectHashService,
    PiiScrubService,
  ],
  exports: [SecretCryptoService, SubjectHashService, PiiScrubService],
})
export class SecurityModule {}
