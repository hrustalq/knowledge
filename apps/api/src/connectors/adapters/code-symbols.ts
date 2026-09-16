import type { Node, Tree } from 'web-tree-sitter';
import type { CodeLanguage } from './tree-sitter.service.js';

/**
 * What a source file declares, read off its syntax tree (docs/features/27).
 *
 * This is the deterministic half of the feature. Everything here is a fact the
 * parser produced — a name, a kind, the text of a signature — with no model
 * involved, which is what makes a codebase page useful even when the workspace
 * has no AI configured at all.
 *
 * The per-language tables below were read off real trees rather than assumed;
 * the grammars disagree more than you would expect. Go hangs the name of a type
 * on a `type_spec` child rather than on `type_declaration`. Python has no export
 * concept, so the leading-underscore convention is the only signal there is.
 * Rust marks visibility with a `pub` prefix on otherwise identical `*_item`
 * nodes. JavaScript and TypeScript wrap the real declaration in an
 * `export_statement`, so the name lives one level down.
 */

export interface CodeSymbol {
  /** 'function' | 'class' | 'interface' | 'type' | 'method' | 'const' | ... */
  kind: string;
  name: string;
  /** One line, body removed — enough to know how to call it. */
  signature: string;
  /** Part of the module's public surface, by that language's own rule. */
  exported: boolean;
}

/** Declaration node type -> the kind we report it as, per language family. */
const ECMA_KINDS: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  lexical_declaration: 'const',
  variable_declaration: 'const',
  abstract_class_declaration: 'class',
};

const PYTHON_KINDS: Record<string, string> = {
  function_definition: 'function',
  class_definition: 'class',
  decorated_definition: 'function',
};

const GO_KINDS: Record<string, string> = {
  function_declaration: 'function',
  method_declaration: 'method',
  type_declaration: 'type',
};

const RUST_KINDS: Record<string, string> = {
  function_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  type_item: 'type',
  mod_item: 'module',
};

export function extractSymbols(language: CodeLanguage, tree: Tree): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  for (const node of tree.rootNode.namedChildren) {
    if (!node) continue;
    switch (language) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        collectEcma(node, out);
        break;
      case 'python':
        collectSimple(node, PYTHON_KINDS, out, (name) => !name.startsWith('_'));
        break;
      case 'go':
        collectGo(node, out);
        break;
      case 'rust':
        collectSimple(node, RUST_KINDS, out, (_name, n) => n.text.startsWith('pub'));
        break;
      default:
        collectGeneric(node, out);
    }
  }
  return out;
}

/**
 * The module's imports, as written.
 *
 * Bare specifiers (`react`, `fmt`) are dependencies on the outside world;
 * relative ones (`./thing`) are internal edges the caller resolves against the
 * module map. Both are returned verbatim — deciding which is which needs the
 * repository layout, which this file deliberately knows nothing about.
 */
export function extractImports(language: CodeLanguage, tree: Tree): string[] {
  const out = new Set<string>();
  const visit = (node: Node, depth: number): void => {
    if (depth > 2) return; // imports live at the top; do not walk whole bodies
    const type = node.type;
    if (
      type === 'import_statement' ||
      type === 'import_from_statement' ||
      type === 'import_declaration' ||
      type === 'import_spec' ||
      type === 'use_declaration'
    ) {
      const literal = firstString(node);
      if (literal) out.add(literal);
    }
    for (const child of node.namedChildren) if (child) visit(child, depth + 1);
  };
  visit(tree.rootNode, 0);
  return [...out];
}

// --- per-language collectors ---

function collectEcma(node: Node, out: CodeSymbol[]): void {
  if (node.type === 'export_statement') {
    const decl = node.namedChildren.find((c) => c && ECMA_KINDS[c.type]);
    if (decl) push(out, ECMA_KINDS[decl.type], nameOf(decl), decl, true);
    return;
  }
  const kind = ECMA_KINDS[node.type];
  if (kind) push(out, kind, nameOf(node), node, false);
}

function collectGo(node: Node, out: CodeSymbol[]): void {
  const kind = GO_KINDS[node.type];
  if (!kind) return;
  // `type Server struct{...}` hangs the name on a type_spec child.
  const spec = node.namedChildren.find((c) => c?.type === 'type_spec');
  const name = spec ? (spec.childForFieldName('name')?.text ?? '') : nameOf(node);
  if (!name) return;
  // Go's export rule is the identifier's own case, and it is exact.
  push(out, kind, name, node, /^\p{Lu}/u.test(name));
}

function collectSimple(
  node: Node,
  kinds: Record<string, string>,
  out: CodeSymbol[],
  isExported: (name: string, node: Node) => boolean,
): void {
  const kind = kinds[node.type];
  if (!kind) return;
  const name = nameOf(node);
  if (!name) return;
  push(out, kind, name, node, isExported(name, node));
}

/**
 * Everything else: Java, Ruby, PHP, C#, C++, shell.
 *
 * One rule — a top-level node whose type reads like a declaration and which
 * carries a `name` field — rather than five more hand-built tables. It is
 * coarser than the tables above and deliberately so: a wrong kind label on a
 * page is a cosmetic problem, whereas five tables nobody verified against a real
 * tree would be four more chances to be confidently wrong.
 */
function collectGeneric(node: Node, out: CodeSymbol[]): void {
  if (!/_(declaration|definition|item|specifier)$/.test(node.type)) return;
  const name = nameOf(node);
  if (!name) return;
  push(out, node.type.replace(/_(declaration|definition|item|specifier)$/, ''), name, node, true);
}

// --- helpers ---

function nameOf(node: Node): string {
  const direct = node.childForFieldName('name')?.text;
  if (direct) return direct;
  // `export const x = …` keeps the name on the declarator.
  const declarator = node.namedChildren.find((c) => c?.type === 'variable_declarator');
  return declarator?.childForFieldName('name')?.text ?? '';
}

function firstString(node: Node): string | null {
  const stack = [...node.namedChildren];
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) continue;
    if (current.type.includes('string')) {
      const text = current.text.replace(/^["'`]|["'`]$/g, '');
      if (text) return text;
    }
    stack.push(...current.namedChildren);
  }
  return null;
}

function push(out: CodeSymbol[], kind: string, name: string, node: Node, exported: boolean): void {
  if (!name) return;
  out.push({ kind, name, signature: signatureOf(node), exported });
}

/**
 * The declaration without its body: everything up to the brace, colon or equals
 * that opens one, on one line. A signature is what a reader needs; a body is
 * what they opened the file for.
 */
function signatureOf(node: Node): string {
  const firstLine = node.text.split('\n')[0].trim();
  const cut = firstLine.search(/\s*[{=]\s*$|\s*\{/);
  const trimmed = (cut > 0 ? firstLine.slice(0, cut) : firstLine).trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}
