import type { AgentRunner } from './agent-services.js';
import { arbiterRunner } from './runners/arbiter.js';
import { archaeologistRunner } from './runners/archaeologist.js';
import { atlasRunner } from './runners/atlas.js';
import { auditorRunner } from './runners/auditor.js';
import { cartographerRunner } from './runners/cartographer.js';
import { curatorRunner } from './runners/curator.js';
import { digestRunner } from './runners/digest.js';
import { glossaristRunner } from './runners/glossarist.js';
import { linterRunner } from './runners/linter.js';
import { reviewerRunner } from './runners/reviewer.js';
import { scribeRunner } from './runners/scribe.js';
import { secretaryRunner } from './runners/secretary.js';
import { sentinelRunner } from './runners/sentinel.js';
import { surveyorRunner } from './runners/surveyor.js';
import { testerRunner } from './runners/tester.js';

/**
 * Every agent with a background runner (#823), by key. Which of them a person
 * or a trigger may start is not decided here: that is `RUNNABLE_AGENTS` and
 * `isTriggerableAgent` in `@knowledge/contracts`, which the API reads without
 * loading this worker-only map. `test/agent-runners.spec.ts` pins the two.
 */
export const AGENT_RUNNERS: ReadonlyMap<string, AgentRunner> = new Map(
  [
    arbiterRunner,
    archaeologistRunner,
    atlasRunner,
    auditorRunner,
    cartographerRunner,
    curatorRunner,
    digestRunner,
    glossaristRunner,
    linterRunner,
    reviewerRunner,
    scribeRunner,
    secretaryRunner,
    sentinelRunner,
    surveyorRunner,
    testerRunner,
  ].map((runner) => [runner.key, runner]),
);
