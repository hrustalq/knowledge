import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { I18nJsonLoader, I18nModule } from 'nestjs-i18n';
import OpenAI from 'openai';

/**
 * A provider refusing the account (402 out of credit, 401/403 bad key) must
 * say so, and must be distinguishable from a flaky request: agent passes stop
 * at the first one instead of failing every page the same way (#110).
 */

const SRC = join(import.meta.dirname, '../src');
const { withLocale, I18nRegistry } = await import('../src/i18n/t.js');
const { AssistantClient, ProviderAccountError } = await import('../src/assistant/assistant.client.js');

describe('AssistantClient upstream error mapping', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      I18nModule.forRoot({
        fallbackLanguage: 'en',
        loader: I18nJsonLoader,
        loaderOptions: { path: join(SRC, 'i18n'), watch: false },
      }),
    ],
    providers: [I18nRegistry],
  }).compile();
  await moduleRef.init();

  const client = new AssistantClient({} as never);
  const map = (status: number) =>
    (client as unknown as { upstreamError(err: unknown): ServiceUnavailableException }).upstreamError(
      new OpenAI.APIError(status, undefined, 'upstream says no', undefined),
    );

  it('402 is an account error that names the missing credit', () => {
    const error = withLocale('ru', () => map(402));
    expect(error).toBeInstanceOf(ProviderAccountError);
    expect(error.getStatus()).toBe(503);
    expect(error.message).toContain('закончились средства');
  });

  it.each([401, 403])('%i is an account error that points at the API key', (status) => {
    const error = withLocale('en', () => map(status));
    expect(error).toBeInstanceOf(ProviderAccountError);
    expect(error.message).toContain('API key');
  });

  it.each([400, 429, 500, 503])('%i stays a plain upstream error', (status) => {
    const error = withLocale('en', () => map(status));
    expect(error).not.toBeInstanceOf(ProviderAccountError);
    expect(error.message).toBe(`The AI provider responded with an error (${status})`);
  });
});
