import { Prisma, type AgentRun } from '@prisma/client';
import { type AgentRunInput, type Locale, type MemoSegment, isPageSource, UUID_RE } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { memoCitedIds, memoOutputContract, memoPrompt, readMemoProposals } from '../memo.js';
import { identifiedSpeakers, loadSpeakers } from '../../memos/speakers.js';
import { effectiveMemoTypes, memoTypeBrief } from '../../memos/memo-types.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, runBrief } from '../agent-services.js';

export const secretaryRunner: AgentRunner = { key: 'secretary', run: minute };

/**
 * The secretary (#551, docs/features/68): what a memo's transcript changes.
 * The transcript is masked already and shown only wrapped untrusted. The
 * model searches as the uploader; an update is kept only for a page one of
 * this run's own tool calls returned **and** the uploader may read — the
 * check is here, not in the prompt. Dropped proposals land on the memo
 * with their reason; `MemoPublishSweeper` opens the kept ones API-side.
 */
async function minute(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const memoId = ((run.input ?? {}) as AgentRunInput).memo?.memoId;
  const memo = memoId ? await svc.prisma.memo.findFirst({ where: { id: memoId, workspaceId: run.workspaceId } }) : null;
  const segments = Array.isArray(memo?.transcript) ? (memo.transcript as unknown as MemoSegment[]) : [];
  if (!memo) throw new Error(t('agent.memoRun.noMemo'));

  const max = svc.config.get('MEMO_MAX_PROPOSALS', { infer: true });
  const blocking = agent.missing.filter((capability) => capability !== 'tools');
  const unavailable = !agent.config.enabled || blocking.length > 0;
  if (unavailable || segments.length === 0 || max === 0) {
    // Silence has nothing to summarise; a missing model says so; proposals
    // switched off (MEMO_MAX_PROPOSALS=0) is zero of zero, not an error.
    const summary =
      segments.length === 0 ? null : unavailable ? t('agent.memoRun.noModel') : t('agent.memoRun.summary', { count: 0, max });
    await svc.prisma.memo.update({ where: { id: memo.id }, data: { summary, dropped: [] } });
    return { summary: summary ?? t('agent.memoRun.summary', { count: 0, max }), findings: [] };
  }

  await report({ stage: 'thinking', progress: 0.2 });
  const call = { config: agent.config, userId: run.createdBy, operation: 'memo' as const, locale: run.locale as Locale };
  // Matches that hold when the run starts (#880): chosen on this memo, or remembered from the uploader's earlier ones.
  const who = await loadSpeakers(svc.prisma, memo);
  // What kind of recording this is (#879): the workspace's own words for it, admin-written, so trusted.
  const kind = memo.type ? memoTypeBrief(effectiveMemoTypes(await svc.prisma.memoType.findMany({ where: { workspaceId: run.workspaceId } })), memo.type) : '';
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `${agent.instructions}\n\n${memoOutputContract(max)}${kind}${await svc.guidance(run, agent)}` },
    { role: 'user', content: runBrief((run.input ?? {}) as AgentRunInput) + memoPrompt(memo.title, segments, identifiedSpeakers(who.speakers, who.members)) },
  ];
  // Every page a tool result carried, as the run saw it: the only pages an
  // update may name.
  const retrieved = new Set<string>();
  const read = svc.readTool(run, principal);
  const raw = await svc.callModel(call, agent, messages, async (name, args) => {
    const result = await read(name, args);
    for (const source of result.sources) if (isPageSource(source)) retrieved.add(source.documentId);
    return result;
  });
  const parsed = parseModelJson(raw);

  const cited = memoCitedIds(parsed).filter((id) => UUID_RE.test(id) && retrieved.has(id));
  const scope = await svc.runScope(run, principal);
  const visible = new Map(
    cited.length
      ? (
          await svc.prisma.document.findMany({
            where: { id: { in: cited }, workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
            select: { id: true, title: true },
          })
        ).map((d) => [d.id, d.title])
      : [],
  );
  const web = svc.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  const { summary, findings, dropped } = readMemoProposals(parsed, {
    retrieved,
    visible,
    segments,
    max,
    linkAt: (seconds) => `${web}/memos/${memo.id}?t=${seconds}`,
    label: (time) => t('agent.memoRun.sourceLabel', { time }),
  });
  const text = summary ?? t('agent.memoRun.summary', { count: findings.length, max });
  await svc.prisma.memo.update({
    where: { id: memo.id },
    data: { summary: text, dropped: dropped as unknown as Prisma.InputJsonValue },
  });
  return { summary: text, findings };
}
