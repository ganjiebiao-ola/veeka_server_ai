# Credentials & access

The authoritative home for credential handling in this workspace. `agent-instructions/security-defaults.md`
references this file rather than restating it.

## Credential red line

- **No credential ever enters the repository.** No keys, tokens, passwords, or connection strings
  in any tracked file — including generated reports and validation output.
- The `.gitignore` at the workspace root carries a mechanical backstop (`.env`, `*.key`, `*.pem`,
  `credentials*`, `token*.txt`, …). The harness-level check is `scripts/check-secret-scan` (#50, run
  by `ws health`): it scans tracked files for credential-shaped names and high-signal secret content.
- **Why:** a leaked credential is expensive and slow to rotate, and git history keeps it forever.
  Metadata about access is cheap to share; the secret itself never needs to be in the repo.

## Reuse the operator's local permissions

Agents run with the **permissions the person already has locally** — never a team-wide service key:

- `gh` CLI login state (`gh auth status`)
- browser login sessions
- IP allowlist / VPN connectivity
- the operator's own SSH config

**Do not mint a team-level API key** and check it in. For example, to reach a dev server, reuse the
operator's own SSH config — do not create a shared key and commit it. This keeps the blast radius tied
to a person (human-id) and avoids shared secrets no one owns.

## Requesting access

When a task needs access the operator lacks, describe **how to request it** — do not store the secret:
`TODO(owner)` — team's access-request path (ticket queue / owner to ping).

## Example & anti-example

- **Good:** an env note records `DB_PASSWORD` as a **field name** and where to request it — never its value.
- **Anti:** pasting a real token into this rule file "so the agent can use it." That is the exact
  thing the red line forbids.
