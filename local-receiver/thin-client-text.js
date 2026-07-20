export const THIN_CLIENT_TEXT_LIMIT = 100
export const THIN_CLIENT_HISTORY_LIMIT = 100
export const THIN_CLIENT_DETAIL_TOTAL_CHARS = 24_000

export function thinClientTextPreview(value, limit = THIN_CLIENT_TEXT_LIMIT) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0))
  if (text.length <= safeLimit) return text
  if (safeLimit <= 3) return '.'.repeat(safeLimit)
  return `...${text.slice(-(safeLimit - 3))}`
}

export function boundedThinClientDetail(value, limit) {
  const text = String(value || '').trim()
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0))
  if (text.length <= safeLimit) return text
  if (safeLimit <= 3) return '.'.repeat(safeLimit)
  return `${text.slice(0, safeLimit - 3)}...`
}
