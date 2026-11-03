import type { BlueprintNode, DocumentCategory, TemplateRef } from '@knowledge/contracts';

/** A built-in node in both languages: `page('Decisions', 'Решения', { … })`. */
export function page(
  en: string,
  ru: string,
  opts: {
    category?: DocumentCategory;
    template?: TemplateRef;
    guidance?: [en: string, ru: string];
    collection?: { template?: TemplateRef; pattern?: string | [en: string, ru: string] };
    children?: BlueprintNode[];
  } = {},
): BlueprintNode {
  const pattern = opts.collection?.pattern;
  return {
    title: { en, ru },
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.template ? { templateRef: opts.template } : {}),
    ...(opts.guidance ? { guidance: { en: opts.guidance[0], ru: opts.guidance[1] } } : {}),
    ...(opts.collection
      ? {
          collection: {
            ...(opts.collection.template ? { childTemplateRef: opts.collection.template } : {}),
            ...(pattern
              ? { childTitlePattern: typeof pattern === 'string' ? { en: pattern, ru: pattern } : { en: pattern[0], ru: pattern[1] } }
              : {}),
          },
        }
      : {}),
    ...(opts.children ? { children: opts.children } : {}),
  };
}
