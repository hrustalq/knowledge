import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { t } from '../../i18n/t.js';
import { ConnectorsService } from '../connectors.service.js';
import { fetchPullRequestFiles, type PullRequestFiles } from '../adapters/pull-request.js';
import { REPO_CONNECTOR_KINDS } from './repo-snapshot.service.js';

/**
 * A connected repository's pull requests, reached through the connector's own
 * credential (docs/features/35).
 *
 * Beside `RepoSnapshotService` because it is the same kind of access — reading
 * a repository the workspace has connected. Read-only on purpose: this module
 * loads in the worker, and the comment on the pull request is an outward write
 * the API makes (`DriftPublishSweeper`), never an unattended run. The
 * credential never leaves here; callers pass a connector id.
 *
 * Eligibility is re-read on every call, the snapshot rule: a run can wait in
 * the queue long enough for somebody to disable the connector it names.
 */
@Injectable()
export class PullRequestService {
  constructor(private readonly connectors: ConnectorsService) {}

  async files(connectorId: string, workspaceId: string, number: number): Promise<PullRequestFiles> {
    const ctx = await this.context(connectorId, workspaceId);
    return fetchPullRequestFiles(ctx, number);
  }

  private async context(connectorId: string, workspaceId: string) {
    const row = await this.connectors.require(connectorId);
    if (row.workspaceId !== workspaceId) {
      throw new NotFoundException(t('error.connector.notFound', { id: connectorId }));
    }
    if (!REPO_CONNECTOR_KINDS.has(row.kind)) {
      throw new BadRequestException(t('error.code.notARepository', { name: row.name }));
    }
    if (!row.enabled) throw new BadRequestException(t('error.code.connectorDisabled', { name: row.name }));
    return this.connectors.contextFor(row, async () => undefined);
  }
}
