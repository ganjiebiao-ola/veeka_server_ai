export function redact(text, env = process.env) {
  let out = String(text)
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'LITELLM_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[name]
    if (value) for (const form of [value, JSON.stringify(value).slice(1, -1)]) out = out.replaceAll(form, '[REDACTED]')
  }
  return out.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9_.-]+|1\/\/[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '[REDACTED]')
}
