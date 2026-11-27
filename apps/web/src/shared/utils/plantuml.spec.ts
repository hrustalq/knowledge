import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PlantumlError, plantumlClassicScript, plantumlProblem, plantumlProblemOf } from './plantuml'

/**
 * The PlantUML wrapper (docs/features/87). What is pinned here: PlantUML reports
 * a syntax error by drawing it *inside* an SVG it still returns, so that output
 * has to be recognised; and the export's classic transform has to keep working
 * against the vendored engine, because a module cannot load from `file://`.
 */
const ENGINE = fileURLToPath(new URL('../../../public/plantuml/plantuml.js', import.meta.url))

/** The shape PlantUML returns for a failed parse: green error text, the source echoed, then the message. */
const errorSvg = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><g><text x="5" y="17" fill="#33FF02" xml:space="preserve">${text}</text></g></svg>`

describe('plantumlProblemOf', () => {
  it('leaves a drawn diagram alone', () => {
    expect(plantumlProblemOf('<svg><text fill="#000000">Alice</text></svg>')).toBeNull()
  })

  it('reads the line and PlantUML\'s own wording out of an error drawing', () => {
    const svg = errorSvg(
      'PlantUML version $version$ [From textarea (line 2) ] @startumlclass Foo { Syntax Error? (Assumed diagram type: sequence)',
    )
    expect(plantumlProblemOf(svg)).toEqual({
      line: 2,
      message: 'Syntax Error? (Assumed diagram type: sequence)',
    })
  })

  it('keeps a missing include as its message, with entities decoded', () => {
    const svg = errorSvg(
      'PlantUML version $version$ [From textarea (line 2) ] @startuml!include &lt;C4&#47;Nope&gt; cannot include &lt;C4/Nope&gt;',
    )
    expect(plantumlProblemOf(svg)).toEqual({ line: 2, message: 'cannot include <C4/Nope>' })
  })

  it('names a line but no message when the drawing says only what it always says', () => {
    expect(plantumlProblemOf(errorSvg('PlantUML version $version$ [From textarea (line 9) ] @startuml'))).toEqual({
      line: 9,
      message: '',
    })
  })
})

describe('plantumlProblem', () => {
  it('carries the engine\'s line and message through', () => {
    expect(plantumlProblem(new PlantumlError(4, 'boom'))).toEqual({ line: 4, message: 'boom' })
  })

  it('reads a line out of a thrown error, as the engine words it', () => {
    expect(plantumlProblem(new Error('Rendering error (line 12): nope'))).toEqual({ line: 12, message: 'Rendering error (line 12): nope' })
  })

  it('never throws on a value that is not an error', () => {
    expect(plantumlProblem('plain failure')).toEqual({ line: null, message: 'plain failure' })
  })
})

describe('plantumlClassicScript', () => {
  const module = readFileSync(ENGINE, 'utf8')

  it('exposes the engine\'s exports on window and leaves no module syntax behind', () => {
    const script = plantumlClassicScript(module)
    expect(script).toContain('window.PlantUML={render:C,renderToString:D};')
    expect(script.slice(-200)).not.toContain('export{')
    // Compiles as a classic script: no `import`, no `export`, no top-level await.
    expect(() => new vm.Script(script)).not.toThrow()
  })

  it('refuses an engine with no export statement rather than shipping a script that defines nothing', () => {
    expect(() => plantumlClassicScript('var a = 1;')).toThrow(/no export statement/)
  })
})
