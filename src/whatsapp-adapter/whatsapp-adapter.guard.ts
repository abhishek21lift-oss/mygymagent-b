import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WhatsAppAdapterFeatureGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(
    _context: ExecutionContext,
  ): boolean {
    // Fail closed: ConfigModule's zod `validate` strips keys that aren't in
    // the schema, so the only name that can ever resolve is the schema'd
    // env var itself (`src/config/env.validation.ts`). Unset -> false.
    return this.config.get<boolean>('WHATSAPP_ADAPTER_ENABLED', false);
  }
}
