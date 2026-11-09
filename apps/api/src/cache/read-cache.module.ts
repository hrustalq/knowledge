import { Module } from '@nestjs/common';
import { ReadCache } from './read-cache.service.js';
import { RedisModule } from '../redis/redis.module.js';

/** Controller-free: the API, the worker and the MCP server all read through it (#472). */
@Module({
  imports: [RedisModule],
  providers: [ReadCache],
  exports: [ReadCache],
})
export class ReadCacheCoreModule {}
