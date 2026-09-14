/** Markdown 渲染：markdown-it + 引用角标高亮 */

import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
})

const CITATION = /\[([A-Z]+\d+_\d+-\d+)\]/g

/** 把 [WEB1_1-2] 这类引用编号渲染成可点击的角标 */
function decorateCitations(html: string): string {
  return html.replace(CITATION, (_, id: string) => {
    const kind = id.startsWith('LOC') ? 'citation local' : 'citation'
    return `<span class="${kind}" data-citation="${id}" title="来源 ${id}">${id}</span>`
  })
}

/** 参考列表里的 [- \[WEB1_1-2\]](url) 形式保持原样，交给普通链接渲染 */
export function renderMarkdown(input: string): string {
  if (!input) return ''
  const html = md.render(input)
  return decorateCitations(html)
}

export function renderInline(input: string): string {
  if (!input) return ''
  return decorateCitations(md.renderInline(input))
}
