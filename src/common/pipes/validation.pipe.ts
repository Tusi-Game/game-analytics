import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Global validation pipe (SKELETON — spec 002 adds real batch validation).
 *
 * Pass-through in this scaffold: returns the value unchanged. Spec 002 wires the
 * real envelope/batch validation (Zod) here. Kept as a class so it can be
 * registered globally now and evolve without changing the wiring.
 */
@Injectable()
export class AppValidationPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return value;
  }
}
