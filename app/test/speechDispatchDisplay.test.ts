import assert from 'node:assert/strict'
import {
  formatSpeechDispatchDisplay,
  stripLeadingDispatchAgent,
} from '../src/speechDispatchDisplay'

assert.equal(
  formatSpeechDispatchDisplay({
    state: 'queued',
    text: 'Pike update the interaction docs',
  }),
  'Queued: Pike update the interaction docs',
)

assert.equal(
  formatSpeechDispatchDisplay({
    state: 'saved',
    text: 'ambient note for later',
  }),
  'Saved: ambient note for later',
)

assert.equal(
  formatSpeechDispatchDisplay({
    state: 'saved',
    text: '',
  }),
  'Saved',
)

assert.equal(
  formatSpeechDispatchDisplay({
    state: 'sent',
    agent: 'Pike',
    text: 'Pike update the interaction docs',
    message: 'Pike update the interaction docs',
  }),
  'Sent: Pike, update the interaction docs',
)

assert.equal(
  formatSpeechDispatchDisplay({
    state: 'sent',
    agent: 'Pike',
    text: 'update the interaction docs',
    message: 'update the interaction docs',
  }),
  'Sent: Pike, update the interaction docs',
)

assert.equal(
  formatSpeechDispatchDisplay({
    state: 'sent',
    agent: 'Pike',
    text: 'Pike',
    message: 'Pike',
  }),
  'Sent: Pike',
)

assert.equal(
  formatSpeechDispatchDisplay({
    state: 'sent',
    text: 'update the interaction docs',
  }),
  'Sent: update the interaction docs',
)

assert.equal(
  stripLeadingDispatchAgent('okay Pike, update the interaction docs', 'Pike'),
  'update the interaction docs',
)

assert.equal(
  stripLeadingDispatchAgent('Pike update Pike interaction docs', 'Pike'),
  'update interaction docs',
)
