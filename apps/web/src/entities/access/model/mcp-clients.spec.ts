import { describe, expect, it } from 'vitest'
import { SKILL_DIRS } from '@knowledge/contracts'
import { mcpClients, skillDirGuides, skillStackInstallCommand } from './mcp-clients'

describe('skill directories', () => {
  const guides = skillDirGuides(mcpClients({ url: 'https://kb.test/v1/mcp', serverName: 'knowledge', auth: true, key: null }))
  const of = (dir: string) => guides.find((g) => g.dir === dir)

  it('groups every client with a skills directory, once', () => {
    expect(new Set(guides.map((g) => g.dir)).size).toBe(guides.length)
    expect(of(SKILL_DIRS.claude)?.clients).toEqual(['Claude Code'])
    expect(of(SKILL_DIRS.agents)?.clients).toContain('Codex')
    expect(guides.flatMap((g) => g.clients)).not.toContain('Claude Desktop')
  })

  it('offers a capture kit only where a client has one', () => {
    expect(of(SKILL_DIRS.claude)?.kits).toEqual([{ client: 'claude-code', name: 'Claude Code' }])
    expect(of(SKILL_DIRS.agents)?.kits).toEqual([{ client: 'cursor', name: 'Cursor' }])
    expect(of('~/.qwen/skills')?.kits).toEqual([])
  })

  it('has a stack only for a directory the server installs into', () => {
    expect(skillStackInstallCommand('u', SKILL_DIRS.agents, true)).toContain('/skills/install?dir=agents')
    expect(skillStackInstallCommand('u', '~/.qwen/skills', true)).toBeNull()
  })
})
