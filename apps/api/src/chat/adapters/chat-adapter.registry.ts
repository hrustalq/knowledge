import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatPlatformKind } from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import type { ChatAdapter } from './chat-adapter.types.js';
import { MattermostAdapter, type MattermostKind } from './mattermost.adapter.js';
import { SlackAdapter } from './slack.adapter.js';
import { TelegramAdapter } from './telegram.adapter.js';

/** The kinds heard over the bot's own websocket — each one a {@link MattermostAdapter}. */
export const CHAT_SOCKET_KINDS: readonly MattermostKind[] = ['time', 'mattermost'];

/**
 * One adapter per platform kind, the connectors registry's shape. Keyed by
 * `ChatPlatformKind`, so a kind added to the contracts list without an adapter
 * here is a type error rather than a 500 at the first delivery.
 */
@Injectable()
export class ChatAdapterRegistry {
  private readonly adapters: Record<ChatPlatformKind, ChatAdapter>;
  /** Also reached directly by the websocket supervisor, which holds these kinds' sockets. */
  private readonly sockets: Record<MattermostKind, MattermostAdapter>;

  constructor(config: ConfigService<Env, true>) {
    const allowPrivate = config.get('CHAT_ALLOW_PRIVATE_URLS', { infer: true });
    this.sockets = {
      time: new MattermostAdapter('time', allowPrivate),
      mattermost: new MattermostAdapter('mattermost', allowPrivate),
    };
    this.adapters = {
      telegram: new TelegramAdapter(config.get('TELEGRAM_API_BASE_URL', { infer: true })),
      ...this.sockets,
      slack: new SlackAdapter(),
    };
  }

  get(kind: string): ChatAdapter {
    const adapter = (this.adapters as Record<string, ChatAdapter | undefined>)[kind];
    if (!adapter) throw new Error(`No chat adapter for kind '${kind}'`);
    return adapter;
  }

  /** The websocket adapter for a bot the supervisor holds. */
  socket(kind: string): MattermostAdapter {
    const adapter = (this.sockets as Record<string, MattermostAdapter | undefined>)[kind];
    if (!adapter) throw new Error(`No websocket chat adapter for kind '${kind}'`);
    return adapter;
  }
}
