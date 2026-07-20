import assert from 'node:assert/strict'
import { wouldExceedAudioBacklog } from '../src/audioBackpressure'
import { LatestTaskQueue } from '../src/latestTaskQueue'

assert.equal(wouldExceedAudioBacklog(64 * 1024, 1), true)
assert.equal(wouldExceedAudioBacklog(32 * 1024, 320), false)

const started: string[] = []
const releases: Array<() => void> = []
const queue = new LatestTaskQueue<string>(value => new Promise(resolve => {
  started.push(value)
  releases.push(() => resolve(true))
}))

const running = queue.submit('first')
queue.submit('obsolete')
queue.submit('latest')
assert.deepEqual(started, ['first'])
assert.deepEqual(queue.snapshot(), {
  running: true,
  pending: true,
  stopped: false,
})
releases.shift()?.()
await new Promise(resolve => setTimeout(resolve, 0))
assert.deepEqual(started, ['first', 'latest'])
releases.shift()?.()
assert.equal(await running, true)

queue.stop()
assert.equal(await queue.submit('ignored'), false)
assert.deepEqual(queue.snapshot(), {
  running: false,
  pending: false,
  stopped: true,
})
