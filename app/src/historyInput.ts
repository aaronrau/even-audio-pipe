import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import type { HistoryScrollDirection } from './historyCanvas'

export function historyScrollDirectionFromEventType(
  type: OsEventTypeList | undefined,
): HistoryScrollDirection | null {
  if (type === OsEventTypeList.SCROLL_TOP_EVENT) return -1
  if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 1
  return null
}
