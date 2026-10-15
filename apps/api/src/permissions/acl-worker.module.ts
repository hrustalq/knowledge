import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { AclRestampSweeper } from './acl-restamp.sweeper.js';

/** The worker half of page permissions (#76) — imported ONLY by worker.module.ts. */
@Module({
  imports: [GraphModule, FulltextModule],
  providers: [AclRestampSweeper],
})
export class AclWorkerModule {}
