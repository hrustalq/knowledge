import { Module } from '@nestjs/common';
import { SearchCoreModule } from './search-core.module.js';
import { SearchController } from './search.controller.js';

/** API side: the search endpoint on top of SearchCoreModule's service. */
@Module({
  imports: [SearchCoreModule],
  controllers: [SearchController],
  exports: [SearchCoreModule],
})
export class SearchModule {}
