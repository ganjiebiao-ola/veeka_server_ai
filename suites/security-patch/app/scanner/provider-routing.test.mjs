import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { providerWording } from './lib/artifacts.mjs'

const scenarios = ['prose', 'fenced', 'file'].map(replyStyle => ({ replyStyle, mainProvider: 'claude', reviewer: 'codex' }))
scenarios.push({ replyStyle: 'file', mainProvider: 'codex', reviewer: 'codex' })
scenarios.push({ replyStyle: 'file', mainProvider: 'claude', reviewer: 'antigravity' })
scenarios.push({ replyStyle: 'file', mainProvider: 'qoder', reviewer: 'codex' }, { replyStyle: 'file', mainProvider: 'claude', reviewer: 'qoder' })
const reviewers = {
  codex: { command: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  antigravity: { command: 'agy', model: 'gemini-4-argon', effort: 'high' },
  qoder: { command: 'qodercli', model: 'Qwen3.8-Flash', effort: '' },
}
for (const { replyStyle, mainProvider, reviewer } of scenarios) test(`bridge routes ${mainProvider} fixes and ${reviewer} reviews, reply=${replyStyle}`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ola-routing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  mkdirSync(repo)
  mkdirSync(artifacts)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'fix.txt'), 'before\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  writeFileSync(join(artifacts, 'base.json'), JSON.stringify({ sha: git('rev-parse', 'HEAD') }))
  writeFileSync(join(repo, 'fix.txt'), 'after\n')
  git('commit', '-qam', 'fix')
  const log = join(root, 'requests.jsonl')
  const record = `
    import { appendFileSync } from 'node:fs'
    async function record(provider, request) {
      let prompt = ''
      for await (const message of request.prompt) prompt += message.message.content
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ provider, prompt, options: request.options, command: request.command }) + '\\n')
      return prompt
    }
  `
  const reply = replyStyle === 'fenced'
    ? 'Private review narration:\n```json\n["Fix the missed site"]\n```\nDone.'
    : 'Private review narration: {"nested": ["Ignore nested notes"]} ["Fix the missed site"] ["Ignore later notes"]'
  const native = join(root, 'fake-native.mjs')
  writeFileSync(native, record + `
    import { writeFileSync } from 'node:fs'
    let count = 0
    export const redact = text => String(text)

    export async function* queryNative(request) {
      await record(request.reviewNotesFile ? ${JSON.stringify(reviewer)} : ${JSON.stringify(mainProvider)}, request)
      if (!request.reviewNotesFile) {
        request.onModelInfo?.({ model: 'native-test', effort: 'low' })
        request.persistOutput?.('Fix report')
        yield { type: 'system', subtype: 'init', session_id: 'fix-session' }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Fix report' }] } }
        yield { type: 'result', subtype: 'success', num_turns: 1 }
        return
      }
      request.onModelInfo?.({ model: 'review-model', effort: 'xhigh' })
      const notes = ${JSON.stringify(join(artifacts, 'review-'))} + (++count) + '.json'
      if ((await request.options.canUseTool('Edit', { file_path: request.options.cwd + '/fix.txt' })).behavior !== 'deny') throw new Error('Review permitted edits')
      if ((await request.options.canUseTool('Write', { file_path: notes })).behavior !== 'allow') throw new Error('Review denied notes')
      if ((await request.options.canUseTool('Bash', { command: "mkdir -p /workspace/artifacts && printf '%s' '[]' > " + notes })).behavior !== 'deny') throw new Error('Review permitted shell writes')
      if (${replyStyle === 'file'}) writeFileSync(notes, JSON.stringify(count === 1 ? ['Fix the missed site'] : []))
      const reply = count === 1 ? ${JSON.stringify(replyStyle === 'file' ? 'Private review narration: ["Ignore reply when file exists"]' : reply)} : 'Private review narration: no problems found. []'
      yield { type: 'assistant', message: { content: [{ type: 'text', text: reply.slice(0, 28) }, { type: 'text', text: reply.slice(28) }] } }
      // Each native request counts as one turn.
      yield { type: 'result', subtype: 'success' }
    }
  `)
  let source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
    .replace('import { query } from "@anthropic-ai/claude-agent-sdk";', record.replace("import { appendFileSync } from 'node:fs'", "") + `
      async function* query(request) {
        await record('claude', request)
        yield { type: 'system', subtype: 'init', session_id: 'fix-session', model: 'claude-test' }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Fix report' }] } }
        yield { type: 'result', subtype: 'success', num_turns: 1 }
      }
    `)
    .replaceAll('"/workspace/repo"', JSON.stringify(repo))
    .replaceAll('"/workspace/artifacts"', JSON.stringify(artifacts))
    .replaceAll('`./lib/${providers[provider].driver}.mjs`', JSON.stringify('file://' + native))
    .replace('await runPushWaitLoop();', 'return;')
  for (const name of ['exports', 'finding-ids', 'vendor', 'call-check', 'semgrep', 'push', 'fix-loop', 'checks', 'resume', 'redact', 'artifacts', 'smoke', 'profile', 'agent-user', 'agent-fs']) {
    source = source.replaceAll(`"./lib/${name}.mjs"`, JSON.stringify(new URL(`./lib/${name}.mjs`, import.meta.url).href))
  }
  // Keep routing and review intact. Check-step execution has its own integration tests.
  if (mainProvider === 'claude') source = source.replace('round = await checkStep(round);', 'round = round;')
  else source = source.replace(/import \{ baselineTests, runChecks \} from "[^"]+";/, `
    function baselineTests() { return new Set() }
    function runChecks() { return [{ name: 'new-test', ok: true, output: 'passes HEAD, fails base' }] }
  `)
  // Records each agent-process kill in order with the provider requests.
  source = source.replaceAll('await killAgentProcesses()', "await record('kill', { prompt: [] })")
  source = source.replaceAll('"../shared/providers.json"', JSON.stringify(new URL('../shared/providers.json', import.meta.url).href))
  source = source.replace('"../skill/ola-security-audit/findings.schema.json"', JSON.stringify(new URL('../skill/ola-security-audit/findings.schema.json', import.meta.url).href))
  const script = join(root, 'bridge.mjs')
  writeFileSync(script, source)
  const child = spawn(process.execPath, [script], { env: { ...process.env,
    PROVIDER: mainProvider, REVIEW_PROVIDER: reviewer, REVIEW_PROVIDER_COMMAND: JSON.stringify([reviewers[reviewer].command]),
    REVIEW_MODEL: reviewers[reviewer].model, ...(reviewers[reviewer].effort ? { REVIEW_EFFORT: reviewers[reviewer].effort } : {}),
    MODE: 'fix', MODEL: mainProvider === 'claude' ? 'haiku' : mainProvider === 'qoder' ? 'Qwen3.8-Flash' : 'gpt-6.1-sol', EFFORT: 'low', EVENTS_LOG: '1',
    PICKED_FILE: 'picked.json', PROMPT_FILE: '', CATEGORIES: '', RESUME_DONE: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  const exit = once(child, 'exit')
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', data => { stderr += data })
  assert.deepEqual(await exit, [0, null], stderr)
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  // Every fix round and the check run end with a kill, so no agent process outlives them into a review, check or push.
  assert.deepEqual(calls.map(r => r.provider), [mainProvider, 'kill', reviewer, mainProvider, 'kill', reviewer, ...(mainProvider === 'claude' ? [] : ['kill'])])
  const requests = calls.filter(r => r.provider !== 'kill')
  // The SDK alias 'haiku' still resolves to Haiku 4.5, so the bridge sends the full id.
  assert.equal(requests[0].options.model, mainProvider === 'claude' ? 'claude-haiku-5-5' : mainProvider === 'qoder' ? 'Qwen3.8-Flash' : 'gpt-6.1-sol')
  const review = requests[1]
  for (const request of requests.filter(r => r.provider === 'codex')) {
    assert.doesNotMatch(request.prompt, /\b(Read|Glob|Grep|Write)\b|(?:Bash|shell) is (?:blocked|prohibited)/)
    assert.match(request.prompt, /shell commands/)
    if (request.prompt.includes('Review pass')) assert.match(request.prompt, /write_artifact MCP tool with path and content/)
    else assert.match(request.prompt, /edit files and run checks in the workspace-write sandbox/)
  }
  assert.match(review.prompt, /Review pass 1/)
  assert.match(review.prompt, /reply with the JSON array as your final message/)
  assert.deepEqual(JSON.parse(readFileSync(join(artifacts, 'review-1.json'), 'utf8')), ['Fix the missed site'])
  assert.match(review.prompt, /\+after/)
  assert.deepEqual(review.command, [reviewers[reviewer].command])
  assert.equal(review.options.model, reviewers[reviewer].model)
  assert.equal(review.options.effort, reviewers[reviewer].effort)
  for (const field of ['thinking', 'resume']) assert.equal(review.options[field], undefined)
  assert.deepEqual(review.options.allowedTools, [])
  for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'Task']) assert.ok(review.options.disallowedTools.includes(tool), tool)
  assert.equal(review.options.maxTurns, undefined)
  assert.equal(review.options.maxBudgetUsd, undefined)
    assert.deepEqual(JSON.parse(readFileSync(join(artifacts, 'review-2.json'), 'utf8')), [])
    assert.match(requests[2].prompt, /Fix the missed site/)
    assert.match(requests[2].prompt, /only notes that led to a code change or were rejected/)
    assert.match(requests[2].prompt, /action: "fixed"\|"rejected"/)
    assert.match(requests[2].prompt, /Omit confirmations and run noise/)
    assert.match(requests[2].prompt, /A sink goes in later or review_notes, never both/)
    assert.equal(JSON.parse(readFileSync(join(artifacts, 'batch.json'), 'utf8')).review_rounds, 2)
    assert.equal(requests[2].options.resume, 'fix-session')
    assert.equal(requests[2].options.model, mainProvider === 'claude' ? 'claude-haiku-5-5' : mainProvider === 'qoder' ? 'Qwen3.8-Flash' : 'gpt-6.1-sol')
    if (mainProvider === 'claude') assert.equal(createHash('sha256').update(requests[2].prompt.replaceAll(root, '/fixture')).digest('hex'), 'bcae0379e694eb7fe1a82e374d2f264484f01066b9636e4a56b6fd124a01c41f')
  assert.equal(readFileSync(join(artifacts, 'report.md'), 'utf8'), 'Fix report\n\nFix report\n')
  assert.deepEqual(JSON.parse(readFileSync(join(artifacts, 'model-info.json'), 'utf8')), { model: mainProvider === 'claude' ? 'claude-test' : 'native-test', effort: 'low' })
  if (mainProvider === 'codex') assert.deepEqual(JSON.parse(readFileSync(join(artifacts, 'checks.json'), 'utf8')), [{ name: 'new-test', ok: true, output: 'passes HEAD, fails base' }])
  assert.match(readFileSync(join(artifacts, 'response.md'), 'utf8'), /Fix report/)
  assert.match(readFileSync(join(artifacts, 'working.patch'), 'utf8'), /\+after/)
  assert.match(readFileSync(join(artifacts, 'commits.log'), 'utf8'), /fix/)
})

test('a reviewer reply needs an explicit JSON array', () => {
  const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
  const parse = new Function(`${source.slice(source.indexOf('function reviewReplyArray'), source.indexOf('async function reviewPass'))}\nreturn reviewReplyArray`)()
  assert.deepEqual(parse('No problems. []'), [])
  assert.deepEqual(parse('Notes: ["Fix the sink"]'), ['Fix the sink'])
  assert.deepEqual(parse('```json\n[{"blocking":false,"text":"Suggestion [optional]"}]\n```'), [{ blocking: false, text: 'Suggestion [optional]' }])
  for (const text of ['No problems.', '{"notes": []}', '[unfinished']) assert.throws(() => parse(text))
})

for (const provider of ['claude', 'codex', 'antigravity', 'qoder']) test(`${provider} review prompt classifies blocking defects`, () => {
  const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
  const wording = providerWording(provider, 'review', 'ola-security-audit')
  const line = source.split('\n').find(line => line.includes('`Review pass'))
  const template = line.slice(line.indexOf('`'), line.lastIndexOf('`, { fresh') + 1)
  const render = language => new Function('wording', 'n', 'scope', 'reviewBase', 'reviewNotesFile', 'REVIEW_PROVIDER', 'diff', 'OUTPUT_LANGUAGE', `return ${template}`)(wording, 1, 'Review the batch diff.', 'base-sha', '/fixture/artifacts/review-1.json', provider, '', language)
  for (const language of ['en', 'zh']) {
    const prompt = render(language)
    assert.match(prompt, /"blocking": true\|false, "text"/)
    assert.match(prompt, /incomplete or bypassable fixes/)
    assert.match(prompt, /broken tests the batch added/)
    assert.match(prompt, /Anything that affects security or correctness of this batch is blocking, even if it looks like a convention/)
    assert.match(prompt, /required escaping or allowlist helper, or bypassing the project's security wrapper/)
    assert.match(prompt, /When unsure whether a note is security-relevant, mark it blocking/)
    assert.match(prompt, /Only pure style, naming, formatting, and out-of-scope issues are non-blocking/)
    assert.doesNotMatch(prompt, /Style, conventions, process or test suggestions/)
    assert.match(prompt, /non-blocking; do not request rework/)
    assert.ok(prompt.includes(`Express all note text in ${language === 'en' ? 'English' : 'Chinese'}.`))
  }
})
