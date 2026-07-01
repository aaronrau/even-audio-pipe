import assert from 'node:assert/strict'
import {
  buildAudioWsEndpoints,
  joinAddress,
  splitAddress,
  type AudioEndpointSettings,
} from '../src/audioEndpoints'

const settings: AudioEndpointSettings = {
  privateAddress: '192.168.1.50:8788',
  publicAddress: 'relay.example.com:443',
  token: 'shared-secret',
}

assert.deepEqual(splitAddress('192.168.1.50:8788'), {
  host: '192.168.1.50',
  port: '8788',
})

assert.deepEqual(splitAddress('http://192.168.1.50:5173'), {
  host: '192.168.1.50',
  port: '8788',
})

assert.equal(joinAddress('192.168.1.50', '8788'), '192.168.1.50:8788')
assert.equal(joinAddress('fd00::1', '8788'), '[fd00::1]:8788')
assert.equal(joinAddress('relay.example.com', ''), 'relay.example.com')

assert.deepEqual(buildAudioWsEndpoints(settings), [
  {
    label: 'Private',
    url: 'ws://192.168.1.50:8788/audio',
  },
  {
    label: 'Public',
    url: 'wss://relay.example.com/audio',
  },
])

assert.deepEqual(
  buildAudioWsEndpoints({
    ...settings,
    publicAddress: 'wss://relay.example.com:443/audio',
  }),
  [
    {
      label: 'Private',
      url: 'ws://192.168.1.50:8788/audio',
    },
    {
      label: 'Public',
      url: 'wss://relay.example.com:8788/audio',
    },
  ],
)

assert.equal(
  buildAudioWsEndpoints(settings, 'launch-token')[0]?.url,
  'ws://192.168.1.50:8788/audio?t=launch-token',
)

console.log('audio endpoint tests passed')
