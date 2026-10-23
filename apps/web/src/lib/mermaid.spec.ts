import { describe, expect, it } from 'vitest'
import { mermaidProblem } from './mermaid'

describe('mermaidProblem', () => {
  it('reads the line and the expectation from jison and langium errors', () => {
    const jison = new Error("Parse error on line 3:\n...-o{ B : has  B }|..|\n----------------------^\nExpecting 'ZERO_OR_ONE', got '|'")
    expect(mermaidProblem(jison, 'erDiagram\n  A ||--o{ B : has\n  B }|..|')).toEqual({
      line: 3,
      message: "Expecting 'ZERO_OR_ONE', got '|'",
    })

    const langium = new Error("Parsing failed:  Parse error on line 3, column 7: Expecting token of type ':' but found `2`.")
    expect(mermaidProblem(langium, 'pie\n  "a" : 1\n  "b" 2').line).toBe(3)
    expect(mermaidProblem(langium, '').message).toBe("Expecting token of type ':' but found `2`.")

    const unknown = new Error('No diagram type detected matching given configuration for text: nonsense')
    expect(mermaidProblem(unknown, 'nonsense')).toEqual({ line: null, message: unknown.message })
  })

  it('counts lines from the top of the source, frontmatter included, never past the end', () => {
    const source = '---\ntitle: x\n---\ngraph TD\n  A --> B\n  B --'
    expect(mermaidProblem(new Error('Parse error on line 2:\nExpecting x'), source).line).toBe(5)
    expect(mermaidProblem(new Error('Parse error on line 4:\nExpecting x'), source).line).toBe(6)
  })
})
