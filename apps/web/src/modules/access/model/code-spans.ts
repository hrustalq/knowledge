/**
 * Split copy on backticks so `qwen mcp list` renders as code, not as a pair of
 * literal backticks (#1225). The catalogues keep markdown-ish backticks
 * because both languages share the commands; the page draws them.
 */
export function codeSpans(text: string): { text: string; code: boolean }[] {
  return text.split('`').map((part, i) => ({ text: part, code: i % 2 === 1 })).filter((s) => s.text)
}
