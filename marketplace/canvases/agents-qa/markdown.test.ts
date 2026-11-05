import { describe, expect, it } from 'vitest'
import { githubRef, parseBlocks, parseInline, plainText } from './markdown.ts'

describe('markdown', () => {
  it('keeps only http links and reads GitHub URLs as references', () => {
    expect(parseInline('see [docs](javascript:alert(1)) and https://github.com/microsoft/vscode/pull/344939.')).toEqual([
      { kind: 'text', text: 'see [docs](javascript:alert(1)) and ' },
      { kind: 'link', href: 'https://github.com/microsoft/vscode/pull/344939', children: [{ kind: 'text', text: 'microsoft/vscode#344939' }] },
      { kind: 'text', text: '.' },
    ])
    expect(githubRef('https://github.com/microsoft/vscode/issues/1')).toBe('microsoft/vscode#1')
    expect(githubRef('https://example.com/a/b/issues/1')).toBeNull()
  })

  it('reads lists, paragraphs, and fenced code, and keeps an unclosed fence as code', () => {
    expect(parseBlocks('Intro\nmore\n\n- a\n- b\n\n```sh\nmkdir -p ~/demo\n```\n1. one\n   two\n\n~~~\nopen')).toEqual([
      { kind: 'p', lines: ['Intro', 'more'] },
      { kind: 'ul', items: ['a', 'b'] },
      { kind: 'code', text: 'mkdir -p ~/demo' },
      { kind: 'ol', items: ['one two'] },
      { kind: 'code', text: 'open' },
    ])
  })

  it('shows only the label of links that are not http', () => {
    expect(parseInline('Details: [W4-root-cause.md](W4-root-cause.md) and [x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: 'Details: ' },
      { kind: 'text', text: 'W4-root-cause.md' },
      { kind: 'text', text: ' and [x](javascript:alert(1))' },
    ])
  })

  it('strips markup for plain text', () => {
    expect(plainText('The **Uninstall** button on `org` plugins [fails](https://x.test)')).toBe('The Uninstall button on org plugins fails')
  })
})
