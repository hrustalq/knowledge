import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

type ArcadeLanguage = 'sql' | 'cypher' | 'sqlscript';

interface ArcadeResponse<T = Record<string, unknown>> {
  result: T[];
}

/**
 * Minimal HTTP client for ArcadeDB (no official JS driver).
 * POST /api/v1/command/{db} for writes/DDL, /api/v1/query/{db} for reads.
 */
@Injectable()
export class ArcadeClient {
  private readonly logger = new Logger(ArcadeClient.name);
  private readonly baseUrl: string;
  private readonly db: string;
  private readonly auth: string;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('ARCADE_URL', { infer: true }).replace(/\/$/, '');
    this.db = config.get('ARCADE_DB', { infer: true });
    this.auth =
      'Basic ' +
      Buffer.from(
        `${config.get('ARCADE_USER', { infer: true })}:${config.get('ARCADE_PASSWORD', { infer: true })}`,
      ).toString('base64');
  }

  async command<T = Record<string, unknown>>(
    language: ArcadeLanguage,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
    return this.post<T>('command', language, command, params);
  }

  async query<T = Record<string, unknown>>(
    language: ArcadeLanguage,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
    return this.post<T>('query', language, command, params);
  }

  private async post<T>(
    kind: 'command' | 'query',
    language: ArcadeLanguage,
    command: string,
    params?: Record<string, unknown>,
    attempt = 0,
  ): Promise<T[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/${kind}/${this.db}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.auth },
      body: JSON.stringify({ language, command, ...(params ? { params } : {}) }),
    });

    if (res.status === 503 && attempt < 3) {
      // Server busy / leader election — brief backoff then retry.
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      return this.post<T>(kind, language, command, params, attempt + 1);
    }

    const text = await res.text();
    if (!res.ok) {
      this.logger.error(`ArcadeDB ${kind} failed (${res.status}): ${text.slice(0, 500)}`);
      throw new Error(`ArcadeDB ${kind} failed with ${res.status}: ${text.slice(0, 200)}`);
    }
    return (JSON.parse(text) as ArcadeResponse<T>).result;
  }
}
