import type { AgentRun } from '@prisma/client';
import type { AgentRunInput, Locale } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { MAX_SCRIBE_PAGES, SCRIBE_OUTPUT_CONTRACT, readScribeDrafts, scribeCitedIds, scribePrompt } from '../scribe.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, UUID, runBrief } from '../agent-services.js';

export const scribeRunner: AgentRunner = { key: 'scribe', run: scribe };

/**
 * The scribe (#433): the documentation a tracker ticket asks for. The ticket
 * is read live through its tracker — its body is never stored here — and
 * shown to the model only wrapped untrusted. The model searches as the run's
 * owner and answers with page drafts; `ScribePublishSweeper` opens each as a
 * merge request on the API side and comments the links on the ticket.
 */
async function scribe(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const input = (run.input ?? {}) as AgentRunInput;
  const workItemId = input.event?.type === 'work-item.updated' ? input.event.subjectId : undefined;
  if (!workItemId) throw new Error(t('agent.scribeRun.noTicket'));

  await report({ stage: 'reading', progress: 0.05 });
  const item = await svc.prisma.connectorWorkItem.findFirst({ where: { id: workItemId, workspaceId: run.workspaceId } });
  const row = item
    ? await svc.prisma.connector.findFirst({ where: { id: item.connectorId, workspaceId: run.workspaceId } })
    : null;
  const tracker = row ? svc.trackers.trackerFor(row) : null;
  const issue = item && row && tracker ? await tracker.getIssue(row, item) : null;
  if (!item || !issue) return { summary: t('agent.scribeRun.ticketGone'), findings: [] };
  const ticket = {
    key: item.externalKey ?? `#${item.number}`,
    title: issue.title,
    url: issue.url,
    labels: issue.labels,
    body: issue.body,
  };

  const blocking = agent.missing.filter((capability) => capability !== 'tools');
  if (!agent.config.enabled || blocking.length > 0) {
    return { summary: t('agent.scribeRun.noModel', { key: ticket.key }), findings: [] };
  }

  await report({ stage: 'thinking', progress: 0.2 });
  const call = { config: agent.config, userId: run.createdBy, operation: 'agent' as const, locale: run.locale as Locale };
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `${agent.instructions}\n\n${SCRIBE_OUTPUT_CONTRACT}${await svc.guidance(run, agent)}` },
    { role: 'user', content: runBrief(input) + scribePrompt(ticket) },
  ];
  const raw = await svc.callModel(call, agent, messages, svc.readTool(run, principal));
  const parsed = parseModelJson(raw);

  // A page to rewrite must be one the run may read: one query over whatever
  // the model named, under the same scope its searches ran with.
  const cited = scribeCitedIds(parsed).filter((id) => UUID.test(id));
  const scope = await svc.runScope(run, principal);
  const known = new Map(
    cited.length
      ? (
          await svc.prisma.document.findMany({
            where: { id: { in: cited }, workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
            select: { id: true, title: true },
          })
        ).map((d) => [d.id, d.title])
      : [],
  );
  const { summary, findings } = readScribeDrafts(parsed, known, ticket);
  return {
    summary:
      summary ?? t('agent.scribeRun.summary', { key: ticket.key, count: findings.length, max: MAX_SCRIBE_PAGES }),
    findings,
  };
}
