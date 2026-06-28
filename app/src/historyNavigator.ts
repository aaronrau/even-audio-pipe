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
  listTopLine: number
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
  detailEntries: HistoryEntry[]
  receivedAt: number
}

type ListRow = {
  id: string | null
  bodyLines: string[]
  selected: boolean
  seen: boolean
}

type ListVisualLine = {
  id: string | null
  content: string
  isFirstLine: boolean
}

const BACK_ROW_ID = null
const SELECTED_MARKER = '> '
const SEEN_SELECTED_MARKER = '< '
const UNSELECTED_MARKER = '  '
const ELLIPSIS = '...'
const ELLIPSIS_GUARD_WIDTH = 40
const CONTINUATION_INDENT = '          '
const CONTINUATION_INDENT_GUARD_WIDTH = 96
const DEFAULT_AGENT_LABELS = ['Flux', 'Brock', 'Pike', 'Wolf']

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
    .replace(new RegExp(`^(?:hey|hi|ok|okay)?\\s*${escapedRegExp(normalizedLabel)}\\s*[:,.\\-]?\\s+`, 'i'), '')
    .trim()
}

function isTranscriptLike(item: HistoryItem) {
  return item.kind === 'transcript'
}

function uniqueLabels(labels: string[]) {
  return Array.from(new Set(
    labels
      .map(label => label.trim())
      .filter(Boolean),
  ))
}

function stripLeadingLabels(text: string, labels: string[]) {
  return uniqueLabels(labels)
    .sort((a, b) => b.length - a.length)
    .reduce((current, label) => stripLeadingLabel(current, label), text)
}

function stripLeadingAgentIntro(text: string, label: string) {
  const normalizedLabel = label.trim()
  let cleaned = text.trim()

  if (normalizedLabel) {
    const labelAgent = escapedRegExp(normalizedLabel)
    cleaned = cleaned
      .replace(new RegExp(`^the\\s+${labelAgent}\\s+agent\\s+(?:is|has|will|can|was|were|did|does|pulled|updated|created|completed|finished|started)\\s+`, 'i'), '')
      .replace(new RegExp(`^${labelAgent}\\s+agent\\s+(?:is|has|will|can|was|were|did|does|pulled|updated|created|completed|finished|started)\\s+`, 'i'), '')
      .replace(new RegExp(`^the\\s+${labelAgent}\\s+agent\\s+`, 'i'), '')
      .replace(new RegExp(`^${labelAgent}\\s+agent\\s+`, 'i'), '')
      .trim()
  }

  return cleaned
    .replace(/^the\s+agent\s+(?:is|has|will|can|was|were|did|does|pulled|updated|created|completed|finished|started)\s+/i, '')
    .replace(/^agent\s+(?:is|has|will|can|was|were|did|does|pulled|updated|created|completed|finished|started)\s+/i, '')
    .replace(/^the\s+agent\s+/i, '')
    .replace(/^agent\s+/i, '')
    .trim()
}

export class HistoryNavigator {
  private readonly width: number
  private readonly visibleLineCount: number
  private readonly maxContentLength: number
  private readonly detailCanvas: HistoryCanvas
  private entries: HistoryEntry[] = []
  private pendingTranscript = ''
  private mode: HistoryNavigatorMode = 'closed'
  private selectedItemId: string | null = BACK_ROW_ID
  private seenDetailIds = new Set<string>()
  private listTopLine = 0

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
      showPageContinuation: true,
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
    this.listTopLine = 0
    return this.result('opened')
  }

  close(action: HistoryNavigatorAction = 'closed_back'): HistoryNavigatorResult {
    this.mode = 'closed'
    this.selectedItemId = BACK_ROW_ID
    this.listTopLine = 0
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

  setPendingTranscript(text: string, _frame = '') {
    const previousNewestId = this.currentItems()[0]?.id
    const wasNewestSelected = this.selectedItemId !== BACK_ROW_ID
      && this.selectedItemId === previousNewestId

    this.pendingTranscript = normalizeInlineText(text)
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
      listTopRow: this.listTopLine,
      listTopLine: this.listTopLine,
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

    return this.groupAdjacentTranscripts(items)
  }

  private entryItem(entry: HistoryEntry, index: number): HistoryItem {
    const detailText = normalizeHistoryBlock(entry.detail || entry.text)
    const listText = normalizeInlineText(entry.text || detailText)
    const id = entryBaseId(entry, index)
    const detailEntry: HistoryEntry = {
      id,
      label: entry.label,
      text: listText,
      receivedAt: entry.receivedAt,
    }
    if (detailText) detailEntry.detail = detailText

    return {
      id,
      kind: entryKind(entry),
      label: entry.label,
      listText,
      detailText: detailText || listText,
      detailEntries: [detailEntry],
      receivedAt: entry.receivedAt,
    }
  }

  private groupAdjacentTranscripts(items: HistoryItem[]) {
    const groupedItems: HistoryItem[] = []

    for (let index = 0; index < items.length;) {
      const item = items[index]
      if (!item || !isTranscriptLike(item)) {
        if (item) groupedItems.push(item)
        index += 1
        continue
      }

      const group: HistoryItem[] = []
      while (index < items.length && isTranscriptLike(items[index])) {
        group.push(items[index])
        index += 1
      }

      groupedItems.push(this.transcriptGroupItem(group))
    }

    return groupedItems
  }

  private transcriptGroupItem(group: HistoryItem[]) {
    const newest = group[0]
    const oldest = group[group.length - 1]
    if (!newest || !oldest || group.length === 1) return newest

    const detailEntries = group
      .slice()
      .reverse()
      .flatMap(item => item.detailEntries)

    return {
      id: `transcripts:${newest.id}:${oldest.id}:${group.length}`,
      kind: newest.kind,
      label: newest.label,
      listText: newest.listText,
      detailText: detailEntries
        .map(entry => entry.detail || entry.text)
        .join('\n'),
      detailEntries,
      receivedAt: newest.receivedAt,
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
    this.detailCanvas.replaceEntries(item.detailEntries, false)
    if (resetScroll) this.detailCanvas.scrollToBottom()
  }

  private listContent() {
    const rows = this.listRows()
    const visualLines = this.listVisualLines(rows)
    this.ensureSelectedVisible(visualLines)
    const lines = visualLines
      .slice(this.listTopLine, this.listTopLine + this.visibleLineCount)
      .map(line => line.content)

    while (lines.length > 1 && lines.join('\n').length > this.maxContentLength) {
      lines.pop()
    }

    return lines.length ? lines.join('\n') : this.formatListRow({
      bodyLines: [this.backRowBody()],
      selected: true,
      seen: true,
      id: BACK_ROW_ID,
    }).map(line => line.content).join('\n')
  }

  private listRows() {
    const rows: ListRow[] = [{
      id: BACK_ROW_ID,
      bodyLines: [this.backRowBody()],
      selected: this.selectedItemId === BACK_ROW_ID,
      seen: true,
    }]

    for (const item of this.currentItems()) {
      rows.push({
        id: item.id,
        bodyLines: this.itemListBodyLines(item),
        selected: this.selectedItemId === item.id,
        seen: this.seenDetailIds.has(item.id),
      })
    }

    return rows
  }

  private listVisualLines(rows = this.listRows()): ListVisualLine[] {
    return rows.flatMap(row => this.formatListRow(row))
  }

  private itemListBodyLines(item: HistoryItem) {
    if (item.kind === 'queued') {
      return [`Queued: ${item.listText}`]
    }

    const listText = this.listPreviewText(item)
    if (item.kind === 'agent' || item.kind === 'error') {
      return this.agentListBodyLines(item, listText)
    }

    return [`${formatHistoryTime(item.receivedAt)} ${listText}`]
  }

  private backRowBody() {
    return this.pendingTranscript
      ? `Back | Queued: ${this.pendingTranscript}`
      : 'Back'
  }

  private agentListBodyLines(item: HistoryItem, listText: string) {
    const prefix = `${formatHistoryTime(item.receivedAt)} ${item.label}`
    const fullBody = `${prefix} ${listText}`
    if (this.textFitsLine(`${SELECTED_MARKER}${fullBody}`)) {
      return [fullBody]
    }

    const split = this.splitIndentedPreview(prefix, listText)
    return split.remaining
      ? [`${prefix} ${split.first}`, split.remaining]
      : [`${prefix} ${split.first}`]
  }

  private splitIndentedPreview(prefix: string, text: string) {
    const normalized = normalizeInlineText(text)
    const chars = Array.from(normalized)
    let low = 1
    let high = chars.length
    let best = ''

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = this.trimPreviewBody(chars.slice(0, mid).join(''))
      if (candidate && this.textFitsLine(`${SELECTED_MARKER}${prefix} ${candidate}`)) {
        best = candidate
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    if (!best) {
      const [first = '', ...rest] = normalized.split(' ')
      return {
        first,
        remaining: rest.join(' '),
      }
    }

    return {
      first: best,
      remaining: normalized.slice(best.length).trimStart(),
    }
  }

  private listPreviewText(item: HistoryItem, text = item.listText) {
    const agentLabels = this.agentLabels()
    const labelsToStrip = isTranscriptLike(item)
      ? [item.label, ...agentLabels]
      : [item.label]
    const withoutLabels = stripLeadingLabels(text, labelsToStrip)

    if (item.kind === 'agent') {
      return stripLeadingAgentIntro(withoutLabels, item.label)
    }

    return withoutLabels
  }

  private agentLabels() {
    return uniqueLabels([
      ...DEFAULT_AGENT_LABELS,
      ...this.entries
        .filter(entry => entryKind(entry) === 'agent')
        .map(entry => entry.label),
    ])
  }

  private formatListRow(row: ListRow): ListVisualLine[] {
    const marker = row.selected
      ? row.seen ? SEEN_SELECTED_MARKER : SELECTED_MARKER
      : UNSELECTED_MARKER
    return row.bodyLines.map((body, index) => ({
      id: row.id,
      content: this.formatListLine(
        body,
        index === 0 ? marker : `${UNSELECTED_MARKER}${CONTINUATION_INDENT}`,
        index > 0,
      ),
      isFirstLine: index === 0,
    }))
  }

  private formatListLine(bodyText: string, marker: string, isContinuation = false) {
    const body = normalizeInlineText(bodyText)
    const full = `${marker}${body}`
    if (!isContinuation && this.textFitsLine(full)) return full

    const chars = Array.from(body)
    let low = 0
    let high = chars.length
    let bestBody = ''
    const previewWidth = Math.max(
      1,
      this.width - ELLIPSIS_GUARD_WIDTH - (isContinuation ? CONTINUATION_INDENT_GUARD_WIDTH : 0),
    )

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidateBody = this.trimPreviewBody(chars.slice(0, mid).join(''))
      const candidate = `${marker}${candidateBody}${ELLIPSIS}`
      if (
        candidateBody
        && this.textFitsLine(candidate)
        && this.textFitsLine(candidate, previewWidth)
      ) {
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

  private ensureSelectedVisible(visualLines = this.listVisualLines()) {
    const maxTopLine = Math.max(0, visualLines.length - this.visibleLineCount)
    const selectedStart = visualLines.findIndex(line => line.id === this.selectedItemId)
    if (selectedStart < 0) {
      this.listTopLine = this.normalizeListTopLine(this.listTopLine, visualLines, maxTopLine)
      return
    }

    let selectedEnd = selectedStart
    while (
      selectedEnd + 1 < visualLines.length
      && visualLines[selectedEnd + 1]?.id === this.selectedItemId
    ) {
      selectedEnd += 1
    }

    if (selectedStart < this.listTopLine) {
      this.listTopLine = selectedStart
    } else if (selectedEnd >= this.listTopLine + this.visibleLineCount) {
      this.listTopLine = selectedEnd - this.visibleLineCount + 1
    }

    this.listTopLine = this.normalizeListTopLine(
      this.listTopLine,
      visualLines,
      maxTopLine,
      selectedStart,
      selectedEnd,
    )
  }

  private normalizeListTopLine(
    requestedTopLine: number,
    visualLines: ListVisualLine[],
    maxTopLine = Math.max(0, visualLines.length - this.visibleLineCount),
    selectedStart?: number,
    selectedEnd?: number,
  ) {
    let topLine = clamp(requestedTopLine, 0, maxTopLine)
    if (visualLines[topLine]?.isFirstLine !== false) {
      return topLine
    }

    let previousFirst = topLine
    while (
      previousFirst > 0
      && visualLines[previousFirst]
      && !visualLines[previousFirst].isFirstLine
    ) {
      previousFirst -= 1
    }

    let nextFirst = topLine
    while (
      nextFirst < visualLines.length - 1
      && visualLines[nextFirst]
      && !visualLines[nextFirst].isFirstLine
    ) {
      nextFirst += 1
    }

    const previousKeepsSelection = selectedEnd === undefined
      || selectedEnd < previousFirst + this.visibleLineCount
    const nextKeepsSelection = selectedStart === undefined
      || nextFirst <= selectedStart

    if (!previousKeepsSelection && nextKeepsSelection && nextFirst <= maxTopLine) {
      return nextFirst
    }

    return previousFirst
  }

  private textFitsLine(text: string, width = this.width) {
    return measureTextWrap(text, width).lineCount <= 1
  }
}
