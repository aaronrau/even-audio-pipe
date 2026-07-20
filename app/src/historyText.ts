export type HistoryEntry = {
  id?: string
  label: string
  text: string
  detail?: string
  hasDetail?: boolean
  receivedAt: number
}

export function normalizeInlineText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

export function normalizeHistoryBlock(text: string) {
  const lines = text
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFKD')
    .replace(/\[tmux\]\[[^\]]+\]\s*/g, '')
    .replace(/\[tmux\]\s*/g, '')
    .replace(/\]0;[^\n]*/g, '')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2500-\u257f]/g, ' ')
    .replace(/[^\x09\x0A\x20-\x7E]/g, ' ')
    .split('\n')
    .map(cleanHistoryLine)
    .filter(line => line && !line.startsWith(']0;') && !/^M+$/.test(line) && !isControlByteLine(line))

  return unwrapSoftWrappedHistoryLines(lines)
    .join('\n')
    .trim()
}

function cleanHistoryLine(line: string) {
  const cleaned = line
    .replace(/\]0;[^\n]*/g, '')
    .replace(/\]8;;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\b[0-9A-Fa-f]{2}\b\s+(https?:\/\/)/, '$1')
    .trim()

  if (cleaned.includes('http')) {
    const [firstUrl, ...remainingUrls] = cleaned
      .split(/(?=https?:\/\/)/)
      .filter(part => part.startsWith('http'))
    if (firstUrl && remainingUrls.includes(firstUrl)) return firstUrl
  }

  return cleaned
    .replace(/[ \t]+/g, ' ')
    .replace(/M{2,}$/g, '')
    .trim()
}

function unwrapSoftWrappedHistoryLines(lines: string[]) {
  const unwrapped: string[] = []

  for (const line of lines) {
    const previous = unwrapped.at(-1)
    if (previous && shouldJoinSoftWrappedLine(previous, line)) {
      unwrapped[unwrapped.length - 1] = previous.endsWith('-')
        ? `${previous}${line}`
        : `${previous} ${line}`
      continue
    }
    unwrapped.push(line)
  }

  return unwrapped
}

function shouldJoinSoftWrappedLine(previous: string, current: string) {
  if (!current || isStructuredHistoryLine(current)) return false
  if (previous.endsWith('-')) return true
  if (previous.length < 72) return false
  if (/[.!?:;)]$/.test(previous)) return false
  if (isStructuredHistoryLine(previous)) return false
  return true
}

function isStructuredHistoryLine(line: string) {
  return /^(\(?no output\)?|Ran\s+|https?:\/\/|[AMDRC?!]{1,2}\s+|\?\?\s+|##\s+|diff\s+--git\s+|index\s+[0-9a-f]|[-+]Subproject\s+commit|[-+][0-9a-f]{7,}|\.{3}\s+\+\d+\s+lines)/.test(line)
}

function isControlByteLine(line: string) {
  return /^(?:[0-9A-Fa-f]{2}\s+){2,}[0-9A-Fa-f]{2}$/.test(line)
}
