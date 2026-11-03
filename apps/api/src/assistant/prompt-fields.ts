import type { AssistantPromptField, AssistantPromptOption } from '@knowledge/contracts';

const FIELD_TYPES = new Set(['choice', 'checklist', 'text']);

/**
 * Model-authored form fields, read once for every asker: the chat's
 * `ask_user` and the Describe it interview (#731). Pure, so a spec pins it.
 * Every string is clipped, a field with no type, name or label is dropped, a
 * second `recommended` on one field is cleared (the pre-selection would be
 * whichever the pane drew first), and a choice/checklist with no usable
 * option is dropped and named in `problems` — a picker with nothing to pick
 * strands the person on a form they cannot complete.
 */
export function readPromptFields(raw: unknown, limits: { fields: number; options: number }): { fields: AssistantPromptField[]; problems: string[] } {
  const fields: AssistantPromptField[] = [];
  const problems: string[] = [];
  const names = new Set<string>();
  // The cap counts kept fields, so a dropped one does not cost a slot.
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (fields.length >= limits.fields) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const f = entry as Record<string, unknown>;
    const type = String(f.type ?? '');
    const name = String(f.name ?? '').trim().slice(0, 60);
    const label = String(f.label ?? '').trim().slice(0, 200);
    // A repeated name would answer two questions with one value.
    if (!FIELD_TYPES.has(type) || !name || !label || names.has(name)) continue;
    const required = f.required === true;

    if (type === 'text') {
      names.add(name);
      fields.push({
        type: 'text',
        name,
        label,
        required,
        ...(f.placeholder ? { placeholder: String(f.placeholder).slice(0, 120) } : {}),
        ...(f.multiline === true ? { multiline: true } : {}),
      });
      continue;
    }

    const options: AssistantPromptOption[] = [];
    for (const opt of Array.isArray(f.options) ? f.options : []) {
      if (options.length >= limits.options) break;
      if (typeof opt !== 'object' || opt === null) continue;
      const o = opt as Record<string, unknown>;
      const value = String(o.value ?? '').trim().slice(0, 120);
      const optLabel = String(o.label ?? '').trim().slice(0, 200);
      if (!value || !optLabel || options.some((x) => x.value === value)) continue;
      options.push({
        value,
        label: optLabel,
        ...(o.description ? { description: String(o.description).slice(0, 240) } : {}),
        ...(o.recommended === true ? { recommended: true } : {}),
      });
    }
    for (const extra of options.filter((o) => o.recommended).slice(1)) delete extra.recommended;
    if (options.length === 0) {
      problems.push(`Field "${name}" is a ${type} but has no usable options — give each option a value and a label`);
      continue;
    }
    names.add(name);
    fields.push({ type: type as 'choice' | 'checklist', name, label, options, required });
  }
  return { fields, problems };
}
