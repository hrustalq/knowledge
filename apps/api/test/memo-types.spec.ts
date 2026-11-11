import { describe, expect, it } from 'vitest';
import { BUILT_IN_MEMO_TYPE_KEYS } from '@knowledge/contracts';
import { effectiveMemoTypes, memoTypeBrief } from '../src/memos/memo-types.js';

describe('memo types (#879)', () => {
  it('is the built-in catalogue when a workspace has no rows', () => {
    const types = effectiveMemoTypes([]);
    expect(types.map((t) => t.key)).toEqual([...BUILT_IN_MEMO_TYPE_KEYS]);
    expect(types.every((t) => t.builtIn && !t.overridden && !t.hidden && t.guidance.length > 40)).toBe(true);
  });

  it('lets a row override or hide a built-in, where an empty field inherits, and adds the workspace’s own', () => {
    const types = effectiveMemoTypes([
      { key: 'daily', name: 'Стендап', guidance: '  ', hidden: false },
      { key: 'retro', name: null, guidance: null, hidden: true },
      { key: 'customer-call', name: 'Customer call', guidance: 'Record what the customer asked for.', hidden: false },
    ]);
    const by = Object.fromEntries(types.map((t) => [t.key, t]));
    expect(by.daily).toMatchObject({ name: 'Стендап', overridden: true, builtIn: true });
    expect(by.daily!.guidance).toContain('stand-up');
    expect(by.retro).toMatchObject({ name: 'Retrospective', hidden: true, overridden: false });
    expect(by['customer-call']).toMatchObject({ builtIn: false, guidance: 'Record what the customer asked for.' });
  });

  it('briefs the secretary only for a type the workspace has, with its name quoted', () => {
    const types = effectiveMemoTypes([{ key: 'x', name: 'Say "hi"', guidance: 'Do the thing.', hidden: false }]);
    expect(memoTypeBrief(types, 'x')).toContain('"Say \\"hi\\"". Do the thing.');
    expect(memoTypeBrief(types, 'gone')).toBe('');
    expect(memoTypeBrief(types, null)).toBe('');
  });
});
