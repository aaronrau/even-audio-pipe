import assert from 'node:assert/strict'
import { measureTextWrap } from '@evenrealities/pretext'
import { HistoryNavigator } from '../src/historyNavigator'
import type { HistoryEntry } from '../src/historyCanvas'

const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288
const VISIBLE_LINES = 9
const MAX_CONTENT_LENGTH = 2000

function atMinute(minute: number) {
  return new Date(2026, 0, 1, 12, minute).getTime()
}

function entry(minute: number, label: string, text: string, detail = ''): HistoryEntry {
  return {
    label,
    text,
    detail,
    receivedAt: atMinute(minute),
  }
}

function assertViewportSafe(content: string) {
  assert.ok(content.split('\n').length <= VISIBLE_LINES, 'viewport rendered too many lines')
  assert.ok(content.length <= MAX_CONTENT_LENGTH, 'viewport exceeded text upgrade limit')

  for (const line of content.split('\n')) {
    assert.ok(
      measureTextWrap(line, CANVAS_WIDTH).lineCount <= 1,
      `line would wrap against configured history width: ${line}`,
    )
  }
}

const longTranscript = [
  'This is a deliberately long transcript that should appear as a compact one line preview in the selected list,',
  'but it should still be available in full when the transcript item is opened as detail.',
  'The preview must end with an ellipsis instead of relying on firmware wrapping.',
].join(' ')

const navigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})

navigator.replaceEntries([
  entry(0, 'You', longTranscript),
  entry(1, 'Flux', 'Flux pulled the latest changes successfully.', [
    'git pull --ff-only',
    'Already up to date.',
  ].join('\n')),
  entry(2, 'Pike', 'Pike updated the roadmap summary.', [
    'Detailed Pike output line one.',
    'Detailed Pike output line two.',
  ].join('\n')),
])

const opened = navigator.open()
assert.equal(opened.mode, 'list')
assert.match(opened.content.split('\n')[0], /^> Back$/)
assert.doesNotMatch(opened.content, /Detailed Pike output/)
assertViewportSafe(opened.content)

const selectedNewest = navigator.scroll(1)
assert.equal(selectedNewest.mode, 'list')
assert.match(selectedNewest.content, /^> 12:02 Pike updated the roadmap summary\./m)
assertViewportSafe(selectedNewest.content)

const detail = navigator.tap()
assert.equal(detail.mode, 'detail')
assert.match(detail.content, /12:02 Pike Detailed Pike output line one\./)
assert.match(detail.content, /Detailed Pike output line two\./)
assertViewportSafe(detail.content)

const backToList = navigator.tap()
assert.equal(backToList.mode, 'list')
assert.match(backToList.content, /^> 12:02 Pike updated the roadmap summary\./m)
assertViewportSafe(backToList.content)

const closedSeen = navigator.tap()
assert.equal(closedSeen.mode, 'closed')
assert.equal(closedSeen.content, '')

const reopened = navigator.open()
assert.equal(reopened.mode, 'list')
assert.match(reopened.content.split('\n')[0], /^> Back$/)
const closedBack = navigator.tap()
assert.equal(closedBack.mode, 'closed')

const selectedFromBackWithOlderGesture = navigator.open()
assert.match(selectedFromBackWithOlderGesture.content.split('\n')[0], /^> Back$/)
const olderGestureSelection = navigator.scroll(-1)
assert.match(olderGestureSelection.content, /^> 12:02 Pike updated the roadmap summary\./m)
assertViewportSafe(olderGestureSelection.content)
navigator.tap()
navigator.tap()

navigator.open()
navigator.scroll(1)
navigator.scroll(1)
navigator.scroll(1)
const transcriptSelected = navigator.content()
assert.match(transcriptSelected, /^> 12:00 You .*\.{3}$/m)
assert.doesNotMatch(transcriptSelected, /available in full when the transcript item is opened as detail/)
assertViewportSafe(transcriptSelected)

const transcriptDetail = navigator.tap()
assert.equal(transcriptDetail.mode, 'detail')
assert.match(transcriptDetail.content, /available in full when the transcript item is opened as detail/)
assertViewportSafe(transcriptDetail.content)

navigator.tap()
navigator.setPendingTranscript('queued transcript text that has not been sent yet')
const pendingList = navigator.content()
assert.match(pendingList, /Queued: queued transcript text/)
assertViewportSafe(pendingList)

console.log('history navigator tests passed')
