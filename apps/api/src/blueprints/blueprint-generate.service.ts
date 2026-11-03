import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  BLUEPRINT_INTERVIEW_MAX_ROUNDS,
  DOCUMENT_CATEGORIES,
  blueprintText,
  type Blueprint,
  type BlueprintInterviewRound,
  type GenerateBlueprintResponse,
} from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AssistantReadToolsService } from '../assistant/assistant-read-tools.service.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { safeJson } from '../glossary/glossary.service.js';
import { t } from '../i18n/t.js';
import { TemplatesService } from '../templates/templates.service.js';
import { titleLocale } from './derive-rules.js';
import { keyed, outlineOf, readDraftedTree, readStyleguide } from './drafted-blueprint.js';
import { parseBlueprint } from './blueprint.schema.js';
import { readRound, readTerms, transcriptOf } from './interview-round.js';

/** The read tools Describe it may use. Intersected with the agent's own list, never widened by it. */
const GENERATE_TOOLS: ReadonlySet<string> = new Set(['list_document_tree', 'search_knowledge']);

const GENERATE_CONTRACT =
  'Draft the outline of a new documentation project from the person\'s description. You may look at how this ' +
  'workspace already organises its pages (list_document_tree) and search what it already covers ' +
  '(search_knowledge), to fit the outline beside them rather than duplicate them; the new project starts empty. ' +
  'Prefer 5–40 pages, at most 3 levels deep. Mark a section whose pages are added one at a time over the ' +
  'project\'s life (decision records, sessions, components, test cases) as a collection instead of listing ' +
  'entries: give it a title pattern such as "ADR {{n:4}}: " or "{{n:2}} — " ({{n:W}} is the next number, ' +
  'zero-padded to W digits) and, when one fits, a child template. Use a template only from the list you are ' +
  'given, by its ref. Respond ONLY with a json object {"name": string, "description": string, "tree": [node], ' +
  '"styleguide": {"description": string, "rules": [{"text": string, "severity": "error"|"warning"|"info"}]}} ' +
  'where node is {"title": string, "category"?: one of ' +
  DOCUMENT_CATEGORIES.map((c) => `"${c}"`).join('|') +
  ', "template"?: ref, "guidance"?: string, "collection"?: {"pattern"?: string, "template"?: ref}, ' +
  '"children"?: [node]}. name is a short name for the project; description one sentence. guidance says in one ' +
  'or two sentences what belongs on that page. Give at most 10 styleguide rules. Add "glossary": [{"term": string, ' +
  '"definition": string}] with at most 15 terms the description or the person\'s answers define, in their words; ' +
  '[] when none. Fold every decision the answers settled into the guidance of the page it shapes.';

/** One interview round (#731): ask what the brief left open, or say there is nothing left. */
const INTERVIEW_CONTRACT =
  'Before drafting the outline of a new documentation project, interview the person about what their description ' +
  'leaves open. Ask only for decisions they must make: who reads the project, what it covers and leaves out, which ' +
  'kinds of pages recur, how it relates to what the workspace already holds. Look facts up yourself with the tools ' +
  'instead of asking for them. Ask every question you can ask now, at most 4: never one whose answer depends on ' +
  'another question still open, never one the description or an earlier answer settled. Each question is a ' +
  '"choice" (one option) or a "checklist" (several) with 2–6 options; mark exactly one option recommended, the one ' +
  'you would pick, and say why in its description. Word the label so accepting the recommended option is the ' +
  'natural answer. The person can always answer in their own words instead. When nothing is left open, respond ' +
  'ONLY with {"done": true}. Otherwise respond ONLY with a json object {"questions": [{"type": "choice"|"checklist", ' +
  '"name": string, "label": string, "options": [{"value": string, "label": string, "description"?: string, ' +
  '"recommended"?: boolean}]}], "outline": [node], "terms": [{"term": string, "definition": string}]} where node is ' +
  '{"title": string, "collection"?: {"pattern"?: string}, "children"?: [node]}: the outline as it stands now, ' +
  'titles only, at most 3 levels; terms are at most 15 words the person\'s own text defines.';

/**
 * Describe it (#716, phase 5): the `scaffolder` drafts a whole blueprint from
 * a person's brief, optionally adapting a starting one. It may read the
 * workspace's tree and search, each call under the caller's own scope, and
 * writes nothing — the wizard takes the result to Shape, and Create is the
 * only write. The route is `@Feature('assistant')`; this service assumes it.
 */
@Injectable()
export class BlueprintGenerateService {
  constructor(
    private readonly agents: AgentRegistryService,
    private readonly aiUsage: AiUsageService,
    private readonly client: AssistantClient,
    private readonly readTools: AssistantReadToolsService,
    private readonly templates: TemplatesService,
  ) {}

  /**
   * Without `interview`, one draft (phase 5). With it (#731), one round: the
   * scaffolder asks again, or — on `draft`, at the round cap, or when it says
   * nothing is left open — drafts from the brief and every answer so far.
   */
  async generate(
    workspaceId: string,
    brief: string,
    start: Blueprint | null,
    principal: Principal,
    interview?: { rounds: BlueprintInterviewRound[]; draft: boolean },
  ): Promise<GenerateBlueprintResponse> {
    const agent = await this.agents.resolve(workspaceId, 'scaffolder');
    if (!agent.enabled) throw new BadRequestException(t('error.ai.agentDisabled', { key: agent.name }));
    await this.aiUsage.assertWithinBudget(workspaceId, principal.userId);

    const lang = titleLocale(brief);
    // Workspace-wide templates and enabled built-ins: what a page of a project not yet made can use.
    const offered = (await this.templates.list({ workspaceId })).templates.filter((tpl) => tpl.enabled && !tpl.projectId);
    const refs = new Set<string>(offered.map((tpl) => tpl.ref));
    const catalogue = offered.map((tpl) => `${tpl.ref} — ${tpl.name} (${tpl.category})`).join('\n');

    const startText = start
      ? `\n\nAdapt this starting outline to the description:\n${wrapUntrusted(outlineOf(start.tree).lines.join('\n'), 'blueprint-generate', 'template')}`
      : '';
    const rounds = interview?.rounds ?? [];
    // The client sends the questions back too, so the whole transcript is the person's side: untrusted.
    const answersText = rounds.length
      ? `\n\nYour questions so far and the person's answers:\n${wrapUntrusted(transcriptOf(rounds), 'blueprint-generate', 'brief')}`
      : '';
    // The language rides in the system message beside the contract: a mention in the user turn alone lost
    // to an English contract and English tool results, and the text landed under the wrong locale key.
    const language = lang === 'ru' ? 'Russian' : 'English';
    // `draft` or the round cap always drafts, whatever the model would say; its own "done" is decided after its call.
    const asking = !!interview && !interview.draft && rounds.length < BLUEPRINT_INTERVIEW_MAX_ROUNDS;
    const contract = asking ? INTERVIEW_CONTRACT : GENERATE_CONTRACT;
    const messages = [
      {
        role: 'system' as const,
        content: `${agent.instructions}\n\n${contract}\n\nWrite ${asking ? 'every question, option, title and term' : 'name, description, every title, guidance and rule'} in ${language}, whatever language the workspace's pages are in. Keep template refs and title-pattern placeholders as they are.`,
      },
      {
        role: 'user' as const,
        content:
          `Answer in ${language}.\n\nTemplates (ref — name (category)):\n${catalogue || '(none)'}` +
          `\n\nThe description:\n${wrapUntrusted(brief, 'blueprint-generate', 'brief')}${startText}${answersText}` +
          (asking ? `\n\nThis is round ${rounds.length + 1} of at most ${BLUEPRINT_INTERVIEW_MAX_ROUNDS}.` : '') +
          // Asked in the language itself, last: it is what the model reads right before it answers.
          (lang === 'ru' ? (asking ? '\n\nЗадавай вопросы и пиши варианты по-русски.' : '\n\nПиши все названия, описания, подсказки и правила по-русски.') : ''),
      },
    ];

    const call = {
      config: agent.config,
      userId: principal.userId,
      operation: asking ? ('blueprint-interview' as const) : ('blueprint-generate' as const),
      locale: principal.locale,
    };
    const allowed = new Set(agent.tools.filter((name) => GENERATE_TOOLS.has(name)));
    const tools = this.readTools.definitions().filter((d) => allowed.has(d.function.name));
    const raw =
      agent.missing.includes('tools') || !tools.length
        ? await this.client.chat(call, messages, { json: true })
        : (
            await this.client.runWithTools(
              call,
              messages,
              tools,
              // Checked on execution, not on offer: a name outside the set is refused whatever the model asks.
              (name, args) =>
                allowed.has(name)
                  ? this.readTools.execute(name, args, { principal, workspaceId })
                  : Promise.resolve({ content: JSON.stringify({ error: `Unknown tool ${name}` }), ok: false }),
              { jsonFinalRound: true },
            )
          ).content;

    const parsed = safeJson(raw) ?? {};
    if (asking) {
      const round = readRound(parsed.questions);
      // "done", or nothing askable: draft now from everything so far, in a second call.
      if (parsed.done === true || !round.questions.length) return this.generate(workspaceId, brief, start, principal, { rounds, draft: true });
      return { status: 'asking', round, outline: readDraftedTree(parsed.outline, new Set()), terms: readTerms(parsed.terms) };
    }
    const tree = readDraftedTree(parsed.tree, refs);
    if (!tree.length) throw new UnprocessableEntityException({ statusCode: 422, message: t('error.blueprint.generateEmpty') });

    const name = typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 120) : '';
    const description = typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 2_000) : '';
    const styleguide = readStyleguide(parsed.styleguide);
    // A starting blueprint's own conventions (templates, glossary) stay; a drafted styleguide replaces its one.
    const conventions = { ...start?.conventions, ...(styleguide ? { styleguide } : {}) };
    return {
      status: 'done',
      glossary: readTerms(parsed.glossary),
      blueprint: parseBlueprint({
        name: keyed(name || (start ? blueprintText(start.name, lang) : '') || brief.trim().split('\n')[0]!.slice(0, 120)),
        ...(description ? { description: keyed(description) } : {}),
        ...(start?.icon ? { icon: start.icon } : {}),
        tree,
        ...(Object.keys(conventions).length ? { conventions } : {}),
      }),
    };
  }
}
