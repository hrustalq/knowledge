import { Module } from '@nestjs/common';
import { PublicStore } from '../public/public-store.js';
import { SharedRedis } from './shared-redis.js';

/** Import this, never provide `SharedRedis` or `PublicStore` yourself: a second provider is a second client. */
@Module({
  providers: [SharedRedis, PublicStore],
  exports: [SharedRedis, PublicStore],
})
export class RedisModule {}
