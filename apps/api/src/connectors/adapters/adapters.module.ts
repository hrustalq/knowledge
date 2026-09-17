import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../../agents/agent-core.module.js';
import { AiCoreModule } from '../../ai/ai-core.module.js';
import { AssistantClientModule } from '../../assistant/assistant-client.module.js';
import { CodebaseAdapter } from './codebase.adapter.js';
import { ConfluenceAdapter } from './confluence.adapter.js';
import { ConfluenceServerAdapter } from './confluence-server.adapter.js';
import { ConnectorRegistry } from './connector.registry.js';
import { JiraAdapter } from './jira.adapter.js';
import { MarkdownGitAdapter } from './markdown-git.adapter.js';
import { NotionAdapter } from './notion.adapter.js';
import { TreeSitterService } from './tree-sitter.service.js';

/**
 * The adapters and their registry. No controllers and no auth dependencies, so
 * both the API (Test connection) and the worker (sync runs) can import it.
 *
 * The three AI modules are here for `CodebaseAdapter` alone (docs/features/27).
 * All three are controller-free halves that `AgentWorkerModule` already imports
 * for exactly this reason, so bringing them in does not make this module any
 * less importable by the worker — which is the property the doc comment above
 * is really protecting. What is deliberately still absent is anything that can
 * write: an adapter produces pages, it does not publish them.
 *
 * `TreeSitterService` is exported for exactly one other consumer, the code
 * research tools (docs/features/31), and exporting it does not make a second
 * one: a Nest provider is a singleton per module, and every importer receives
 * this instance. What the export must never become is a second *provider* —
 * a grammar cache constructed twice would be two owners of a wasm heap this
 * one is careful about.
 */
@Module({
  imports: [AiCoreModule, AgentCoreModule, AssistantClientModule],
  providers: [
    ConfluenceAdapter,
    ConfluenceServerAdapter,
    JiraAdapter,
    NotionAdapter,
    MarkdownGitAdapter,
    CodebaseAdapter,
    TreeSitterService,
    ConnectorRegistry,
  ],
  exports: [ConnectorRegistry, TreeSitterService],
})
export class ConnectorAdaptersModule {}
