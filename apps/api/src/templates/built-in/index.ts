import type { BuiltInTemplateKey } from '@knowledge/contracts';
import type { BuiltInTemplate } from './types.js';
import { ADR_TEMPLATE } from './adr.js';
import { RFC_TEMPLATE } from './rfc.js';
import { RUNBOOK_TEMPLATE } from './runbook.js';
import { POSTMORTEM_TEMPLATE } from './postmortem.js';
import { API_SPEC_TEMPLATE } from './api-spec.js';
import { USE_CASE_TEMPLATE } from './use-case.js';
import { ENTITY_TEMPLATE } from './entity.js';
import { COMPONENT_TEMPLATE } from './component.js';
import { TEST_PLAN_TEMPLATE } from './test-plan.js';
import { TEST_CASE_TEMPLATE } from './test-case.js';
import { TEST_DATA_TEMPLATE } from './test-data.js';
import { BUG_REPORT_TEMPLATE } from './bug-report.js';

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
  component: COMPONENT_TEMPLATE,
  'test-plan': TEST_PLAN_TEMPLATE,
  'test-case': TEST_CASE_TEMPLATE,
  'test-data': TEST_DATA_TEMPLATE,
  'bug-report': BUG_REPORT_TEMPLATE,
};
