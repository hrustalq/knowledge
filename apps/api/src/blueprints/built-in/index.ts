import type { Blueprint, BuiltInBlueprintKey } from '@knowledge/contracts';
import { DISCOVERY_BLUEPRINT } from './discovery.js';
import { CODE_PRODUCT_BLUEPRINT } from './code-product.js';
import { SERVICE_DOCS_BLUEPRINT } from './service-docs.js';

/**
 * Blueprints shipped in code (#716), never seeded as rows — the built-in
 * template argument. The `Record` fails to compile if contracts gains a key
 * with no blueprint behind it. Order is the wizard's order.
 */
export const BUILT_IN_BLUEPRINTS: Readonly<Record<BuiltInBlueprintKey, Blueprint>> = {
  discovery: DISCOVERY_BLUEPRINT,
  'code-product': CODE_PRODUCT_BLUEPRINT,
  'service-docs': SERVICE_DOCS_BLUEPRINT,
  blank: {
    name: { en: 'Blank', ru: 'Пустой' },
    description: { en: 'An empty project.', ru: 'Пустой проект.' },
    tree: [],
  },
};
