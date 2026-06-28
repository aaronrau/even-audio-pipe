import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { measureTextWrap } from '@evenrealities/pretext'
import { HistoryCanvas, normalizeHistoryBlock, normalizeInlineText, type HistoryEntry } from '../src/historyCanvas'
import { HistoryNavigator } from '../src/historyNavigator'

const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288
const HISTORY_WRAP_WIDTH = CANVAS_WIDTH
const VISIBLE_LINES = 9
const MAX_CONTENT_LENGTH = 2000
const DETAIL_TEXT_FIELDS = [
  'detail',
  'details',
  'detail_response',
  'detailResponse',
  'detailed_response',
  'detailedResponse',
  'response_detail',
  'responseDetail',
  'detail response',
  'detailed response',
]
const SUMMARY_TEXT_FIELDS = ['text', 'summary', 'message', 'response']

function dateStamp(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function stringValue(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function textFromFields(record: Record<string, unknown>, fields: readonly string[]) {
  for (const field of fields) {
    const text = stringValue(record[field])
    if (text) return text
  }
  return ''
}

function assertViewportSafe(content: string) {
  assert.ok(content.split('\n').length <= VISIBLE_LINES, 'viewport should fit visible line count')
  assert.ok(content.length <= MAX_CONTENT_LENGTH, 'viewport should fit update limit')

  for (const line of content.split('\n')) {
    assert.ok(
      measureTextWrap(line, HISTORY_WRAP_WIDTH).lineCount <= 1,
      `line would wrap against configured history width: ${line}`,
    )
  }
}

function assertAllPagesSafe(canvas: HistoryCanvas) {
  const seenLineStarts = new Set<number>()

  for (;;) {
    const content = canvas.content()
    const debug = canvas.debug(content)
    assertViewportSafe(content)
    if (seenLineStarts.has(debug.lineStart)) break
    seenLineStarts.add(debug.lineStart)
    if (debug.lineStart <= 1) break
    canvas.scroll(-1)
  }
}

function assertNavigatorSafe(navigator: HistoryNavigator) {
  let result = navigator.open()
  assertViewportSafe(result.content)
  assert.match(result.content.split('\n')[0], /^> Back$/)

  for (let index = 0; index < entries.length; index += 1) {
    result = navigator.scroll(1)
    assertViewportSafe(result.content)

    if (index < 5) {
      const detail = navigator.tap()
      assert.equal(detail.mode, 'detail')
      assertViewportSafe(detail.content)
      const list = navigator.tap()
      assert.equal(list.mode, 'list')
      assertViewportSafe(list.content)
    }
  }
}

function sanitizeEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const detail = normalizeHistoryBlock(textFromFields(record, DETAIL_TEXT_FIELDS))
  const text = normalizeInlineText(textFromFields(record, SUMMARY_TEXT_FIELDS) || detail)
  const receivedAt = Number(record.receivedAt)
  if (!text || !Number.isFinite(receivedAt)) return null

  const entry: HistoryEntry = {
    label: stringValue(record.label) || 'Message',
    text,
    receivedAt,
  }
  if (detail) entry.detail = detail
  return entry
}

const stamp = process.env.HISTORY_TEST_DATE || dateStamp()
const file = `../data/transcripts/message-history/${stamp}.jsonl`

if (!existsSync(file)) {
  console.log(`current history simulation skipped: missing ${file}`)
  process.exit(0)
}

const entries = readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line) as unknown)
  .map(sanitizeEntry)
  .filter((entry): entry is HistoryEntry => entry !== null)

const canvas = new HistoryCanvas({
  width: HISTORY_WRAP_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  maxContentLength: MAX_CONTENT_LENGTH,
})
canvas.replaceEntries(entries)
const navigator = new HistoryNavigator({
  width: HISTORY_WRAP_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
navigator.replaceEntries(entries)

const bottom = canvas.content()
const bottomDebug = canvas.debug(bottom)
const older = canvas.scroll(-1)
const olderDebug = canvas.debug(older.content)
const newer = canvas.scroll(1)
const newerDebug = canvas.debug(newer.content)

assert.ok(entries.length > 0, 'expected current history entries')
assert.equal(bottomDebug.pinnedToBottom, true, 'current history should open at bottom')
assertViewportSafe(bottom)
assertViewportSafe(older.content)
assertViewportSafe(newer.content)
assertAllPagesSafe(canvas)
assertNavigatorSafe(navigator)
assert.notEqual(older.content, bottom, 'older scroll should change current history viewport')
assert.equal(newer.content, bottom, 'newer scroll should return to current history bottom')
assert.equal(
  olderDebug.lineEnd,
  bottomDebug.lineStart,
  'older current-history page should overlap the bottom page by one line',
)
assert.equal(
  newerDebug.lineStart,
  olderDebug.lineEnd,
  'newer current-history page should overlap the older page by one line',
)

console.log(JSON.stringify({
  file,
  entries: entries.length,
  bottomDebug,
  olderDebug,
  olderChanged: older.content !== bottom,
  newerReturnsBottom: newer.content === bottom,
  bottomFirstLine: bottom.split('\n')[0],
  bottomLastLine: bottom.split('\n').at(-1),
}, null, 2))
