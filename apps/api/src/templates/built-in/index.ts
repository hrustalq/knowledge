import type { BuiltInTemplateKey } from '@knowledge/contracts';
import type { BuiltInTemplate } from './types.js';
import { ADR_TEMPLATE } from './adr.js';
import { RFC_TEMPLATE } from './rfc.js';
import { RUNBOOK_TEMPLATE } from './runbook.js';
import { POSTMORTEM_TEMPLATE } from './postmortem.js';
import { API_SPEC_TEMPLATE } from './api-spec.js';
import { USE_CASE_TEMPLATE } from './use-case.js';
import { ENTITY_TEMPLATE } from './entity.js';

export type { BuiltInTemplate, BuiltInTemplateText } from './types.js';

/**
 * The built-in gallery, keyed so a lookup cannot miss one: the `Record` over
 * `BuiltInTemplateKey` fails to compile if a key is added to contracts without
 * a template behind it. Order is the gallery's order.
 */
export const BUILT_IN_TEMPLATES: Readonly<Record<BuiltInTemplateKey, BuiltInTemplate>> = {
  adr: ADR_TEMPLATE,
  rfc: RFC_TEMPLATE,
  runbook: RUNBOOK_TEMPLATE,
  postmortem: POSTMORTEM_TEMPLATE,
  'api-spec': API_SPEC_TEMPLATE,
  'use-case': USE_CASE_TEMPLATE,
  entity: ENTITY_TEMPLATE,
};
