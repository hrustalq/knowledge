/**
 * What the analytics views (#79) share: the colour of each traffic class, and
 * the API's per-class day points as stacked bars, human at the bottom.
 * Colours are one hue at two strengths plus a neutral — never the only cue:
 * every chart carries a legend with the numbers in words.
 */
import { TRAFFIC_CLASSES, type AnalyticsDayPoint, type TrafficClass } from '@knowledge/contracts'

export const TRAFFIC_BAR: Record<TrafficClass, string> = {
  human: 'bg-primary',
  assisted: 'bg-primary/40',
  agent: 'bg-muted-foreground/40',
}

export const TRAFFIC_SEGMENTS = TRAFFIC_CLASSES.map((c) => ({ class: TRAFFIC_BAR[c] }))

export function trafficPoints(series: AnalyticsDayPoint[]): Array<{ date: string; values: number[] }> {
  return series.map((p) => ({ date: p.date, values: TRAFFIC_CLASSES.map((c) => p[c]) }))
}
