import assert from 'node:assert/strict'
import test from 'node:test'
import {
  averageEmbeddings,
  cosineSimilarity,
  speakerProfileIdForUser,
} from '../diarization-sidecar.js'

test('speaker profile ids use the authenticated uid', () => {
  assert.equal(speakerProfileIdForUser({ uid: '1373602', name: 'Ignored' }), 'uid:1373602')
  assert.equal(speakerProfileIdForUser({ userId: 'fallback-user' }), 'uid:fallback-user')
  assert.equal(speakerProfileIdForUser({ name: 'No uid' }), '')
})

test('speaker embedding helpers average and compare vectors', () => {
  assert.deepEqual(averageEmbeddings([[1, 0], [0, 1]]), [0.5, 0.5])
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1, 0], [1]), null)
})
