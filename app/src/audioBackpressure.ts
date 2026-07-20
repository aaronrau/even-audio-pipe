export const MAX_AUDIO_SOCKET_BUFFER_BYTES = 64 * 1024

export function wouldExceedAudioBacklog(
  bufferedAmount: number,
  nextBytes: number,
  maximum = MAX_AUDIO_SOCKET_BUFFER_BYTES,
) {
  const buffered = Number.isFinite(bufferedAmount) ? Math.max(0, bufferedAmount) : maximum
  const next = Number.isFinite(nextBytes) ? Math.max(0, nextBytes) : maximum
  return buffered + next > maximum
}
