import { Global, Module } from '@nestjs/common';
import { I18nRegistry } from './t.js';

/**
 * Captures the I18nService instance for the ambient `t()` helper, so throw
 * sites can translate without injecting anything. Global and provider-only —
 * safe in the HTTP, worker and MCP contexts alike.
 */
@Global()
@Module({ providers: [I18nRegistry], exports: [I18nRegistry] })
export class I18nSetupModule {}
