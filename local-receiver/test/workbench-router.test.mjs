import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkbenchRouter } from '../workbench-router.js'

function router(options = {}) {
  return createWorkbenchRouter({
    enabled: true,
    agent: '',
    agents: ['Flux', 'Brock', 'Pike', 'Wolf'],
    requireAgentPrefix: true,
    agentPrefixWordLimit: 3,
    agentArmTimeoutMs: 30_000,
    ...options,
  })
}

test('routes an explicit agent prefix inside the configured prefix window', () => {
  const target = {}
  assert.deepEqual(router().routeTranscript('hey Flux check status', target), {
    agent: 'Flux',
    message: 'check status',
  })
})

test('removes repeated agent names from the routed message content', () => {
  assert.deepEqual(router().routeTranscript('Pike Pike update docs and Pike run tests', {}), {
    agent: 'Pike',
    message: 'update docs and run tests',
  })

  const target = {}
  const workbench = router()
  assert.deepEqual(workbench.routeTranscript('Pike', target), {
    skip: true,
    reason: 'agent_armed',
    agent: 'Pike',
  })
  assert.deepEqual(workbench.routeTranscript('Pike update docs', target), {
    agent: 'Pike',
    message: 'update docs',
  })
})

test('arms an agent-only utterance and routes the next transcript to that agent', () => {
  const target = {}
  const workbench = router()

  assert.deepEqual(workbench.routeTranscript('Wolf', target), {
    skip: true,
    reason: 'agent_armed',
    agent: 'Wolf',
  })
  assert.deepEqual(workbench.routeTranscript('terminate session', target), {
    agent: 'Wolf',
    message: 'terminate session',
    clearPendingAgentOnSent: true,
  })
})

test('requires an agent prefix when configured', () => {
  assert.deepEqual(router().routeTranscript('check status', {}), {
    skip: true,
    reason: 'missing_agent_prefix',
  })
})

test('preserves raw command words when cleanup collapses a command to only the agent', () => {
  assert.equal(
    router().preserveCommand('Wolf terminate session', 'Wolf'),
    'Wolf terminate session',
  )
})
