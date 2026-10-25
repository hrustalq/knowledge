import { Module } from '@nestjs/common';
import { ReadCache } from './read-cache.service.js';

/** Controller-free: the API, the worker and the MCP server all read through it (#472). */
@Module({
  providers: [ReadCache],
  exports: [ReadCache],
})
export class ReadCacheCoreModule {}
