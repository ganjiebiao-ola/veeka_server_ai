#!/usr/bin/env python3
"""suites/sre-inspect CLI — verbs: doctor | spike | window | intake | dive | finish | mcp-config | sls | validate.

Exit codes: 0 ok · 1 error · 2 usage/config · 3 nothing to do (suppressed / no candidates) ·
4 report failed the contract · 5 blocked (secret in outbound text).
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import deploys as _deploys, discover as _discover, doctor as _doctor, envfile, grafana, inspect_md, intake as _intake, mcp, report as _report  # noqa: E402
from lib import spike as _spike, tenant as _tenant, window as _window  # noqa: E402
from lib.common import (EXIT_BLOCKED, EXIT_ERROR, EXIT_FAILED, EXIT_NOTHING, EXIT_OK, EXIT_USAGE, SuiteError,  # noqa: E402
                        parse_duration, read_json, read_text, require_python, short_hash, utc_now, write_json, write_text)
from lib.ledger import Ledger  # noqa: E402


def say(msg):
    print(msg, flush=True)


class Ctx:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.suite_dir = os.path.join(self.root, "suites", "sre-inspect")
        self.runs = os.path.join(self.root, "runs", "sre-inspect")
        self.env_path = os.environ.get("SRE_INSPECT_ENV_FILE") or os.path.join(self.suite_dir, "env", ".env.holmes")
        self.env_values = envfile.load(self.env_path)
        envfile.apply(self.env_values)          # never overrides an already-set variable
        self._tenant = None
        self._routes = None

    def tenant(self):
        if self._tenant is None:
            self._tenant = _tenant.load(self.suite_dir)
        return self._tenant

    def routes(self):
        if self._routes is None:
            self._routes = _tenant.load_routes(self.suite_dir, self.tenant())
        return self._routes

    def ledger(self):
        t = self.tenant()
        return Ledger(os.path.join(self.runs, "ledger.json"), t.cooldown, t.recurrence)

    def queue_path(self):
        return os.path.join(self.runs, "queue", "latest.json")


# ---------------------------------------------------------------- verbs
def cmd_validate(ctx, a):
    t = ctx.tenant()
    probs = _tenant.validate(t)
    routes, rpath = ctx.routes()
    probs += _tenant.validate_routes(routes, ctx.suite_dir, t)
    probs += toolset_guard(ctx.suite_dir)
    say("tenant: %s" % os.path.relpath(t.path, ctx.root))
    say("routes: %s (%d rules)" % (os.path.relpath(rpath, ctx.root) if rpath else "missing", len(routes)))
    if probs:
        say("FAIL: validate\n  - " + "\n  - ".join(probs))
        return EXIT_USAGE
    say("OK: validate")
    return EXIT_OK


def toolset_guard(suite_dir):
    """Port of ola-sre-agent toolset_guard_test.go: no credential shape in a custom toolset command."""
    import glob
    import re
    bad = re.compile(r"(?i)--(access-key-(id|secret)|secret(-key)?|api-key|token|password)\b|\$\{?[A-Z_]*(SECRET|TOKEN|PASSWORD|ACCESS_KEY)[A-Z_]*\}?|\{\{\s*env\.")
    probs = []
    for f in sorted(glob.glob(os.path.join(suite_dir, "toolsets", "*.yaml"))):
        for i, line in enumerate(read_text(f, "").splitlines(), 1):
            if line.strip().startswith("#"):
                continue
            m = bad.search(line)
            if m:
                probs.append("%s:%d credential shape in toolset (%r) — credentials travel only via the container env" % (os.path.basename(f), i, m.group(0)))
    return probs


def cmd_doctor(ctx, a):
    rep = _doctor.run_doctor(ctx, with_mcp=not a.no_mcp)
    say(rep.render())
    return EXIT_OK if rep.must_ok() else EXIT_ERROR


def cmd_spike(ctx, a):
    md = _spike.run_spike(ctx, slow=a.slow, with_mcp=not a.no_mcp)
    path = os.path.join(ctx.runs, "spike-%s.md" % time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    write_text(path, md)
    say(md)
    say("\nwritten: %s (gitignored under runs/)" % os.path.relpath(path, ctx.root))
    return EXIT_OK


def cmd_window(ctx, a):
    t = ctx.tenant()
    tz, tzname = t.tz()
    ev = _window.parse_at(a.at)
    f = _window.facts(ev, a.before, a.after, tz, tzname)
    say(_window.block(f))
    if a.json:
        say(json.dumps(f, ensure_ascii=False))
    return EXIT_OK


def _window_args(ctx, a):
    t = ctx.tenant()
    now = int(time.time())
    if a.frm or a.to:
        frm = _window.parse_at(a.frm) if a.frm else now - parse_duration(t.lookback)
        to = _window.parse_at(a.to) if a.to else now
    else:
        frm, to = now - parse_duration(a.since or t.lookback), now
    if to <= frm:
        raise SuiteError("--to must be after --from", EXIT_USAGE)
    return frm, to


def cmd_intake(ctx, a):
    t = ctx.tenant()
    probs = _tenant.validate(t)
    if probs:
        raise SuiteError("tenant.yaml invalid:\n  - " + "\n  - ".join(probs), EXIT_USAGE)
    routes, rpath = ctx.routes()
    client = grafana.from_env()
    frm, to = _window_args(ctx, a)
    if a.print_policy:
        say("notification policy tree:\n" + json.dumps(client.policies(), ensure_ascii=False, indent=1))
    alerts, notes = _intake.collect(client, t, frm, to)
    items, dropped = _intake.build_queue(alerts, routes, ctx.ledger(), t)
    tz, tzname = t.tz()
    text = _intake.digest(items, dropped, frm, to, notes, tz, tzname)
    queue = {"generated_at": utc_now(), "from_epoch": frm, "to_epoch": to, "tenant": t.id,
             "routes_file": os.path.relpath(rpath, ctx.root) if rpath else None, "items": items,
             "dropped": [{"alert": al, "why": why} for al, why in dropped]}
    write_json(ctx.queue_path(), queue)
    write_json(os.path.join(ctx.runs, "queue", "queue-%s.json" % time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())), queue)
    say(text)
    say("queue: %s" % os.path.relpath(ctx.queue_path(), ctx.root))
    if a.json:
        say(json.dumps(queue, ensure_ascii=False))
    return EXIT_OK if any(it["candidate"] for it in items) else EXIT_NOTHING


def _pick(ctx, a):
    """Queue item by number, or a manual alert from --rule-uid/--at/--subject."""
    if a.item is not None:
        q = read_json(ctx.queue_path())
        if not q:
            raise SuiteError("no queue yet — run `intake` first", EXIT_USAGE)
        for it in q.get("items", []):
            if int(it["n"]) == int(a.item):
                return it["alert"], it["route"], it["ledger"]
        raise SuiteError("queue item %s not found in %s" % (a.item, ctx.queue_path()), EXIT_USAGE)
    if not (a.rule_uid and a.at):
        raise SuiteError("先 `run intake [--from … --to …]` 生成队列，再 `run dive <编号>`（历史告警把窗口指到历史即可）。\n"
                         "手动形式 --rule-uid + --at (+ --subject) 只在告警史保留期之外需要：值来自 "
                         "runs/sre-inspect/queue/*.json 的 alert.rule_uid / eval_epoch，或 alerting_manage_rules operation=list。", EXIT_USAGE)
    routes, _ = ctx.routes()
    ev = _window.parse_at(a.at)
    subject = a.subject or ""
    r = routes.get(a.rule_uid)
    alert = {"fingerprint": "fb-" + short_hash(a.rule_uid + "|" + subject, 16), "fingerprint_source": "fallback",
             "rule_uid": a.rule_uid, "rule_name": r.name if r else "", "title": a.title or ((r.name if r else a.rule_uid) + " " + subject).strip(),
             "subject": subject, "eval_epoch": ev, "window_sec": None, "labels": {}, "annotations": {}, "links": {},
             "state": "manual", "source": "manual", "starts_at": ev, "ends_at": None}
    rt = _intake.route(alert, routes)
    return alert, rt, ctx.ledger().peek(alert)


def cmd_dive(ctx, a):
    t = ctx.tenant()
    alert, rt, led = _pick(ctx, a)
    if rt["action"] == "unrouted" and not a.force:
        say("unrouted：%s\n先在 routes.yaml 对号并补 triage 模板，或 `--force` 以空模板深挖。" % rt["reason"])
        return EXIT_NOTHING
    if rt["action"] == "known_bug" and not a.force:
        say("known_bug（确定性判定，不深挖）：%s\n`--force` 可强开。" % rt["reason"])
        return EXIT_NOTHING
    ledger = ctx.ledger()
    dec = ledger.check(alert) if not a.force else ledger.peek(alert)
    if dec.get("suppress") and not a.force:
        say("冷却窗内同指纹已并入 %s（第 %d 次）：%s\n`--force` 可另开一件。" % (dec.get("active_incident"), dec.get("occurrence", 0), dec["reason"]))
        return EXIT_NOTHING
    tz, tzname = t.tz()
    facts = _window.facts(alert["eval_epoch"], a.before, a.after, tz, tzname, alert.get("window_sec"))
    inc_id = "INC-%s-%s" % (time.strftime("%Y%m%d-%H%M%S", time.gmtime(alert["eval_epoch"])), short_hash(alert["fingerprint"] + str(alert["eval_epoch"]), 8))
    inc_dir = os.path.join(ctx.runs, inc_id)
    if os.path.exists(inc_dir) and not a.force:
        raise SuiteError("%s already exists (use --force to re-render)" % os.path.relpath(inc_dir, ctx.root), EXIT_USAGE)
    ledger.register(alert, inc_id)
    tmpl = ""
    if rt.get("template"):
        tmpl = read_text(os.path.join(ctx.suite_dir, t.triage_dir, rt["template"]), "")
    lookback = parse_duration(a.deploy_lookback or "24h")
    events, note = _deploys.fetch(t.deploys, facts["from_epoch"] - lookback, facts["to_epoch"])
    md = inspect_md.render(inc_id, alert, rt, facts, tmpl, events, note, t, t.skills)
    write_json(os.path.join(inc_dir, "alert.json"), alert)
    write_json(os.path.join(inc_dir, "route.json"), rt)
    write_json(os.path.join(inc_dir, "facts.json"), facts)
    write_json(os.path.join(inc_dir, "deploys.json"), {"events": events, "note": note})
    write_json(os.path.join(inc_dir, "ledger.json"), dec)
    write_json(os.path.join(inc_dir, "report.json"), _report.skeleton(inc_id, alert, rt, facts, t, dec.get("occurrence", 1),
                                                                      os.path.relpath(inc_dir, ctx.root)))
    write_text(os.path.join(inc_dir, "INSPECT.md"), md)
    say("incident %s → %s" % (inc_id, os.path.relpath(inc_dir, ctx.root)))
    if dec.get("recurred"):
        say("复发：上次 %s（%s）" % (dec.get("active_incident"), dec["reason"]))
    say("读 %s/INSPECT.md 开始验真与深挖；完成后 `suites/sre-inspect/run finish %s`" % (os.path.relpath(inc_dir, ctx.root), inc_id))
    if a.holmes:
        return run_holmes(ctx, inc_dir, md)
    return EXIT_OK


def run_holmes(ctx, inc_dir, md):
    """Optional: hand INSPECT.md to a local Holmes via the suite's compose (holmes_cli.py ask)."""
    from lib.common import run, which
    if not which("docker"):
        raise SuiteError("--holmes needs docker", EXIT_USAGE)
    compose = os.path.join(ctx.suite_dir, "holmes", "docker-compose.yaml")
    prompt_path = os.path.join(inc_dir, "holmes-prompt.md")
    write_text(prompt_path, md + "\n\n把最终结论写成上面《产出》要求的 rca.md 内容（Markdown），report.json 的字段值以 JSON 代码块附在末尾。")
    # the service's entrypoint is the HTTP server; the CLI needs it overridden or the args are swallowed
    argv = ["docker", "compose", "-f", compose, "run", "--rm", "-T", "--entrypoint", "python", "-v", inc_dir + ":/inc:ro", "holmes",
            "/app/holmes_cli.py", "ask", "--no-interactive", "--show-tool-output", "--prompt-file", "/inc/holmes-prompt.md"]
    say("holmes: " + " ".join(argv[:8]) + " …（墙钟 30m，detached 运行更稳）")
    res = run(argv, cwd=ctx.suite_dir, wall=1800)
    write_text(os.path.join(inc_dir, "holmes.md"), res.stdout + ("\n\n<!-- stderr -->\n" + res.stderr if res.stderr.strip() else ""))
    say("holmes 回答已落 %s/holmes.md（exit %d）——据此整理 rca.md 与 report.json，再 finish" % (os.path.relpath(inc_dir, ctx.root), res.code))
    return EXIT_OK if res.code == 0 else EXIT_ERROR


def cmd_finish(ctx, a):
    inc_dir = os.path.join(ctx.runs, a.incident)
    if not os.path.isdir(inc_dir):
        raise SuiteError("no such incident dir: %s" % os.path.relpath(inc_dir, ctx.root), EXIT_USAGE)
    rep, findings = _report.finish(inc_dir, ctx.root)
    v = rep["verdict"]["value"]
    if v == "PASS":
        ctx.ledger().close(rep["incident"]["fingerprint"])
    say("finish %s：verdict=%s state=%s scrub findings=%d" % (a.incident, v, rep["status"]["state"], len(findings)))
    rc = rep.get("root_cause") or {}
    if v == "FAIL" and rc.get("cause_locus") == "code_defect" and rc.get("confidence") in ("medium", "high"):
        say("下一步：suites/sre-autofix/run claim %s" % os.path.relpath(os.path.join(inc_dir, "report.json"), ctx.root))
    elif v == "FAIL":
        say("根因归属 %s（置信 %s）——不进修复腿；报告已可交给负责该层的人。" % (rc.get("cause_locus") or "?", rc.get("confidence") or "?"))
    return EXIT_OK


def cmd_mcp_config(ctx, a):
    if a.write:
        path = os.path.join(ctx.root, ".mcp.json")
        text, action = mcp.merge_claude_mcp_json(read_text(path))
        if action != "unchanged":
            write_text(path, text)
        say("%s %s (server `grafana`; file is per-machine and gitignored)" % (os.path.relpath(path, ctx.root), action))
        say("next: `set -a; . suites/sre-inspect/env/.env.holmes; set +a` then start `claude` FROM %s; approve the project MCP server when asked; `/mcp` must list grafana" % ctx.root)
        say("(previously declined the prompt? `claude mcp reset-project-choices`)")
        return EXIT_OK
    say("# Claude Code — merge into <workspace>/.mcp.json, or let the suite do it: `run mcp-config --write`")
    say("# (values come from your environment; `set -a; . suites/sre-inspect/env/.env.holmes; set +a` before starting claude)")
    say(json.dumps(mcp.claude_mcp_json(), indent=2))
    say("\n# Codex — ~/.codex/config.toml")
    say(mcp.codex_toml())
    return EXIT_OK


def cmd_discover(ctx, a):
    if a.what == "datasources":
        return cmd_sls(ctx, argparse.Namespace(args=["datasources", "--all-types"]))
    if a.what == "rules":
        routes, _ = ctx.routes()
        client = grafana.from_env()
        rows, snippet = _discover.rules(client, routes)
        names = {d.get("uid"): d.get("name") for d in client.datasources()}
        say(_discover.format_rules(rows, snippet, names))
        return EXIT_OK
    if a.what == "deploys":
        if not a.repo:
            raise SuiteError("usage: run discover deploys <owner/repo>", EXIT_USAGE)
        d = _discover.deploys(a.repo)
        say(_discover.format_deploys(a.repo, d))
        return EXIT_OK if d["snippet"] else EXIT_NOTHING
    raise SuiteError("discover what? rules | deploys <owner/repo> | datasources", EXIT_USAGE)


def cmd_sls(ctx, a):
    import importlib
    sys.path.insert(0, os.path.join(ctx.suite_dir, "tools", "grafana-sls"))
    sls_query = importlib.import_module("sls_query")
    return sls_query.main(a.args)


# ---------------------------------------------------------------- main
def build_parser():
    p = argparse.ArgumentParser(prog="suites/sre-inspect/run", description=__doc__.split("\n")[0])
    p.add_argument("--root", default=os.getcwd())
    sub = p.add_subparsers(dest="verb")
    sub.add_parser("validate", help="tenant.yaml / routes.yaml / toolset credential guard (offline)")
    s = sub.add_parser("doctor", help="readiness of the Grafana data plane (D0–D5)")
    s.add_argument("--no-mcp", action="store_true")
    s = sub.add_parser("spike", help="the #146 G0 checklist, written to runs/sre-inspect/spike-<ts>.md")
    s.add_argument("--slow", action="store_true", help="also run the 30-day count(*) with/without powerSql")
    s.add_argument("--no-mcp", action="store_true")
    s = sub.add_parser("window", help="print time facts for an instant (no model-side time zone math)")
    s.add_argument("--at", required=True)
    s.add_argument("--before", default=_window.DEFAULT_BEFORE)
    s.add_argument("--after", default=_window.DEFAULT_AFTER)
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("intake", help="Grafana-native alert funnel -> queue + digest")
    s.add_argument("--since", default="", help="window ending now (default tenant alert_source.lookback)")
    s.add_argument("--from", dest="frm", default="")
    s.add_argument("--to", default="")
    s.add_argument("--print-policy", action="store_true")
    s.add_argument("--json", action="store_true")
    s = sub.add_parser("dive", help="render INSPECT.md + report skeleton for one alert")
    s.add_argument("item", nargs="?", type=int, help="queue item number from `intake`")
    s.add_argument("--rule-uid")
    s.add_argument("--at")
    s.add_argument("--subject", default="")
    s.add_argument("--title", default="")
    s.add_argument("--before", default=_window.DEFAULT_BEFORE)
    s.add_argument("--after", default=_window.DEFAULT_AFTER)
    s.add_argument("--deploy-lookback", default="24h")
    s.add_argument("--force", action="store_true")
    s.add_argument("--holmes", action="store_true", help="also hand the brief to the local Holmes (suite compose)")
    s = sub.add_parser("finish", help="validate + scrub report.json/rca.md, update the ledger")
    s.add_argument("incident")
    s = sub.add_parser("mcp-config", help="mcp-grafana stdio config for Claude Code / Codex (print, or --write into <workspace>/.mcp.json)")
    s.add_argument("--write", action="store_true", help="create or merge the `grafana` server into <workspace>/.mcp.json")
    s = sub.add_parser("discover", help="find the values tenant.yaml / routes.yaml need: rules | deploys <owner/repo> | datasources")
    s.add_argument("what", choices=["rules", "deploys", "datasources"])
    s.add_argument("repo", nargs="?", help="owner/repo (for deploys)")
    s = sub.add_parser("sls", help="passthrough to tools/grafana-sls/sls_query.py with the env file loaded")
    s.add_argument("args", nargs=argparse.REMAINDER)
    return p


def main(argv=None):
    p = build_parser()
    a = p.parse_args(argv)
    if not a.verb:
        p.print_help()
        return EXIT_USAGE
    try:
        require_python()
        ctx = Ctx(a.root)
        fn = {"validate": cmd_validate, "doctor": cmd_doctor, "spike": cmd_spike, "window": cmd_window,
              "intake": cmd_intake, "dive": cmd_dive, "finish": cmd_finish, "mcp-config": cmd_mcp_config,
              "discover": cmd_discover, "sls": cmd_sls}[a.verb]
        return fn(ctx, a)
    except SuiteError as e:
        print("error: %s" % e, file=sys.stderr, flush=True)
        return e.code
    except (grafana.GrafanaError, grafana.QueryError) as e:
        print("error: grafana: %s" % e, file=sys.stderr, flush=True)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
