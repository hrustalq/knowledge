/**
 * A session's User-Agent as a person reads it: "Firefox on macOS". Only the
 * families a sessions list needs to tell apart, checked in the order that
 * matters (Edge and Opera also say Chrome; Chrome also says Safari). Null when
 * nothing is recognised, so the caller shows its own "unknown device" rather
 * than a raw header.
 */
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/YaBrowser\//, 'Yandex Browser'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/^curl\//, 'curl'],
]

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]

export function describeUserAgent(ua: string | null | undefined): { browser: string; os: string | null } | null {
  if (!ua) return null
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1]
  if (!browser) return null
  return { browser, os: SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null }
}
