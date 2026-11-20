import { uiStrings as s } from './strings'
import type { ViewAction } from './view-model'

/** Position the two quote actions inside the visible transcript, beside a single message selection. */
export function selectionToolbar(chat: HTMLElement, session: () => string | undefined, post: (action: ViewAction) => void) {
  const bar = document.createElement('div')
  bar.className = 'selection-toolbar'
  bar.setAttribute('role', 'group')
  bar.hidden = true
  const add = document.createElement('button')
  const ask = document.createElement('button')
  bar.append(add, ask)
  document.body.append(bar)
  let quote: { session: string; id: string; text: string } | undefined
  const hide = () => { bar.hidden = true; quote = undefined }
  const use = (ask: boolean) => {
    if (quote) post({ type: 'quoted', ...quote, ask })
    document.getSelection()?.removeAllRanges()
    hide()
  }
  add.onclick = () => use(false)
  ask.onclick = () => use(true)
  bar.addEventListener('mousedown', event => event.preventDefault())

  function position() {
    const selection = document.getSelection()
    const id = session()
    if (!id || !selection || selection.isCollapsed || selection.rangeCount !== 1) return hide()
    const range = selection.getRangeAt(0)
    const common = range.commonAncestorContainer
    const message = (common instanceof Element ? common : common.parentElement)?.closest<HTMLElement>('[data-quote-entry]')
    const text = selection.toString()
    if (!message || !chat.contains(message) || !text.trim()) return hide()
    const bounds = chat.getBoundingClientRect()
    const rect = range.getBoundingClientRect()
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || !bounds.height) return hide()
    quote = { session: id, id: message.dataset.quoteEntry!, text }
    bar.setAttribute('aria-label', s.selectionActions)
    add.textContent = s.addQuote
    ask.textContent = s.askQuote
    bar.hidden = false
    const size = bar.getBoundingClientRect()
    const left = Math.min(Math.max(4, rect.left), Math.max(4, window.innerWidth - size.width - 4))
    const top = rect.top - size.height - 5
    bar.style.left = `${left}px`
    bar.style.top = `${Math.max(bounds.top, Math.min(top >= bounds.top ? top : rect.bottom + 5, bounds.bottom - size.height))}px`
  }
  let frame = 0
  const refresh = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(position)
  }
  document.addEventListener('selectionchange', refresh)
  chat.addEventListener('scroll', refresh)
  window.addEventListener('resize', refresh)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !bar.hidden) {
      event.stopPropagation()
      document.getSelection()?.removeAllRanges()
      hide()
    }
  })
  return refresh
}
