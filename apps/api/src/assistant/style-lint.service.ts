import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AssistantLintResponse } from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { LINT_TEXT_MAX, enabledRules, lintMessages, readLintViolations } from '../agents/lint.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from './assistant.client.js';
import { parseModelJson } from '../common/model-json.js';
import type { Env } from '../config/env.js';

export interface StyleLintInput {
  workspaceId: string;
  projectId?: string | null;
  title: string;
  markdown: string;
}

/**
 * Check text against the styleguide of its project (#74). The one
 * implementation behind `POST /v1/assistant/lint` and the MCP
 * `knowledge_lint_draft` tool, which is why it sits outside AssistantService:
 * that service carries the chat surface and its module a controller, and the
 * MCP tool set must not load either.
 *
 * No styleguide, or none of its rules enabled, means no model call at all —
 * the check has nothing to check against. What the model reports is filtered
 * by `readLintViolations`: a rule id the styleguide does not hold, or a quote
 * the text does not contain, never reaches the caller.
 */
@Injectable()
export class StyleLintService {
  constructor(
    private readonly client: AssistantClient,
    private readonly aiUsage: AiUsageService,
    private readonly skills: AiSkillsService,
    private readonly agents: AgentRegistryService,
    private readonly env: ConfigService<Env, true>,
  ) {}

  async lint(input: StyleLintInput, principal: Principal): Promise<AssistantLintResponse> {
    const found = await this.skills.effectiveStyleguide(input.workspaceId, input.projectId ?? null);
    const styleguide = found ? { id: found.row.id, name: found.row.name, scope: found.scope } : null;
    if (!found || enabledRules(found.rules).length === 0) {
      return { enabled: true, styleguide, violations: [], dropped: 0 };
    }
    const agent = await this.agents.resolve(input.workspaceId, 'linter');
    if (!agent.enabled || !agent.config.enabled) return { enabled: false, styleguide, violations: [], dropped: 0 };
    await this.aiUsage.assertWithinBudget(input.workspaceId, principal.userId);
    const text = input.markdown.slice(0, LINT_TEXT_MAX);
    const raw = await this.client.chat(
      { config: agent.config, userId: principal.userId, operation: 'lint', locale: principal.locale, projectId: input.projectId ?? null },
      lintMessages(agent.instructions, found.rules, input.title, text),
      { json: true },
    );
    const max = this.env.get('LINT_MAX_FINDINGS', { infer: true });
    return { enabled: true, styleguide, ...readLintViolations(parseModelJson(raw), found.rules, text, max) };
  }
}

