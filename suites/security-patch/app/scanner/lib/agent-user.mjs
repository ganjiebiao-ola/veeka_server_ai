// The model and everything it runs (Bash tool, git commit, lint, tests) run as the unprivileged
// user "agent". The bridge, push and clone stay root, so only root can read GH_TOKEN
// and the bridge's /proc/<pid>/environ. Docker's default caps have no CAP_SYS_PTRACE, so another uid
// cannot read them. Off root (dev host, unit tests) nothing switches.
import { spawn, spawnSync } from "node:child_process"

export const AGENT_HOME = "/home/agent"
const SWITCH = process.getuid?.() === 0
const DROP = ["--reuid=agent", "--regid=agent", "--clear-groups", "--no-new-privs"]
// Credentials the agent must never see. The Anthropic key stays: the model client needs it.
// The OpenAI key goes only to the Codex process, which lib/codex.mjs adds back as CODEX_API_KEY.
const SECRETS = ["GH_TOKEN", "GITHUB_TOKEN", "SECPATCH_GIT_TOKEN", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "SSH_AUTH_SOCK", "OPENAI_API_KEY", "CODEX_API_KEY"]

export function agentEnv(env = process.env) {
  return { ...env, HOME: AGENT_HOME, CLAUDE_CONFIG_DIR: `${AGENT_HOME}/.claude`,
    ...(env.CODEX_HOME ? { CODEX_HOME: `${AGENT_HOME}/.codex` } : {}),
    ...Object.fromEntries(SECRETS.map(k => [k, undefined])) }
}

const asAgent = (cmd, args) => SWITCH ? ["setpriv", [...DROP, cmd, ...args]] : [cmd, args]
export const agentSpawn = (cmd, args, opts) => spawn(...asAgent(cmd, args), opts)
export const agentSpawnSync = (cmd, args, opts) => spawnSync(...asAgent(cmd, args), opts)

// A fixer's setsid or nohup process outlives the session's process group. Root kills every agent process
// before it trusts agent-writable state again. Off root, kill -1 would signal the developer's own processes.
export async function killAgentProcesses(spawn = SWITCH ? spawnSync : null, tries = 20) {
  if (!spawn) return
  for (let i = 0; i < tries; i++) {
    spawn(...asAgent("kill", ["-9", "--", "-1"]), { stdio: "ignore" })
    // pgrep exits 1 when it finds no process.
    if (spawn("pgrep", ["-u", "agent"], { stdio: "ignore" }).status === 1) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error("Agent processes survived the kill")
}
