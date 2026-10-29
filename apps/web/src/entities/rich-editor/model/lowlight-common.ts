import type { LanguageFn } from 'lowlight'
import arduino from 'highlight.js/lib/languages/arduino'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import graphql from 'highlight.js/lib/languages/graphql'
import kotlin from 'highlight.js/lib/languages/kotlin'
import less from 'highlight.js/lib/languages/less'
import lua from 'highlight.js/lib/languages/lua'
import makefile from 'highlight.js/lib/languages/makefile'
import objectivec from 'highlight.js/lib/languages/objectivec'
import perl from 'highlight.js/lib/languages/perl'
import php from 'highlight.js/lib/languages/php'
import phpTemplate from 'highlight.js/lib/languages/php-template'
import pythonRepl from 'highlight.js/lib/languages/python-repl'
import r from 'highlight.js/lib/languages/r'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import swift from 'highlight.js/lib/languages/swift'
import vbnet from 'highlight.js/lib/languages/vbnet'
import wasm from 'highlight.js/lib/languages/wasm'

/**
 * The part of lowlight's `common` set that `lowlight.ts` does not register up
 * front — its own chunk, imported only when a code block names one of these.
 * Together with `EAGER` it is exactly `common`, so no language that used to
 * highlight stops.
 */
export const rest: Record<string, LanguageFn> = {
  arduino,
  c,
  cpp,
  csharp,
  graphql,
  kotlin,
  less,
  lua,
  makefile,
  objectivec,
  perl,
  php,
  'php-template': phpTemplate,
  'python-repl': pythonRepl,
  r,
  ruby,
  rust,
  scss,
  swift,
  vbnet,
  wasm,
}
