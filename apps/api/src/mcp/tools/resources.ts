import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from './context.js';
import { STACK_CORE_SKILL, stackToolsets } from '../skill.js';
import { TOOLSET_SKILLS } from '../skill-sections.js';

/** The skill as a resource and a prompt, and the AI-readable resource templates (#68). */
export function registerResourcesTools(ctx: McpToolContext): void {
  const { server, caller, guard, svc } = ctx;
  // ------------------------------------------------------------ the skill
  // The same SKILL.md the connection page hands out, served where a client
  // that has no skills directory can still reach it: as a resource to read,
  // and as a prompt to invoke (`/mcp__knowledge__guide` in Claude Code).
  server.registerResource(
    'skill',
    'knowledge://skill',
    {
      title: 'Knowledge platform skill',
      description: 'How to use this knowledge base well: the workspaces you can reach, the tools, and the flows.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await ctx.skill() }] }),
  );
  // The stack (#945): the core and each offered toolset's playbook on its own,
  // for a client that reads one resource at a time. Listed only when offered.
  for (const toolset of ['core' as const, ...stackToolsets(ctx.offered)]) {
    const name = toolset === 'core' ? STACK_CORE_SKILL : `knowledge-${toolset}`;
    server.registerResource(
      `skill-${toolset}`,
      `knowledge://skills/${name}`,
      {
        title: toolset === 'core' ? 'Knowledge platform: core skill' : `Knowledge platform: ${TOOLSET_SKILLS[toolset]!.title}`,
        description:
          toolset === 'core'
            ? 'The connection, your workspaces, how to answer from the knowledge base, and the rules. One part of knowledge://skill.'
            : `Use when ${TOOLSET_SKILLS[toolset]!.when}. One part of knowledge://skill.`,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: (await ctx.stack()).find((s) => s.toolset === toolset)?.content ?? '' }],
      }),
    );
  }
  server.registerPrompt(
    'guide',
    {
      title: 'Knowledge platform guide',
      description: 'Load the knowledge-platform skill into the conversation before working with this knowledge base.',
    },
    async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: await ctx.skill() } }],
    }),
  );

  // ------------------------------------------------- AI-readable (#68)
  // The /markdown and llms.txt representations as resource templates. Reads,
  // not tools, so WRITE_TOOLS is untouched. Each read goes through
  // AiReadableService — the REST code path — so the text is byte-identical,
  // and each starts with the same guard as the REST route's @Access.
  // AI_READABLE_ENABLED=false: the templates are simply not offered.
  // No llms-full resource: too large for one read; use search + page reads.
  if (svc.aiReadable.enabled()) {
    server.registerResource(
      'document-markdown',
      new ResourceTemplate('knowledge://documents/{documentId}.md', { list: undefined }),
      {
        title: 'Page as markdown',
        description: 'One page (default-branch head) as plain markdown — the same text as GET /v1/documents/:id/markdown.',
        mimeType: 'text/markdown',
      },
      async (uri, { documentId }) => {
        const id = String(documentId);
        await guard.doc(id, 'viewer');
        const result = await svc.aiReadable.pageMarkdown(id, { frontmatter: false });
        if (result.status === 200) void svc.analytics.view(caller, id);
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: result.status === 200 ? result.body : '' }] };
      },
    );
    server.registerResource(
      'workspace-llms-txt',
      new ResourceTemplate('knowledge://workspaces/{workspaceId}/llms.txt', { list: undefined }),
      {
        title: 'Workspace llms.txt',
        description: 'llms.txt index of a workspace: a section per project, pages in tree order.',
        mimeType: 'text/plain',
      },
      async (uri, { workspaceId }) => {
        const id = String(workspaceId);
        await guard.ws(id, 'viewer');
        const result = await svc.aiReadable.workspaceIndex(id);
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: result.status === 200 ? result.body : '' }] };
      },
    );
    server.registerResource(
      'project-llms-txt',
      new ResourceTemplate('knowledge://projects/{projectId}/llms.txt', { list: undefined }),
      {
        title: 'Project llms.txt',
        description: 'llms.txt index of one project, pages in tree order.',
        mimeType: 'text/plain',
      },
      async (uri, { projectId }) => {
        const id = String(projectId);
        await guard.project(id, 'viewer');
        const result = await svc.aiReadable.projectIndex(id);
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: result.status === 200 ? result.body : '' }] };
      },
    );
  }
}
