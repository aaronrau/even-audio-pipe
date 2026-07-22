export function defaultCleanupPrompt() {
  return [
    'You clean short ASR transcript chunks from smart glasses.',
    'Fix obvious speech recognition errors, capitalization, punctuation, and light grammar only.',
    'Preserve these established pronunciation corrections in every transcript:',
    'Always rewrite every occurrence of "length view", "lang fuse", "land fuse", "ling few", "lane view", and "lanefuse" as "Langfuse".',
    'Rewrite "code x", "condex", "codec", and "kodex" as "Codex" when referring to the coding agent or product.',
    'Rewrite "yaws", "evalues", "e values", "e vals", and "evals" as "EVALS" when referring to the evaluation system.',
    'Treat Simcha and simcha.ai as fixed product and domain names. When context clearly refers to the Simcha product, company, app, login, or email domain, rewrite observed sound-alikes such as Semcha, Symtra, Simchot, Simchad, sim chat, asim chat, SMCAT, and their .ai forms as Simcha or simcha.ai as appropriate.',
    'When software, testing, integration, or workflow context clearly means complete-path coverage, rewrite ASR variants such as "N to N", "N two N", "end to N", "N to end", "end two end", and "E to E" as "end-to-end". Do not rewrite literal letters, ranges, or unrelated uses.',
    "Preserve the speaker's meaning and wording.",
    'Do not remove command words after a routing target; keep "Wolf terminate session" as "Wolf terminate session", not "Wolf".',
    'Do not add facts, commands, explanations, or markdown.',
    'If uncertain, keep the original wording.',
    'Return only the cleaned transcript text.',
  ].join(' ')
}

export function defaultCodingAgentPrompt() {
  return [
    'The transcript addresses {agent}, a local AI coding agent.',
    'Begin the cleaned transcript with the canonical target name "{agent}" and omit only greetings or filler that precede that target.',
    'Treat the remaining speech as an engineering task or planning prompt.',
    'The routing-name corrections are "flex" to "Flux", "block" or "brook" to "Brock", "pipe" to "Pike", and "wolfe" to "Wolf".',
    'When the audio supports it, prefer common coding actions and terms such as analyze, inspect, search, plan, implement, fix, refactor, update, debug, reproduce, verify, run, test, build, lint, type-check, commit, push, pull, branch, pull request, issue, ticket, repository, worktree, terminal, shell, dependency, endpoint, API, prompt, trace, and logs, and technical names such as Codex, tmux, Git, GitHub, Langfuse, npm, pnpm, pytest, Docker, GPT, Linear, Datadog, and EVALS.',
    'Preserve the requested order, scope, constraints, existing filenames, paths, flags, explicitly dictated exact identifiers, versions, and polite command phrasing such as "can you", "please", and "make sure".',
    'When the speaker asks the agent to create or rename something, correct supported ASR mistakes inside the requested new title or identifier too; do not preserve a mishearing merely because it appears after "called" or "named".',
    'For an agent prompt, remove filler and false starts, collapse accidental repeated words, and repair obvious grammar so the instruction is coherent, while retaining every requested action and constraint.',
    'Never summarize, shorten, or omit an informational clause. The cleaned transcript must retain every goal, action, condition, sequence, and requested validation from the raw transcript. If a grammar repair might lose meaning, keep the awkward wording instead.',
    'Correct only context-supported ASR mistakes; do not improve the plan, invent steps, execute the task, or turn uncertain speech into a command.',
    'When "N to N" directly modifies conversation flow, test, workflow, or coverage, rewrite every such occurrence as "end-to-end", including as "End-to-End" inside a new title the speaker is asking the agent to create.',
    'After an agent target, rewrite the session-control sound-alikes "Claire session", "Clare session", and "clean session" as "clear session"; the word "session" must already be present.',
    'In an AI model or conversation-simulation context, rewrite "GBT" as "GPT". Rewrite "in PM" as "npm" when it directly precedes a package command such as test, install, run, or build. Rewrite "get status" and "get diff" as "git status" and "git diff" in repository context.',
    'Rewrite "hen all the chains push to death" and "did all the change got pushed to dev" as "did all the changes get pushed to dev".',
    'Repair "make sure that is successfully able to" as "make sure it can successfully". Otherwise repair "is successfully able to" as "can successfully" only when the original subject remains in the sentence.',
    'Use these guarded coding-context examples:',
    'Raw: "Hey Pipe, make an imp lamentation plan, then run get status and in PM test." Cleaned: "Pike, make an implementation plan, then run git status and npm test."',
    'Raw: "Hey Flux, can you create an N to N conversation flow test? Specifically a new one called N to N Conversation Flow Workshop Test. The goal is to connect to the workshop and create a workshop. Make sure it passes all workshop guides." Cleaned: "Flux, can you create an end-to-end conversation flow test? Specifically, a new one called End-to-End Conversation Flow Workshop Test. The goal is to connect to the workshop and create a workshop. Make sure it passes all workshop guides."',
    'Raw: "Hey Flux, can you pull the latest changes, make sure everything is at the dive branch, and clean any wood trees that are not there?" Cleaned: "Flux, can you pull the latest changes, make sure everything is on the dev branch, and clean up any worktrees that are not there?"',
    'Raw: "Hey Brock. Claire session." Cleaned: "Brock, clear session."',
    'Raw: "Hey Flex, use code x to inspect the length view traces and update the e values test." Cleaned: "Flux, use Codex to inspect the Langfuse traces and update the EVALS test."',
  ].join(' ')
}

export function cleanupPromptForTranscript(
  basePrompt,
  codingAgentPrompt,
  rawTranscript,
  workbenchRouter,
) {
  const route = workbenchRouter.parseIntent(rawTranscript) || guardedFluxMispronunciation(rawTranscript)
  if (!route?.agent) return basePrompt

  return [
    basePrompt,
    codingAgentPrompt.replaceAll('{agent}', route.agent),
  ].filter(Boolean).join(' ')
}

function guardedFluxMispronunciation(rawTranscript) {
  const words = String(rawTranscript || '').trim().split(/\s+/).filter(Boolean)
  const prefixLimit = Math.min(3, words.length)
  for (let index = 0; index < prefixLimit; index += 1) {
    if (normalizeWords(words[index]) !== 'fuck') continue

    const command = normalizeWords(words.slice(index + 1).join(' '))
    if (
      /\b(analyze|build|check|clear|commit|create|debug|fix|implement|inspect|lint|open|plan|pull|push|refactor|review|run|search|test|terminate|update|verify)\b/.test(command)
    ) {
      return { agent: 'Flux' }
    }
  }

  return null
}

function normalizeWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
