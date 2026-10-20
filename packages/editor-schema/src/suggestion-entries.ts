/**
 * The shared draft's suggestion list in the Y.Doc (#80, #316): one Y.Map per
 * suggestion under `SUGGESTIONS_FIELD`. Read and written by the editor
 * (`use-collab.ts`) and by the API's MCP draft tools, through these three
 * functions only. The shapes are in `@knowledge/editor-schema/suggestions`.
 */
import * as Y from 'yjs';
import { BODY_FIELD } from '@knowledge/editor-schema';
import { SUGGESTIONS_FIELD, type SuggestionEntry } from '@knowledge/editor-schema/suggestions';

/** Every entry whose range still resolves in the body. */
export function readSuggestionEntries(doc: Y.Doc): SuggestionEntry[] {
  const body = doc.getXmlFragment(BODY_FIELD);
  const indexOf = (json: unknown) => {
    const at = json ? Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc) : null;
    return at?.type === body ? at.index : null;
  };
  const out: SuggestionEntry[] = [];
  doc.getMap<Y.Map<unknown>>(SUGGESTIONS_FIELD).forEach((entry, id) => {
    const fromIndex = indexOf(entry.get('from'));
    const toIndex = indexOf(entry.get('to'));
    if (fromIndex === null || toIndex === null) return;
    out.push({
      id,
      fromIndex,
      toIndex,
      original: entry.get('original'),
      originalText: (entry.get('originalText') as string) ?? '',
      state: entry.get('state') === 'streaming' ? 'streaming' : 'ready',
      agent: (entry.get('agent') as SuggestionEntry['agent']) ?? null,
      requestedBy: (entry.get('requestedBy') as SuggestionEntry['requestedBy']) ?? null,
      clientId: entry.get('clientId') as number,
    });
  });
  return out;
}

/**
 * Create or move an entry. What it replaced and who it is credited to are
 * written once, on creation: they do not change while it streams. Call it
 * after the suggested content is in the body, so the indices match.
 */
export function writeSuggestionEntry(
  doc: Y.Doc,
  item: Omit<SuggestionEntry, 'clientId' | 'requestedBy'>,
  requestedBy: SuggestionEntry['requestedBy'],
): void {
  const map = doc.getMap<Y.Map<unknown>>(SUGGESTIONS_FIELD);
  const body = doc.getXmlFragment(BODY_FIELD);
  const put = (entry: Y.Map<unknown>, key: string, value: unknown) => {
    if (JSON.stringify(entry.get(key)) !== JSON.stringify(value)) entry.set(key, value);
  };
  doc.transact(() => {
    let entry = map.get(item.id);
    if (!entry) {
      entry = new Y.Map();
      map.set(item.id, entry);
      entry.set('original', item.original);
      entry.set('originalText', item.originalText);
      entry.set('agent', item.agent);
      entry.set('requestedBy', requestedBy);
      entry.set('clientId', doc.clientID);
    }
    put(entry, 'from', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(body, item.fromIndex, 0)));
    put(entry, 'to', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(body, item.toIndex, -1)));
    put(entry, 'state', item.state);
  });
}

export function removeSuggestionEntries(doc: Y.Doc, ids: string[]): void {
  const map = doc.getMap<Y.Map<unknown>>(SUGGESTIONS_FIELD);
  doc.transact(() => ids.forEach((id) => map.delete(id)));
}
