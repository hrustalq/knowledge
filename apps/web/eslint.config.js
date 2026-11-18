// ESLint here exists for three jobs: keep UI copy in the i18n catalogs (#85,
// docs/features/18-i18n.md), keep API calls on the one typed client (#472),
// and keep "may I" with the API rather than the workspace role (#1299).
// General linting stays with vue-tsc; this config deliberately enables nothing
// else.
//
// Existing violations live in eslint-suppressions.json — a shrink-only
// baseline like `make deps-baseline`: `pnpm lint:i18n-baseline` prunes fixed
// entries, and a NEW violation fails `make verify`. Never re-run
// `--suppress-all` to hide one; translate it.
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

// Symbols and brand names that are the same in every language.
const RAW_TEXT_IGNORE = [
  // punctuation and keycaps
  '·', '→', '←', '—', '–', '−', '×', '/', '/ −', '…', '•', '|', ':', '(', ')', '+', '-', '#', '@', '~', '“', '”', '↵',
  'Esc', 'H', 'J', 'P', 'V',
  // brand, protocol and file names
  'Knowledge', 'MCP', 'GitHub', 'GitLab', 'Markdown', 'DeepSeek', 'GenAPI (gen-api.ru)', 'Streamable HTTP', 'URL', 'SKILL.md',
  // env assignments shown verbatim to operators
  'ASSISTANT_PROVIDER=openai-compatible', 'ASSISTANT_PROVIDER=none',
  // example names in placeholders
  'Jira', 'DeepSeek prod', 'Authorization',
]


// Dates, numbers, sizes and lists go through shared/utils/format.ts: a locale-less
// `toLocale*()` follows the host (the server, during SSR — a hydration
// mismatch), and a second `new Intl.*` is a second place deciding the locale.
const LOCALE_FORMATTING = [
  'error',
  {
    selector: "CallExpression[callee.property.name=/^toLocale(String|DateString|TimeString)$/]",
    message: 'Use the shared/utils/format.ts wrappers (formatNumber, formatDate, …) — a locale-less toLocale*() is a hydration mismatch.',
  },
  {
    selector: "NewExpression[callee.object.name='Intl']",
    message: 'Add a helper to shared/utils/format.ts instead of building Intl formatters here.',
  },
]

// One HTTP client (#472): reads go through the generated client and the query
// cache, so they are typed, deduped and reached by live invalidation. A raw
// fetch is allowed only in RAW_FETCH_OK, each with a comment saying why.
const RAW_FETCH = [
  {
    selector: "CallExpression[callee.name='fetch'], CallExpression[callee.property.name='fetch'][callee.object.name=/^(window|globalThis|self)$/]",
    message: 'Use the generated client (api.* / fetchApi / apiQueryOptions from @/shared/api/queries). Raw fetch is allowlisted in eslint.config.js only where XHR cannot do the job.',
  },
]
const RAW_FETCH_OK = [
  'src/entities/assistant/model/assistant-stream.ts', // a streamed response body
  'src/entities/insight/model/use-page-view.ts', // a keepalive beacon that outlives the tab
  'src/sw.ts', // the service worker passes a navigation through; there is no client in it
  'src/entities/api-operation/components/ApiTryConsole.vue', // try-it: the request is the reader's own
  'src/entities/api-operation/components/ApiTestRun.vue', // the same, for a suite run in the browser
  'src/entry-public.ts', // the public SSR entry: no member client, no credential
  'src/modules/reader/**',
]

// The API owns every "may I" (#1245): a control reads `usePermission(action)`,
// never the caller's role. A comparison of `.role` / `.myRole` against a role
// literal is how a rule gets rebuilt by hand, so it fails here, in a template as
// much as in a script. `no-restricted-syntax` never visits a template and
// eslint-plugin-vue is not installed, hence this small rule: vue-eslint-parser
// hands it the template's expressions directly. Showing a role (a badge, a
// "no grant needed" note) is allowed in ROLE_LABELS only.
const ROLE_LITERALS = new Set(['admin', 'editor', 'viewer', 'guest'])
const unchain = (n) => (n?.type === 'ChainExpression' ? n.expression : n)
const isRoleRead = (n) =>
  unchain(n)?.type === 'MemberExpression' && !unchain(n).computed && ['role', 'myRole'].includes(unchain(n).property.name)
const isRoleLiteral = (n) => n?.type === 'Literal' && ROLE_LITERALS.has(n.value)
const noRoleLiteral = {
  meta: {
    type: 'problem',
    messages: {
      role: 'Ask the API, not the role: read usePermission(\'<resource>:<action>\') from @/stores/permissions. A role shown as a label belongs in ROLE_LABELS (eslint.config.js).',
    },
  },
  create(context) {
    const BinaryExpression = (node) => {
      if (!['==', '===', '!=', '!=='].includes(node.operator)) return
      if ((isRoleRead(node.left) && isRoleLiteral(node.right)) || (isRoleRead(node.right) && isRoleLiteral(node.left))) {
        context.report({ node, messageId: 'role' })
      }
    }
    const services = context.sourceCode.parserServices
    return services?.defineTemplateBodyVisitor
      ? services.defineTemplateBodyVisitor({ BinaryExpression }, { BinaryExpression })
      : { BinaryExpression }
  },
}
const ROLE_LABELS = [
  'src/modules/access/components/AccessRoles.vue', // the role matrix: members grouped and badged by role
  'src/modules/access/components/AccessGroups.vue', // a guest badge on a group member
  'src/modules/access/pages/AccessControlPage.vue', // "admins need no grant", beside an admin's row
]

// The app's catalogs, and the public reader's own small one (docs/features/43):
// kept apart so a reader's bundle never carries the app's whole catalog. The UI
// kit's `ui.*` keys are its own (packages/ui/src/messages): app code reads none.
const I18N_LOCALE_DIR = ['./src/shared/i18n/messages/*.json', './src/shared/i18n/reader/*.json']

export default [
  // Pre-existing disable comments belong to no configured rule here.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  { ignores: ['dist/**', 'node_modules/**', 'src/modules/help/docs/content/**'] },
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, sourceType: 'module', extraFileExtensions: ['.vue'] },
    },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: {
      'vue-i18n': { localeDir: I18N_LOCALE_DIR, messageSyntaxVersion: '^11.0.0' },
    },
    rules: {
      '@intlify/vue-i18n/no-raw-text': [
        'error',
        {
          // Punctuation-only, or an example value in a placeholder: an address,
          // a URL, a slug or an entity key (`service:identity`) — the same in
          // every language (#85 keeps them English on purpose).
          ignorePattern:
            '^(?:[\\s\\d.,:;!?·→←—–×/…•|()+\\-#@%&*=<>\\[\\]{}"\'`]*|\\S+@example\\.com|https?://\\S+|[a-z0-9.-]+\\.example\\.com|[a-z]+(?:[-:][a-z0-9-]+)+|[a-z]+(?:, [a-z]+)+)$',
          ignoreText: RAW_TEXT_IGNORE,
          // Static attributes a reader or a screen reader sees.
          attributes: { '/.+/': ['title', 'aria-label', 'placeholder', 'alt'] },
        },
      ],
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-restricted-syntax': [...LOCALE_FORMATTING, ...RAW_FETCH],
    },
  },
  {
    files: ['src/**/*.vue', 'src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/**/*.d.ts', ...ROLE_LABELS],
    plugins: { knowledge: { rules: { 'no-role-literal': noRoleLiteral } } },
    rules: { 'knowledge/no-role-literal': 'error' },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
    languageOptions: { parser: tseslint.parser, sourceType: 'module' },
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: {
      'vue-i18n': { localeDir: I18N_LOCALE_DIR, messageSyntaxVersion: '^11.0.0' },
    },
    rules: {
      '@intlify/vue-i18n/no-missing-keys': 'error',
      'no-restricted-syntax': [...LOCALE_FORMATTING, ...RAW_FETCH],
    },
  },
  {
    files: RAW_FETCH_OK,
    rules: { 'no-restricted-syntax': LOCALE_FORMATTING },
  },
  {
    // The one place allowed to build Intl formatters.
    files: ['src/shared/utils/format.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // A module's, an entity's or a widget's index.ts is its public surface and nothing else
    // (docs/architecture/11): named re-exports from the module's own files. The
    // build marks it side-effect free (vite.config.ts), which only pays off while
    // it declares nothing itself: an importer of one declaration would include
    // the whole index, eager re-exports and all. A lazily loaded component is
    // declared in components/lazy.ts and re-exported.
    files: ['src/{modules,entities,widgets}/*/index.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportAllDeclaration', message: 'Name each export: an index never re-exports with `export *`.' },
        {
          selector: 'Program > :not(ExportNamedDeclaration[source])',
          message: 'A module index only re-exports (`export { x } from …`): declare in the module, re-export here.',
        },
      ],
    },
  },
  {
    // core/ is plain TypeScript (#566, docs/architecture/11): the import half
    // of that is `core-is-pure` in .dependency-cruiser.cjs, the DOM half is here.
    files: ['src/core/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'matchMedia', 'requestAnimationFrame'].map(
          (name) => ({ name, message: 'core/ runs without a DOM — take the value as an argument, or move this to shared/.' }),
        ),
      ],
    },
  },
]
