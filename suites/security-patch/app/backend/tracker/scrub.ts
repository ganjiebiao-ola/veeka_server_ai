export type ScrubFinding = { kind: "secret" | "pii", name: string, sample: string, blocked: boolean }

export const SECRET_PATTERNS: [string, RegExp, boolean][] = [
  ["aliyun-ak-id", /LTAI[0-9A-Za-z]{12,24}/g, false],
  ["aws-ak-id", /AKIA[0-9A-Z]{16}/g, false],
  ["openai-style-key", /sk-[A-Za-z0-9_\-]{16,}/g, false],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{30,}/g, false],
  ["github-fine-grained-pat", /github_pat_[A-Za-z0-9_]{20,}/g, false],
  ["git-url-credentials", /x-access-token:[^@\s\"']+/gi, false],
  ["slack-app-token", /xapp-[0-9]-[A-Za-z0-9]+-[0-9]+-[a-f0-9]+/g, false],
  ["slack-bot-token", /xox[baprs]-[A-Za-z0-9\-]{10,}/g, false],
  ["bearer", /bearer\s+[A-Za-z0-9._\-]{20,}/gi, false],
  ["basic-auth", /basic\s+[A-Za-z0-9+\/=]{20,}/gi, false],
  ["authorization-header", /(\"?authorization\"?\s*[:=]\s*\"?)[A-Za-z0-9+\/=._\-]{20,}/gi, true],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, false],
  ["argv-secret", /(--(?:access-key-secret|secret(?:-key)?|client-secret|api-key|token|password)[= ]+)[A-Za-z0-9_\-+\/=]{12,}/gi, true],
  ["keyed-secret", /((?:access[_-]?key[_-]?secret|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|api[_-]?key|password|passwd|token)[\"\']?\s*[:=]\s*[\"\']?)[^\s\"\',]{16,}/gi, true],
  ["jwt", /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, false],
  ["cookie-header", /(\bcookie[\"\']?\s*[:=]\s*[\"\']?)[A-Za-z0-9%_\-=.\/+]{16,}/gi, true],
  // Scrub complete private key material and credential-bearing DSNs too.
  ["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, false],
  ["dsn-password", /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(?=@)/gi, true],
]

function mask(value: string): string {
  return value.length <= 8 ? "*".repeat(value.length) : value.slice(0, 4) + "******" + value.slice(-2)
}

export function scrub(text: string, extraSecrets: string[] = []): [string, ScrubFinding[]] {
  const findings: ScrubFinding[] = []
  let out = text || ""
  for (const value of extraSecrets.map(value => value.trim()).filter(value => value.length >= 12)) {
    if (!out.includes(value)) continue
    out = out.replaceAll(value, "«已脱敏:配置值»")
    findings.push({ kind: "secret", name: "env-exact-match", sample: mask(value), blocked: true })
  }
  // Complete blocks must run before the upstream header-only pattern.
  const patterns = [...SECRET_PATTERNS.slice(-2), ...SECRET_PATTERNS.slice(0, -2)]
  for (const [name, rx, keep] of patterns) {
    out = out.replace(rx, (match, prefix) => {
      findings.push({ kind: "secret", name, sample: mask(match), blocked: true })
      return (keep ? prefix : "") + `«已脱敏:${name}»`
    })
  }
  const pii: [string, RegExp, boolean][] = [
    ["uid", /(\b(?:uid|user_?id|memberid|blid)\b["']?\s*[:=]?\s*["']?)\d{5,}/gi, true],
    ["email", /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, false],
    ["phone", /\b(?:\+?\d{1,3}[ \-]?)?1[3-9]\d{9}\b/g, false],
    ["client-ip", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, false],
  ]
  for (const [name, rx, keep] of pii) {
    out = out.replace(rx, (match, ...args) => {
      if (name === "client-ip") {
        const [a, b] = match.split(".").map(Number)
        const offset = args[0] as number
        if (match.split(".").some((n: string) => Number(n) > 255) ||
          [0, 10, 127].includes(a) || a >= 224 ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
          (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ||
          /(?:version|ver|版本)[\s:=v]*$/i.test(out.slice(Math.max(0, offset - 40), offset))) return match
      }
      findings.push({ kind: "pii", name, sample: mask(match), blocked: false })
      return (keep ? args[0] : "") + `«已脱敏:${name}·请用查询式引用»`
    })
  }
  return [out, findings]
}
