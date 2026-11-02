import { writeArtifact as writeFileSync } from './agent-fs.mjs'
import { resolve } from 'node:path'
import { redact } from './redact.mjs'

export function relaySettings(env) {
  let url
  try { url = new URL(env.ANTHROPIC_BASE_URL) } catch { throw new Error('Relay requires a valid ANTHROPIC_BASE_URL') }
  const local = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(url.hostname)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('Relay requires HTTPS outside the local test environment and no URL credentials')
  }
  if (!env.ANTHROPIC_AUTH_TOKEN) throw new Error('Relay requires ANTHROPIC_AUTH_TOKEN')
  if (!env.ANTHROPIC_MODEL && !env.MODEL) throw new Error('Relay requires ANTHROPIC_MODEL or an explicit MODEL')
  return { model: env.MODEL || env.ANTHROPIC_MODEL, effort: env.EFFORT || 'medium' }
}

// Wrap the existing SDK query. Abort and close its process without starting another query.
export async function* smokeQuery(iter, { seconds, controller, artifactsDir, env = process.env }) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) throw new Error('Smoke limit must be greater than zero and at most 30 seconds')
  const started = Date.now()
  let timer
  let reason = 'no_output'
  let firstOutputMs = null
  let failure
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reason = 'timeout'
      reject(new Error('Provider smoke inconclusive: no model output within the time limit'))
    }, seconds * 1000)
  })
  try {
    while (true) {
      let next
      try { next = await Promise.race([iter.next(), deadline]) } catch (error) {
        if (reason !== 'timeout') reason = 'error'
        throw error
      }
      const { value: raw, done } = next
      if (done) break
      const message = JSON.parse(redact(JSON.stringify(raw), env))
      if ((message.type === 'assistant' && message.error) || (message.type === 'result' && message.is_error)) {
        reason = 'error'
        const details = message.message?.content?.filter(block => block.type === 'text').map(block => block.text) || []
        throw new Error(redact([message.error, message.result, ...details, ...(message.errors || [])].filter(Boolean).join(': '), env))
      }
      // Any reply counts. A model that starts with thinking or a tool call has answered, with no text yet.
      const output = message.type === 'assistant' && message.message?.content?.length > 0
      if (output) firstOutputMs = Date.now() - started
      yield message
      if (output) { reason = 'first_output'; return }
    }
    throw new Error('Provider smoke inconclusive: agent finished without model output')
  } catch (error) {
    failure = redact(error.message, env)
    throw new Error(failure)
  } finally {
    clearTimeout(timer)
    controller.abort()
    iter.close?.()
    // A stalled iterator must not delay cancellation or artifact export.
    void iter.return?.().catch(() => {})
    const rejectedSetting = reason === 'error' && /effort|reasoning|thinking|output_config/i.test(failure || '')
    writeFileSync(resolve(artifactsDir, 'smoke.json'), redact(JSON.stringify({
      kind: 'provider-smoke', provider: env.PROVIDER && env.PROVIDER !== 'claude' ? env.PROVIDER : env.ANTHROPIC_BASE_URL ? 'relay' : 'claude',
      model: env.MODEL || env.ANTHROPIC_MODEL || null, effort: env.EFFORT || 'medium',
      limitSeconds: seconds, stopReason: reason,
      status: firstOutputMs !== null ? 'responded' : reason === 'error' ? 'failed' : 'inconclusive',
      settingStatus: rejectedSetting ? 'rejected' : firstOutputMs !== null ? 'request_succeeded' : 'unverified',
      firstOutputMs, ...(failure ? { error: failure } : {}),
    }, null, 2), env))
  }
}
