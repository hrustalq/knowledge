import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatPlatformKind } from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import type { ChatAdapter } from './chat-adapter.types.js';
import { TelegramAdapter } from './telegram.adapter.js';

/**
 * One adapter per platform kind, the connectors registry's shape. Keyed by
 * `ChatPlatformKind`, so a kind added to the contracts list without an adapter
 * here is a type error rather than a 500 at the first delivery.
 */
@Injectable()
export class ChatAdapterRegistry {
  private readonly adapters: Record<ChatPlatformKind, ChatAdapter>;

  constructor(config: ConfigService<Env, true>) {
    this.adapters = {
      telegram: new TelegramAdapter(config.get('TELEGRAM_API_BASE_URL', { infer: true })),
    };
  }

  get(kind: string): ChatAdapter {
    const adapter = (this.adapters as Record<string, ChatAdapter | undefined>)[kind];
    if (!adapter) throw new Error(`No chat adapter for kind '${kind}'`);
    return adapter;
  }
}
