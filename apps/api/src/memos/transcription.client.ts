import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import type { ChunkTranscript } from './transcript.js';

/** One chunk is at most ten minutes of audio; a server slower than this is down. */
const TIMEOUT_MS = 5 * 60_000;

/**
 * Speech-to-text over any OpenAI-compatible `/audio/transcriptions` endpoint
 * (#551): hosted Whisper, whisper.cpp's server, speaches. The URL is the
 * operator's, from env, so it is a plain fetch with a timeout — as
 * `EMBEDDING_*` is — not the user-URL SSRF filter, which would refuse the
 * self-hosted server on the LAN it exists to reach.
 *
 * No `language` is sent: each chunk is detected on its own, so a recording
 * that switches between ru and en keeps both. Nothing is translated.
 */
@Injectable()
export class TranscriptionClient {
  private readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('TRANSCRIPTION_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.model = config.get('TRANSCRIPTION_MODEL', { infer: true });
    this.apiKey = config.get('TRANSCRIPTION_API_KEY', { infer: true });
  }

  async transcribe(path: string, offset: number, duration: number): Promise<ChunkTranscript> {
    const form = new FormData();
    form.append('file', new Blob([await readFile(path)], { type: 'audio/mpeg' }), basename(path));
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    // The message reaches the uploader, so it names no host: the URL is the operator's.
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {
      throw new Error(t('error.memo.speechServerDown'));
    });
    if (!res.ok) throw new Error(t('error.memo.speechServerRefused', { status: res.status }));
    const body = (await res.json()) as {
      text?: unknown;
      language?: unknown;
      segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
    };
    return {
      offset,
      duration,
      language: typeof body.language === 'string' && body.language ? body.language : null,
      text: typeof body.text === 'string' ? body.text : '',
      segments: (Array.isArray(body.segments) ? body.segments : []).flatMap((s) =>
        typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string'
          ? [{ start: s.start, end: s.end, text: s.text }]
          : [],
      ),
    };
  }
}
