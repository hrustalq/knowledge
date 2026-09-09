import { BadRequestException, Injectable, ParseUUIDPipe } from '@nestjs/common';
import type { ValidationArguments, ValidationError } from 'class-validator';
import { t } from '../i18n/t.js';

/**
 * Translated validation messages (docs/features/18).
 *
 * class-validator runs inside the request, so the ambient `t()` already knows
 * the caller's language — no separate resolution is needed here.
 */

/**
 * Message factory for decorators that carry arguments (`@MaxLength(200)`), so
 * the limit reaches the catalog as `{n}` instead of being scraped back out of
 * an English sentence.
 */
export function vmsg(constraint: string) {
  return (a: ValidationArguments): string =>
    t(`validation.${constraint}`, {
      property: a.property,
      value: a.value,
      // Flat, named: the default formatter does not resolve `{constraints.0}`.
      n: a.constraints?.[0],
      n2: a.constraints?.[1],
    });
}

/** Sentinel for detecting `{n}` slots in a template without rendering them. */
const ARG_PROBE = '\u0000';

/** `{ property, constraint, args }` — the machine-readable form of one failure. */
export interface Violation {
  property: string;
  constraint: string;
  message: string;
}

/** Flatten nested @ValidateNested errors into dotted property paths. */
function flatten(errors: ValidationError[], prefix = ''): Violation[] {
  const out: Violation[] = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    for (const [constraint, fallback] of Object.entries(e.constraints ?? {})) {
      // `fallback` is whatever class-validator produced: already translated
      // when the decorator is wired with `vmsg`, an English default otherwise.
      //
      // Translating here by constraint name covers the ~580 decorators that
      // need no arguments. It must NOT be used for a template that wants one
      // (`{n}`), because this path has no access to the decorator's arguments
      // and would render the limit as an empty string — so probe the template
      // with a sentinel and defer to `fallback` whenever a slot is present.
      const key = `validation.${constraint}`;
      const probe = t(key, { property: path, n: ARG_PROBE, n2: ARG_PROBE });
      const usable = probe !== key && !probe.includes(ARG_PROBE);
      out.push({ property: path, constraint, message: usable ? probe : fallback });
    }
    if (e.children?.length) out.push(...flatten(e.children, path));
  }
  return out;
}

/**
 * ValidationPipe exceptionFactory. Keeps `details.errors: string[]` — the shape
 * the web already consumes — and adds `violations` for programmatic use.
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const violations = flatten(errors);
  return new BadRequestException({
    statusCode: 400,
    code: 'VALIDATION_FAILED',
    message: t('error.validationFailed'),
    errors: violations.map((v) => v.message),
    violations,
  });
}

/**
 * ParseUUIDPipe with a translated message. Imported under the framework's name
 * so the 131 `@Param('id', ParseUUIDPipe)` call sites stay untouched.
 */
@Injectable()
export class ParseUuidPipe extends ParseUUIDPipe {
  constructor() {
    super({
      exceptionFactory: () =>
        new BadRequestException(t('error.invalidUuid', { subject: t('subject.id') })),
    });
  }
}
