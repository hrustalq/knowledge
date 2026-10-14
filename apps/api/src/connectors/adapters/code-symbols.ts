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
  /**
   * Type-like declarations only (docs/features/46): the supertypes it names, as
   * written with type arguments stripped — `extends`/superclasses/trait bounds/
   * Go embedding in `extends`, `implements` clauses and Rust `impl Trait for`
   * (same file) in `implements`. Absent when the declaration names none.
   */
  extends?: string[];
  implements?: string[];
  /** Member names — methods and fields — capped; what a class diagram draws in the box. */
  members?: string[];
}

/** Members kept per type. A class diagram box with forty rows is a table nobody reads. */
const MAX_MEMBERS = 12;

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
  if (language === 'rust') attachRustImpls(tree, out);
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
  out.push({ kind, name, signature: signatureOf(node), exported, ...typeFacts(node) });
}

// --- inheritance and members (docs/features/46) ---

/** `Base<T>` -> `Base`, `pkg.Base` stays. What a diagram edge points at is the name. */
function typeName(node: Node | null | undefined): string | null {
  const text = node?.text.replace(/^\*/, '').split(/[<[(]/)[0].trim();
  return text && /^[\p{L}_$][\p{L}\p{N}_$.:]*$/u.test(text) ? text : null;
}

function names(nodes: Array<Node | null | undefined>): string[] {
  return [...new Set(nodes.map(typeName).filter((n): n is string => !!n))];
}

function children(node: Node | null | undefined, type?: string): Node[] {
  return (node?.namedChildren ?? []).filter((c): c is Node => !!c && (!type || c.type === type));
}

/**
 * Supertypes and members, for the declaration types that have them.
 *
 * Read off real trees (the shapes are in the spec), per grammar, because they
 * disagree: TypeScript nests `extends_clause` under `class_heritage`, Java hangs
 * `superclass` and `super_interfaces` off fields, Python lists bases as call
 * arguments, Go embeds a type as a field with no name.
 */
function typeFacts(node: Node): Pick<CodeSymbol, 'extends' | 'implements' | 'members'> {
  const facts: Pick<CodeSymbol, 'extends' | 'implements' | 'members'> = {};
  let ext: string[] = [];
  let impl: string[] = [];
  let members: string[] = [];

  switch (node.type) {
    case 'class_declaration':
    case 'abstract_class_declaration': {
      // TypeScript / JavaScript
      const heritage = children(node, 'class_heritage')[0];
      if (heritage) {
        ext = names(children(heritage, 'extends_clause').map((c) => c.childForFieldName('value') ?? c.namedChildren[0]));
        impl = names(children(heritage, 'implements_clause').flatMap((c) => children(c)));
      }
      // Java
      const superclass = node.childForFieldName('superclass');
      if (superclass) ext = names(children(superclass));
      const interfaces = node.childForFieldName('interfaces');
      if (interfaces) impl = names(children(interfaces).flatMap((c) => (c.type === 'type_list' ? children(c) : [c])));
      members = memberNames(node.childForFieldName('body'));
      break;
    }
    case 'interface_declaration': {
      ext = names([
        ...children(node, 'extends_type_clause').flatMap((c) => children(c)),
        ...children(node, 'extends_interfaces').flatMap((c) => children(c).flatMap((l) => children(l))),
      ]);
      members = memberNames(node.childForFieldName('body'));
      break;
    }
    case 'class_definition': {
      // Python: bases are positional arguments; `metaclass=` is a keyword and not a base.
      ext = names(children(node.childForFieldName('superclasses')).filter((c) => c.type !== 'keyword_argument'));
      members = memberNames(node.childForFieldName('body'));
      break;
    }
    case 'struct_item':
      members = memberNames(node.childForFieldName('body'));
      break;
    case 'trait_item':
      ext = names(children(node.childForFieldName('bounds')));
      members = memberNames(node.childForFieldName('body'));
      break;
    case 'type_declaration': {
      // Go: `type S struct { Base; x int }` — a field with no name is an embedding.
      const type = children(node, 'type_spec')[0]?.childForFieldName('type');
      if (type?.type === 'struct_type') {
        const fields = children(children(type, 'field_declaration_list')[0], 'field_declaration');
        ext = names(fields.filter((f) => !f.childForFieldName('name')).map((f) => f.childForFieldName('type')));
        members = fields.flatMap((f) => (f.childForFieldName('name') ? [f.childForFieldName('name')!.text] : []));
      } else if (type?.type === 'interface_type') {
        ext = names(children(type, 'type_elem').flatMap((e) => children(e)));
        members = children(type, 'method_elem').flatMap((m) => (m.childForFieldName('name') ? [m.childForFieldName('name')!.text] : []));
      }
      break;
    }
    default:
      return facts;
  }

  if (ext.length > 0) facts.extends = ext;
  if (impl.length > 0) facts.implements = impl;
  if (members.length > 0) facts.members = [...new Set(members)].slice(0, MAX_MEMBERS);
  return facts;
}

/** The names declared directly inside a type's body, in source order. */
function memberNames(body: Node | null | undefined): string[] {
  const out: string[] = [];
  for (const child of children(body)) {
    const inner = child.type === 'decorated_definition' ? (child.childForFieldName('definition') ?? child) : child;
    const name = inner.childForFieldName('name')?.text;
    if (name) {
      out.push(name);
      continue;
    }
    // Java fields keep the name on a declarator.
    const declarator = children(inner, 'variable_declarator')[0]?.childForFieldName('name')?.text;
    if (declarator) out.push(declarator);
  }
  return out;
}

/**
 * Rust says what a type implements in a separate `impl Trait for Type` block.
 * Attached to the type when both are in the same file; a trait implemented in
 * another file is not knowable from this one, and is simply absent.
 */
function attachRustImpls(tree: Tree, out: CodeSymbol[]): void {
  for (const node of children(tree.rootNode, 'impl_item')) {
    const trait = typeName(node.childForFieldName('trait'));
    const target = typeName(node.childForFieldName('type'));
    if (!trait || !target) continue;
    const symbol = out.find((s) => s.name === target && (s.kind === 'struct' || s.kind === 'enum'));
    if (!symbol) continue;
    symbol.implements = [...new Set([...(symbol.implements ?? []), trait])];
  }
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
