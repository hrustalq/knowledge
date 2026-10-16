import type { CaptureKitClient, CaptureKitFile, CaptureKitResponse } from '@knowledge/contracts';

/**
 * The capture kit (issue #73, phase 5): what a coding agent installs in a
 * repository so the session's learnings are offered back to the knowledge base
 * before they disappear.
 *
 * Two halves. The **playbook** says what is worth capturing and how; it is the
 * same text in the generated skill (`renderSkill`'s "Capture memory") and in the
 * kit's own skill or rule. The **hook** is a small POSIX script that asks the
 * model, once per session and only when the session changed files, to review
 * what it learned. It holds no key and calls nothing: the model does the
 * capturing, through the MCP tools it is already connected with.
 *
 * Pure, like skill.ts: the service supplies who is asking, this renders text.
 * The hook contracts are the vendors' as of October 2026 — Claude Code's
 * `Stop` + `hookSpecificOutput.additionalContext`, Cursor's `stop` +
 * `followup_message`. When one changes, bump CAPTURE_KIT_VERSION: an installed
 * kit names its version, and re-fetching is how it updates.
 */
export const CAPTURE_KIT_VERSION = 1;

/** The marker the installer looks for when it merges hook entries — and the script's file name. */
const HOOK_FILE = 'knowledge-capture.sh';

export interface CaptureKitInput {
  client: CaptureKitClient;
  /** The MCP endpoint, `$API_PUBLIC_URL/v1/mcp`; the kit is fetched from beneath it. */
  url: string;
  serverName: string;
  webUrl: string;
  /** Where this caller may capture: a capture key's project pin already applied. */
  workspaces: { workspaceId: string; name: string; projects: { projectId: string; name: string }[] }[];
}

/** The playbook, as a `## Capture memory` section. Shared by the generated skill and the kit. */
export function renderCapturePlaybook(): string {
  return `## Capture memory

What this session learned disappears when it ends unless it is written down. The capture tools propose it back into
the knowledge base: each capture is staged, checked against what the knowledge base already says, and opened as a merge
request a person reviews. Nothing you capture changes a page until someone merges it.

### What is worth capturing

Capture at the end of a piece of work, or when a hook reminds you — not after every edit — and only what the next
person or agent would otherwise have to rediscover:

| Learned | Tool |
| --- | --- |
| A decision, with its reasons and the options ruled out | \`knowledge_capture_decision\` |
| A gotcha: a non-obvious failure and its cause | \`knowledge_capture_note\`, \`kind: "gotcha"\` |
| A convention the team holds | \`knowledge_capture_note\`, \`kind: "convention"\` |
| A how-to that took real digging | \`knowledge_capture_note\`, \`kind: "howto"\` |
| A term the codebase uses in its own sense | \`knowledge_propose_glossary_term\` |
| A dependency a page should record | \`knowledge_propose_relation\` |
| An answer that took many tool calls, citing its pages | \`knowledge_propose_answer\` |

### What is not

- Secrets, credentials, tokens or personal data. A capture carrying one is refused; never rephrase around the check.
- Transient debugging, the steps of this session, or what the diff already shows.
- Anything the knowledge base already says. Call \`knowledge_find_similar\` first and skip what a hit covers.
- Text copied from a page. Point at the page (\`relatedDocumentIds\`) instead.

### How

1. One capture per fact: two decisions are two calls.
2. Write for a reader who was not here. The title is the claim; the body says why.
3. Always pass \`session\`: \`client\` (\`claude-code\`, \`cursor\`, \`codex\`, \`gemini\` or \`other\`), the \`sessionId\` a hook
   gave you, \`repo\` (\`git remote get-url origin\`), \`branch\` (\`git rev-parse --abbrev-ref HEAD\`), \`commit\`
   (\`git rev-parse HEAD\`) and \`files\` — the repository paths involved, paths only, never their contents.
4. Read the reply. \`state: "duplicate"\` means the knowledge base already says it: stop there. Otherwise give the user
   \`webUrl\`, the merge request a person will review.
5. A \`429\` means the capture budget is spent for now. Say so and move on; do not retry in a loop.
`;
}

/** The files to install for `input.client`, paths relative to the repository root. */
export function renderCaptureKit(input: CaptureKitInput): CaptureKitResponse {
  const files = input.client === 'claude-code' ? claudeCodeFiles(input) : cursorFiles(input);
  return { client: input.client, version: CAPTURE_KIT_VERSION, files };
}

/**
 * A POSIX shell script that installs `kit` into the repository it runs in:
 * `curl … /capture-kit/install?client=… | sh`.
 *
 * `write` files are written whole. A `merge` file is a config the person
 * already owns, so it is created only when absent; when present its hook
 * entries are merged in with `jq`, replacing any earlier kit's entries so a
 * re-run updates rather than duplicates, and without `jq` the entries are
 * printed to merge by hand. Nothing is overwritten that the kit did not write.
 */
export function renderCaptureKitInstaller(kit: CaptureKitResponse, kitUrl: string): string {
  const eof = 'KNOWLEDGE_KIT_EOF';
  const body = kit.files.map((file) => {
    // A heredoc ends at the first line equal to its delimiter. Every file is
    // rendered here and no line can be bare `KNOWLEDGE_KIT_EOF`, but a guard
    // is cheaper than an argument about it.
    if (file.content.split('\n').includes(eof)) throw new Error(`capture kit: ${file.path} contains the heredoc delimiter`);
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
    const heredoc = `<<'${eof}'\n${file.content.replace(/\n$/, '')}\n${eof}`;
    if (file.mode === 'write') {
      return [
        `mkdir -p '${dir}'`,
        `cat > '${file.path}' ${heredoc}`,
        ...(file.executable ? [`chmod +x '${file.path}'`] : []),
        `echo "  wrote ${file.path}"`,
      ].join('\n');
    }
    return [
      `entries=$(mktemp)`,
      `cat > "$entries" ${heredoc}`,
      `if [ ! -f '${file.path}' ]; then`,
      `  mkdir -p '${dir}' && cp "$entries" '${file.path}'`,
      `  echo "  wrote ${file.path}"`,
      `elif command -v jq >/dev/null 2>&1; then`,
      `  jq --slurpfile kit "$entries" '(($kit[0] | del(.hooks)) + .) | reduce ($kit[0].hooks | to_entries[]) as $e (.; .hooks[$e.key] = ([(.hooks[$e.key] // [])[] | select(tostring | contains("${HOOK_FILE}") | not)] + $e.value))' '${file.path}' > "$entries.out" \\`,
      `    && mv "$entries.out" '${file.path}' && echo "  merged the hooks into ${file.path}"`,
      `else`,
      `  echo "  ${file.path} exists and jq is not installed. Merge these entries into it by hand:"`,
      `  cat "$entries"`,
      `fi`,
      `rm -f "$entries"`,
    ].join('\n');
  });

  return `#!/bin/sh
# Knowledge capture kit v${kit.version} for ${CLIENT_NAME[kit.client]}.
# Fetched from ${kitUrl}?client=${kit.client}
# Installs into the repository it is run in. Run it again to update.
set -eu
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Run this inside the git repository the agent works in." >&2; exit 1; }
cd "$root"
echo "Installing the knowledge capture kit into $root"

${body.join('\n\n')}

echo "Done. Start a new ${CLIENT_NAME[kit.client]} session to load it."
`;
}

const CLIENT_NAME: Record<CaptureKitClient, string> = { 'claude-code': 'Claude Code', cursor: 'Cursor' };

/* ------------------------------------------------------------------ clients */

function claudeCodeFiles(input: CaptureKitInput): CaptureKitFile[] {
  const run = (arg: string) => ({ type: 'command', command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${HOOK_FILE} ${arg}`, timeout: 5 });
  return [
    {
      path: '.claude/skills/knowledge-capture/SKILL.md',
      content: `---
name: knowledge-capture
description: Use when finishing a piece of work, or when the knowledge-capture hook asks, to record the decisions, gotchas, conventions and hard-won answers from this session in the Knowledge platform at ${hostOf(input.url)} — proposed as merge requests a person reviews, never written straight to a page.
---

${kitSkillBody(input)}`,
      mode: 'write',
      executable: false,
    },
    {
      path: `.claude/hooks/${HOOK_FILE}`,
      content: hookScript(input, 'claude-code'),
      mode: 'write',
      executable: true,
    },
    {
      path: '.claude/settings.json',
      content: json({
        hooks: {
          PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [run('edited')] }],
          Stop: [{ hooks: [run('stop')] }],
        },
      }),
      mode: 'merge',
      executable: false,
    },
  ];
}

function cursorFiles(input: CaptureKitInput): CaptureKitFile[] {
  // Project hooks run from the repository root, so the path is relative.
  const run = (arg: string) => ({ command: `.cursor/hooks/${HOOK_FILE} ${arg}` });
  return [
    {
      // An agent-requested rule: no globs, not always applied — the model
      // pulls it in by its description, or when the hook's follow-up names it.
      path: '.cursor/rules/knowledge-capture.mdc',
      content: `---
description: Record the decisions, gotchas, conventions and hard-won answers from this session in the Knowledge platform at ${hostOf(input.url)}, as merge requests a person reviews. Use when finishing a piece of work or when the knowledge-capture hook asks.
alwaysApply: false
---

${kitSkillBody(input)}`,
      mode: 'write',
      executable: false,
    },
    {
      path: `.cursor/hooks/${HOOK_FILE}`,
      content: hookScript(input, 'cursor'),
      mode: 'write',
      executable: true,
    },
    {
      path: '.cursor/hooks.json',
      content: json({ version: 1, hooks: { afterFileEdit: [run('edited')], stop: [run('stop')] } }),
      mode: 'merge',
      executable: false,
    },
  ];
}

/** The kit's own skill / rule: where to capture, then the playbook. No person's name or email — a team may commit it. */
function kitSkillBody(input: CaptureKitInput): string {
  const where = input.workspaces.length
    ? input.workspaces
        .map(
          (w) =>
            `- ${flat(w.name)} — \`workspaceId: ${w.workspaceId}\`${
              w.projects.length
                ? `\n${w.projects.map((p) => `  - ${flat(p.name)} — \`projectId: ${p.projectId}\``).join('\n')}`
                : ''
            }`,
        )
        .join('\n')
    : '- _No workspace is reachable with this credential._ Ask a workspace admin to add you.';

  return `# Knowledge capture

The capture tools are \`knowledge_*\` tools of the \`${input.serverName}\` MCP server (\`${input.url}\`). If they are not
available, the server is not connected: say so once, and do not improvise with web requests. The
\`knowledge-platform\` skill covers reading and searching the knowledge base.

## Where to capture

Pick the project the work belongs to. \`knowledge_whoami\` is the live answer if this list looks stale.

${where}

Captured merge requests are reviewed at \`${input.webUrl}/merge-requests\`; every capture is listed at
\`${input.webUrl}/captures\`.

${renderCapturePlaybook()}`;
}

/**
 * The hook script, one per client. `edited` marks the session as having
 * changed files; `stop` asks the model to capture — once, and only after a
 * mark. Both read the hook's JSON on stdin and keep their markers outside the
 * repository, so the working tree never shows them.
 *
 * The session id is matched against a closed alphabet before it becomes a
 * file name or lands in the JSON this prints: an id that does not match is
 * treated as no id, and the hook stays silent.
 */
function hookScript(input: CaptureKitInput, client: CaptureKitClient): string {
  const claude = client === 'claude-code';
  const idField = claude ? 'session_id' : 'conversation_id';
  // No double quotes in the reminder: it is printed into a JSON string as is.
  const reminder =
    `Before you finish: this session changed files. If it settled a decision, hit a non-obvious gotcha, followed a team ` +
    `convention or answered a question that took real digging, record each one with the knowledge-capture ${
      claude ? 'skill' : 'rule'
    } (knowledge_capture_decision, knowledge_capture_note) and session.client ${client}, session.sessionId %s. ` +
    `Call knowledge_find_similar first and skip what the knowledge base already says. Never include secrets. ` +
    `If nothing is worth keeping, say so in one line and stop. This reminder comes once per session.`;
  const emit = claude
    ? `printf '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"%s"}}\\n' "$msg"`
    : `printf '{"followup_message":"%s"}\\n' "$msg"`;
  // Cursor runs stop on an aborted or failed turn too; a follow-up then would
  // answer the person's interruption with a chore.
  const completedOnly = claude
    ? ''
    : `    case "$in" in *'"status":"completed"'* | *'"status": "completed"'*) ;; *) exit 0 ;; esac\n`;

  return `#!/bin/sh
# Knowledge capture kit v${CAPTURE_KIT_VERSION} for ${CLIENT_NAME[client]}: generated by ${input.url}/capture-kit.
# Re-fetch it to update — local edits are overwritten.
#
#   ${HOOK_FILE} edited   ${claude ? 'PostToolUse on Edit|Write' : 'afterFileEdit'}: the session changed a file
#   ${HOOK_FILE} stop     ${claude ? 'Stop' : 'stop'}: remind the model to capture, once per session, only after an edit
#
# It holds no key and calls nothing; it only prints a reminder. Hook JSON is on stdin.
in=$(tr -d '\\n\\r')
id=$(printf '%s' "$in" | sed -n 's/.*"${idField}"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9._-]\\{1,200\\}\\)".*/\\1/p')
[ -n "$id" ] || exit 0
dir="\${TMPDIR:-/tmp}/knowledge-capture"
mkdir -p "$dir" 2>/dev/null || exit 0
case "\${1:-}" in
  edited)
    : >"$dir/$id.edited"
    ;;
  stop)
${completedOnly}    [ -f "$dir/$id.edited" ] || exit 0
    # mkdir is atomic: whichever stop gets here first reminds, every later one is silent.
    mkdir "$dir/$id.reminded" 2>/dev/null || exit 0
    msg=$(printf '${reminder}' "$id")
    ${emit}
    ;;
esac
exit 0
`;
}

/* ------------------------------------------------------------------ helpers */

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** One line, no markdown that could break out of a list item. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[`<>]/g, '').trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
