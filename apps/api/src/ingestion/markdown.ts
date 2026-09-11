export interface MarkdownSection {
  headingPath: string[];
  text: string;
}

export interface ChunkDraft {
  index: number;
  text: string;
  headingPath: string[];
}

/**
 * The text a chunk is embedded *as*, which is not the text it is stored as.
 *
 * A chunk body alone is missing the two things that most often say what it is
 * about: the page it belongs to and the section it sits under. Both are known
 * here for free, and a body three headings deep ("set it to 30s") is otherwise
 * unfindable by the words a reader would actually search for. Prepending them
 * is provider-independent — it helps a real embedding model as much as the
 * stub — so it belongs at the embed call, not in the stored `text`, which
 * stays verbatim for snippets and the fulltext index.
 */
export function chunkEmbedText(chunk: ChunkDraft, documentTitle: string): string {
  return [documentTitle, chunk.headingPath.join(' > '), chunk.text]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

/** Heading-aware split of a markdown body into sections. */
export function splitMarkdown(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) sections.push({ headingPath: stack.map((s) => s.title), text });
    buffer = [];
  };

  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Greedy paragraph packing to ~800 tokens (chars/4 heuristic) with overlap.
 */
export function chunkSections(
  sections: MarkdownSection[],
  maxChars = 3200,
  overlapChars = 400,
): ChunkDraft[] {
  const chunks: ChunkDraft[] = [];

  for (const section of sections) {
    const paragraphs = section.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let current = '';

    const push = (text: string) => {
      if (text.trim()) {
        chunks.push({ index: chunks.length, text: text.trim(), headingPath: section.headingPath });
      }
    };

    for (const p of paragraphs) {
      if (current && current.length + p.length + 2 > maxChars) {
        push(current);
        current = current.slice(Math.max(0, current.length - overlapChars));
      }
      current = current ? `${current}\n\n${p}` : p;
      // A single paragraph longer than maxChars gets hard-split.
      while (current.length > maxChars) {
        push(current.slice(0, maxChars));
        current = current.slice(maxChars - overlapChars);
      }
    }
    push(current);
  }
  return chunks;
}
