import { describe, expect, it } from 'vitest';
import { directiveMatches } from '../src/memory/memory-directives.service.js';

describe('scoped reflect directives (#1159)', () => {
  it('always applies global directives and matches tagged ones like recall', () => {
    expect(directiveMatches([], undefined)).toBe(true);
    expect(directiveMatches([], [], 'exact')).toBe(true);
    expect(directiveMatches(['user:a'], undefined)).toBe(false);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'])).toBe(true);
    expect(directiveMatches(['user:a', 'team:x'], ['user:a'], 'all')).toBe(false);
    expect(
      directiveMatches(['team:x', 'user:a'], ['user:a', 'team:x'], 'all_strict'),
    ).toBe(true);
    expect(
      directiveMatches(['team:x', 'user:a'], ['user:a', 'team:x'], 'exact'),
    ).toBe(true);
    expect(directiveMatches(['user:a'], ['user:a', 'team:x'], 'exact')).toBe(
      false,
    );
    expect(directiveMatches([' user:a ', 'user:a'], ['user:a'])).toBe(true);
  });
});
