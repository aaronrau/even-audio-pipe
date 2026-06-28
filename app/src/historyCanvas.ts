import { measureTextWrap } from '@evenrealities/pretext'

export type HistoryEntry = {
  label: string
  text: string
  detail?: string
  receivedAt: number
}

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
}

const DEFAULT_LINE_HEIGHT = 27
const DEFAULT_MAX_CONTENT_LENGTH = 2000

export function normalizeInlineText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

export function normalizeHistoryBlock(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .normalize('NFKD')
    .replace(/\[tmux\]\[[^\]]+\]\s*/g, '')
    .replace(/\[tmux\]\s*/g, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2500-\u257f]/g, ' ')
    .replace(/[^\x09\x0A\x20-\x7E]/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function formatHistoryTime(receivedAt: number) {
  const date = new Date(receivedAt)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function formatHistoryRow(prefix: string, text: string) {
  const displayText = normalizeHistoryBlock(text)
  if (!displayText) return prefix

  const [firstLine, ...remainingLines] = displayText.split('\n')
  return [`${prefix} ${firstLine}`, ...remainingLines].join('\n')
}

export class HistoryCanvas {
  private readonly width: number
  private readonly visibleLineCount: number
  private readonly scrollStepLines: number
  private readonly maxContentLength: number
  private entries: HistoryEntry[] = []
  private pendingTranscript = ''
  private visualLines: string[] = ['No messages']
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
      .map(entry => formatHistoryRow(
        formatHistoryTime(entry.receivedAt),
        entry.detail || entry.text,
      ))

    if (this.pendingTranscript) {
      rows.push(formatHistoryRow('Queued:', this.pendingTranscript))
    }

    return rows.length ? rows : ['No messages']
  }

  private buildVisualLines() {
    const lines = this.historyRows()
      .flatMap(row => row
        .split('\n')
        .flatMap(line => this.wrapLine(line)))

    return lines.length ? lines : ['No messages']
  }

  private wrapLine(line: string) {
    const normalized = line.replace(/[ \t]+/g, ' ').trim()
    if (!normalized) return []

    const visualLines: string[] = []
    let current = ''

    for (const word of normalized.split(' ')) {
      if (!word) continue

      if (!current) {
        if (this.textFitsLine(word)) {
          current = word
        } else {
          const pieces = this.splitLongWord(word)
          visualLines.push(...pieces.slice(0, -1))
          current = pieces.at(-1) ?? ''
        }
        continue
      }

      const candidate = `${current} ${word}`
      if (this.textFitsLine(candidate)) {
        current = candidate
        continue
      }

      visualLines.push(current)
      if (this.textFitsLine(word)) {
        current = word
      } else {
        const pieces = this.splitLongWord(word)
        visualLines.push(...pieces.slice(0, -1))
        current = pieces.at(-1) ?? ''
      }
    }

    if (current) visualLines.push(current)
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

    const lines = this.visualLines.slice(
      this.scrollTopLine,
      this.scrollTopLine + this.visibleLineCount,
    )

    while (lines.length > 1 && lines.join('\n').length > this.maxContentLength) {
      lines.pop()
    }

    if (lines.join('\n').length > this.maxContentLength) {
      return [lines[0].slice(0, this.maxContentLength)]
    }

    return lines.length ? lines : ['No messages']
  }

  private maxScrollTop() {
    return Math.max(0, this.visualLines.length - this.visibleLineCount)
  }
}
