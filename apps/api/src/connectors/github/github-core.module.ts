import { Module } from '@nestjs/common';
import { GithubAppService } from './github-app.service.js';

/**
 * The App credential, alone (docs/features/28).
 *
 * Split out to the smallest module that works because `ConnectorsService` —
 * which the **worker** loads — now resolves a connector's credential through
 * it. `GithubAppService` reads only `ConfigService` and dials github.com, so it
 * carries nothing controller-shaped into the worker process.
 *
 * The OAuth and browse services deliberately stay out: they exist to serve a
 * person clicking through a picker, and a worker has no person.
 */
@Module({
  providers: [GithubAppService],
  exports: [GithubAppService],
})
export class GithubCoreModule {}
