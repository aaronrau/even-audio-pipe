import { measureTextWrap } from '@evenrealities/pretext'
import {
  normalizeHistoryBlock,
  normalizeInlineText,
  type HistoryEntry,
} from './historyText'

export {
  normalizeHistoryBlock,
  normalizeInlineText,
  type HistoryEntry,
} from './historyText'

export type HistoryScrollDirection = -1 | 1

export type HistoryCanvasDebug = {
  contentLength: number
  lineStart: number
  lineEnd: number
  totalLines: number
  visibleLines: number
  maxScrollTopLine: number
  pinnedToBottom: boolean
  revision: number
}

type HistoryCanvasOptions = {
  width: number
  height: number
  lineHeight?: number
  visibleLineCount?: number
  scrollOverlapLines?: number
  maxContentLength?: number
  showPageContinuation?: boolean
}

type HistoryLogicalLine = {
  content: string
  contextPrefix: string
}

type HistoryVisualLine = {
  content: string
  contextPrefix: string
}

const DEFAULT_LINE_HEIGHT = 27
const DEFAULT_MAX_CONTENT_LENGTH = 2000
const PAGE_CONTINUATION_ARROW = '↑'
const PAGE_CONTINUATION_ARROW_DOWN = '↓'

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function formatHistoryTime(receivedAt: number) {
  const date = new Date(receivedAt)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function formatHistoryLines(time: string, label: string, text: string): HistoryLogicalLine[] {
  const displayText = normalizeHistoryBlock(text)
  const prefix = label ? `${time} ${label}` : time
  if (!displayText) return [{ content: prefix, contextPrefix: prefix }]

  const [firstLine, ...remainingLines] = displayText.split('\n')
  return [
    { content: `${prefix} ${firstLine}`, contextPrefix: prefix },
    ...remainingLines.map(line => ({ content: line, contextPrefix: prefix })),
  ]
}

function splitLinePrefix(line: string) {
  const match = line.match(/^((?:\d{2}:\d{2}\s+\S+|Queued:)\s+)(.*)$/)
  if (!match) {
    return { prefix: '', body: line }
  }

  return {
    prefix: match[1],
    body: match[2],
  }
}

function hasRenderedPrefix(line: string, prefix: string) {
  return !!prefix && (line === prefix || line.startsWith(`${prefix} `))
}

export class HistoryCanvas {
  private readonly width: number
  private readonly visibleLineCount: number
  private readonly scrollStepLines: number
  private readonly maxContentLength: number
  private readonly showPageContinuation: boolean
  private entries: HistoryEntry[] = []
  private pendingTranscript = ''
  private visualLines: HistoryVisualLine[] = [{ content: 'No messages', contextPrefix: '' }]
  private scrollTopLine = 0
  private pinnedToBottom = true
  private revision = 0

  constructor(options: HistoryCanvasOptions) {
    this.width = options.width
    this.visibleLineCount = options.visibleLineCount
      ? Math.max(1, Math.floor(options.visibleLineCount))
      : Math.max(
        1,
        Math.floor(options.height / (options.lineHeight ?? DEFAULT_LINE_HEIGHT)),
      )
    this.scrollStepLines = Math.max(
      1,
      this.visibleLineCount - (options.scrollOverlapLines ?? 1),
    )
    this.maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH
    this.showPageContinuation = options.showPageContinuation ?? false
  }

  replaceEntries(entries: HistoryEntry[], anchorToBottom = true) {
    this.entries = entries.slice()
    this.rebuild(anchorToBottom)
  }

  appendEntry(entry: HistoryEntry, anchorToBottom = true) {
    this.entries.push(entry)
    this.rebuild(anchorToBottom)
  }

  setPendingTranscript(text: string, anchorToBottom = true) {
    this.pendingTranscript = normalizeInlineText(text)
    this.rebuild(anchorToBottom)
  }

  clearPendingTranscript(anchorToBottom = true) {
    this.pendingTranscript = ''
    this.rebuild(anchorToBottom)
  }

  scrollToBottom() {
    this.scrollTopLine = this.maxScrollTop()
    this.pinnedToBottom = true
  }

  scrollToTop() {
    this.scrollTopLine = 0
    this.pinnedToBottom = this.scrollTopLine >= this.maxScrollTop()
  }

  scroll(direction: HistoryScrollDirection) {
    const previousTopLine = this.scrollTopLine
    const delta = direction < 0 ? -this.scrollStepLines : this.scrollStepLines
    this.scrollTopLine = clamp(
      this.scrollTopLine + delta,
      0,
      this.maxScrollTop(),
    )
    this.pinnedToBottom = this.scrollTopLine >= this.maxScrollTop()

    return {
      previousTopLine,
      currentTopLine: this.scrollTopLine,
      content: this.content(),
    }
  }

  content() {
    return this.visibleLines().join('\n')
  }

  debug(content = this.content()): HistoryCanvasDebug {
    const lineEnd = Math.min(
      this.visualLines.length,
      this.scrollTopLine + this.visibleLineCount,
    )
    return {
      contentLength: content.length,
      lineStart: this.visualLines.length ? this.scrollTopLine + 1 : 0,
      lineEnd,
      totalLines: this.visualLines.length,
      visibleLines: content ? content.split('\n').length : 0,
      maxScrollTopLine: this.maxScrollTop() + 1,
      pinnedToBottom: this.pinnedToBottom,
      revision: this.revision,
    }
  }

  private rebuild(anchorToBottom: boolean) {
    const previousMaxTop = this.maxScrollTop()
    const wasPinnedToBottom = this.scrollTopLine >= previousMaxTop
    this.visualLines = this.buildVisualLines()
    this.revision += 1

    if (anchorToBottom || wasPinnedToBottom) {
      this.scrollToBottom()
      return
    }

    this.scrollTopLine = clamp(this.scrollTopLine, 0, this.maxScrollTop())
    this.pinnedToBottom = this.scrollTopLine >= this.maxScrollTop()
  }

  private historyRows() {
    const rows = this.entries
      .slice()
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .flatMap(entry => formatHistoryLines(
        formatHistoryTime(entry.receivedAt),
        entry.label,
        entry.detail || entry.text,
      ))

    if (this.pendingTranscript) {
      rows.push(...formatHistoryLines('Queued:', '', this.pendingTranscript))
    }

    return rows.length ? rows : [{ content: 'No messages', contextPrefix: '' }]
  }

  private buildVisualLines() {
    const lines = this.historyRows()
      .flatMap(line => this.wrapLine(line.content, line.contextPrefix))

    return lines.length ? lines : [{ content: 'No messages', contextPrefix: '' }]
  }

  private wrapLine(line: string, contextPrefix: string) {
    const normalized = line.replace(/[ \t]+/g, ' ').trim()
    if (!normalized) return []

    const { prefix, body } = splitLinePrefix(normalized)
    const content = body || normalized
    const visualLines: HistoryVisualLine[] = []
    let current = ''
    let firstLinePrefix = prefix

    for (const word of content.split(' ')) {
      if (!word) continue

      if (!current) {
        if (firstLinePrefix) {
          const prefixedWord = `${firstLinePrefix}${word}`
          if (this.textFitsLine(prefixedWord)) {
            current = prefixedWord
            firstLinePrefix = ''
            continue
          }

          const prefixLine = firstLinePrefix.trimEnd()
          if (prefixLine) {
            const prefixPieces = this.textFitsLine(prefixLine)
              ? [prefixLine]
              : this.splitLongWord(prefixLine)
            visualLines.push(...prefixPieces.map(piece => ({
              content: piece,
              contextPrefix,
            })))
          }
          firstLinePrefix = ''
        }

        if (this.textFitsLine(word)) {
          current = word
        } else {
          const pieces = this.splitLongWord(word)
          visualLines.push(...pieces.slice(0, -1).map(piece => ({
            content: piece,
            contextPrefix,
          })))
          current = pieces.at(-1) ?? ''
        }
        continue
      }

      const candidate = `${current} ${word}`
      if (this.textFitsLine(candidate)) {
        current = candidate
        continue
      }

      visualLines.push({ content: current, contextPrefix })
      if (this.textFitsLine(word)) {
        current = word
      } else {
        const pieces = this.splitLongWord(word)
        visualLines.push(...pieces.slice(0, -1).map(piece => ({
          content: piece,
          contextPrefix,
        })))
        current = pieces.at(-1) ?? ''
      }
    }

    if (current) visualLines.push({ content: current, contextPrefix })
    return visualLines
  }

  private splitLongWord(word: string) {
    const pieces: string[] = []
    let remaining = word

    while (remaining) {
      const chars = Array.from(remaining)
      let low = 1
      let high = chars.length
      let fit = 1

      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const candidate = chars.slice(0, mid).join('')
        if (this.textFitsLine(candidate)) {
          fit = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }

      pieces.push(chars.slice(0, fit).join(''))
      remaining = chars.slice(fit).join('')
    }

    return pieces
  }

  private textFitsLine(text: string) {
    return measureTextWrap(text, this.width).lineCount <= 1
  }

  private visibleLines() {
    this.scrollTopLine = clamp(this.scrollTopLine, 0, this.maxScrollTop())
    this.pinnedToBottom = this.scrollTopLine >= this.maxScrollTop()

    const hasPageContinuationAbove = this.showPageContinuation && this.scrollTopLine > 0
    const hasPageContinuationBelow = this.showPageContinuation && this.scrollTopLine < this.maxScrollTop()
    const hasPageContinuation = hasPageContinuationAbove || hasPageContinuationBelow
    const lines: string[] = []
    for (
      let sourceIndex = this.scrollTopLine;
      sourceIndex < this.visualLines.length && lines.length < this.visibleLineCount;
      sourceIndex += 1
    ) {
      const line = this.visualLines[sourceIndex]
      if (!line) continue

      if (sourceIndex === this.scrollTopLine && hasPageContinuation) {
        lines.push(...this.pageContinuationLines(
          line.contextPrefix,
          line.content,
          hasPageContinuationAbove,
          hasPageContinuationBelow,
        ).slice(0, this.visibleLineCount - lines.length))
        continue
      }

      if (sourceIndex > this.scrollTopLine || hasRenderedPrefix(line.content, line.contextPrefix)) {
        lines.push(line.content)
        continue
      }

      lines.push(this.addPageContext(line.contextPrefix, line.content))
    }

    while (lines.length > 1 && lines.join('\n').length > this.maxContentLength) {
      lines.pop()
    }

    if (lines.join('\n').length > this.maxContentLength) {
      return [lines[0].slice(0, this.maxContentLength)]
    }

    return lines.length ? lines : ['No messages']
  }

  private pageContinuationLines(
    prefix: string,
    content: string,
    showUpArrow: boolean,
    showDownArrow: boolean,
  ) {
    const header = this.pageContinuationHeader(prefix, showUpArrow, showDownArrow)
    if (!prefix) return [content]
    if (header === prefix) return [content]

    let body = content
    if (content.startsWith(`${prefix} `)) {
      body = content.slice(prefix.length + 1)
    } else if (content.startsWith(prefix)) {
      body = content.slice(prefix.length)
    }

    const withBody = body ? `${header} ${body}` : header
    if (this.textFitsLine(withBody)) return [withBody]

    const headerOnly = this.pageContinuationHeaderOnly(showUpArrow, showDownArrow)
    const headerLine = this.textFitsLine(header) ? header : headerOnly
    if (!body) return [headerLine]

    return [headerLine, content]
  }

  private pageContinuationHeaderOnly(showUpArrow: boolean, showDownArrow: boolean) {
    if (!showUpArrow && !showDownArrow) return ''

    return `${showUpArrow ? PAGE_CONTINUATION_ARROW : ''}${showDownArrow ? PAGE_CONTINUATION_ARROW_DOWN : ''}`
  }

  private addPageContext(prefix: string, content: string) {
    if (!prefix) return content

    const candidate = `${prefix} ${content}`
    if (this.textFitsLine(candidate)) return candidate

    return prefix
  }

  private pageContinuationHeader(prefix: string, showUpArrow: boolean, showDownArrow: boolean) {
    if (!showUpArrow && !showDownArrow) return prefix

    const arrowSuffix = `${showUpArrow ? PAGE_CONTINUATION_ARROW : ''}${showDownArrow ? PAGE_CONTINUATION_ARROW_DOWN : ''}`
    const withSpace = `${prefix} ${arrowSuffix}`
    const withNoSpace = `${prefix}${arrowSuffix}`
    if (this.textFitsLine(withSpace)) return withSpace
    if (this.textFitsLine(withNoSpace)) return withNoSpace
    return arrowSuffix
  }

  private maxScrollTop() {
    return Math.max(0, this.visualLines.length - this.visibleLineCount)
  }
}
