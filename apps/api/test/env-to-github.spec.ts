import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #1113: scripts/env-to-github.mjs files a credential-bearing value as a secret,
// whatever its name. A dry run never calls gh.
const SCRIPT = join(import.meta.dirname, '../../../scripts/env-to-github.mjs');

function kinds(env: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'env-to-github-'));
  const file = join(dir, '.env');
  writeFileSync(file, env);
  const out = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' }).stdout;
  return Object.fromEntries(out.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p[0] === 'secret' || p[0] === 'variable').map(([k, n]) => [n, k]));
}

describe('env-to-github secret classifier', () => {
  it('files the migration owner URL and a password-bearing Redis URL as secrets', () => {
    const got = kinds(
      [
        'DATABASE_OWNER_URL=postgresql://owner:pw@postgres:5432/knowledge',
        'REDIS_URL=redis://:hunter2@redis:6379',
        'OPENSEARCH_URL=https://admin:pw@search:9200',
        'DATABASE_URL=postgresql://app:pw@postgres:5432/knowledge',
      ].join('\n'),
    );
    expect(got).toMatchObject({ DATABASE_OWNER_URL: 'secret', REDIS_URL: 'secret', OPENSEARCH_URL: 'secret', DATABASE_URL: 'secret' });
  });

  it('keeps a plain URL and a plain setting as variables', () => {
    expect(kinds('REDIS_URL=redis://redis:6379\nWEB_BASE_URL=https://knowledge.example.com\nLOG_LEVEL=info')).toMatchObject({
      REDIS_URL: 'variable',
      WEB_BASE_URL: 'variable',
      LOG_LEVEL: 'variable',
    });
  });
});
