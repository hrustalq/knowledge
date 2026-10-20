/**
 * The editor's document schema, DOM-free (#80).
 *
 * Every node and mark the rich editor stores, as a spec only: name, content,
 * attributes, `parseHTML` and `renderHTML`. The web extends each one with its
 * Vue node view and its commands (`apps/web/src/components/editor/extensions`);
 * the API builds the same schema headless to seed a shared draft from the
 * branch head. Two schemas that disagree corrupt a Y.Doc silently —
 * y-prosemirror drops any node or attribute the receiving side does not know —
 * so both sides take the list from here.
 *
 * Each `renderHTML` is the exact shape `apps/web/src/lib/markdown/serialize.ts`
 * expects and `markdown.ts` produces. Change one, change all three.
 */
import { Mark, Node, getSchema, mergeAttributes, type AnyExtension } from '@tiptap/core';
import { DOMParser as PMDOMParser, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { createLowlight } from 'lowlight';
import { markdownToHtml } from '@knowledge/editor-schema/markdown';
import {
  KN,
  isApiSection,
  isHttpMethod,
  isPanelType,
  isStatusColor,
  type ApiSectionKind,
  type HttpMethod,
  type PanelType,
  type StatusColor,
} from '@knowledge/editor-schema/nodes';

/* ------------------------------------------------------------------ blocks */

export const Panel = Node.create({
  name: 'knPanel',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'note' as PanelType,
        parseHTML: (element) => {
          const raw = element.getAttribute(KN.panel) ?? 'note';
          return isPanelType(raw) ? raw : 'note';
        },
        renderHTML: (attributes) => ({ [KN.panel]: attributes.type }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${KN.panel}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },
});

export const Expand = Node.create({
  name: 'knExpand',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      summary: {
        default: 'Details',
        parseHTML: (element) => {
          const summary = [...element.children].find((c) => c.tagName === 'SUMMARY');
          return summary?.textContent?.trim() || 'Details';
        },
        renderHTML: () => ({}),
      },
      open: {
        default: true,
        parseHTML: (element) => element.hasAttribute('open'),
        renderHTML: (attributes) => (attributes.open ? { open: 'open' } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'details',
        // The summary is an attribute, not content — hand ProseMirror a copy
        // with it removed so the label does not also appear inside the body.
        contentElement: (element) => {
          const clone = element.cloneNode(true) as HTMLElement;
          for (const child of [...clone.children]) {
            if (child.tagName === 'SUMMARY') child.remove();
          }
          return clone;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes),
      ['summary', {}, node.attrs.summary as string],
      ['div', { 'data-kn-expand-body': '' }, 0],
    ];
  },
});

export const LayoutColumn = Node.create({
  name: 'knLayoutColumn',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: `div[${KN.column}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { [KN.column]: '' }), 0];
  },
});

export const Layout = Node.create({
  name: 'knLayout',
  group: 'block',
  content: 'knLayoutColumn{2,3}',
  isolating: true,

  addAttributes() {
    return {
      columns: {
        default: 2,
        parseHTML: (element) => (Number(element.getAttribute(KN.layout)) === 3 ? 3 : 2),
        renderHTML: (attributes) => ({ [KN.layout]: String(attributes.columns) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${KN.layout}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },
});

export const TableOfContents = Node.create({
  name: 'knToc',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: `div[${KN.toc}]` }];
  },

  renderHTML() {
    return ['div', { [KN.toc]: '1' }];
  },
});

/* --------------------------------------------------------------------- api */

/**
 * The API contract block: one HTTP endpoint, documented. Markdown stays
 * canonical and text stays visible (`nodes.ts`): method and path ride as
 * attributes for the machine, but the endpoint is also a real `###` heading
 * and every parameter a real GFM table, because ingestion chunks the stored
 * markdown and prepends the heading path before embedding.
 */
export const ApiContract = Node.create({
  name: 'knApi',
  group: 'block',
  content: 'knApiSection+',
  defining: true,

  addAttributes() {
    return {
      method: {
        default: 'GET' as HttpMethod,
        parseHTML: (element) => {
          const raw = (element.getAttribute(KN.api) ?? '').toUpperCase();
          return isHttpMethod(raw) ? raw : 'GET';
        },
        renderHTML: (attributes) => ({ [KN.api]: attributes.method }),
      },
      path: {
        default: '/',
        parseHTML: (element) => element.getAttribute(KN.apiPath) || '/',
        renderHTML: (attributes) => ({ [KN.apiPath]: attributes.path }),
      },
      // The spec operation this block mirrors (#78). Set, the read view draws
      // the operation live from the spec and the page IMPLEMENTS it.
      op: {
        default: null as string | null,
        parseHTML: (element) => element.getAttribute(KN.apiOp) || null,
        renderHTML: (attributes) => (attributes.op ? { [KN.apiOp]: attributes.op } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[${KN.api}]`,
        // The endpoint line is an attribute rendered as a heading, not content.
        // Hand ProseMirror a copy without it — the way Expand drops its
        // <summary> — or the header would also appear as the body's first
        // block. The method check keeps a user's own leading heading safe.
        contentElement: (element) => {
          const clone = element.cloneNode(true) as HTMLElement;
          const first = clone.firstElementChild;
          const lead = (first?.textContent ?? '').trim().split(/\s+/)[0]?.toUpperCase() ?? '';
          if (first && /^H[1-6]$/.test(first.tagName) && isHttpMethod(lead)) first.remove();
          return clone;
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes),
      // A real <h3>: both outlines (MarkdownView's `h1, h2, h3` and
      // DocumentCanvas's `.kn-prose h1, h2, h3`) then list the endpoint, so the
      // page rail reads the same whether you are reading or editing.
      ['h3', {}, `${node.attrs.method as string} ${node.attrs.path as string}`],
      ['div', { 'data-kn-api-body': '' }, 0],
    ];
  },
});

export const ApiSection = Node.create({
  name: 'knApiSection',
  content: 'block+',
  // Deliberately not `isolating`: these sections are stacked, not side by side,
  // so Backspace at the top of one should join the previous the way it does
  // between any two blocks. (knLayoutColumn isolates because columns are
  // parallel and joining them would be meaningless.)
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'summary' as ApiSectionKind,
        parseHTML: (element) => {
          const raw = element.getAttribute(KN.apiSection) ?? 'summary';
          return isApiSection(raw) ? raw : 'summary';
        },
        renderHTML: (attributes) => ({ [KN.apiSection]: attributes.kind }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${KN.apiSection}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },
});

/* ------------------------------------------------------------------- media */

/** Mermaid and drawings are the only nodes stored as an opaque fence: neither carries prose. */
export const DEFAULT_MERMAID = `graph TD
  A[Request] --> B{Cached?}
  B -- yes --> C[Serve]
  B -- no --> D[Compute]
  D --> C`;

/** Reads the fence body out of the `<pre>` the markdown renderer emits. */
function preText(element: HTMLElement): string {
  const pre = [...element.querySelectorAll('pre')][0];
  return (pre?.textContent ?? element.textContent ?? '').trim();
}

export const Mermaid = Node.create({
  name: 'knMermaid',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: {
        default: DEFAULT_MERMAID,
        parseHTML: (element) => preText(element as HTMLElement) || DEFAULT_MERMAID,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: `div[${KN.mermaid}]` },
      // A plain ```mermaid fence pasted as HTML still lands here rather than in
      // the generic code block, which would strip the diagram on save.
      { tag: 'pre > code.language-mermaid', priority: 60, getAttrs: () => ({}) },
    ];
  },

  renderHTML({ node }) {
    return ['div', { [KN.mermaid]: '1' }, ['pre', {}, node.attrs.code as string]];
  },
});

export const Drawing = Node.create({
  name: 'knDrawing',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      scene: {
        default: '',
        parseHTML: (element) =>
          (element as HTMLElement).getAttribute('data-scene') || preText(element as HTMLElement),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${KN.drawing}]` }];
  },

  renderHTML({ node }) {
    return ['div', { [KN.drawing]: '1' }, ['pre', {}, (node.attrs.scene as string) || '']];
  },
});

export const FileEmbed = Node.create({
  name: 'knFile',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: '',
        parseHTML: (element) => element.getAttribute(KN.file) ?? '',
        renderHTML: (attributes) => ({ [KN.file]: attributes.attachmentId }),
      },
      filename: {
        default: 'attachment',
        parseHTML: (element) => element.getAttribute('data-kn-name') ?? 'attachment',
        renderHTML: (attributes) => ({ 'data-kn-name': attributes.filename }),
      },
      mime: {
        default: 'application/octet-stream',
        parseHTML: (element) => element.getAttribute('data-kn-mime') ?? 'application/octet-stream',
        renderHTML: (attributes) => ({ 'data-kn-mime': attributes.mime }),
      },
      size: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-kn-size')) || 0,
        renderHTML: (attributes) => (attributes.size ? { 'data-kn-size': String(attributes.size) } : {}),
      },
      href: {
        default: '',
        parseHTML: (element) => element.querySelector('a')?.getAttribute('href') ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[${KN.file}]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes),
      ['a', { href: node.attrs.href as string }, node.attrs.filename as string],
    ];
  },
});

/**
 * Images gain a persisted width. Width is the one image property markdown
 * cannot carry, so the serializer switches that image to an `<img>` tag —
 * resizing is real authored intent, not a view preference.
 */
export const ResizableImage = Image.extend({
  draggable: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => element.getAttribute('width'),
        renderHTML: (attributes) => (attributes.width ? { width: attributes.width } : {}),
      },
    };
  },
});

/** Block images, no data URLs: an option, but a schema one — both sides configure it this way. */
export const IMAGE_OPTIONS = { inline: false, allowBase64: false } as const;

/* ------------------------------------------------------------------ inline */

/**
 * Status is a *mark*, not an atom node, on purpose: the text stays in the
 * paragraph, stays editable in place, and stays visible to the chunker that
 * embeds this page.
 */
export const StatusMark = Mark.create({
  name: 'knStatus',
  inclusive: false,

  addAttributes() {
    return {
      color: {
        default: 'neutral' as StatusColor,
        parseHTML: (element) => {
          const raw = element.getAttribute(KN.status) ?? 'neutral';
          return isStatusColor(raw) ? raw : 'neutral';
        },
        renderHTML: (attributes) => ({ [KN.status]: attributes.color }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[${KN.status}]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

/**
 * A link to another page. Serializes to an ordinary `[Title](/documents/<uuid>)`
 * link, so the relation extractor and the graph keep seeing a normal internal
 * link — the chip is presentation.
 */
export const DocMention = Node.create({
  name: 'knMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      documentId: {
        default: '',
        parseHTML: (element) => element.getAttribute('href')?.replace('/documents/', '') ?? '',
        renderHTML: () => ({}),
      },
      label: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    // Above StarterKit's Link (50): both rules match this <a>, and without the
    // bump the link mark wins and the chip degrades to an underlined link.
    return [{ tag: `a[${KN.mention}]`, priority: 60 }];
  },

  renderHTML({ node }) {
    return [
      'a',
      { href: `/documents/${node.attrs.documentId as string}`, [KN.mention]: '1' },
      node.attrs.label as string,
    ];
  },

  renderText({ node }) {
    return node.attrs.label as string;
  },
});

/**
 * A mention of a person: a `<span>`, not an `<a>` (there is no user profile to
 * link to), with the visible name inside so it survives into the markdown as
 * prose and stays searchable.
 */
export const UserMention = Node.create({
  name: 'knUserMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      userId: {
        default: '',
        parseHTML: (element) => element.getAttribute(KN.user) ?? '',
        renderHTML: () => ({}),
      },
      label: {
        default: '',
        // Stored without the sigil so the chip owns how it is presented; the
        // markup carries "@Ada" because that is what a reader should copy.
        parseHTML: (element) => (element.textContent ?? '').replace(/^@/, ''),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[${KN.user}]` }];
  },

  renderHTML({ node }) {
    return ['span', { [KN.user]: node.attrs.userId as string }, `@${node.attrs.label as string}`];
  },

  renderText({ node }) {
    return `@${node.attrs.label as string}`;
  },
});

/**
 * An agent, mentioned. A separate node from `UserMention`: the value is an
 * agent key, not a UUID, and the API acts on this attribute in a comment body,
 * so a mistyped person chip must not be able to spend a model call.
 */
export const AgentMention = Node.create({
  name: 'knAgentMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      agentKey: {
        default: '',
        parseHTML: (element) => element.getAttribute(KN.agent) ?? '',
        renderHTML: () => ({}),
      },
      label: {
        default: '',
        parseHTML: (element) => (element.textContent ?? '').replace(/^@/, ''),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[${KN.agent}]` }];
  },

  renderHTML({ node }) {
    return ['span', { [KN.agent]: node.attrs.agentKey as string }, `@${node.attrs.label as string}`];
  },

  renderText({ node }) {
    return `@${node.attrs.label as string}`;
  },
});

/* ------------------------------------------------------------------ schema */

/**
 * The stock extensions, configured once. The editor adds behaviour on top
 * (placeholder, slash menu, drag handle…); anything that changes the schema
 * belongs here.
 *
 * `undoRedo: false` for a shared draft (#80): Collaboration brings its own
 * per-peer undo, and ProseMirror's history would undo other people's edits.
 */
export function baseExtensions(lowlight = createLowlight(), { undoRedo = true } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      ...(undoRedo ? {} : { undoRedo: false as const }),
      codeBlock: false,
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow' } },
      heading: { levels: [1, 2, 3, 4] },
    }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
    Highlight,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
  ];
}

/** Everything that defines the schema, headless. The web builds it from its own view-bearing copies of the custom nodes. */
export const editorSchema = getSchema([
  ...baseExtensions(),
  Panel,
  Expand,
  Layout,
  LayoutColumn,
  TableOfContents,
  ApiContract,
  ApiSection,
  Mermaid,
  Drawing,
  FileEmbed,
  ResizableImage.configure(IMAGE_OPTIONS),
  StatusMark,
  DocMention,
  UserMention,
  AgentMention,
]);

/**
 * The schema's shape — every node and mark with its content expression,
 * group and attribute names — hashed (FNV-1a, so the browser can compute it
 * too). A draft records the version it was written with; a client on another
 * version would silently drop what it does not know.
 */
export function schemaVersion(schema: Schema): string {
  const shape: unknown[] = [];
  schema.spec.nodes.forEach((name, spec) =>
    shape.push([name, spec.content ?? '', spec.group ?? '', Object.keys(spec.attrs ?? {}).sort()]),
  );
  schema.spec.marks.forEach((name, spec) => shape.push([name, Object.keys(spec.attrs ?? {}).sort()]));
  let hash = 0x811c9dc5;
  for (const ch of JSON.stringify(shape)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const SCHEMA_VERSION = schemaVersion(editorSchema);

/** The Y.XmlFragment a shared draft keeps the page body in (#80): what the server seeds and the editor binds. */
export const BODY_FIELD = 'body';

/**
 * markdown → ProseMirror document, the way the editor opens a page. The DOM is
 * handed in (jsdom on the server, `window.document` in a browser) so this
 * package never picks one.
 */
export function parseMarkdown(md: string, document: Document): PMNode {
  const body = document.createElement('body');
  body.innerHTML = markdownToHtml(md);
  return PMDOMParser.fromSchema(editorSchema).parse(body);
}
