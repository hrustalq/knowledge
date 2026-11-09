import { describe, expect, it } from 'vitest';
import { parseModelJson } from '../src/common/model-json.js';

describe('parseModelJson', () => {
  it('reads a bare object', () => {
    expect(parseModelJson('  {"a": 1}\n')).toEqual({ a: 1 });
  });

  it('reads a fenced object', () => {
    expect(parseModelJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```JSON {"a": 1}```')).toEqual({ a: 1 });
  });

  it('reads a fenced block inside prose', () => {
    expect(parseModelJson('Here you go:\n```json\n{"a": "}"}\n```\nHope that helps {x}.')).toEqual({ a: '}' });
  });

  it('reads an object wrapped in prose', () => {
    expect(parseModelJson('Sure! {"a": {"b": 2}} Let me know.')).toEqual({ a: { b: 2 } });
  });

  it('returns null for broken or non-object replies', () => {
    expect(parseModelJson('{"a": ')).toBeNull();
    expect(parseModelJson('not json')).toBeNull();
    expect(parseModelJson('')).toBeNull();
    expect(parseModelJson('null')).toBeNull();
    expect(parseModelJson('"a string"')).toBeNull();
    expect(parseModelJson('42')).toBeNull();
  });
});
