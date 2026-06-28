import assert from 'node:assert/strict'
import { measureTextWrap } from '@evenrealities/pretext'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { HistoryCanvas, normalizeHistoryBlock, type HistoryEntry } from '../src/historyCanvas'
import { historyScrollDirectionFromEventType } from '../src/historyInput'

const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288
const HISTORY_WRAP_WIDTH = CANVAS_WIDTH
const VISIBLE_LINES = 9
const MAX_CONTENT_LENGTH = 2000

function atMinute(minute: number) {
  return new Date(2026, 0, 1, 12, minute).getTime()
}

function entry(minute: number, text: string, detail = ''): HistoryEntry {
  return {
    label: 'Agent',
    text,
    detail,
    receivedAt: atMinute(minute),
  }
}

function assertViewportSafe(canvas: HistoryCanvas, content = canvas.content()) {
  const debug = canvas.debug(content)
  assert.ok(debug.visibleLines <= VISIBLE_LINES, 'viewport rendered too many lines')
  assert.ok(content.length <= MAX_CONTENT_LENGTH, 'viewport exceeded text upgrade limit')

  for (const line of content.split('\n')) {
    assert.ok(
      measureTextWrap(line, HISTORY_WRAP_WIDTH).lineCount <= 1,
      `line would wrap against configured history width: ${line}`,
    )
  }
}

function simulateHistoryEvent(canvas: HistoryCanvas, eventType: OsEventTypeList) {
  const direction = historyScrollDirectionFromEventType(eventType)
  assert.notEqual(direction, null, `event did not map to history scroll: ${eventType}`)
  if (direction === null) throw new Error(`missing direction for ${eventType}`)
  return canvas.scroll(direction)
}

const longDetail = [
  'The first detailed line should keep its own carriage return.',
  'The second detailed line should be rendered as its own visual line.',
  'A deliberately long command output line should wrap before it reaches firmware overflow and continue through the manual viewport without using native text scrolling.',
  'Another long detail line creates enough history to test older and newer gesture navigation through the virtual text canvas.',
  'Final detail line before the newest message.',
].join('\n')

const entries = [
  entry(0, 'oldest message'),
  entry(1, 'middle message', longDetail),
  entry(2, 'another middle message', longDetail),
  entry(3, 'latest visible message', [
    'latest detail line one',
    'latest detail line two',
    'latest detail line three',
    'latest detail line four',
    'latest detail line five',
    'latest detail line six',
    'latest detail line seven',
    'latest detail line eight',
    'latest detail line nine',
    'latest detail line ten',
    'latest detail line eleven',
  ].join('\n')),
]

const canvas = new HistoryCanvas({
  width: HISTORY_WRAP_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  maxContentLength: MAX_CONTENT_LENGTH,
})

assert.equal(
  historyScrollDirectionFromEventType(OsEventTypeList.SCROLL_TOP_EVENT),
  -1,
  'SCROLL_TOP_EVENT should move toward older history',
)
assert.equal(
  historyScrollDirectionFromEventType(OsEventTypeList.SCROLL_BOTTOM_EVENT),
  1,
  'SCROLL_BOTTOM_EVENT should move toward newer history',
)
assert.equal(historyScrollDirectionFromEventType(OsEventTypeList.CLICK_EVENT), null)

canvas.replaceEntries(entries)
const bottom = canvas.content()
const bottomDebug = canvas.debug(bottom)
assertViewportSafe(canvas, bottom)
assert.equal(bottomDebug.pinnedToBottom, true, 'history should open pinned to bottom')
assert.match(bottom, /latest detail line eleven/, 'bottom viewport should show newest content')

const prefixCanvas = new HistoryCanvas({
  width: HISTORY_WRAP_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  maxContentLength: MAX_CONTENT_LENGTH,
})
prefixCanvas.replaceEntries([
  entry(5, 'prefix check', [
    'first detail line',
    'second detail line',
    'third detail line',
  ].join('\n')),
])
const prefixLines = prefixCanvas.content().split('\n')
assert.match(prefixLines[0], /^12:05 Agent first detail line/)
assert.doesNotMatch(prefixLines[1], /^12:05 Agent/)
assert.doesNotMatch(prefixLines[2], /^12:05 Agent/)

const cleanedTerminalOutput = normalizeHistoryBlock([
  ']0;terminal titleMMMMMMMMM',
  'real output lineMM',
  'MMMM',
  'another real line',
].join('\n'))
assert.equal(cleanedTerminalOutput, 'real output line\nanother real line')

const narrowWidth = 120
const firstWordCanvas = new HistoryCanvas({
  width: narrowWidth,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  maxContentLength: MAX_CONTENT_LENGTH,
})
firstWordCanvas.replaceEntries([
  entry(6, 'long first word', 'Supercalifragilisticexpialidocious-first-token-with-no-breaks'),
])
for (const line of firstWordCanvas.content().split('\n')) {
  assert.ok(
    measureTextWrap(line, narrowWidth).lineCount <= 1,
    `first-word wrapping emitted an over-wide line: ${line}`,
  )
}

const older = simulateHistoryEvent(canvas, OsEventTypeList.SCROLL_TOP_EVENT)
const olderDebug = canvas.debug(older.content)
assertViewportSafe(canvas, older.content)
assert.notEqual(older.content, bottom, 'older scroll should repaint a different viewport')
assert.equal(olderDebug.pinnedToBottom, false)
assert.equal(
  olderDebug.lineEnd,
  bottomDebug.lineStart,
  'older page should include the previous page first line as overlap',
)

const newer = simulateHistoryEvent(canvas, OsEventTypeList.SCROLL_BOTTOM_EVENT)
const newerDebug = canvas.debug(newer.content)
assertViewportSafe(canvas, newer.content)
assert.equal(newer.content, bottom, 'newer scroll should return to the bottom viewport')
assert.equal(newerDebug.pinnedToBottom, true)
assert.equal(
  newerDebug.lineStart,
  olderDebug.lineEnd,
  'newer page should include the previous page last line as overlap',
)

simulateHistoryEvent(canvas, OsEventTypeList.SCROLL_TOP_EVENT)
canvas.setPendingTranscript('pending transcript that has not been sent yet')
const pending = canvas.content()
assertViewportSafe(canvas, pending)
assert.match(pending, /Queued: pending transcript/, 'pending transcript should snap to bottom')
assert.equal(canvas.debug(pending).pinnedToBottom, true)

canvas.clearPendingTranscript()
canvas.appendEntry(entry(4, 'new live update while history is open'))
const updated = canvas.content()
assertViewportSafe(canvas, updated)
assert.match(updated, /new live update while history is open/)
assert.equal(canvas.debug(updated).pinnedToBottom, true)

console.log('history canvas tests passed')
