import { toCsv } from '../src/analytics/analytics-csv.js';
import { effectiveAnalytics } from '../src/analytics/analytics-settings.js';
import { AnalyticsRetentionSweeper } from '../src/analytics/analytics-retention.sweeper.js';

/** #79 phase 4: the CSV encoder, the settings ceiling, and the retention sweep's batching. */
describe('analytics CSV', () => {
  it('quotes RFC 4180 fields and ends rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', null]])).toBe(
      'a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n',
    );
  });

  it('defuses formulas in text but leaves numbers alone', () => {
    expect(toCsv(['q', 'n'], [['=HYPERLINK("x")', -3], ['@sum', 0], ['+1', 1.5]])).toBe(
      'q,n\r\n"\'=HYPERLINK(""x"")",-3\r\n\'@sum,0\r\n\'+1,1.5\r\n',
    );
  });
});

describe('analytics settings', () => {
  const ceiling = { enabled: true, retentionDays: 180 };

  it('inherits the env when nothing is set', () => {
    expect(effectiveAnalytics(ceiling, null)).toEqual(ceiling);
    expect(effectiveAnalytics(ceiling, { analyticsEnabled: null, analyticsRetentionDays: null })).toEqual(ceiling);
  });

  it('lets a workspace turn recording off and shorten retention, never the reverse', () => {
    expect(effectiveAnalytics(ceiling, { analyticsEnabled: false, analyticsRetentionDays: 30 })).toEqual({
      enabled: false,
      retentionDays: 30,
    });
    expect(effectiveAnalytics({ enabled: false, retentionDays: 90 }, { analyticsEnabled: true, analyticsRetentionDays: 400 })).toEqual({
      enabled: false,
      retentionDays: 90,
    });
  });
});

describe('analytics retention sweep', () => {
  function sweeper(batches: number[]) {
    const calls: string[] = [];
    const prisma = {
      $executeRaw: vi.fn(async (q: { sql: string }) => {
        calls.push(q.sql.trim().split(/\s+/).slice(0, 3).join(' '));
        return batches.shift() ?? 0;
      }),
    };
    const config = { get: (k: string) => ({ ANALYTICS_RETENTION_DAYS: 180, ANALYTICS_QUERY_TEXT_DAYS: 90 })[k] };
    return { s: new AnalyticsRetentionSweeper(prisma as never, config as never), calls };
  }

  it('deletes in batches until a short one, per table, then redacts query text', async () => {
    const { s, calls } = sweeper([5000, 12, 0, 0, 3]);
    await s.sweep();
    expect(calls).toEqual([
      'DELETE FROM page_views',
      'DELETE FROM page_views',
      'DELETE FROM search_queries',
      'DELETE FROM mcp_tool_calls',
      'UPDATE search_queries SET',
    ]);
  });

  it('never runs two sweeps at once', async () => {
    const { s, calls } = sweeper([]);
    await Promise.all([s.sweep(), s.sweep()]);
    expect(calls.length).toBe(4);
  });
});
