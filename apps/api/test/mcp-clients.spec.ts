import { describe, expect, it } from 'vitest';
import {
  SKILL_DIRS,
  captureKitInstallCommand,
  mcpClients,
  skillDirGuides,
  skillInstallCommand,
  skillStackInstallCommand,
} from '@knowledge/contracts';

// The client table (#1346). The snapshot was recorded on the web copy before the
// table moved to contracts, so a pass here means the move changed no snippet.
const url = 'https://kb.test/v1/mcp';
const inputs = {
  'auth, no key': { url, serverName: 'knowledge', auth: true, key: null },
  'auth, minted key': { url, serverName: 'kb', auth: true, key: 'kp_minted', anyClientName: 'Любой MCP-клиент' },
  'no auth': { url, serverName: 'knowledge', auth: false, key: null },
};

describe('client table snapshot', () => {
  for (const [label, input] of Object.entries(inputs)) {
    it(`renders every client — ${label}`, () => {
      const clients = mcpClients(input);
      expect(clients).toMatchSnapshot();
      expect(skillDirGuides(clients)).toMatchSnapshot();
    });
  }

  it('renders the install commands', () => {
    const out = [true, false].flatMap((auth) => [
      skillInstallCommand('https://kb.test/v1/mcp/skill', SKILL_DIRS.claude, auth),
      skillStackInstallCommand(url, SKILL_DIRS.agents, auth),
      skillStackInstallCommand(url, '~/.qwen/skills', auth),
      captureKitInstallCommand('https://kb.test/v1/mcp/capture-kit', 'cursor', auth),
    ]);
    expect(out).toMatchSnapshot();
  });
});

describe('skill directories', () => {
  const guides = skillDirGuides(mcpClients({ url, serverName: 'knowledge', auth: true, key: null }));
  const of = (dir: string) => guides.find((g) => g.dir === dir);

  it('groups every client with a skills directory, once', () => {
    expect(new Set(guides.map((g) => g.dir)).size).toBe(guides.length);
    expect(of(SKILL_DIRS.claude)?.clients).toEqual(['Claude Code']);
    expect(of(SKILL_DIRS.agents)?.clients).toContain('Codex');
    expect(guides.flatMap((g) => g.clients)).not.toContain('Claude Desktop');
  });

  it('offers a capture kit only where a client has one', () => {
    expect(of(SKILL_DIRS.claude)?.kits).toEqual([{ client: 'claude-code', name: 'Claude Code' }]);
    expect(of(SKILL_DIRS.agents)?.kits).toEqual([{ client: 'cursor', name: 'Cursor' }]);
    expect(of('~/.qwen/skills')?.kits).toEqual([]);
  });

  it('has a stack only for a directory the server installs into', () => {
    expect(skillStackInstallCommand('u', SKILL_DIRS.agents, true)).toContain('/skills/install?dir=agents');
    expect(skillStackInstallCommand('u', '~/.qwen/skills', true)).toBeNull();
  });
});
