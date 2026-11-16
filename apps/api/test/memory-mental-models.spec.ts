import { describe, expect, it } from 'vitest';
import {
  applyMentalModelDelta,
  cronDue,
  cronMatches,
  mentalModelScope,
  parseCron,
  previousCronFire,
  parseMentalModelDocument,
  readDeltaOperations,
  readMentalModelDocument,
  renderMentalModelDocument,
  validMentalModelId,
  validResponseSchema,
} from '../src/memory/memory-mental-models.js';

describe('mental model rules (#1160)', () => {
  it('validates custom ids, structured schemas and five-field UTC cron expressions', () => {
    expect(validMentalModelId('team-policies')).toBe(true);
    expect(validMentalModelId('Team/Policies')).toBe(false);
    expect(validResponseSchema({ type: 'object', properties: { owner: { type: 'string' } } })).toBe(true);
    expect(validResponseSchema({ type: 'object', properties: {} })).toBe(false);
    expect(parseCron('0 3 * * *')).not.toBeNull();
    expect(parseCron('0 25 * * *')).toBeNull();
    expect(cronMatches('0 3 * * *', new Date('2026-11-16T03:00:30Z'))).toBe(true);
    expect(cronMatches('0 3 * * *', new Date('2026-11-16T03:01:00Z'))).toBe(false);
    expect(cronDue('0 3 * * *', Date.parse('2026-11-16T03:00:30Z'), null)).toBe(true);
    expect(cronDue('0 3 * * *', Date.parse('2026-11-16T03:00:30Z'), new Date('2026-11-16T03:00:00Z'))).toBe(false);
  });

  it('round-trips markdown exactly and applies delta operations by stable id', () => {
    const original = '# Runbook\n\nKeep this.  \n\n## Commands\n\n```bash\nmake verify\n\nmake check\n```\n';
    const document = parseMentalModelDocument(original);
    expect(renderMentalModelDocument(document)).toBe(original);
    expect(readMentalModelDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
    const operations = readDeltaOperations({
      operations: [
        { op: 'replace_block', section_id: 's1', block_id: 's1-b1', content: 'Updated owner.' },
        { op: 'append_block', section_id: 's2', content: 'make deploy' },
        { op: 'replace_block', section_id: 'missing', block_id: 's1-b1', content: 'Drop me.' },
      ],
    })!;
    const result = applyMentalModelDelta(document, operations);
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toMatchObject([{ reason: 'section_not_found' }]);
    expect(renderMentalModelDocument(result.document)).toBe('# Runbook\n\nUpdated owner.\n\n## Commands\n\n```bash\nmake verify\n\nmake check\n```\n\nmake deploy\n\n');
    expect(result.document.sections[1]!.blocks[0]).toEqual(document.sections[1]!.blocks[0]);
  });

  it('rejects malformed or wholly unapplied deltas instead of producing a partial document', () => {
    const current = parseMentalModelDocument('# Existing\n\nKeep me.\n');
    expect(readDeltaOperations({ operations: [] })).toBeNull();
    expect(readDeltaOperations({ operations: [{ op: 'replace_block', section_id: 's1' }] })).toBeNull();
    const operations = readDeltaOperations({ operations: [{ op: 'remove_block', section_id: 's1', block_id: 'absent' }] })!;
    const result = applyMentalModelDelta(current, operations);
    expect(result.applied).toEqual([]);
    expect(renderMentalModelDocument(result.document)).toBe('# Existing\n\nKeep me.\n');
  });

  it('is due when the schedule fired anywhere since the last run, not only on the exact minute', () => {
    const now = Date.parse('2026-11-16T03:04:10Z');
    expect(cronDue('0 3 * * *', now, new Date('2026-11-14T03:00:00Z'))).toBe(true);
    expect(cronDue('0 3 * * *', now, new Date('2026-11-16T03:01:00Z'))).toBe(false);
    expect(cronDue('0 3 * * *', now, null)).toBe(false);
    expect(previousCronFire('0 3 * * *', now)).toBe(Date.parse('2026-11-16T03:00:00Z'));
    expect(previousCronFire('30 4 * * *', now)).toBe(Date.parse('2026-11-15T04:30:00Z'));
    expect(previousCronFire('*/15 * * * 1', now)).toBe(Date.parse('2026-11-16T03:00:00Z'));
    expect(previousCronFire('0 0 1 * *', now)).toBe(Date.parse('2026-11-01T00:00:00Z'));
    expect(previousCronFire('0 0 29 2 *', now)).toBe(Date.parse('2024-02-29T00:00:00Z'));
    expect(cronDue('0 0 1 * *', now, new Date('2026-10-20T00:00:00Z'))).toBe(true);
  });

  it('fingerprints the scope a model reads, so a tag or fact-type change is detectable', () => {
    const base = mentalModelScope({ tags: ['b', 'a'], trigger: {} });
    expect(mentalModelScope({ tags: ['a', 'b'], trigger: { mode: 'delta', refresh_cron: '0 3 * * *' } })).toBe(base);
    expect(mentalModelScope({ tags: ['a'], trigger: {} })).not.toBe(base);
    expect(mentalModelScope({ tags: ['a', 'b'], trigger: { tags_match: 'any' } })).not.toBe(base);
    expect(mentalModelScope({ tags: ['a', 'b'], trigger: { fact_types: ['world'] } })).not.toBe(base);
  });
});
