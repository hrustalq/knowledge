import { describe, expect, it } from 'vitest';
import {
  applyMentalModelDelta,
  cronDue,
  cronMatches,
  parseCron,
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
});
