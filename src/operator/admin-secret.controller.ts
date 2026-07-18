/**
 * Admin infra-secret rotation controller (T-10.22/33) — API-only, admin-only.
 *
 * The master-key ROTATION maintenance operation. During the dual-key window the
 * fleet runs with BOTH keys available: SECRET_MASTER_KEY (old) and
 * SECRET_MASTER_KEY_NEW (new). This endpoint runs the bulk re-encrypt pass
 * (SecretRotationService.reEncryptAll) old→new. When the pass reports every row
 * migrated, the operator promotes the new key and drops the old (see
 * SecretRotationService JSDoc for the full sequence + doc/security).
 *
 * The raw key material is read from env, NEVER from the request body — a master
 * key must not travel over the admin API. The endpoint 400s if either env key is
 * absent, so it cannot run outside a properly-staged dual-key window.
 */

import { BadRequestException, Controller, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretRotationService, type ReEncryptResult } from '../security/secret-rotation.service';
import { OperatorSessionGuard } from './operator-session.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';

@Controller('admin/secrets')
@UseGuards(OperatorSessionGuard, RolesGuard)
export class AdminSecretController {
  constructor(
    private readonly rotation: SecretRotationService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Run one master-key re-encrypt pass old→new. Idempotent + resumable — safe to
   * re-run until `reEncrypted` is 0 and `skipped` is 0. Reads both keys from env.
   */
  @Post('rotate-master-key')
  @Roles('admin')
  async rotateMasterKey(): Promise<ReEncryptResult> {
    const oldKey = this.config.get<string>('SECRET_MASTER_KEY') ?? '';
    const newKey = this.config.get<string>('SECRET_MASTER_KEY_NEW') ?? '';
    if (oldKey.trim() === '' || newKey.trim() === '') {
      throw new BadRequestException(
        'master-key rotation requires BOTH SECRET_MASTER_KEY (old) and SECRET_MASTER_KEY_NEW (new) in the environment ' +
          '(the dual-key decrypt-old/encrypt-new window).',
      );
    }
    return this.rotation.reEncryptAll(oldKey, newKey);
  }
}
