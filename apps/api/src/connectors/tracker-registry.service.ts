import { Injectable } from '@nestjs/common';
import type { Connector } from '@prisma/client';
import type { TrackerAdapter } from './adapters/tracker.js';
import { GithubIssuesService } from './github/github-issues.service.js';

/**
 * Which tracker serves a connector row (#424). One list, read by the handoff,
 * the sweeper and the tab alike, so "can this connector take a ticket" has one
 * answer. Null means the row has no tracker: not a refusal, just no chip.
 */
@Injectable()
export class TrackerRegistry {
  private readonly adapters: TrackerAdapter[];

  constructor(github: GithubIssuesService) {
    this.adapters = [github];
  }

  trackerFor(row: Connector): TrackerAdapter | null {
    return this.adapters.find((adapter) => adapter.supports(row)) ?? null;
  }
}
