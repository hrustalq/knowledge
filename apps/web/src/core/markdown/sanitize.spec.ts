// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import DOMPurify from 'dompurify'
import { SANITIZE_CONFIG, markdownToHtml } from './render'
import { KN, carryDiagramLayout } from './nodes'

// #1098: SANITIZE_CONFIG guards every surface that renders someone else's
// markdown on the app's origin — a viewer's comment, a merge-request
// description, model output, a share link. Markup that restyles the app or
// posts a form elsewhere must not survive it.
const sanitize = (html: string) => DOMPurify.sanitize(html, { ...SANITIZE_CONFIG })

describe('SANITIZE_CONFIG', () => {
  it.each([
    // After content: a leading <style> is hoisted out by the parser and would pass on its own.
    ['style', '<p>x</p><style>body{display:none}</style>'],
    ['form', '<form action="https://evil.example/collect"><p>x</p></form>'],
    ['input', '<input name="password" type="password">'],
    ['button', '<button type="submit">Sign in</button>'],
    ['textarea', '<textarea>x</textarea>'],
    ['select', '<select><option>a</option></select>'],
    ['option', '<option>a</option>'],
    ['object', '<object data="https://evil.example/x.pdf"></object>'],
  ])('drops <%s>', (tag, html) => {
    expect(sanitize(html)).not.toMatch(new RegExp(`<${tag}[\\s>]`, 'i'))
  })

  it('keeps the text a dropped form held', () => {
    expect(sanitize('<form action="https://evil.example/"><p>kept</p></form>')).toContain('<p>kept</p>')
  })

  it.each([
    ['style', '<div style="position:fixed;inset:0;opacity:0">x</div>'],
    ['id', '<div id="app">x</div>'],
    ['name', '<a name="top" href="https://example.com/">x</a>'],
  ])('drops the %s attribute', (attr, html) => {
    expect(sanitize(html)).not.toMatch(new RegExp(`\\s${attr}=`, 'i'))
  })

  it('drops a <style> smuggled inside inline SVG', () => {
    expect(sanitize('<svg><style>a{color:red}</style><circle r="1"></circle></svg>')).not.toContain('<style')
  })

  it('still keeps table alignment, which marked writes as align, not style', () => {
    const html = sanitize(markdownToHtml('| a | b |\n|:-:|--:|\n| 1 | 2 |'))
    expect(html).toMatch(/<th align="center">a<\/th>/)
    expect(html).toMatch(/<td align="right">2<\/td>/)
  })

  it('still keeps every rich block marker', () => {
    const html = sanitize(markdownToHtml('> [!NOTE]\n> hi'))
    expect(html).toContain(`${KN.panel}="note"`)
  })

  it('keeps the diagram width through sanitizing and the read view', () => {
    const html = sanitize(markdownToHtml('```mermaid width=480 wrap=right\ngraph TD; A-->B\n```'))
    // The inline style the pipeline wrote is stripped like any other…
    expect(html).not.toContain('style=')
    // …but the data attributes survive, and the read view puts the width back.
    const host = document.createElement('div')
    host.innerHTML = html
    const block = host.querySelector(`[${KN.mermaid}]`)!
    const figure = document.createElement('div')
    carryDiagramLayout(block, figure)
    expect(figure.getAttribute('style')).toBe('--kn-diagram-width: 480px')
    expect(figure.getAttribute(KN.wrap)).toBe('right')
  })
})
