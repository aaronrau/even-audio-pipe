import assert from 'node:assert/strict'
import test from 'node:test'
import { pcm16ToFloat32 } from '../silero-vad.ts'

test('converts signed 16-bit PCM to float audio', () => {
  const frame = Buffer.alloc(8)
  frame.writeInt16LE(-32768, 0)
  frame.writeInt16LE(-16384, 2)
  frame.writeInt16LE(0, 4)
  frame.writeInt16LE(16384, 6)

  assert.deepEqual([...pcm16ToFloat32(frame)], [-1, -0.5, 0, 0.5])
})
