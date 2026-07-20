import assert from 'node:assert/strict'
import test from 'node:test'
import {
  boundedThinClientDetail,
  thinClientTextPreview,
} from '../thin-client-text.js'

test('thin client previews retain the newest 100 normalized characters', () => {
  const source = `  beginning ${'x'.repeat(120)} ending  `
  const preview = thinClientTextPreview(source)
  assert.equal(preview.length, 100)
  assert.match(preview, /^\.\.\./)
  assert.match(preview, / ending$/)
  assert.doesNotMatch(preview, /beginning/)
})

test('short previews and bounded detail are unchanged or capped', () => {
  assert.equal(thinClientTextPreview('  short\n message '), 'short message')
  assert.equal(boundedThinClientDetail('abcdefgh', 6), 'abc...')
})
