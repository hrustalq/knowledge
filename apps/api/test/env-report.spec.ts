import { describe, expect, it } from 'vitest';
import { envSchema, providedEnvKeys, validateEnv } from '../src/config/env.js';
import { CREDENTIAL_NAME, envGroupOf, envReport, NOT_SECRET_ENV_KEYS, SECRET_ENV_KEYS } from '../src/config/env-report.js';

const KEYS = Object.keys(envSchema.shape);
const REQUIRED = {
  DATABASE_URL: 'postgresql://knowledge:hunter2@db:5432/knowledge',
  REDIS_URL: 'redis://:hunter2@redis:6379',
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'AKIA-hunter2',
  S3_SECRET_KEY: 'hunter2',
  S3_BUCKET: 'knowledge',
  ARCADE_URL: 'http://root:hunter2@arcadedb:2480',
  ARCADE_DB: 'knowledge',
  ARCADE_USER: 'root',
  ARCADE_PASSWORD: 'hunter2',
};

describe('env report (#1237)', () => {
  it('classifies every key whose name looks like a credential', () => {
    const unclassified = KEYS.filter((k) => CREDENTIAL_NAME.test(k) && !SECRET_ENV_KEYS.has(k) && !NOT_SECRET_ENV_KEYS.has(k));
    expect(unclassified).toEqual([]);
    // Both lists name real keys, and never the same one.
    for (const k of [...SECRET_ENV_KEYS, ...NOT_SECRET_ENV_KEYS]) expect(KEYS).toContain(k);
    expect([...SECRET_ENV_KEYS].filter((k) => NOT_SECRET_ENV_KEYS.has(k))).toEqual([]);
  });

  it('never returns a secret, nor a URL credential under any key', () => {
    const env = validateEnv({ ...REQUIRED, OPENSEARCH_URL: 'https://admin:hunter2@search:9200', ASSISTANT_API_KEY: 'sk-hunter2' });
    const report = envReport(env, providedEnvKeys());
    expect(report.map((e) => e.key)).toEqual(KEYS);
    expect(JSON.stringify(report)).not.toContain('hunter2');
    const byKey = new Map(report.map((e) => [e.key, e]));
    expect(byKey.get('ASSISTANT_API_KEY')).toMatchObject({ secret: true, set: true, value: null });
    expect(byKey.get('EMBEDDINGS_API_KEY')).toMatchObject({ secret: true, set: false, value: null });
    expect(byKey.get('OPENSEARCH_URL')?.value).toBe('https://search:9200/');
    expect(byKey.get('ARCADE_URL')?.value).toBe('http://arcadedb:2480/');
  });

  it('says env for a key the environment set and default for one it did not', () => {
    const env = validateEnv({ ...REQUIRED, PORT: '4000', LOG_LEVEL: undefined });
    const byKey = new Map(envReport(env, providedEnvKeys()).map((e) => [e.key, e]));
    expect(byKey.get('PORT')).toMatchObject({ source: 'env', value: 4000 });
    expect(byKey.get('HTTP_BODY_LIMIT')).toMatchObject({ source: 'default', value: '2mb' });
    expect(byKey.get('LOG_LEVEL')?.source).toBe('default');
  });

  it('files keys by their longest prefix', () => {
    expect(envGroupOf('AI_READABLE_ENABLED')).toBe('publishing');
    expect(envGroupOf('AI_PLUGINS_ALLOW_PRIVATE_URLS')).toBe('ai');
    expect(envGroupOf('WEB_SOURCES_ENABLED')).toBe('connectors');
    expect(KEYS.filter((k) => envGroupOf(k) === 'other')).toEqual([]);
  });
});
