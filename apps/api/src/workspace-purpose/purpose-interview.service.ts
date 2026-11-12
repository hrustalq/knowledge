import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PURPOSE_INTERVIEW_MAX_ROUNDS, suggestedDisabled, type InterviewRound, type PurposeInterviewResponse } from '@knowledge/contracts';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import type { Principal } from '../auth/principal.js';
import { parseModelJson } from '../common/model-json.js';
import { purposeMessages, readPicks, readPurposeRound } from './purpose-interview.js';

/**
 * Asks a new workspace's admin what it is for (#934) and picks uses from the
 * closed catalogue. It borrows the `scaffolder`'s model the way memo triage
 * borrows the secretary's: its own contract, its own usage operation, no
 * tools, and none of the agent's instructions — so an admin's edits to the
 * scaffolder neither leak in here nor are changed by this. Stateless and
 * writes nothing; saving is `PUT :id/purpose`.
 */
@Injectable()
export class PurposeInterviewService {
  constructor(
    private readonly agents: AgentRegistryService,
    private readonly usage: AiUsageService,
    private readonly client: AssistantClient,
  ) {}

  async interview(
    workspaceId: string,
    input: { description: string; rounds: InterviewRound[]; finish: boolean },
    principal: Principal,
  ): Promise<PurposeInterviewResponse> {
    // No model here is an answer, not an error: the wizard falls back to the checklist.
    const agent = await this.agents.resolve(workspaceId, 'scaffolder');
    if (!agent.enabled || !agent.config.enabled) return { status: 'unavailable' };
    const spent = await this.usage.assertWithinBudget(workspaceId, principal.userId).then(
      () => false,
      (error: unknown) => {
        if (error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) return true;
        throw error;
      },
    );
    if (spent) return { status: 'unavailable' };

    // `finish` or the round cap always ends it, whatever the model would say.
    const asking = !input.finish && input.rounds.length < PURPOSE_INTERVIEW_MAX_ROUNDS;
    const { system, user } = purposeMessages({ ...input, asking, language: principal.locale === 'ru' ? 'Russian' : 'English' });
    const raw = await this.client.chat(
      { config: agent.config, userId: principal.userId, operation: 'purpose-interview', locale: principal.locale },
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { json: true },
    );
    const parsed = parseModelJson(raw) ?? {};
    if (asking) {
      const round = readPurposeRound(parsed.questions);
      if (round.questions.length && parsed.done !== true) return { status: 'asking', round };
      // Neither a usable question nor a pick: ask once more for the picks alone.
      if (!Array.isArray(parsed.uses)) return this.interview(workspaceId, { ...input, finish: true }, principal);
    }
    const picks = readPicks(parsed.uses);
    return { status: 'done', picks, suggestedDisabled: suggestedDisabled(picks.map((p) => p.use)) };
  }
}
