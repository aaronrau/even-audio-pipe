import { measureTextWrap } from '@evenrealities/pretext'
import {
  HistoryCanvas,
  formatHistoryTime,
  normalizeHistoryBlock,
  normalizeInlineText,
  type HistoryEntry,
  type HistoryScrollDirection,
} from './historyCanvas'

export type HistoryNavigatorMode = 'closed' | 'list' | 'detail'

export type HistoryNavigatorAction =
  | 'none'
  | 'opened'
  | 'closed_back'
  | 'closed_seen'
  | 'opened_detail'
  | 'closed_detail'
  | 'selected'
  | 'detail_scrolled'

export type HistoryItemKind = 'agent' | 'transcript' | 'queued' | 'error'

export type HistoryNavigatorResult = {
  action: HistoryNavigatorAction
  mode: HistoryNavigatorMode
  content: string
  debug: HistoryNavigatorDebug
}

export type HistoryNavigatorDebug = {
  mode: HistoryNavigatorMode
  itemCount: number
  selectedRow: number
  selectedItemId: string | null
  listTopRow: number
  visibleLines: number
  contentLength: number
  detail?: ReturnType<HistoryCanvas['debug']>
}

type HistoryNavigatorOptions = {
  width: number
  height: number
  visibleLineCount: number
  scrollOverlapLines?: number
  maxContentLength: number
}

type HistoryItem = {
  id: string
  kind: HistoryItemKind
  label: string
  listText: string
  detailText: string
  receivedAt: number
}

const BACK_ROW_ID = null
const SELECTED_MARKER = '> '
const UNSELECTED_MARKER = '  '
const ELLIPSIS = '...'
const ELLIPSIS_GUARD_WIDTH = 24

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function hashString(value: string) {
  let hash = 2166136261
  for (const char of value) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function entryBaseId(entry: HistoryEntry, index: number) {
  if (entry.id) return entry.id
  return [
    entry.receivedAt,
    entry.label,
    hashString(entry.text),
    hashString(entry.detail || ''),
    index,
  ].join(':')
}

function entryKind(entry: HistoryEntry): HistoryItemKind {
  const label = entry.label.trim().toLowerCase()
  if (label === 'you' || label === 'transcript') return 'transcript'
  if (label === 'error') return 'error'
  return 'agent'
}

function compareEntryRecords(
  a: { entry: HistoryEntry; index: number },
  b: { entry: HistoryEntry; index: number },
) {
  return b.entry.receivedAt - a.entry.receivedAt || b.index - a.index
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripLeadingLabel(text: string, label: string) {
  const normalizedLabel = label.trim()
  if (!normalizedLabel) return text

  return text
    .replace(new RegExp(`^${escapedRegExp(normalizedLabel)}\\s*[:\\-]?\\s+`, 'i'), '')
    .trim()
}

export class HistoryNavigator {
  private readonly width: number
  private readonly visibleLineCount: number
  private readonly maxContentLength: number
  private readonly detailCanvas: HistoryCanvas
  private entries: HistoryEntry[] = []
  private pendingTranscript = ''
  private pendingReceivedAt = Date.now()
  private mode: HistoryNavigatorMode = 'closed'
  private selectedItemId: string | null = BACK_ROW_ID
  private seenDetailIds = new Set<string>()
  private listTopRow = 0

  constructor(options: HistoryNavigatorOptions) {
    this.width = options.width
    this.visibleLineCount = Math.max(1, Math.floor(options.visibleLineCount))
    this.maxContentLength = options.maxContentLength
    this.detailCanvas = new HistoryCanvas({
      width: options.width,
      height: options.height,
      visibleLineCount: options.visibleLineCount,
      scrollOverlapLines: options.scrollOverlapLines,
      maxContentLength: options.maxContentLength,
    })
  }

  currentMode() {
    return this.mode
  }

  isOpen() {
    return this.mode !== 'closed'
  }

  open(): HistoryNavigatorResult {
    this.mode = 'list'
    this.selectedItemId = BACK_ROW_ID
    this.seenDetailIds.clear()
    this.listTopRow = 0
    return this.result('opened')
  }

  close(action: HistoryNavigatorAction = 'closed_back'): HistoryNavigatorResult {
    this.mode = 'closed'
    this.selectedItemId = BACK_ROW_ID
    this.listTopRow = 0
    return this.result(action)
  }

  tap(): HistoryNavigatorResult {
    if (this.mode === 'closed') return this.open()

    if (this.mode === 'detail') {
      this.mode = 'list'
      this.ensureSelectedVisible()
      return this.result('closed_detail')
    }

    if (this.selectedItemId === BACK_ROW_ID) {
      return this.close('closed_back')
    }

    if (this.seenDetailIds.has(this.selectedItemId)) {
      return this.close('closed_seen')
    }

    const item = this.selectedItem()
    if (!item) {
      this.selectedItemId = BACK_ROW_ID
      return this.result('none')
    }

    this.seenDetailIds.add(item.id)
    this.openDetail(item)
    return this.result('opened_detail')
  }

  scroll(direction: HistoryScrollDirection): HistoryNavigatorResult {
    if (this.mode === 'closed') return this.result('none')

    if (this.mode === 'detail') {
      this.detailCanvas.scroll(direction)
      return this.result('detail_scrolled')
    }

    const rowCount = this.currentItems().length + 1
    const previousRow = this.selectedRow()
    const nextRow = previousRow === 0 && rowCount > 1
      ? 1
      : clamp(previousRow + direction, 0, Math.max(0, rowCount - 1))
    this.selectRow(nextRow)
    this.ensureSelectedVisible()
    return this.result('selected')
  }

  replaceEntries(entries: HistoryEntry[]) {
    const previousNewestId = this.currentItems()[0]?.id
    const wasNewestSelected = this.selectedItemId !== BACK_ROW_ID
      && this.selectedItemId === previousNewestId

    this.entries = entries.slice()
    this.reconcileSelection(wasNewestSelected)
  }

  appendEntry(entry: HistoryEntry) {
    const previousNewestId = this.currentItems()[0]?.id
    const wasNewestSelected = this.selectedItemId !== BACK_ROW_ID
      && this.selectedItemId === previousNewestId

    this.entries.push(entry)
    this.reconcileSelection(wasNewestSelected)
  }

  setPendingTranscript(text: string) {
    const previousNewestId = this.currentItems()[0]?.id
    const wasNewestSelected = this.selectedItemId !== BACK_ROW_ID
      && this.selectedItemId === previousNewestId

    this.pendingTranscript = normalizeInlineText(text)
    this.pendingReceivedAt = Date.now()
    this.reconcileSelection(wasNewestSelected)
  }

  clearPendingTranscript() {
    this.pendingTranscript = ''
    this.reconcileSelection(false)
  }

  content() {
    if (this.mode === 'closed') return ''
    if (this.mode === 'detail') return this.detailCanvas.content()
    return this.listContent()
  }

  debug(content = this.content()): HistoryNavigatorDebug {
    const detail = this.mode === 'detail'
      ? this.detailCanvas.debug(content)
      : undefined
    return {
      mode: this.mode,
      itemCount: this.currentItems().length,
      selectedRow: this.selectedRow(),
      selectedItemId: this.selectedItemId,
      listTopRow: this.listTopRow,
      visibleLines: content ? content.split('\n').length : 0,
      contentLength: content.length,
      detail,
    }
  }

  private result(action: HistoryNavigatorAction): HistoryNavigatorResult {
    const content = this.content()
    return {
      action,
      mode: this.mode,
      content,
      debug: this.debug(content),
    }
  }

  private currentItems() {
    const items = this.entries
      .map((entry, index) => ({ entry, index }))
      .sort(compareEntryRecords)
      .map(({ entry, index }) => this.entryItem(entry, index))

    if (this.pendingTranscript) {
      items.unshift({
        id: 'queued',
        kind: 'queued' as const,
        label: 'Queued',
        listText: this.pendingTranscript,
        detailText: this.pendingTranscript,
        receivedAt: this.pendingReceivedAt,
      })
    }

    return items
  }

  private entryItem(entry: HistoryEntry, index: number): HistoryItem {
    const detailText = normalizeHistoryBlock(entry.detail || entry.text)
    const listText = normalizeInlineText(entry.text || detailText)
    return {
      id: entryBaseId(entry, index),
      kind: entryKind(entry),
      label: entry.label,
      listText,
      detailText: detailText || listText,
      receivedAt: entry.receivedAt,
    }
  }

  private selectedRow() {
    if (this.selectedItemId === BACK_ROW_ID) return 0

    const index = this.currentItems()
      .findIndex(item => item.id === this.selectedItemId)
    return index >= 0 ? index + 1 : 0
  }

  private selectRow(row: number) {
    if (row <= 0) {
      this.selectedItemId = BACK_ROW_ID
      return
    }

    this.selectedItemId = this.currentItems()[row - 1]?.id ?? BACK_ROW_ID
  }

  private selectedItem() {
    if (this.selectedItemId === BACK_ROW_ID) return null
    return this.currentItems()
      .find(item => item.id === this.selectedItemId) ?? null
  }

  private reconcileSelection(selectNewest: boolean) {
    const items = this.currentItems()
    if (selectNewest) {
      this.selectedItemId = items[0]?.id ?? BACK_ROW_ID
    } else if (
      this.selectedItemId !== BACK_ROW_ID
      && !items.some(item => item.id === this.selectedItemId)
    ) {
      this.selectedItemId = BACK_ROW_ID
      if (this.mode === 'detail') this.mode = 'list'
    }

    if (this.mode === 'detail') {
      const item = this.selectedItem()
      if (item) {
        this.openDetail(item, false)
      } else {
        this.mode = 'list'
      }
    }

    this.ensureSelectedVisible()
  }

  private openDetail(item: HistoryItem, resetScroll = true) {
    this.mode = 'detail'
    this.detailCanvas.replaceEntries([
      {
        id: item.id,
        label: item.label,
        text: item.listText,
        detail: item.detailText,
        receivedAt: item.receivedAt,
      },
    ], false)
    if (resetScroll) this.detailCanvas.scrollToTop()
  }

  private listContent() {
    const rows = this.listRows()
    this.ensureSelectedVisible(rows.length)
    const visibleRows = rows.slice(
      this.listTopRow,
      this.listTopRow + this.visibleLineCount,
    )
    const lines = visibleRows.map(row => this.formatListRow(row))

    while (lines.length > 1 && lines.join('\n').length > this.maxContentLength) {
      lines.pop()
    }

    return lines.length ? lines.join('\n') : this.formatListRow({
      body: 'Back',
      selected: true,
    })
  }

  private listRows() {
    const rows: Array<{ id: string | null; body: string; selected: boolean }> = [{
      id: BACK_ROW_ID,
      body: 'Back',
      selected: this.selectedItemId === BACK_ROW_ID,
    }]

    for (const item of this.currentItems()) {
      rows.push({
        id: item.id,
        body: this.itemListBody(item),
        selected: this.selectedItemId === item.id,
      })
    }

    return rows
  }

  private itemListBody(item: HistoryItem) {
    if (item.kind === 'queued') {
      return `Queued: ${item.listText}`
    }

    const listText = stripLeadingLabel(item.listText, item.label)
    return `${formatHistoryTime(item.receivedAt)} ${item.label} ${listText}`
  }

  private formatListRow(row: { body: string; selected: boolean }) {
    const marker = row.selected ? SELECTED_MARKER : UNSELECTED_MARKER
    const body = normalizeInlineText(row.body)
    const full = `${marker}${body}`
    if (this.textFitsLine(full)) return full

    const chars = Array.from(body)
    let low = 0
    let high = chars.length
    let bestBody = ''
    const previewWidth = Math.max(1, this.width - ELLIPSIS_GUARD_WIDTH)

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidateBody = this.trimPreviewBody(chars.slice(0, mid).join(''))
      const candidate = `${marker}${candidateBody}${ELLIPSIS}`
      if (candidateBody && this.textFitsLine(candidate, previewWidth)) {
        bestBody = candidateBody
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    return bestBody
      ? `${marker}${bestBody}${ELLIPSIS}`
      : `${marker.trimEnd()}${ELLIPSIS}`
  }

  private trimPreviewBody(text: string) {
    const trimmed = text
      .replace(/[\s,.;:!?-]+$/g, '')
      .trimEnd()
    if (!trimmed) return ''

    const lastSpace = trimmed.lastIndexOf(' ')
    if (lastSpace > 0 && trimmed.length - lastSpace <= 12) {
      return trimmed.slice(0, lastSpace)
    }

    return trimmed
  }

  private ensureSelectedVisible(rowCount = this.currentItems().length + 1) {
    const maxTopRow = Math.max(0, rowCount - this.visibleLineCount)
    const selectedRow = this.selectedRow()
    if (selectedRow < this.listTopRow) {
      this.listTopRow = selectedRow
    } else if (selectedRow >= this.listTopRow + this.visibleLineCount) {
      this.listTopRow = selectedRow - this.visibleLineCount + 1
    }

    this.listTopRow = clamp(this.listTopRow, 0, maxTopRow)
  }

  private textFitsLine(text: string, width = this.width) {
    return measureTextWrap(text, width).lineCount <= 1
  }
}
