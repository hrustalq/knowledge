import { cosine } from '../agents/coverage.js';
import { clusterFindings, findingText, refKey, type DismissedFinding } from './learner-derive.js';

/**
 * The pure half of the LEARNER_CLUSTER_THRESHOLD calibration (#305), done the
 * way #234 calibrated the capture thresholds: labelled cases, every candidate
 * threshold, and what each would get wrong. `backtest.main.ts --learner` does
 * the I/O (embedding, and reading a workspace's labelled findings).
 *
 * A case is a finding with a label naming the mistake it stands for. Two
 * findings with one label are the same mistake on different pages, worded
 * differently — what a cluster should hold. Two with different labels are
 * different mistakes, which must never share a cluster, and the hardest ones
 * share a `kind`: a stale page that really is stale is not the stale page that
 * is versioned on purpose.
 *
 * Errors are weighed asymmetrically on purpose. A **mixed** cluster drafts one
 * learning out of two mistakes and teaches the agent something nobody said —
 * a wrong learning, even if an admin catches it. A **missed** group only waits
 * for more dismissals. So the recommendation is the lowest threshold with no
 * mixed cluster, which recovers the most groups among those.
 */

export interface LabelledFinding {
  label: string;
  kind: string;
  title: string;
  detail: string;
}

/**
 * Built-in cases: eight recurring mistakes, four findings each on four
 * different pages (one of them in Russian, as this deployment's pages are),
 * and six one-off findings — two of them the same `kind` as a group but a
 * different, legitimate reason. Hand-written from the shapes the reviewer,
 * curator, auditor, linter and cartographer actually report.
 */
export const BUILT_IN_CASES: readonly LabelledFinding[] = [
  // Versioned legal pages flagged stale.
  { label: 'stale-versioned-legal', kind: 'stale', title: 'Privacy policy has not been updated in 14 months', detail: 'The page has not changed since last year and may no longer be accurate.' },
  { label: 'stale-versioned-legal', kind: 'stale', title: 'Terms of service look out of date', detail: 'Last edited more than 400 days ago; the content may not reflect current practice.' },
  { label: 'stale-versioned-legal', kind: 'stale', title: 'Data processing agreement is stale', detail: 'No revision for over a year. Please review whether it still applies.' },
  { label: 'stale-versioned-legal', kind: 'stale', title: 'Политика cookie устарела', detail: 'Страница не менялась больше года и, возможно, уже неактуальна.' },
  // Per-region (or per-platform) pages flagged as duplicates.
  { label: 'duplicate-per-region', kind: 'duplicate', title: 'Deploying to the EU region duplicates Deploying to the US region', detail: 'The two pages share most of their steps; consider merging them into one.' },
  { label: 'duplicate-per-region', kind: 'duplicate', title: 'Release checklist (iOS) overlaps Release checklist (Android)', detail: 'Large parts of both pages are identical. Merge them into a single checklist.' },
  { label: 'duplicate-per-region', kind: 'duplicate', title: 'On-call guide for APAC repeats the EMEA on-call guide', detail: 'Nearly the same content appears on both pages; keep one and link to it.' },
  { label: 'duplicate-per-region', kind: 'duplicate', title: 'Инструкция по развёртыванию в регионе KZ дублирует инструкцию для RU', detail: 'Почти все шаги совпадают; объедините страницы в одну.' },
  // Landing and index pages flagged as orphans.
  { label: 'orphan-index-page', kind: 'orphan', title: 'Team handbook has no relations', detail: 'No other page links to it and it declares no relations, so readers will not find it.' },
  { label: 'orphan-index-page', kind: 'orphan', title: 'Engineering home page is not connected to anything', detail: 'The page has no incoming links and no declared relations.' },
  { label: 'orphan-index-page', kind: 'orphan', title: 'Product overview is an orphan', detail: 'Nothing references this page; add relations so it can be discovered.' },
  { label: 'orphan-index-page', kind: 'orphan', title: 'Главная страница раздела «Поддержка» ни с чем не связана', detail: 'На страницу никто не ссылается, и у неё нет объявленных связей.' },
  // Passive voice flagged inside quoted error messages.
  { label: 'style-passive-in-quotes', kind: 'style', title: 'Passive voice: "the request was rejected by the gateway"', detail: 'Rewrite in the active voice. The sentence is inside a quoted error message from the API.' },
  { label: 'style-passive-in-quotes', kind: 'style', title: 'Passive voice: "token has been revoked"', detail: 'Use the active voice. The phrase appears in the error text the CLI prints.' },
  { label: 'style-passive-in-quotes', kind: 'style', title: 'Passive voice: "file was not found"', detail: 'Prefer the active voice here; this is the literal message shown in the log.' },
  { label: 'style-passive-in-quotes', kind: 'style', title: 'Страдательный залог: «запрос был отклонён сервером»', detail: 'Перепишите в действительном залоге. Фраза — это текст ошибки, который возвращает API.' },
  // Historical version numbers in release notes flagged as contradictions.
  { label: 'contradiction-release-history', kind: 'contradiction', title: 'Release notes 2.3 say the limit is 100, the API page says 500', detail: 'The two pages disagree about the request limit.' },
  { label: 'contradiction-release-history', kind: 'contradiction', title: 'Changelog for 1.8 contradicts the configuration reference on the default timeout', detail: 'One page says 30 seconds, the other 60 seconds.' },
  { label: 'contradiction-release-history', kind: 'contradiction', title: 'Version 4.0 release notes disagree with the current install guide about the minimum Node version', detail: 'Release notes require Node 16; the install guide requires Node 20.' },
  { label: 'contradiction-release-history', kind: 'contradiction', title: 'Заметки к выпуску 3.1 противоречат справке о размере пакета', detail: 'В заметках указано 10 МБ, в справке — 50 МБ.' },
  // Relations proposed from names that appear only in examples.
  { label: 'relation-from-example', kind: 'relation', title: 'Payments guide should depend on the Example Shop service', detail: 'The page mentions Example Shop in a sample request; declare depends_on.' },
  { label: 'relation-from-example', kind: 'relation', title: 'Webhook tutorial should reference the Acme CRM page', detail: 'Acme CRM is named in the code sample; add a references relation.' },
  { label: 'relation-from-example', kind: 'relation', title: 'Auth quickstart depends on Demo App', detail: 'Demo App appears in the example configuration; declare the dependency.' },
  { label: 'relation-from-example', kind: 'relation', title: 'Руководство по API должно ссылаться на сервис «Тестовый магазин»', detail: '«Тестовый магазин» упоминается в примере запроса; добавьте связь references.' },
  // Intentionally short redirect pages scored as incomplete.
  { label: 'quality-redirect-stub', kind: 'quality', title: 'Old onboarding page scores 31/100 for completeness', detail: 'The page is two lines long and only links to the new onboarding guide.' },
  { label: 'quality-redirect-stub', kind: 'quality', title: 'Legacy API page is too thin (completeness 25)', detail: 'It contains a single sentence pointing readers to the current reference.' },
  { label: 'quality-redirect-stub', kind: 'quality', title: 'Moved: Billing FAQ has almost no content', detail: 'Completeness is low: the page says it moved and links elsewhere.' },
  { label: 'quality-redirect-stub', kind: 'quality', title: 'Страница «Старый процесс релиза» почти пустая (полнота 20)', detail: 'На странице одна строка со ссылкой на новую инструкцию.' },
  // Glossary-style gaps on terms the glossary already defines.
  { label: 'gap-term-defined', kind: 'gap', title: 'No page explains what an SLO is', detail: 'Several pages use the term SLO without defining it.' },
  { label: 'gap-term-defined', kind: 'gap', title: 'The term "tenant" is never defined', detail: 'Pages refer to tenants but none of them explains the term.' },
  { label: 'gap-term-defined', kind: 'gap', title: 'Missing definition of "runbook"', detail: 'The word runbook is used across the ops pages without an explanation.' },
  { label: 'gap-term-defined', kind: 'gap', title: 'Нигде не объяснено, что такое «витрина данных»', detail: 'Термин используется на нескольких страницах, но не определён.' },
  // One-offs: no learning should come of any of these.
  { label: 'one-off-real-stale', kind: 'stale', title: 'Orders API reference still documents /v2/orders', detail: 'The endpoint was removed in the code six weeks ago; the page describes a route that no longer exists.' },
  { label: 'one-off-real-duplicate', kind: 'duplicate', title: 'Two pages both called "Getting started"', detail: 'Getting started and Getting started (copy) are the same page pasted twice.' },
  { label: 'one-off-broken-link', kind: 'quality', title: 'Security overview has three broken links', detail: 'Links to the old wiki return 404.' },
  { label: 'one-off-missing-owner', kind: 'other', title: 'Incident process page has no owner', detail: 'Nobody is responsible for keeping this page current.' },
  { label: 'one-off-real-contradiction', kind: 'contradiction', title: 'Support hours differ between the help centre and the contact page', detail: 'One says 9 to 6, the other 8 to 8, both describing the current schedule.' },
  { label: 'one-off-gap', kind: 'gap', title: 'No page describes how to rotate the database password', detail: 'People asked three times this month and found nothing.' },
];

export interface ThresholdRow {
  threshold: number;
  /** Pairs of one label at or above the threshold, over all such pairs. */
  pairRecall: number;
  /** Pairs at or above the threshold that share a label, over all pairs at or above it. */
  pairPrecision: number;
  /** Clusters of two or more holding more than one label: a learning drafted from two mistakes. */
  mixed: number;
  /** Groups (labels with `minSize`+ findings) recovered whole enough: one cluster holds `minSize` of them. */
  recovered: number;
  groups: number;
  /** One-offs that ended up in a cluster that qualifies by size. */
  absorbed: number;
}

/** The cases as the learner's own input, so the measurement runs `clusterFindings` itself. */
export function asFindings(cases: readonly LabelledFinding[]): Array<DismissedFinding & { label: string }> {
  return cases.map((c, i) => ({
    label: c.label,
    runId: `case-${i}`,
    findingIndex: 0,
    agentKey: 'calibration',
    projectId: 'calibration',
    kind: c.kind,
    title: c.title,
    detail: c.detail,
    dismissedBy: `person-${i % 3}`,
    // Visited in the order written, as the learner visits dismissal order.
    dismissedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    locale: 'en',
  }));
}

export const caseTexts = (cases: readonly LabelledFinding[]): string[] => cases.map((c) => findingText(c));

/** What one threshold gets right and wrong on the cases, given one vector per case in order. */
export function measure(
  cases: readonly LabelledFinding[],
  vectors: readonly (readonly number[])[],
  threshold: number,
  minSize = 3,
): ThresholdRow {
  let samePairs = 0;
  let sameAbove = 0;
  let above = 0;
  for (let i = 0; i < cases.length; i++) {
    for (let j = i + 1; j < cases.length; j++) {
      const same = cases[i].label === cases[j].label;
      const hit = cosine(vectors[i], vectors[j]) >= threshold;
      if (same) samePairs += 1;
      if (hit) above += 1;
      if (same && hit) sameAbove += 1;
    }
  }
  const findings = asFindings(cases);
  const byKey = new Map(findings.map((f, i) => [refKey(f), vectors[i]]));
  const labelOf = new Map(findings.map((f) => [refKey(f), f.label]));
  const clusters = clusterFindings(findings, byKey, threshold);
  const sizes = new Map<string, number>();
  for (const c of cases) sizes.set(c.label, (sizes.get(c.label) ?? 0) + 1);
  const groups = [...sizes].filter(([, n]) => n >= minSize).map(([label]) => label);

  let mixed = 0;
  let absorbed = 0;
  const recovered = new Set<string>();
  for (const cluster of clusters) {
    const labels = cluster.map((f) => labelOf.get(refKey(f))!);
    const distinct = new Set(labels);
    if (cluster.length >= 2 && distinct.size > 1) mixed += 1;
    if (cluster.length >= minSize) {
      absorbed += labels.filter((l) => (sizes.get(l) ?? 0) < minSize).length;
      for (const label of distinct) {
        if (labels.filter((l) => l === label).length >= minSize && (sizes.get(label) ?? 0) >= minSize) recovered.add(label);
      }
    }
  }
  return {
    threshold,
    pairRecall: samePairs ? sameAbove / samePairs : 0,
    pairPrecision: above ? sameAbove / above : 1,
    mixed,
    recovered: recovered.size,
    groups: groups.length,
    absorbed,
  };
}

/**
 * The recommended threshold: the lowest with no mixed cluster and no one-off
 * absorbed into a qualifying one, recovering the most groups among those.
 * Null when every threshold mixes something — the model cannot separate these
 * cases at all, and no value is safe.
 */
export function recommend(rows: readonly ThresholdRow[]): number | null {
  const safe = rows.filter((r) => r.mixed === 0 && r.absorbed === 0);
  if (safe.length === 0) return null;
  const best = Math.max(...safe.map((r) => r.recovered));
  return safe.filter((r) => r.recovered === best).sort((a, b) => a.threshold - b.threshold)[0].threshold;
}
