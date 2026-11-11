import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { scribeSegments, type ChunkTranscript, type ScribeWord } from './transcript.js';

/** One chunk is at most ten minutes of audio; a server slower than this is down. */
const TIMEOUT_MS = 5 * 60_000;
/** A whole recording in one request (#878) is up to an hour of audio. */
const SPEAKERS_TIMEOUT_MS = 20 * 60_000;

/**
 * gen-api's speech-to-text network (#584): synchronous, text only (a
 * `timestamps` parameter is dropped), at most 600 s and 20 MiB a request.
 * Unsent, `language` defaults to `ru`, a hint gen-api says its main path
 * barely reads.
 */
export const GEN_STT_URL = 'https://api.gen-api.ru/api/v1/networks/gen-stt';

/**
 * gen-api's speaker-aware network (#878), ElevenLabs Scribe: synchronous,
 * `response.words[]` with `start`, `end`, `type` (`word` | `spacing`) and
 * `speaker_id` (`speaker_0`, …), `response.language_code` as ISO 639-3, and a
 * `cost`. Measured on one real call (17 s, two voices, 2026-11-11); its size
 * and duration limits are not documented.
 */
export const GEN_SCRIBE_URL = 'https://api.gen-api.ru/api/v1/networks/speech-to-text';

/**
 * Speech-to-text (#551) over any OpenAI-compatible `/audio/transcriptions`
 * endpoint (hosted Whisper, whisper.cpp's server, speaches), or gen-api's
 * `gen-stt` (#584). The URL is the operator's, from env, so it is a plain
 * fetch with a timeout — as `EMBEDDING_*` is — not the user-URL SSRF filter,
 * which would refuse the self-hosted server on the LAN it exists to reach.
 *
 * No `language` is sent: each chunk is detected on its own, so a recording
 * that switches between ru and en keeps both. Nothing is translated.
 */
@Injectable()
export class TranscriptionClient {
  readonly provider: Env['TRANSCRIPTION_PROVIDER'];
  readonly model: string;
  /** Whether what this server transcribes comes back with speakers (#878): gen-api only. */
  readonly speakers: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: ConfigService<Env, true>) {
    this.provider = config.get('TRANSCRIPTION_PROVIDER', { infer: true });
    this.speakers = this.provider === 'gen-api' && config.get('TRANSCRIPTION_SPEAKERS', { infer: true });
    this.model = this.provider === 'gen-api' ? (this.speakers ? 'speech-to-text' : 'gen-stt') : config.get('TRANSCRIPTION_MODEL', { infer: true });
    this.baseUrl = config.get('TRANSCRIPTION_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.apiKey = config.get('TRANSCRIPTION_API_KEY', { infer: true });
  }

  async transcribe(path: string, offset: number, duration: number): Promise<ChunkTranscript> {
    const audio = new Blob([await readFile(path)], { type: 'audio/mpeg' });
    const form = new FormData();
    if (this.speakers) {
      form.append('audio_url', audio, basename(path));
      form.append('is_sync', 'true');
      form.append('model', 'v2');
      form.append('diarize', 'true');
      // "(laughter)" is not speech, and would be read as something somebody said.
      form.append('tag_audio_events', 'false');
      const body = (await this.post(GEN_SCRIBE_URL, form, SPEAKERS_TIMEOUT_MS)) as {
        response?: { text?: unknown; language_code?: unknown; words?: unknown };
        cost?: unknown;
      };
      const answer = body.response;
      if (!answer || !Array.isArray(answer.words)) throw new Error(t('error.memo.speechServerRefused', { status: 200 }));
      return {
        offset,
        duration,
        language: typeof answer.language_code === 'string' && answer.language_code ? answer.language_code : null,
        text: typeof answer.text === 'string' ? answer.text : '',
        segments: scribeSegments(answer.words as ScribeWord[]),
        anonymousSpeakers: true,
        ...(typeof body.cost === 'number' ? { cost: body.cost } : {}),
      };
    }
    if (this.provider === 'gen-api') {
      form.append('audio_url', audio, basename(path));
      form.append('is_sync', 'true');
      const body = (await this.post(GEN_STT_URL, form)) as { response?: unknown; cost?: unknown };
      if (!Array.isArray(body.response)) throw new Error(t('error.memo.speechServerRefused', { status: 200 }));
      const text = body.response.filter((s): s is string => typeof s === 'string').join(' ');
      // No segments: `stitchTranscript` makes the whole chunk one, which is why gen-api chunks are short.
      return { offset, duration, language: null, text, segments: [], ...(typeof body.cost === 'number' ? { cost: body.cost } : {}) };
    }
    form.append('file', audio, basename(path));
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const body = (await this.post(`${this.baseUrl}/audio/transcriptions`, form)) as {
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

  private async post(url: string, form: FormData, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    // The message reaches the uploader, so it names no host: the URL is the operator's.
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      throw new Error(t('error.memo.speechServerDown'));
    });
    if (!res.ok) throw new Error(t('error.memo.speechServerRefused', { status: res.status }));
    return res.json();
  }
}
