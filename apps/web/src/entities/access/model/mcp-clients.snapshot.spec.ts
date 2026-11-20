import { describe, expect, it } from 'vitest'
import { SKILL_DIRS } from '@knowledge/contracts'
import {
  captureKitInstallCommand,
  mcpClients,
  skillDirGuides,
  skillInstallCommand,
  skillStackInstallCommand,
} from './mcp-clients'

// Pins every client's text (#1346): recorded on the web copy before the table moved to contracts.
const url = 'https://kb.test/v1/mcp'
const inputs = {
  'auth, no key': { url, serverName: 'knowledge', auth: true, key: null },
  'auth, minted key': { url, serverName: 'kb', auth: true, key: 'kp_minted', anyClientName: 'Любой MCP-клиент' },
  'no auth': { url, serverName: 'knowledge', auth: false, key: null },
}

describe('client table snapshot', () => {
  for (const [label, input] of Object.entries(inputs)) {
    it(`renders every client — ${label}`, () => {
      const clients = mcpClients(input)
      expect(clients).toMatchSnapshot()
      expect(skillDirGuides(clients)).toMatchSnapshot()
    })
  }

  it('renders the install commands', () => {
    const out = [true, false].flatMap((auth) => [
      skillInstallCommand('https://kb.test/v1/mcp/skill', SKILL_DIRS.claude, auth),
      skillStackInstallCommand(url, SKILL_DIRS.agents, auth),
      skillStackInstallCommand(url, '~/.qwen/skills', auth),
      captureKitInstallCommand('https://kb.test/v1/mcp/capture-kit', 'cursor', auth),
    ])
    expect(out).toMatchSnapshot()
  })
})
