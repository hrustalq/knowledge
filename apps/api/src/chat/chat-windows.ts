/** A kept message the indexer has not packed yet (#339). */
export interface UnpackedMessage {
  id: string;
  authorId: string;
  text: string;
  sentAt: Date;
}

export interface WindowRules {
  /** CHAT_SEARCH_WINDOW_MESSAGES */
  maxMessages: number;
  /** CHAT_SEARCH_WINDOW_GAP_MIN, in ms: a silence this long starts a new window. */
  gapMs: number;
  /** CHAT_SEARCH_SETTLE_MIN, in ms: the last window is packed once the thread is this quiet. */
  settleMs: number;
}

/**
 * One thread's unpacked messages, oldest first, cut into the windows that
 * are ready to index: split at a silence of `gapMs` and at `maxMessages`.
 * Every window but the last is ready — something came after it. The last is
 * ready once full or once the thread has been quiet for `settleMs`, so a
 * live thread is not re-embedded on every message.
 */
export function sealedWindows(messages: UnpackedMessage[], rules: WindowRules, now: number): UnpackedMessage[][] {
  const windows: UnpackedMessage[][] = [];
  for (const m of messages) {
    const open = windows.at(-1);
    const last = open?.at(-1);
    if (open && last && open.length < rules.maxMessages && m.sentAt.getTime() - last.sentAt.getTime() < rules.gapMs) open.push(m);
    else windows.push([m]);
  }
  const tail = windows.at(-1);
  if (tail && tail.length < rules.maxMessages && now - tail.at(-1)!.sentAt.getTime() < rules.settleMs) windows.pop();
  return windows;
}

/**
 * A window as it is embedded, stored and shown: one line per message, its
 * author a number in order of first appearance. Never a name or a platform
 * id — a chunk says who spoke to whom, not who they are.
 */
export function windowText(window: UnpackedMessage[]): string {
  const authors = new Map<string, number>();
  return window
    .map((m) => {
      if (!authors.has(m.authorId)) authors.set(m.authorId, authors.size + 1);
      return `author-${authors.get(m.authorId)}: ${m.text}`;
    })
    .join('\n');
}
