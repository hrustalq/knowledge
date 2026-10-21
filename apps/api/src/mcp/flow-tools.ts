import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { fromElicitation, toElicitationSchema } from '@knowledge/contracts';
import type { FlowRun } from '../flows/flows.service.js';

/** The `answers` argument of a flow-bearing tool (#425). Not a write of its own: it joins no list in mcp-tools.ts. */
export const flowAnswersArg = z
  .record(z.string(), z.union([z.string(), z.array(z.string()), z.null()]))
  .optional()
  .describe(
    'Answers to the questions a previous call returned as status "needs_input": question id → the option value the ' +
      'person picked (an array for a checklist, text for a text question, null to skip an optional one). Send the ' +
      'whole answersSoFar back each time; the flow is rebuilt from it.',
  );

/** A person may re-submit a form the client let through invalid; past this the call hands back `needs_input`. */
const MAX_ELICITATIONS = 10;
/** A form waits on a person, not a machine: the SDK's 60 s request default is too short. */
const ELICITATION_TIMEOUT_MS = 15 * 60_000;

/**
 * Walk a flow over MCP (#425). `run` is the FlowsService call with the answers
 * so far; `done` shapes the result once nothing is open.
 *
 * - The client declared form elicitation (stdio only — the HTTP transport is
 *   stateless and cannot send a request back): each open question is asked
 *   with `elicitInput`; `decline` / `cancel` ends the flow and writes nothing.
 * - Otherwise (every HTTP caller): the open question comes back as
 *   `status: "needs_input"` and the agent asks the person, then calls again.
 */
export async function runFlow<T>(
  server: McpServer,
  tool: string,
  given: Record<string, unknown>,
  run: (answers: Record<string, unknown>) => Promise<FlowRun<T>>,
  done: (run: Extract<FlowRun<T>, { status: 'done' }>) => unknown,
): Promise<unknown> {
  const canElicit = Boolean(server.server.getClientCapabilities()?.elicitation?.form);
  let answers = given;
  for (let asked = 0; ; asked++) {
    const res = await run(answers);
    if (res.status === 'done') return done(res);
    const q = res.step.question;
    if (!canElicit || asked >= MAX_ELICITATIONS) return needsInput(tool, res);
    const reply = await server.server.elicitInput(
      {
        message: q.description ?? q.label,
        requestedSchema: toElicitationSchema(q) as ElicitRequestFormParams['requestedSchema'],
      },
      { timeout: ELICITATION_TIMEOUT_MS },
    );
    if (reply.action !== 'accept') return { status: 'cancelled', flow: res.flow, question: q.id, wrote: 'nothing' };
    // An empty form is a skip; `validate` refuses it for a required question and the question is asked again.
    answers = { ...res.answers, [q.id]: fromElicitation(q, reply.content ?? {}) ?? null };
  }
}

function needsInput<T>(tool: string, res: Extract<FlowRun<T>, { status: 'needs_input' }>) {
  const q = res.step.question;
  return {
    status: 'needs_input',
    flow: res.flow,
    step: res.step.step,
    of: res.step.of,
    // `when` is a function, so JSON leaves it out.
    question: q,
    answersSoFar: res.answers,
    ...(res.dropped.length ? { ignored: res.dropped } : {}),
    next:
      'Ask the person this question with your own question tool: offer the options, mark the recommended one, and ' +
      `never answer it for them. Then call ${tool} again with the same arguments and answers set to answersSoFar plus ` +
      `"${q.id}": ${q.type === 'checklist' ? 'an array of the option values they ticked' : q.type === 'text' ? 'their text' : 'the value they picked'}` +
      `${q.required ? '' : ' (null to skip)'}. If they decline, stop: nothing has been written.`,
  };
}
