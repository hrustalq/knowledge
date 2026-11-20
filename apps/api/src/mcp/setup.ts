import { KEY_ENV, SKILL_NAME, type McpClientGuide, type ProjectConfig } from '@knowledge/contracts';
import { PUT_FN } from './installer-shell.js';

/**
 * One setup command (#1347): `curl … /setup/install?client=… | sh` registers
 * the MCP server with one client, installs the skill and, inside a git
 * repository, the capture kit. It composes the two installers the API already
 * renders (each runs in its own subshell, unchanged) and adds the register
 * step from the contracts client table.
 *
 * A vendor CLI is run only where this file knows how to ask it whether the
 * server is already there; every other client gets its command or config
 * printed. The script never edits a config file it did not write, never
 * prints the key, and is safe to run again.
 *
 * Pure, like skill.ts: the service decides what the caller gets.
 */
export interface SetupInput {
  /** The client's table entry, rendered with no key: a config that cannot read env shows a placeholder. */
  client: McpClientGuide;
  url: string;
  serverName: string;
  auth: boolean;
  /** The skill-stack installer, for a skills directory the server has a stack for. */
  skillStack: string | null;
  /** The one SKILL.md, for any other skills directory. */
  skill: string | null;
  /** The capture-kit installer and the files it writes, or why there is no kit step. */
  kit: { installer: string; files: string[] } | { skipped: 'no-kit' | 'not-offered' | 'declined' };
  /** `scope=project` (#1348): the client's committable config, written into the repository instead of registering per user. */
  project: ProjectConfig | null;
  sourceUrl: string;
}

/**
 * The clients whose CLI the script runs, each with how to ask it whether a
 * server of that name is already registered. Without a reliable check a re-run
 * would fail or add a duplicate, so every other CLI is printed instead.
 */
function registerCheck(client: McpClientGuide, name: string, url: string): { bin: string; same: string; any: string } | null {
  if (client.id !== 'claude-code') return null;
  // `get` prints the headers it stores: it goes to grep or /dev/null, never to the terminal.
  return {
    bin: 'claude',
    same: `claude mcp get ${name} </dev/null 2>/dev/null | grep -qF 'URL: ${url}'`,
    any: `claude mcp get ${name} </dev/null >/dev/null 2>&1`,
  };
}

const EOF = 'KNOWLEDGE_SETUP_EOF';

function heredoc(content: string): string {
  if (content.split('\n').includes(EOF)) throw new Error('setup: content contains the heredoc delimiter');
  return `<<'${EOF}'\n${content.replace(/\n$/, '')}\n${EOF}`;
}

function registerStep(input: SetupInput): string {
  const { client, serverName: name, url, auth } = input;
  const check = client.command ? registerCheck(client, name, url) : null;
  const placeholder = auth && !client.usesEnv && client.id !== 'vscode';
  const printConfig = [
    `echo "  Add this to ${client.config.path}:"`,
    `echo`,
    `cat ${heredoc(client.config.code)}`,
    `echo`,
    ...(placeholder ? [`echo "  Replace <your-api-key> with your key: ${client.name} cannot read it from ${KEY_ENV}."`] : []),
  ];
  if (!client.command) return printConfig.join('\n');
  const printCommand = [`echo`, `cat ${heredoc(client.command)}`, `echo`];
  if (!check) {
    return [`echo "  Run this to register it (this script does not run it: it cannot tell whether the server is already there):"`, ...printCommand].join('\n');
  }
  return [
    `if ! command -v ${check.bin} >/dev/null 2>&1; then`,
    `  echo "  ${check.bin} is not on PATH. Run this script where it is, or register the server with:"`,
    ...printCommand.map((l) => `  ${l}`),
    `elif ${check.same}; then`,
    `  echo "  unchanged: ${name} is already registered with ${client.name}"`,
    `elif ${check.any}; then`,
    `  echo "  left as it is: a server named ${name} is already registered with another URL. Remove it (${check.bin} mcp remove ${name}) and run this again to replace it."`,
    `else`,
    `  ${client.command} </dev/null`,
    `  echo "  registered ${name} with ${client.name}"`,
    `fi`,
  ].join('\n');
}

/**
 * Write the client's project config at the repository root (#1348). The
 * capture kit's rule: create it when absent; when present, merge with `jq`
 * (every other server and setting kept, this server's entry replaced whole),
 * and print the entry to merge by hand when `jq` is missing or the file is not
 * JSON. The content holds an env reference, never a key.
 */
function projectStep(project: ProjectConfig): string {
  const dir = project.path.includes('/') ? project.path.slice(0, project.path.lastIndexOf('/')) : '.';
  const merge =
    'reduce ($cfg[0] | to_entries[]) as $e (.; .[$e.key] = (if ($e.value | type) == "object" and ((.[$e.key] // {}) | type) == "object" then (.[$e.key] // {}) + $e.value else (.[$e.key] // $e.value) end))';
  return [
    `cfg=$(mktemp)`,
    `cat > "$cfg" ${heredoc(project.code)}`,
    `if [ ! -f '${project.path}' ]; then`,
    `  mkdir -p '${dir}' && put '${project.path}' '${project.path}' < "$cfg"`,
    `elif command -v jq >/dev/null 2>&1 && jq --slurpfile cfg "$cfg" '${merge}' '${project.path}' > "$cfg.out" 2>/dev/null; then`,
    `  put '${project.path}' 'the server in ${project.path}' < "$cfg.out"`,
    `else`,
    `  echo "  ${project.path} exists and could not be merged (jq is missing or the file is not JSON). Merge this into it by hand:"`,
    `  cat "$cfg"`,
    `fi`,
    `rm -f "$cfg" "$cfg.out"`,
  ].join('\n');
}

function skillStep(input: SetupInput): string {
  if (input.skillStack) return `(\n${input.skillStack.replace(/\n$/, '')}\n)`;
  if (input.skill && input.client.skillDir) {
    return [
      `dir="\${KNOWLEDGE_SKILLS_DIR:-${input.client.skillDir.replace(/^~/, '$HOME')}}/${SKILL_NAME}"`,
      `mkdir -p "$dir"`,
      `put "$dir/SKILL.md" "$dir/SKILL.md" ${heredoc(input.skill)}`,
    ].join('\n');
  }
  return `echo "  skipped: ${input.client.name} reads no skills directory. It gets the same playbooks from the server's guide prompt."`;
}

function kitStep(input: SetupInput): string {
  if ('installer' in input.kit) {
    return [
      `if git rev-parse --show-toplevel >/dev/null 2>&1; then`,
      `(\n${input.kit.installer.replace(/\n$/, '')}\n)`,
      `else`,
      `  echo "  skipped: not inside a git repository. Run this again from the repository the agent works in to add it."`,
      `fi`,
    ].join('\n');
  }
  const why = {
    'no-kit': `${input.client.name} has no capture kit; it captures through the skill`,
    'not-offered': 'this key is offered no capture tool',
    declined: 'asked for without it (kit=no)',
  }[input.kit.skipped];
  return `echo "  skipped: ${why}."`;
}

export function renderSetupInstaller(input: SetupInput): string {
  const { client, project } = input;
  const commit = project ? [project.path, ...('files' in input.kit ? input.kit.files : [])] : [];
  return `#!/bin/sh
# Knowledge setup for ${client.name}: ${project ? `writes the ${input.serverName} MCP server into ${project.path} for the repository` : `registers the ${input.serverName} MCP server`}, installs the skill and the capture kit.
# Fetched from ${input.sourceUrl}
# Run it again to update: it replaces only what it wrote, and it never prints the key.
set -eu
set +x

# The whole script is read before anything runs, so a step that reads stdin cannot eat the rest of it.
main() {
${
  input.auth
    ? `if [ -z "\${${KEY_ENV}:-}" ]; then
  echo "${KEY_ENV} is empty. Run: export ${KEY_ENV}=<your-api-key> and then this command again." >&2
  exit 1
fi
`
    : ''
}${
  project
    ? `root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Run this inside the git repository the project config belongs to." >&2; exit 1; }
cd "$root"
`
    : ''
}${PUT_FN}

${
  project
    ? `echo "1/3 The MCP server for everyone who clones $root"
${projectStep(project)}

echo "2/3 The skill, for you only"
echo "  It is generated for your key (your workspaces, your tools), so it is not committed. Each teammate runs this command once for theirs."`
    : `echo "1/3 Registering the MCP server with ${client.name}"
${registerStep(input)}

echo "2/3 The skill"`
}
${skillStep(input)}

echo "3/3 The capture kit"
${kitStep(input)}

${
  project
    ? `echo "Setup done. Commit these files (they hold no key):"
for f in ${commit.map((f) => `'${f}'`).join(' ')}; do [ -e "$f" ] && echo "  $f"; done
echo "Each teammate exports ${KEY_ENV} with their own key. ${client.name} may ask to approve or trust the project's server the first time."`
    : `echo "Setup done. Start a new ${client.name} session and ask it to call knowledge_whoami."`
}
}

main
`;
}
