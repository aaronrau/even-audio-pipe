import assert from 'node:assert/strict'
import {
  STARTUP_READY_CONTENT,
  STARTUP_SETUP_CONTENT,
  hasReceiverAddress,
  nextStartupPromptVisible,
  startupLiveContent,
} from '../src/startupPrompt'

assert.equal(
  STARTUP_SETUP_CONTENT,
  [
    ' ||| ',
    'Open the phone app.',
    'Set receiver IP.',
    'Follow the checklist.',
  ].join('\n'),
)

assert.equal(
  STARTUP_READY_CONTENT,
  [
    ' ||| ',
    'Receiver IP saved.',
    'Say something to start.',
    'Tap R1 for history.',
  ].join('\n'),
)

assert.equal(hasReceiverAddress({ privateAddress: '', publicAddress: '' }), false)
assert.equal(hasReceiverAddress({ privateAddress: '192.168.1.96:8788', publicAddress: '' }), true)
assert.equal(startupLiveContent({ privateAddress: '', publicAddress: '' }), STARTUP_SETUP_CONTENT)
assert.equal(startupLiveContent({ privateAddress: '192.168.1.96:8788', publicAddress: '' }), STARTUP_READY_CONTENT)

assert.equal(
  nextStartupPromptVisible(true, { type: 'receiver_status', status: 'connected' }),
  true,
)
assert.equal(
  nextStartupPromptVisible(true, { type: 'asr_status', status: 'transcribing' }),
  true,
)
assert.equal(
  nextStartupPromptVisible(true, { type: 'asr_status', status: 'vad_detected' }),
  false,
)
assert.equal(
  nextStartupPromptVisible(false, { type: 'receiver_status', status: 'connected' }),
  false,
)

console.log('startup prompt tests passed')
