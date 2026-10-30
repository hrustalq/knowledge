import { slugFor } from './slug.js';

describe('slugFor', () => {
  it.each([
    ['Getting Started', 'getting-started'],
    ['  Архитектура   сервиса ', 'архитектура-сервиса'],
    ['a/b\\c:d*e?f"g<h>i|j', 'abcdefghij'],
    ['Tabs\tand\nnewlines', 'tabs-and-newlines'],
    ['--.Hidden.--', 'hidden'],
    ['a -- b', 'a-b'],
    ['???', 'page'],
    ['CON', 'con-page'],
    ['com1', 'com1-page'],
    ['console', 'console'],
    ['Café', 'café'],
  ])('%j → %j', (title, slug) => expect(slugFor(title)).toBe(slug));

  it('cuts at 80 UTF-8 bytes on a character boundary, then trims', () => {
    const cyr = slugFor('ж'.repeat(60));
    expect(Buffer.byteLength(cyr)).toBe(80);
    expect(cyr).toBe('ж'.repeat(40));
    expect(slugFor(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79));
    expect(Buffer.byteLength(slugFor('😀'.repeat(30)))).toBe(80);
  });
});
