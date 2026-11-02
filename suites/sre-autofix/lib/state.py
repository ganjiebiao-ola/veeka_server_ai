"""Per-incident run directory under runs/sre-autofix/<incident-id>/ (gitignored via /runs/).

File names mirror the upstream archive's n2/ set (fixleg.go) so archived incidents and local runs read
the same; `status.json` carries a small phase machine.
"""
import os

from .common import append_jsonl, read_json, read_jsonl, utc_now, write_json, workspace_sha

PHASES = ("claimed", "parked", "planned", "fixing", "gate_passed", "gate_failed",
          "committed", "pushed", "shipped", "released")
PHASE_RANK = {p: i for i, p in enumerate(PHASES)}

FILES = {
    "input": "input.json", "incident": "incident.json", "issue_md": "issue.draft.md",
    "eligibility": "eligibility.json", "status": "status.json", "workspace": "workspace.json",
    "git_exclude": "git-exclude", "brief": "INCIDENT.md", "attempts": "attempts.jsonl",
    "last_run": "last-run.json", "agent_prompt": "agent-prompt.txt",
    "agent_response": "agent-response.md", "agent_events": "agent-events.jsonl",
    "gate": "verification-gate.json", "patch": "fix.patch", "fixnotes": "FIXNOTES.md",
    "verification": "verification.json", "pr_title": "pr-title.txt", "pr_body": "pr-body.md",
    "pr": "pr.json", "run_log": "run-log.jsonl", "repo_checks": "repo-checks.log",
}


class RunDir:
    def __init__(self, root, incident_id):
        self.root = root
        self.incident_id = incident_id
        self.dir = os.path.join(root, "runs", "sre-autofix", incident_id)
        self.worktree = os.path.join(self.dir, "worktree")

    def path(self, key):
        return os.path.join(self.dir, FILES[key])

    def exists(self):
        return os.path.isdir(self.dir)

    def ensure(self):
        os.makedirs(self.dir, exist_ok=True)

    # ---- status / phase ----
    def status(self):
        return read_json(self.path("status"), {}) or {}

    def phase(self):
        return self.status().get("phase", "")

    def phase_at_least(self, phase):
        return PHASE_RANK.get(self.phase(), -1) >= PHASE_RANK[phase]

    def set_phase(self, phase, note="", **extra):
        st = self.status()
        st.setdefault("incident", self.incident_id)
        st.setdefault("history", [])
        st["history"].append({"at": utc_now(), "from": st.get("phase", ""), "to": phase, "note": note})
        st["phase"] = phase
        st["updated_at"] = utc_now()
        st["workspace_sha"] = workspace_sha(self.root)
        st.update(extra)
        write_json(self.path("status"), st)
        return st

    # ---- json helpers ----
    def read(self, key, default=None):
        return read_json(self.path(key), default)

    def write(self, key, obj):
        write_json(self.path(key), obj)

    # ---- attempts ----
    def attempts(self):
        return read_jsonl(self.path("attempts"))

    def append_attempt(self, att):
        att = dict(att)
        att.setdefault("at", utc_now())
        att.setdefault("incident", self.incident_id)
        att.setdefault("attempt", len(self.attempts()) + 1)
        append_jsonl(self.path("attempts"), att)
        return att

    def log_run(self, command, exit_code, operator=""):
        append_jsonl(self.path("run_log"), {
            "ts": utc_now(), "workspace_sha": workspace_sha(self.root),
            "command": "sre-autofix " + command, "exit_code": exit_code, "operator": operator,
        })
