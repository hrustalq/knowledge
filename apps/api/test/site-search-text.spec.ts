import { describe, expect, it } from 'vitest';
import { searchTextOf } from '../src/publishing/site-search.text.js';
describe('an embed group (#470)', () => {
  it('is searched by its captions, never by the Figma links that reveal file keys', () => {
    const { body } = searchTextOf(
      'Before.\n\n<figure data-kn-embed="grid">\n<a href="https://www.figma.com/design/AbCdEfGhIj12/?node-id=1-2" data-kn-version="7">Sign-in, empty</a>\n<figcaption>Sign-in flow</figcaption>\n</figure>\n\nAfter.',
    );
    expect(body).toContain('Sign-in, empty');
    expect(body).toContain('Sign-in flow');
    expect(body).not.toContain('figma.com');
    expect(body).not.toContain('AbCdEfGhIj12');
  });
});
