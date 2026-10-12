// Fill the GitHub `production` environment from .env files (#134).
// deploy.yml renders the box's .env from that environment on every deploy, so this is
// how an existing .env (or a batch of new keys) gets into it. Later files win; `-` is
// stdin. Empty values and CHANGE_ME placeholders are skipped, so the template can go
// first and fill only what the real file lacks. Dry run unless --apply:
//
//   ssh macmini 'cat ~/Homelab/infra/knowledge/.env' |
//     node scripts/env-to-github.mjs .env.production.example - [--apply]
//
// Credential-shaped names become secrets, the rest variables. Prints names, never values.
// GitHub refuses names starting GITHUB_, so those are stored as GH_* — deploy.yml renames
// them back (#138).
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const REPO = 'hrustalq/knowledge';
const ENVIRONMENT = 'production';
const SECRET = /PASSWORD|SECRET|TOKEN|_KEY$|DATABASE_URL|SMTP_URL/;
const TEMPLATE = new URL('../.env.production.example', import.meta.url);

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const files = args.filter((a) => a !== '--apply');
if (files.length === 0) {
  console.error('Usage: node scripts/env-to-github.mjs [--apply] <file|-> [...]');
  process.exit(1);
}

function parse(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length > 1 && value.endsWith(q)) value = value.slice(1, -1);
    out.set(m[1].toUpperCase(), value);
  }
  return out;
}

const merged = new Map(); // key -> { value, from }
for (const file of files) {
  for (const [key, value] of parse(readFileSync(file === '-' ? 0 : file, 'utf8'))) {
    if (!value || value.includes('CHANGE_ME')) continue;
    merged.set(key, { value, from: file === '-' ? 'stdin' : file });
  }
}

let failed = false;
for (const [key, { value, from }] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
  if (/[\r\n']/.test(value)) {
    console.error(`✖ ${key}: a newline or single quote cannot be rendered into .env`);
    failed = true;
    continue;
  }
  const kind = SECRET.test(key) ? 'secret' : 'variable';
  const name = key.replace(/^GITHUB_/, 'GH_');
  const shown = name === key ? key : `${key} -> ${name}`;
  console.log(`${kind.padEnd(8)}  ${shown.padEnd(32)}  ${from}`);
  if (!apply) continue;
  const scope = ['--env', ENVIRONMENT, '--repo', REPO];
  const res =
    kind === 'secret'
      ? spawnSync('gh', ['secret', 'set', name, ...scope], { input: value, stdio: ['pipe', 'ignore', 'inherit'] })
      : spawnSync('gh', ['variable', 'set', name, ...scope, '--body', value], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (res.status !== 0) failed = true;
}

// The same rule deploy.yml enforces: a key the template gives a value to is required.
const missing = [...parse(readFileSync(TEMPLATE, 'utf8'))]
  .filter(([key, value]) => value && !merged.has(key))
  .map(([key]) => key);
if (missing.length) {
  console.error(`\n✖ required by .env.production.example but not provided: ${missing.join(', ')}`);
  console.error(`  add them to an input file, or: gh secret|variable set <NAME> --env ${ENVIRONMENT} --repo ${REPO}`);
  failed = true;
}
console.log(apply ? '\napplied' : '\ndry run — nothing changed; pass --apply to set these');
process.exit(failed ? 1 : 0);
