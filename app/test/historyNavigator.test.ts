import assert from 'node:assert/strict'
import { measureTextWrap } from '@evenrealities/pretext'
import { HistoryNavigator } from '../src/historyNavigator'
import type { HistoryEntry } from '../src/historyCanvas'

const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288
const VISIBLE_LINES = 9
const MAX_CONTENT_LENGTH = 2000
const ELLIPSIS_GUARD_WIDTH = 40
const CONTINUATION_INDENT_GUARD_WIDTH = 96

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

function assertViewportSafe(content: string, visibleLines = VISIBLE_LINES) {
  assert.ok(content.split('\n').length <= visibleLines, 'viewport rendered too many lines')
  assert.ok(content.length <= MAX_CONTENT_LENGTH, 'viewport exceeded text upgrade limit')

  for (const line of content.split('\n')) {
    assert.ok(
      measureTextWrap(line, CANVAS_WIDTH).lineCount <= 1,
      `line would wrap against configured history width: ${line}`,
    )
    if (line.endsWith('...')) {
      assert.doesNotMatch(line, /\s\.{3}/)
      assert.ok(
        measureTextWrap(line, CANVAS_WIDTH - ELLIPSIS_GUARD_WIDTH).lineCount <= 1,
        `truncated line should keep guard space before ellipsis: ${line}`,
      )
    }
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
    'Detailed Pike output line three.',
    'Detailed Pike output line four.',
    'Detailed Pike output line five.',
    'Detailed Pike output line six.',
    'Detailed Pike output line seven.',
    'Detailed Pike output line eight.',
    'Detailed Pike output line nine.',
    'Detailed Pike output line ten.',
    'Detailed Pike output line eleven.',
    'Detailed Pike output line twelve.',
  ].join('\n')),
])

const opened = navigator.open()
assert.equal(opened.mode, 'list')
assert.match(opened.content.split('\n')[0], /^< Back$/)
assert.doesNotMatch(opened.content, /Detailed Pike output/)
assertViewportSafe(opened.content)

const selectedNewest = navigator.scroll(1)
assert.equal(selectedNewest.mode, 'list')
assert.match(selectedNewest.content, /^> 12:02 Pike updated the roadmap summary\./m)
assertViewportSafe(selectedNewest.content)

const detail = navigator.tap()
assert.equal(detail.mode, 'detail')
assert.doesNotMatch(detail.content, /Detailed Pike output line one\./)
assert.match(detail.content.split('\n')[0], /^12:02 Pike ↑/)
assert.match(detail.content.split('\n')[1], /^Detailed Pike output line/)
assert.match(detail.content, /Detailed Pike output line twelve\./)
assert.doesNotMatch(detail.content, /\.\.\./, 'detail should not inject paging ellipses')
assert.equal(detail.debug.detail?.pinnedToBottom, true)
assertViewportSafe(detail.content)

const backToList = navigator.tap()
assert.equal(backToList.mode, 'list')
assert.match(backToList.content, /^< 12:02 Pike updated the roadmap summary\./m)
assertViewportSafe(backToList.content)

const closedSeen = navigator.tap()
assert.equal(closedSeen.mode, 'closed')
assert.equal(closedSeen.content, '')

const reopened = navigator.open()
assert.equal(reopened.mode, 'list')
assert.match(reopened.content.split('\n')[0], /^< Back$/)
const closedBack = navigator.tap()
assert.equal(closedBack.mode, 'closed')

const duplicateNameNavigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
duplicateNameNavigator.replaceEntries([
  entry(3, 'Pike', 'Pike has updated the paused voice session tips layout.'),
])
duplicateNameNavigator.open()
duplicateNameNavigator.scroll(1)
const duplicateNameDetail = duplicateNameNavigator.tap()
assert.equal(duplicateNameDetail.mode, 'detail')
assert.match(duplicateNameDetail.content, /^12:03 Pike has updated the paused voice session tips layout\.$/m)
assert.doesNotMatch(duplicateNameDetail.content, /Pike Pike/i)
assertViewportSafe(duplicateNameDetail.content)

const selectedFromBackWithOlderGesture = navigator.open()
assert.match(selectedFromBackWithOlderGesture.content.split('\n')[0], /^< Back$/)
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
assert.match(transcriptSelected, /^> 12:00 This is a deliberately long transcript.*\.{3}$/m)
assert.doesNotMatch(transcriptSelected, /^> 12:00 You /m)
assert.doesNotMatch(transcriptSelected, /\s\.{3}/)
assert.doesNotMatch(transcriptSelected, /available in full when the transcript item is opened as detail/)
assertViewportSafe(transcriptSelected)
for (const line of transcriptSelected.split('\n').filter(line => line.endsWith('...'))) {
  assert.ok(
    measureTextWrap(line, CANVAS_WIDTH - ELLIPSIS_GUARD_WIDTH).lineCount <= 1,
    `truncated line should keep guard space before ellipsis: ${line}`,
  )
}

const transcriptDetail = navigator.tap()
assert.equal(transcriptDetail.mode, 'detail')
assert.match(transcriptDetail.content, /available in full when the transcript item is opened as detail/)
assert.doesNotMatch(transcriptDetail.content, /\.\.\./, 'detail should not inject paging ellipses')
assertViewportSafe(transcriptDetail.content)

navigator.tap()
navigator.setPendingTranscript('queued transcript text that has not been sent yet')
const pendingList = navigator.content()
assert.match(pendingList.split('\n')[0], /^ {2}Back \| Queued: queued transcript text/)
assertViewportSafe(pendingList)
assert.doesNotMatch(pendingList, /^> Queued:/m)

const groupedNavigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
groupedNavigator.replaceEntries([
  entry(0, 'You', 'Hey Flux, older transcript one'),
  entry(1, 'You', 'Pike. older transcript two'),
  entry(2, 'Flux', [
    'The agent is ready to separate transcript groups with enough summary content',
    'to require an indented second row in the selected list view.',
  ].join(' '), 'agent detail'),
  entry(3, 'You', 'newer transcript one'),
  entry(4, 'You', [
    'Flux, newer transcript two',
    'detail line three',
    'detail line four',
    'detail line five',
    'detail line six',
    'detail line seven',
    'detail line eight',
    'detail line nine',
    'detail line ten',
    'detail line eleven',
    'detail line twelve',
  ].join('\n')),
])

const groupedOpened = groupedNavigator.open()
assertViewportSafe(groupedOpened.content)
assert.match(groupedOpened.content, /^  12:04 newer transcript two detail line three detail line four/m)
assert.doesNotMatch(groupedOpened.content, /^ {10,}newer transcript one$/m)
assert.match(groupedOpened.content, /^  12:02 Flux ready to separate transcript groups with enough$/m)
assert.match(groupedOpened.content, /^ {12}summary content to require an indented second\.\.\.$/m)
assert.match(groupedOpened.content, /^  12:01 older transcript two$/m)
assert.doesNotMatch(groupedOpened.content, /^ {10,}older transcript one$/m)
assert.doesNotMatch(groupedOpened.content, /^  12:(?:04|01) (You|Flux|Pike|agent|The agent) /im)
assert.doesNotMatch(groupedOpened.content, /^  12:02 Flux (?:agent|The agent) /im)

const newestGroupSelected = groupedNavigator.scroll(1)
assert.match(newestGroupSelected.content, /^> 12:04 newer transcript two detail line three detail line.*\.\.\.$/m)
assert.doesNotMatch(newestGroupSelected.content, /^ {10,}newer transcript one$/m)
assert.doesNotMatch(newestGroupSelected.content, /^> 12:\d{2} (You|Flux|Pike|agent|The agent) /im)
const newestGroupDetail = groupedNavigator.tap()
assert.equal(newestGroupDetail.mode, 'detail')
assert.match(newestGroupDetail.content.split('\n')[0], /^12:04 You ↑/)
assert.match(newestGroupDetail.content.split('\n')[1], /^detail line /)
assert.match(newestGroupDetail.content, /detail line twelve/)
assert.doesNotMatch(newestGroupDetail.content, /older transcript one/)
assert.doesNotMatch(newestGroupDetail.content, /agent detail/)
assert.equal(newestGroupDetail.debug.detail?.pinnedToBottom, true)
assertViewportSafe(newestGroupDetail.content)
const newestGroupOlderPage = groupedNavigator.scroll(-1)
assert.match(newestGroupOlderPage.content, /12:03 You .*newer transcript one/)
assert.match(newestGroupOlderPage.content, /12:04 You Flux, newer transcript two/)
assertViewportSafe(newestGroupOlderPage.content)

groupedNavigator.tap()
groupedNavigator.tap()
groupedNavigator.open()
groupedNavigator.setPendingTranscript('queued newest transcript')
const queuedGroupSelected = groupedNavigator.scroll(1)
assert.match(queuedGroupSelected.content.split('\n')[0], /^  Back \| Queued: queued newest transcript$/)
assert.doesNotMatch(queuedGroupSelected.content, /[⧖⋈⦚]/)
assert.doesNotMatch(queuedGroupSelected.content, /^> Queued:/m)
const queuedGroupDetail = groupedNavigator.tap()
assert.equal(queuedGroupDetail.mode, 'detail')
assert.match(queuedGroupDetail.content.split('\n')[0], /^12:04 You ↑/)
assert.match(queuedGroupDetail.content.split('\n')[1], /^detail line /)
assert.doesNotMatch(queuedGroupDetail.content, /\.\.\./, 'detail should not inject paging ellipses')
assert.doesNotMatch(queuedGroupDetail.content, /older transcript one/)
assertViewportSafe(queuedGroupDetail.content)
const queuedGroupOlderPage = groupedNavigator.scroll(-1)
assert.match(queuedGroupOlderPage.content, /12:03 You .*newer transcript one/)
assert.match(queuedGroupOlderPage.content, /12:04 You Flux, newer transcript two/)
assertViewportSafe(queuedGroupOlderPage.content)

const queuedBackNavigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
queuedBackNavigator.replaceEntries([
  entry(0, 'Flux', 'short agent response'),
])
queuedBackNavigator.open()
queuedBackNavigator.setPendingTranscript([
  'this queued transcript is deliberately long enough to require truncation',
  'on the same row as the back button without becoming a selectable item',
].join(' '))
const queuedBackContent = queuedBackNavigator.content()
assert.match(queuedBackContent.split('\n')[0], /^< Back \| Queued: .*\.{3}$/)
assert.doesNotMatch(queuedBackContent, /[⧖⋈⦚]/)
assert.doesNotMatch(queuedBackContent, /^> Queued:/m)
assertViewportSafe(queuedBackContent)
for (const line of queuedBackContent.split('\n').filter(line => line.includes('Queued:'))) {
  assert.ok(
    measureTextWrap(line, CANVAS_WIDTH - ELLIPSIS_GUARD_WIDTH).lineCount <= 1,
    `queued back row should reserve ellipsis guard width: ${line}`,
  )
}

const queuedBackNavigatorIgnoresWaitingFrame = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
queuedBackNavigatorIgnoresWaitingFrame.replaceEntries([{ label: 'Flux', text: 'latest', receivedAt: atMinute(0) }])
queuedBackNavigatorIgnoresWaitingFrame.open()
queuedBackNavigatorIgnoresWaitingFrame.setPendingTranscript('queued transcript now waiting', '⋈')
const queuedWaitingContent = queuedBackNavigatorIgnoresWaitingFrame.content()
const queuedWaitingRow = queuedWaitingContent.split('\n')[0]
assert.match(queuedWaitingRow, /Queued: queued transcript now waiting/)
assert.doesNotMatch(queuedWaitingRow, /[⧖⋈⦚]/)

const progressNavigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: VISIBLE_LINES,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
progressNavigator.replaceProgressAgents(['Flux', 'Pike'])
progressNavigator.replaceEntries([
  entry(0, 'You', 'older transcript'),
  entry(1, 'Flux', 'Flux finished a previous task.', 'previous detail'),
])
const progressOpened = progressNavigator.open()
assert.match(progressOpened.content, /^  Flux \(\.\.\.\)$/m)
assert.match(progressOpened.content, /^  Pike \(\.\.\.\)$/m)
assertViewportSafe(progressOpened.content)
const selectedProgress = progressNavigator.scroll(1)
assert.match(selectedProgress.content, /^> Flux \(\.\.\.\)$/m)
const progressTap = progressNavigator.tap()
assert.equal(progressTap.action, 'peek_progress')
assert.equal(progressTap.mode, 'detail')
assert.equal(progressTap.agent, 'Flux')
assert.match(progressTap.content, /Checking\.\.\./)
assertViewportSafe(progressTap.content)
progressNavigator.replaceProgressAgents(['Pike'])
assert.equal(progressNavigator.currentMode(), 'detail')
assert.match(progressNavigator.content(), /Checking\.\.\./)
progressNavigator.appendEntry(entry(
  2,
  'Flux',
  'Flux summarized the current progress.',
  'npm test\n72 passed',
))
assert.equal(progressNavigator.currentMode(), 'detail')
assert.match(progressNavigator.content(), /^12:02 Flux npm test$/m)
assert.match(progressNavigator.content(), /^72 passed$/m)
assert.doesNotMatch(progressNavigator.content(), /Checking\.\.\./)
progressNavigator.replaceEntries([
  entry(0, 'You', 'older transcript'),
  entry(1, 'Flux', 'Flux finished a previous task.', 'previous detail'),
  entry(3, 'Flux', 'Flux summarized the current progress.', 'npm test\n72 passed'),
])
assert.equal(progressNavigator.currentMode(), 'detail')
assert.match(progressNavigator.content(), /^12:03 Flux npm test$/m)
assert.match(progressNavigator.content(), /^72 passed$/m)
assert.doesNotMatch(progressNavigator.content(), /previous detail/)
progressNavigator.replaceEntries([
  entry(0, 'You', 'older transcript'),
  entry(1, 'Flux', 'Flux finished a previous task.', 'previous detail'),
])
assert.equal(progressNavigator.currentMode(), 'detail')
assert.match(progressNavigator.content(), /^12:03 Flux npm test$/m)
assert.match(progressNavigator.content(), /^72 passed$/m)
progressNavigator.appendEntry(entry(
  4,
  'Flux',
  'Flux found a later update.',
  'npm test --watch\n73 passed',
))
assert.equal(progressNavigator.currentMode(), 'detail')
assert.match(progressNavigator.content(), /^12:04 Flux npm test --watch$/m)
assert.match(progressNavigator.content(), /^73 passed$/m)
assert.doesNotMatch(progressNavigator.content(), /72 passed/)
const openedProgressDetail = progressNavigator.openLatestDetailForAgent('flux')
assert.equal(openedProgressDetail.action, 'opened_detail')
assert.equal(openedProgressDetail.mode, 'detail')
assert.match(openedProgressDetail.content, /^12:04 Flux npm test --watch$/m)
assert.match(openedProgressDetail.content, /^73 passed$/m)
assert.doesNotMatch(openedProgressDetail.content, /previous detail/)
assertViewportSafe(openedProgressDetail.content)

const pagingNavigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: 4,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
pagingNavigator.replaceEntries([
  entry(3, 'Brock', 'short older response'),
  entry(4, 'You', 'older transcript'),
  entry(5, 'Pike', [
    'The agent is summarizing a boundary case with a continuation line that',
    'must be clipped after the larger indent and kept with its selected row.',
  ].join(' '), 'agent detail'),
  entry(6, 'You', 'middle transcript'),
  entry(7, 'Flux', 'short newer response'),
  entry(8, 'You', 'newest transcript'),
])

pagingNavigator.open()
pagingNavigator.scroll(1)
pagingNavigator.scroll(1)
pagingNavigator.scroll(1)
const selectedTwoLineAgent = pagingNavigator.scroll(1)
const selectedTwoLineLines = selectedTwoLineAgent.content.split('\n')
assertViewportSafe(selectedTwoLineAgent.content, 4)
assert.equal(selectedTwoLineLines.length, 4)
assert.doesNotMatch(selectedTwoLineLines[0], /^ {12}/, 'continuation line should not be orphaned at viewport top')
assert.equal(
  selectedTwoLineLines.filter(line => line.startsWith('> ')).length,
  1,
  'only the selected item first line should carry the cursor',
)
assert.match(selectedTwoLineAgent.content, /^> 12:05 Pike summarizing a boundary case with a continuation line/m)
assert.match(selectedTwoLineAgent.content, /^ {12}.*larger indent.*\.\.\.$/m)
const continuationLine = selectedTwoLineLines.find(line => line.startsWith('            '))
assert.ok(continuationLine, 'agent continuation line should use the larger indent')
assert.ok(
  measureTextWrap(
    continuationLine,
    CANVAS_WIDTH - ELLIPSIS_GUARD_WIDTH - CONTINUATION_INDENT_GUARD_WIDTH,
  ).lineCount <= 1,
  `indented continuation should reserve ellipsis and indent guard width: ${continuationLine}`,
)

const twoLineWidthNavigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: 4,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
twoLineWidthNavigator.replaceEntries([
  entry(0, 'Flux', [
    'The agent is validating that the first line and continuation line use',
    'different width calculations before ellipsis clipping happens on glasses.',
  ].join(' '), 'agent detail'),
])
twoLineWidthNavigator.open()
const twoLineWidthSelected = twoLineWidthNavigator.scroll(1)
const twoLineWidthLines = twoLineWidthSelected.content.split('\n')
const plannedContinuationLine = twoLineWidthLines.find(line => line.startsWith('            '))
assert.ok(plannedContinuationLine, 'long agent response should render an indented continuation line')
assert.match(plannedContinuationLine, /\.\.\.$/)
assert.ok(
  measureTextWrap(plannedContinuationLine, CANVAS_WIDTH).lineCount <= 1,
  `planned continuation should fit the real width with ellipsis: ${plannedContinuationLine}`,
)
assert.ok(
  measureTextWrap(
    plannedContinuationLine,
    CANVAS_WIDTH - ELLIPSIS_GUARD_WIDTH - CONTINUATION_INDENT_GUARD_WIDTH,
  ).lineCount <= 1,
  `planned continuation should reserve guard width for indent and ellipsis: ${plannedContinuationLine}`,
)
assert.doesNotMatch(
  plannedContinuationLine,
  /\s\.{3}$/,
  'planned continuation should trim before adding ellipsis',
)

const cursorBoundaryNavigator = new HistoryNavigator({
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  visibleLineCount: 5,
  scrollOverlapLines: 1,
  maxContentLength: MAX_CONTENT_LENGTH,
})
cursorBoundaryNavigator.replaceEntries([
  entry(0, 'You', 'old transcript'),
  entry(1, 'Flux', 'The agent is creating a two line response before the boundary row.', 'agent detail'),
  entry(2, 'You', 'middle transcript'),
  entry(3, 'Pike', 'The agent is creating another two line response before the selected row.', 'agent detail'),
  entry(4, 'You', 'newer transcript'),
])
cursorBoundaryNavigator.open()
let cursorBoundaryResult = cursorBoundaryNavigator.scroll(1)
for (let index = 0; index < 4; index += 1) {
  const selectedCursorLines = cursorBoundaryResult.content
    .split('\n')
    .filter(line => line.startsWith('> '))
  assert.equal(
    selectedCursorLines.length,
    1,
    `selected cursor should stay visible while crossing continuation boundary:\n${cursorBoundaryResult.content}`,
  )
  cursorBoundaryResult = cursorBoundaryNavigator.scroll(1)
}

console.log('history navigator tests passed')
