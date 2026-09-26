import { describe, expect, it } from 'vitest';
import { scanPartialObject } from '../src/assistant/partial-args.js';

describe('scanPartialObject', () => {
  const full = JSON.stringify({ op: 'replace', anchor: 'The "old" line', markdown: 'Line one\n\nLine étwo' });

  it('reads a complete object the way JSON.parse does', () => {
    const got = scanPartialObject(full);
    expect(got.op).toEqual({ value: 'replace', complete: true });
    expect(got.anchor).toEqual({ value: 'The "old" line', complete: true });
    expect(got.markdown).toEqual({ value: 'Line one\n\nLine étwo', complete: true });
  });

  it('only ever grows the value being written, at every cut', () => {
    let previous = '';
    for (let cut = 0; cut <= full.length; cut++) {
      const md = scanPartialObject(full.slice(0, cut)).markdown?.value ?? '';
      expect(md.startsWith(previous)).toBe(true);
      previous = md;
    }
    expect(previous).toBe('Line one\n\nLine étwo');
  });

  it('marks a value incomplete until its closing quote lands', () => {
    const got = scanPartialObject('{"op":"insert_after","anchor":"Half a quo');
    expect(got.op?.complete).toBe(true);
    expect(got.anchor).toEqual({ value: 'Half a quo', complete: false });
  });

  it('holds back a cut escape instead of emitting half of it', () => {
    expect(scanPartialObject('{"markdown":"a\\').markdown?.value).toBe('a');
    expect(scanPartialObject('{"markdown":"a\\u00').markdown?.value).toBe('a');
  });

  it('skips values that are not strings', () => {
    const got = scanPartialObject('{"n": 3, "nested": {"x": "}"}, "markdown": "ok"}');
    expect(got.markdown).toEqual({ value: 'ok', complete: true });
    expect(got.n).toBeUndefined();
  });
});
