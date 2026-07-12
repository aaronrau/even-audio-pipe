import assert from 'node:assert/strict'
import test from 'node:test'
import {
  customAgentCleanupPrompt,
  customAgentDetail,
  customAgentInvokedInText,
  findCustomAgentInvocation,
  normalizeCustomAgents,
  speakerBreakoutVerified,
  verifyCustomAgentInvocation,
} from '../custom-agent.js'

const [meemo] = normalizeCustomAgents([{
  id: 'meemo',
  name: 'Meemo',
  aliases: ['Meamo', 'Me Mo', 'Mimo'],
  nameCorrectionPrompt: 'Normalize Meamo, Me Mo, and Mimo to Meemo.',
  processingPrompt: 'Return only distinct, deduplicated Markdown bullet points.',
  processingMaxTokens: 8_192,
  speakerMatchThreshold: 0.58,
  matchAnywhere: true,
}])

test('matches Meemo and its configured STT aliases in raw and cleaned text', () => {
  assert.equal(
    findCustomAgentInvocation(
      'Meemo summarize the architecture',
      'Meamo summarize the architecture',
      [meemo],
    ).message,
    'summarize the architecture',
  )
  assert.equal(
    findCustomAgentInvocation(
      'please Meemo capture all decisions',
      'please me mo capture all decisions',
      [meemo],
    ).message,
    'capture all decisions',
  )
  assert.equal(
    findCustomAgentInvocation(
      'Meemo create a memo from this discussion',
      'Mimo create a memo from this discussion',
      [meemo],
    ).message,
    'create a memo from this discussion',
  )
})

test('requires the custom invocation in both raw and cleaned transcripts', () => {
  assert.equal(
    findCustomAgentInvocation('Meemo invent a memo', 'ordinary background speech', [meemo]),
    null,
  )
})

test('matches a trailing Mimo invocation and preserves the preceding conversation', () => {
  const cleaned = 'We chose the local receiver. Aaron will test it Friday. Meemo'
  const raw = 'We chose the local receiver. Aaron will test it Friday. Mimo'
  assert.equal(
    findCustomAgentInvocation(cleaned, raw, [meemo]).message,
    'We chose the local receiver. Aaron will test it Friday.',
  )
})

test('identifies only the batch segment that contains the custom invocation', () => {
  const segments = [
    'Hey Mimo, help me think through these ideas.',
    'The next speaker describes the hiring criteria.',
    'Communication and relevant questions matter.',
  ]
  assert.deepEqual(
    segments.map(text => customAgentInvokedInText(text, meemo)),
    [true, false, false],
  )
})

test('authorizes a multi-speaker memo from the verified invocation segment', () => {
  const rawSegments = [
    'Hey Mimo, help me think through these ideas.',
    'Another speaker describes the hiring criteria.',
    'Communication and relevant questions matter.',
  ]
  const diarizationResults = [
    {
      breakout: {
        turns: [{
          speaker: {
            matchedProfile: false,
            profileId: 'uid:1373602',
            profileSimilarity: 0.588,
          },
        }],
      },
    },
    { breakout: { turns: [{ speaker: { matchedProfile: false } }] } },
    { breakout: { turns: [{ speaker: { matchedProfile: false } }] } },
  ]
  assert.deepEqual(
    verifyCustomAgentInvocation(rawSegments, diarizationResults, meemo),
    { invocationIndexes: [0], verified: true },
  )
})

test('does not register a custom agent that conflicts with Workbench', () => {
  assert.deepEqual(normalizeCustomAgents([{
    id: 'flux',
    name: 'Flux',
    processingPrompt: 'Return Markdown.',
  }], ['Flux']), [])
})

test('keeps the configured Meemo output token budget', () => {
  assert.equal(meemo.processingMaxTokens, 8_192)
})

test('adds custom name corrections without replacing the base cleanup prompt', () => {
  assert.equal(
    customAgentCleanupPrompt('Base cleanup.', [meemo]),
    'Base cleanup. Normalize Meamo, Me Mo, and Mimo to Meemo.',
  )
})

test('requires every diarized turn to match the enrolled profile', () => {
  assert.equal(speakerBreakoutVerified({
    breakout: {
      turns: [
        { speaker: { matchedProfile: true } },
        { speaker: { matchedProfile: true } },
      ],
    },
  }), true)
  assert.equal(speakerBreakoutVerified({
    breakout: {
      turns: [
        { speaker: { matchedProfile: true } },
        { speaker: { matchedProfile: false } },
      ],
    },
  }), false)
  assert.equal(speakerBreakoutVerified({ verificationFailed: true }), false)
})

test('supports a custom-agent threshold without changing the stored profile', () => {
  const result = {
    breakout: {
      turns: [{
        speaker: {
          matchedProfile: false,
          profileId: 'uid:1373602',
          profileSimilarity: 0.588,
        },
      }],
    },
  }
  assert.equal(speakerBreakoutVerified(result, 0.58), true)
  assert.equal(speakerBreakoutVerified(result, 0.59), false)
})

test('detail preserves the raw, cleaned, and complete Markdown memo', () => {
  const detail = customAgentDetail({
    rawTranscript: 'Meamo capture all of this',
    cleanedTranscript: 'Meemo capture all of this',
    agentName: 'Meemo',
    processedText: '- Everything was captured.\n- Action: Review it Friday.',
  })
  assert.match(detail, /Raw ASR\nMeamo capture all of this/)
  assert.match(detail, /Cleaned transcript\nMeemo capture all of this/)
  assert.match(detail, /Meemo memo\n- Everything was captured/)
})
