import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureKitClient } from '@knowledge/contracts';
import { CAPTURE_KIT_VERSION, TICKET_TOOL_MATCHER, renderCaptureKit, renderCaptureKitInstaller, type CaptureKitInput } from './capture-kit.js';

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

const input = (client: CaptureKitClient): CaptureKitInput => ({
  client,
  url: 'https://kb.example.com/api/v1/mcp',
  serverName: 'knowledge',
  webUrl: 'https://kb.example.com',
  workspaces: [{ workspaceId: WS, name: 'Eng `ops`\n team', projects: [{ projectId: PROJECT, name: 'Billing' }] }],
});

const fileOf = (client: CaptureKitClient, suffix: string) => {
  const file = renderCaptureKit(input(client)).files.find((f) => f.path.endsWith(suffix));
  if (!file) throw new Error(`no ${suffix} in the ${client} kit`);
  return file;
};

const hasJq = spawnSync('sh', ['-c', 'command -v jq']).status === 0;

describe('renderCaptureKit', () => {
  it.each(['claude-code', 'cursor'] as const)('renders the %s kit', (client) => {
    const kit = renderCaptureKit(input(client));
    expect(kit.version).toBe(CAPTURE_KIT_VERSION);
    expect(kit.files.map((f) => [f.path, f.mode, f.executable])).toMatchSnapshot();
    for (const file of kit.files) expect(file.content).toMatchSnapshot(file.path);
  });

  it('names where to capture, flattened, and no person', () => {
    const skill = fileOf('claude-code', 'SKILL.md').content;
    expect(skill.startsWith('---\nname: knowledge-capture\ndescription: ')).toBe(true);
    expect(skill).toContain(`- Eng ops team — \`workspaceId: ${WS}\``);
    expect(skill).toContain(`  - Billing — \`projectId: ${PROJECT}\``);
    expect(skill).toContain('## Capture memory');
    expect(skill).not.toContain('@');
  });

  it('gives each client hook entries that are valid JSON and point at the script', () => {
    const claude = JSON.parse(fileOf('claude-code', 'settings.json').content);
    expect(claude.hooks.Stop[0].hooks[0].command).toBe('"$CLAUDE_PROJECT_DIR"/.claude/hooks/knowledge-capture.sh stop');
    expect(claude.hooks.PostToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(claude.hooks.PostToolUse[1].hooks[0].command).toBe('"$CLAUDE_PROJECT_DIR"/.claude/hooks/knowledge-capture.sh ticket');
    expect(claude.hooks.UserPromptSubmit[0].hooks[0].command).toBe('"$CLAUDE_PROJECT_DIR"/.claude/hooks/knowledge-capture.sh ticket-prompt');
    const cursor = JSON.parse(fileOf('cursor', 'hooks.json').content);
    expect(cursor).toEqual({
      version: 1,
      hooks: {
        afterFileEdit: [{ command: '.cursor/hooks/knowledge-capture.sh edited' }],
        postToolUse: [{ command: '.cursor/hooks/knowledge-capture.sh ticket' }],
        stop: [{ command: '.cursor/hooks/knowledge-capture.sh stop' }],
      },
    });
  });

  it('matches the tools that read tickets, not the ones that edit code', () => {
    const re = new RegExp(`^(?:${TICKET_TOOL_MATCHER})$`);
    for (const tool of ['Bash', 'mcp__atlassian__getJiraIssue', 'mcp__linear__get_issue', 'mcp__github__issue_read']) expect(re.test(tool)).toBe(true);
    for (const tool of ['Edit', 'Read', 'mcp__knowledge__knowledge_search']) expect(re.test(tool)).toBe(false);
  });

  it('holds no key and makes no network call', () => {
    for (const client of ['claude-code', 'cursor'] as const) {
      const script = fileOf(client, 'knowledge-capture.sh').content;
      expect(script).not.toMatch(/\b(curl|wget|nc)\b|Authorization|kn_/);
    }
  });
});

describe('the hook script', () => {
  let tmp: string;
  let script: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kn-hook-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const install = (client: CaptureKitClient) => {
    script = join(tmp, 'knowledge-capture.sh');
    writeFileSync(script, fileOf(client, 'knowledge-capture.sh').content);
  };
  // `sh`, not bash: the script must stay POSIX.
  const run = (arg: string, stdin: unknown) =>
    execFileSync('sh', [script, arg], {
      input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
      env: { PATH: process.env.PATH, TMPDIR: tmp },
    }).toString();

  it('is silent for a Claude Code session that made no edits', () => {
    install('claude-code');
    expect(run('stop', { session_id: 's-1', hook_event_name: 'Stop', stop_hook_active: false })).toBe('');
  });

  it('reminds a Claude Code session once, after an edit, naming its session id', () => {
    install('claude-code');
    expect(run('edited', { session_id: 's-1', tool_name: 'Edit' })).toBe('');
    const out = run('stop', { session_id: 's-1', last_assistant_message: 'done "session_id": "evil"' });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('session.sessionId s-1');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('session.client claude-code');
    expect(run('stop', { session_id: 's-1' })).toBe('');
    // A second session keeps its own count.
    run('edited', { session_id: 's-2' });
    expect(JSON.parse(run('stop', { session_id: 's-2' })).hookSpecificOutput.additionalContext).toContain('s-2');
  });

  it('reads pretty-printed JSON and stays silent for an id it would not trust as a file name', () => {
    install('claude-code');
    run('edited', JSON.stringify({ session_id: 's-3' }, null, 2));
    expect(run('stop', JSON.stringify({ session_id: 's-3' }, null, 2))).not.toBe('');
    expect(run('edited', { session_id: '../x' })).toBe('');
    expect(run('stop', { session_id: '../x' })).toBe('');
    expect(run('stop', 'not json')).toBe('');
  });

  const nudged = (out: string) => (out ? (JSON.parse(out).hookSpecificOutput?.additionalContext ?? JSON.parse(out).additional_context) : '');
  const bash = (session: string, command: string, response = '') => ({ session_id: session, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: response } });

  it('nudges knowledge_context once per ticket a Claude Code session reads', () => {
    install('claude-code');
    const first = JSON.parse(run('ticket', bash('s-1', 'gh issue view 123 --repo org/repo')));
    expect(first.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(first.hookSpecificOutput.additionalContext).toMatch(/^Ticket 123: .*knowledge_context/);
    expect(run('ticket', bash('s-1', 'gh issue view 123'))).toBe('');
    expect(nudged(run('ticket', bash('s-1', 'gh issue view https://github.com/org/repo/issues/124')))).toContain('Ticket 124');
    expect(run('ticket', bash('s-1', 'ls -la', 'see ABC-1 and https://x.atlassian.net/browse/ABC-2'))).toBe('');
    // Another session starts its own count.
    expect(nudged(run('ticket', bash('s-2', 'gh issue view 123')))).toContain('Ticket 123');
  });

  it('nudges for every ticket a chained command reads (#1340)', () => {
    install('claude-code');
    expect(nudged(run('ticket', bash('s-1', 'gh issue view 128')))).toContain('Ticket 128');
    expect(nudged(run('ticket', bash('s-1', 'gh issue view 128; echo ---; gh issue view 131')))).toMatch(/^Ticket 131: /);
    expect(nudged(run('ticket', bash('s-1', 'gh issue view 140 && glab issue view 141 | head')))).toMatch(/^Ticket 140, 141: /);
    expect(nudged(run('ticket', bash('s-1', 'gh issue view 150\ngh issue view https://github.com/o/r/issues/151')))).toMatch(/^Ticket 150, 151: /);
    expect(run('ticket', bash('s-1', 'gh issue view 131 || gh issue view 141'))).toBe('');
  });

  it('reads a tracker MCP tool’s input, never its output', () => {
    install('claude-code');
    const call = { session_id: 's-1', tool_name: 'mcp__atlassian__getJiraIssue', tool_response: { text: 'blocks OTHER-9' }, tool_input: { issueIdOrKey: 'PROJ-7' } };
    expect(nudged(run('ticket', call))).toContain('Ticket PROJ-7');
    const github = { session_id: 's-1', tool_name: 'mcp__github__issue_read', tool_input: { owner: 'o', repo: 'r', issue_number: 42 } };
    expect(nudged(run('ticket', github))).toContain('Ticket 42');
    expect(run('ticket', { session_id: 's-1', tool_name: 'mcp__atlassian__search', tool_response: { text: 'ABC-1' } })).toBe('');
  });

  it('nudges for a prompt that names a ticket, and not for one that names a standard', () => {
    install('claude-code');
    const prompt = (text: string) => ({ session_id: 's-1', cwd: '/work/ZZZ-9-branch', hook_event_name: 'UserPromptSubmit', prompt: text });
    expect(run('ticket-prompt', prompt('make the parser UTF-8 and ISO-8601 safe'))).toBe('');
    const out = JSON.parse(run('ticket-prompt', prompt('pick up https://acme.atlassian.net/browse/PAY-311 please')));
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('Ticket PAY-311');
    // The same ticket read later through a tool is already handled.
    expect(run('ticket', bash('s-1', 'jira issue view PAY-311'))).toBe('');
    expect(nudged(run('ticket-prompt', prompt('and org/repo#77 too')))).toContain('Ticket 77');
  });

  it('nudges a Cursor agent after a ticket read, as additional context', () => {
    install('cursor');
    const shell = { conversation_id: 'c-1', tool_name: 'Shell', tool_input: { command: 'gh issue view https://github.com/o/r/issues/5' }, tool_output: '{"stdout":"LIN-3"}' };
    expect(JSON.parse(run('ticket', shell)).additional_context).toContain('Ticket 5');
    expect(run('ticket', shell)).toBe('');
    expect(run('ticket', { conversation_id: 'c-1', tool_name: 'Read', tool_input: { path: 'ENG-1.md' } })).toBe('');
  });

  it('follows up a completed Cursor turn once, and never an aborted one', () => {
    install('cursor');
    run('edited', { conversation_id: 'c-1', file_path: '/repo/a.ts' });
    expect(run('stop', { conversation_id: 'c-1', status: 'aborted', loop_count: 0 })).toBe('');
    const out = JSON.parse(run('stop', { conversation_id: 'c-1', status: 'completed', loop_count: 0 }));
    expect(out.followup_message).toContain('session.client cursor, session.sessionId c-1');
    expect(run('stop', { conversation_id: 'c-1', status: 'completed', loop_count: 1 })).toBe('');
  });
});

describe('renderCaptureKitInstaller', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kn-kit-'));
    execFileSync('git', ['init', '-q', repo]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const installer = (client: CaptureKitClient) =>
    renderCaptureKitInstaller(renderCaptureKit(input(client)), 'https://kb.example.com/api/v1/mcp/capture-kit/install');
  const runIn = (cwd: string, script: string) => execFileSync('sh', ['-s'], { cwd, input: script }).toString();

  it('installs the Claude Code kit into a fresh repository from any directory in it', () => {
    mkdirSync(join(repo, 'src'));
    const out = runIn(join(repo, 'src'), installer('claude-code'));
    expect(out).toContain('wrote .claude/settings.json');
    expect(readFileSync(join(repo, '.claude/skills/knowledge-capture/SKILL.md'), 'utf8')).toBe(
      fileOf('claude-code', 'SKILL.md').content,
    );
    expect(statSync(join(repo, '.claude/hooks/knowledge-capture.sh')).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8')).hooks.Stop).toHaveLength(1);
  });

  it.runIf(hasJq)('merges into existing settings, keeps the person’s own entries, and does not duplicate on a re-run', () => {
    mkdirSync(join(repo, '.claude'));
    const own = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
    writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify(own));
    runIn(repo, installer('claude-code'));
    runIn(repo, installer('claude-code'));
    const merged = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
    expect(merged.permissions).toEqual(own.permissions);
    expect(merged.hooks.Stop.map((e: { hooks: { command: string }[] }) => e.hooks[0].command)).toEqual([
      'say done',
      '"$CLAUDE_PROJECT_DIR"/.claude/hooks/knowledge-capture.sh stop',
    ]);
    expect(merged.hooks.PostToolUse.map((e: { hooks: { command: string }[] }) => e.hooks[0].command.split(' ').pop())).toEqual(['edited', 'ticket']);
    expect(merged.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it.runIf(hasJq)('merges Cursor hooks and keeps the file’s version', () => {
    mkdirSync(join(repo, '.cursor'));
    writeFileSync(join(repo, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'fmt.sh' }] } }));
    runIn(repo, installer('cursor'));
    const merged = JSON.parse(readFileSync(join(repo, '.cursor/hooks.json'), 'utf8'));
    expect(merged.version).toBe(1);
    expect(merged.hooks.afterFileEdit.map((e: { command: string }) => e.command)).toEqual([
      'fmt.sh',
      '.cursor/hooks/knowledge-capture.sh edited',
    ]);
    expect(merged.hooks.stop).toHaveLength(1);
    expect(merged.hooks.postToolUse).toHaveLength(1);
  });

  it('tells a Cursor user what the hook cannot cover', () => {
    expect(installer('cursor')).toContain('cannot add context to a prompt');
    expect(installer('claude-code')).not.toContain('cannot add context');
  });

  it('refuses to run outside a git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'kn-nogit-'));
    try {
      const res = spawnSync('sh', ['-s'], { cwd: outside, input: installer('cursor') });
      expect(res.status).toBe(1);
      expect(res.stderr.toString()).toContain('inside the git repository');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
