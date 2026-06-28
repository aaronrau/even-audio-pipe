# History Text Canvas Plan

## Goal

The message history view should behave like a manually controlled text canvas:

- Ring tap opens the history view.
- Ring tap closes the history view.
- The view opens on the newest/current bottom content.
- Scroll gestures move through our virtual history viewport.
- New pending transcripts and received messages repaint the window while it is open.
- The SDK should not be treated as a native scroll view.

## SDK Constraints

The Even Hub text API gives us a paint target, not a scrollable document model.

- Display canvas: `576 x 288` pixels.
- `TextContainerProperty.content` startup limit: `1000` characters.
- `TextContainerUpgrade.content` update limit: `2000` characters.
- Text wraps automatically at container width.
- There is no text font-size field in the documented SDK.
- There is no documented text scroll offset or "scroll to bottom" control.
- `textContainerUpgrade` can repaint an existing text container without rebuilding the page.
- `contentOffset: 0, contentLength: 0` is the full replacement path.
- Scroll gestures arrive as input events; they should change our viewport state, then repaint.

The implication is that history should be rendered as pages or visible line slices that we compute locally.

## Overflow and Scrollbar Contract

This approach is supported by the documented text-container API because we are only using the SDK for what it guarantees:

- create a fixed `576 x 288` text container
- receive scroll/tap events from that container
- replace the text content with `textContainerUpgrade`

We should not create a conflict between native overflow scrolling and our own scrolling because the app must never send overflowing content to the text container. The rendered payload is always a pre-measured viewport slice:

```ts
const visibleText = visualLines
  .slice(scrollTopLine, scrollTopLine + visibleLineCount)
  .join('\n')
```

The invariant is:

```ts
visibleTextLineCount <= visibleLineCount
visibleText.length <= 2000
```

If a scrollbar appears, the renderer is wrong or the observed hardware fit is too generous. It means one of these happened:

- the viewport sent too many lines
- wrapping was measured against the wrong width
- line height was wrong for the active firmware font
- padding or border reduced the inner text area but the measurement still used the full `576 x 288`
- `VITE_HISTORY_WRAP_WIDTH` is too high for the device

To prevent that, the history container must stay at:

```ts
width: 576
height: 288
borderWidth: 0
paddingLength: 0
```

and wrapping must use the same inner width and line-height assumptions as the actual container.

## Display Contract

Create one full-screen text container first and keep that container alive:

```ts
const HISTORY_CONTAINER_ID = 1
const HISTORY_CONTAINER_NAME = 'audio_status'
const CANVAS_WIDTH = 576
const CANVAS_HEIGHT = 288

new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  borderWidth: 0,
  borderColor: 15,
  borderRadius: 0,
  paddingLength: 0,
  containerID: HISTORY_CONTAINER_ID,
  containerName: HISTORY_CONTAINER_NAME,
  content: ' ',
  isEventCapture: 1,
})
```

Rules:

- Do not rely on native scrolling.
- Do not send the whole history text to the container.
- Do not rebuild the page for normal scrolling.
- Do not change container dimensions between live and history modes.
- Always repaint with `textContainerUpgrade` using the same container ID and name.

```ts
await bridge.textContainerUpgrade(new TextContainerUpgrade({
  containerID: HISTORY_CONTAINER_ID,
  containerName: HISTORY_CONTAINER_NAME,
  contentOffset: 0,
  contentLength: 0,
  content: visibleText,
}))
```

## Virtual Viewport Model

Use a state object that represents our own scroll position:

```ts
type HistoryCanvasState = {
  mode: 'live' | 'history'
  entries: HistoryEntry[]
  pendingTranscript: string
  visualLines: string[]
  scrollTopLine: number
  isPinnedToBottom: boolean
  revision: number
}
```

The rendered text is always derived from:

```ts
visualLines.slice(scrollTopLine, scrollTopLine + visibleLineCount).join('\n')
```

Opening history sets:

```ts
scrollTopLine = Math.max(0, visualLines.length - visibleLineCount)
isPinnedToBottom = true
```

That makes the newest content visible immediately without needing SDK scroll support.

## Pixel-Measured Wrapping

Use `@evenrealities/pretext` instead of character-count wrapping.

The Even Hub text-heavy template documents a fixed line height of `27px` for the G2 LVGL text renderer. Use `9` visible lines as the default for this app so we stay below native overflow while still using most of the full-height container:

```ts
const LINE_HEIGHT = 27
const visibleLineCount = Number(import.meta.env.VITE_HISTORY_VISIBLE_LINES || 9)
```

The wrapping width is also configurable because the observed hardware appears slightly wider than the conservative SDK canvas width. The app keeps the SDK container at `576 x 288`, but measures history lines with:

```ts
const wrapWidth = Number(import.meta.env.VITE_HISTORY_WRAP_WIDTH || 656)
```

If the device shows native wrapping or clipping, lower `VITE_HISTORY_WRAP_WIDTH` first, then lower `VITE_HISTORY_VISIBLE_LINES`.

Build `visualLines` by wrapping each logical line using firmware-compatible width measurements:

```ts
import { measureTextWrap } from '@evenrealities/pretext'

function wrapVisualLine(text: string, width: number): string[] {
  const words = text.split(/(\s+)/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current + word
    if (measureTextWrap(candidate, width).lineCount > 1 && current.trim()) {
      lines.push(current.trimEnd())
      current = word.trimStart()
    } else {
      current = candidate
    }
  }

  if (current.trim()) lines.push(current.trimEnd())
  return lines
}
```

Logical message format:

```text
12:23 message or detail line
```

For multiline details:

```text
12:23 first detail line
second detail line
third detail line
```

Only the first line gets the timestamp prefix. Continuation lines stay plain so details remain readable.

## Scroll Behavior

Scroll changes only `scrollTopLine`, then repaints.

```ts
function scrollHistory(deltaLines: number) {
  const maxTop = Math.max(0, visualLines.length - visibleLineCount)
  scrollTopLine = clamp(scrollTopLine + deltaLines, 0, maxTop)
  isPinnedToBottom = scrollTopLine === maxTop
  renderHistoryViewport()
}
```

Start with one gesture moving by one viewport minus one line. That keeps the previous page's boundary line visible on the next page in either direction:

```ts
const SCROLL_STEP_LINES = Math.max(1, visibleLineCount - 1)
```

Observed hardware mapping should be logged and adjusted in one place:

```ts
if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
  scrollHistory(-SCROLL_STEP_LINES) // older, if this matches the device
}

if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
  scrollHistory(SCROLL_STEP_LINES) // newer, if this matches the device
}
```

If testing shows the physical direction is inverted, swap these mappings only in this function.

## Live Updates While Open

When pending transcript or message history changes:

1. Rebuild `visualLines`.
2. If the history view is closed, do not repaint history.
3. If the history view is open and `isPinnedToBottom` is true, reset to bottom.
4. If the history view is open and the user is not pinned to bottom, prefer snapping to bottom for this app's current behavior requirement.
5. Repaint the visible slice.

```ts
function onHistoryDataChanged() {
  rebuildVisualLines()
  if (state.mode !== 'history') return

  scrollTopLine = Math.max(0, visualLines.length - visibleLineCount)
  isPinnedToBottom = true
  renderHistoryViewport()
}
```

## Bridge Call Discipline

All bridge writes should be serialized. Overlapping BLE calls can create stale displays or dropped updates.

```ts
let renderQueue: Promise<unknown> = Promise.resolve()

function queueRender(content: string) {
  renderQueue = renderQueue.then(() => bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: HISTORY_CONTAINER_ID,
      containerName: HISTORY_CONTAINER_NAME,
      contentOffset: 0,
      contentLength: 0,
      content,
    }),
  ))
  return renderQueue
}
```

Add a timeout wrapper around bridge calls if the connection keeps hanging.

## Implementation Phases

1. Add `@evenrealities/pretext` to the app dependencies.
2. Replace the current character-budget history pager with `visualLines` and `scrollTopLine`.
3. Initialize one full-screen text container at startup and use it for both live and history modes.
4. Replace every history update with a full `textContainerUpgrade` repaint of the visible slice.
5. Route scroll events through a single mapping function.
6. Rebuild and bottom-anchor the viewport on:
   - history open
   - loaded daily history
   - pending transcript update
   - received transcript
   - received agent summary
7. Add debug logs with:
   - line count
   - visible line range
   - scroll direction
   - pinned-to-bottom state
   - event type/source
8. Add a local test script that loads today's `message-history/yyyy-mm-dd.jsonl`, builds visual lines, and verifies:
   - bottom open starts at `maxTop`
   - older scroll changes the visible text
   - newer scroll returns to bottom
   - no rendered viewport exceeds the text update limit

## Non-Goals

- Do not use `ListContainerProperty` for details. It is limited to short selectable items and does not fit multiline message details.
- Do not use `ImageContainerProperty` for this pass. Images would let us draw custom tiny fonts, but image containers are smaller, BLE image updates are slower, and updates must be serialized.
- Do not use SDK local storage for history. The receiver's daily `yyyy-mm-dd.jsonl` files remain the history source of truth.

## Acceptance Criteria

- Opening the history view always shows the newest bottom slice.
- Scroll gestures never rely on native text-container scrolling.
- Scroll gestures repaint different slices until the top or bottom boundary is reached.
- New messages and queued transcripts appear while the history view is open.
- Tapping the ring closes the history view.
- `SYSTEM_EXIT_EVENT` does not close the app.
- Debug logs clearly show the virtual scroll state for each repaint.
