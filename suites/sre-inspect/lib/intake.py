"""Grafana-native alert intake: Alertmanager (firing now) + alert state history (annotations) in a
window -> normalised alerts -> tenant filter -> routes.yaml -> recurrence ledger -> queue + digest.

Deterministic on purpose (the reference engine's pairing/routing/suppression were too); the LLM only
ever sees the queue. Nothing here mutates the ledger — `run dive` registers.
"""
import datetime as _dt
import re

from .common import short_hash

_ANN = re.compile(r"^(?P<title>.*?)\s*\{(?P<labels>.*)\}\s*(?:-\s*(?P<values>.*))?$", re.S)


def rfc_to_epoch(s):
    """RFC3339 with any fractional precision / Z -> epoch seconds (int), or None."""
    s = (s or "").strip()
    if not s or s.startswith("0001-"):
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$", s)
    if not m:
        return None
    base, frac, tz = m.groups()
    tz = "+00:00" if tz == "Z" else (tz if ":" in tz else tz[:3] + ":" + tz[3:])
    return int(_dt.datetime.fromisoformat(base + tz).timestamp())


def parse_annotation_text(text):
    """'Name {k=v, k2=v2} - B=1, C=2' -> (name, labels, values_str)."""
    m = _ANN.match(text or "")
    if not m:
        return (text or "").strip(), {}, ""
    labels = {}
    for part in m.group("labels").split(", "):
        if "=" in part:
            k, v = part.split("=", 1)
            labels[k.strip()] = v.strip()
    return m.group("title").strip(), labels, (m.group("values") or "").strip()


def subject_of(labels, subject_labels):
    for k in subject_labels:
        v = labels.get(k)
        if v:
            return str(v)
    return ""


def _fallback_fp(rule_key, subject):
    return "fb-" + short_hash(rule_key + "|" + subject, 16)


def from_am(am_list, frm_s, to_s, subject_labels):
    out = []
    for a in am_list or []:
        labels = a.get("labels") or {}
        state = ((a.get("status") or {}).get("state") or "active")
        if state != "active":
            continue
        start = rfc_to_epoch(a.get("startsAt")) or 0
        end = rfc_to_epoch(a.get("endsAt"))
        if start > to_s or (end and end < frm_s and end < start):
            continue
        rule_uid = labels.get("__alert_rule_uid__", "")
        title = labels.get("alertname", "")
        subject = subject_of(labels, subject_labels)
        ann = a.get("annotations") or {}
        out.append({
            "fingerprint": a.get("fingerprint") or _fallback_fp(rule_uid or title, subject),
            "fingerprint_source": "grafana" if a.get("fingerprint") else "fallback",
            "rule_uid": rule_uid, "rule_name": title, "title": ann.get("summary") or (title + " " + subject).strip(),
            "subject": subject, "eval_epoch": start, "window_sec": None,
            "labels": {k: v for k, v in labels.items() if not k.startswith("__")},
            "annotations": {k: v for k, v in ann.items() if not k.startswith("__")},
            "links": {"generator": a.get("generatorURL", "")},
            "state": "firing", "source": "alertmanager", "starts_at": start, "ends_at": end,
        })
    return out


def from_annotations(ann_list, title_index, frm_s, to_s, subject_labels):
    out = []
    for a in ann_list or []:
        if not str(a.get("newState", "")).startswith("Alerting"):
            continue
        t_ms = a.get("time") or 0
        eval_epoch = int(t_ms // 1000)
        if eval_epoch < frm_s or eval_epoch > to_s:
            continue
        title, labels, values = parse_annotation_text(a.get("text", ""))
        title = a.get("alertName") or title
        uids = title_index.get(title) or []
        rule_uid = uids[0] if len(uids) == 1 else ""
        subject = subject_of(labels, subject_labels)
        out.append({
            "fingerprint": _fallback_fp(rule_uid or title, subject), "fingerprint_source": "fallback",
            "rule_uid": rule_uid, "rule_name": title, "title": (title + " " + subject).strip(),
            "subject": subject, "eval_epoch": eval_epoch, "window_sec": None,
            "labels": labels, "annotations": {"values": values} if values else {},
            "links": {}, "state": "alerting-transition", "source": "annotations",
            "starts_at": eval_epoch, "ends_at": None,
            "ambiguous_uids": uids if len(uids) > 1 else None,
        })
    return out


def merge(alerts):
    """Dedup across sources on (rule key, subject, eval second); annotation alerts adopt the Grafana
    fingerprint of a firing alert with the same (rule, subject)."""
    fp_by_key = {}
    for a in alerts:
        if a["source"] == "alertmanager":
            fp_by_key[(a["rule_uid"] or a["rule_name"], a["subject"])] = a["fingerprint"]
    seen, out = {}, []
    for a in sorted(alerts, key=lambda x: (0 if x["source"] == "alertmanager" else 1)):
        key = (a["rule_uid"] or a["rule_name"], a["subject"])
        if a["source"] != "alertmanager" and key in fp_by_key:
            a["fingerprint"], a["fingerprint_source"] = fp_by_key[key], "grafana"
        dk = key + (int(a["eval_epoch"]),)
        if dk in seen:
            continue
        seen[dk] = True
        out.append(a)
    out.sort(key=lambda x: -x["eval_epoch"])
    return out


def _match(m, labels):
    for k, vals in (m or {}).items():
        vals = vals if isinstance(vals, list) else [vals]
        v = labels.get(k)
        if v is None or str(v) not in [str(x) for x in vals]:
            return False
    return True


def apply_filter(alerts, filt):
    inc = (filt or {}).get("include_labels") or {}
    exc = (filt or {}).get("exclude_labels") or {}
    kept, dropped = [], []
    for a in alerts:
        labels = a.get("labels") or {}
        if inc and not _match(inc, labels):
            dropped.append((a, "include_labels 未命中"))
            continue
        hit = False
        for k, vals in exc.items():
            vals = vals if isinstance(vals, list) else [vals]
            if labels.get(k) is not None and str(labels[k]) in [str(x) for x in vals]:
                dropped.append((a, "exclude_labels %s=%s" % (k, labels[k])))
                hit = True
                break
        if not hit:
            kept.append(a)
    return kept, dropped


def route(alert, routes):
    """Port of triage.Resolve: triage | known_bug | unrouted (never silently dropped)."""
    r = routes.get(alert.get("rule_uid", ""))
    if r is None and not alert.get("rule_uid"):
        for cand in routes.values():
            if cand.title and cand.title == alert.get("rule_name"):
                r = cand
                break
    if r is None:
        why = "rule_uid %s 不在 routes.yaml（信号目录未对号或新增规则）" % (alert.get("rule_uid") or "<空>")
        if alert.get("ambiguous_uids"):
            why = "规则标题 %r 对应多个 uid %s，annotations 无法唯一定位" % (alert.get("rule_name"), alert["ambiguous_uids"])
        return {"action": "unrouted", "reason": why}
    text = " ".join([alert.get("title", ""), str(alert.get("annotations") or {}), str(alert.get("labels") or {})])
    if r.known_bug_match and r.known_bug_match in text:
        return {"action": "known_bug", "rid": r.rid, "rule_name": r.name, "layer": r.layer,
                "reason": r.known_bug_reason or ("命中 known_bug 形态 %r" % r.known_bug_match)}
    if not r.template:
        return {"action": "unrouted", "rid": r.rid, "rule_name": r.name, "layer": r.layer,
                "reason": "%s（%s）已在路由表但尚无 triage 模板" % (r.rid, r.name)}
    return {"action": "triage", "rid": r.rid, "rule_name": r.name, "layer": r.layer, "template": r.template,
            "reason": "按 %s（%s）路由到 %s" % (r.rid, r.name, r.template)}


def collect(client, tenant, frm_s, to_s):
    """Pull from Grafana and normalise. Returns (alerts, notes)."""
    notes = []
    rules = client.alert_rules()
    title_index = {}
    for r in rules:
        title_index.setdefault(r.get("title", ""), []).append(r.get("uid", ""))
    am = from_am(client.am_alerts(), frm_s, to_s, tenant.subject_labels)
    ann = from_annotations(client.annotations_alert(frm_s * 1000, to_s * 1000), title_index, frm_s, to_s,
                           tenant.subject_labels)
    notes.append("alertmanager firing=%d, annotations Alerting=%d, rules=%d" % (len(am), len(ann), len(rules)))
    return merge(am + ann), notes


CLUSTER_TOLERANCE_S = 60


def annotate(items, tolerance_s=CLUSTER_TOLERANCE_S):
    """Deterministic reading aids the model must not have to infer:
    * a CLUSTER = candidates whose evaluation instants fall within `tolerance_s` of each other
      (same-second multi-subject bursts are one underlying event; dig one member);
    * a RE-FIRE = a later candidate with the same fingerprint as an earlier one, outside the
      cooldown (so the ledger did not fold it) — dig the first, treat the later as its recurrence.
    Returns the list of clusters (each a list of items) and marks items in place."""
    cands = sorted((it for it in items if it["candidate"]), key=lambda it: it["alert"]["eval_epoch"])
    clusters, cur = [], []
    for it in cands:
        if cur and it["alert"]["eval_epoch"] - cur[-1]["alert"]["eval_epoch"] <= tolerance_s:
            cur.append(it)
        else:
            if len(cur) >= 2:
                clusters.append(cur)
            cur = [it]
    if len(cur) >= 2:
        clusters.append(cur)
    for ci, cl in enumerate(clusters, 1):
        for it in cl:
            it["cluster"] = "C%d" % ci
    by_fp = {}
    for it in cands:
        by_fp.setdefault(it["alert"]["fingerprint"], []).append(it)
    for group in by_fp.values():
        if len(group) >= 2:
            first = group[0]
            for it in group[1:]:
                it["refire_of"] = first["n"]
                it["refire_gap_s"] = it["alert"]["eval_epoch"] - first["alert"]["eval_epoch"]
    return clusters


def build_queue(alerts, routes, ledger, tenant):
    kept, dropped = apply_filter(alerts, tenant.filter)
    items = []
    for i, a in enumerate(kept, 1):
        rt = route(a, routes)
        led = ledger.peek(a)
        items.append({"n": i, "alert": a, "route": rt, "ledger": led,
                      "candidate": rt["action"] == "triage" and not led.get("suppress")})
    annotate(items)
    return items, dropped


def digest(items, dropped, frm_s, to_s, notes, tz, tzname):
    def local(ep):
        return _dt.datetime.fromtimestamp(ep, _dt.timezone.utc).astimezone(tz).strftime("%m-%d %H:%M:%S")
    cand = [it for it in items if it["candidate"]]
    supp = [it for it in items if it["ledger"].get("suppress")]
    unr = [it for it in items if it["route"]["action"] == "unrouted"]
    kb = [it for it in items if it["route"]["action"] == "known_bug"]
    fps = len(set(it["alert"]["fingerprint"] for it in items))
    lines = ["窗 epoch %d–%d（%s → %s %s）：%s" % (frm_s, to_s, local(frm_s), local(to_s), tzname, "；".join(notes)),
             "过滤后 %d 条（%d 条被 filter 丢弃）→ %d 个指纹 → 候选 %d 件，冷却抑制 %d，known_bug %d，unrouted %d"
             % (len(items), len(dropped), fps, len(cand), len(supp), len(kb), len(unr))]
    if cand:
        from .window import DEFAULT_BEFORE, DEFAULT_AFTER
        lines.append("候选（`run dive <n>`；每件的默认查询窗 = 评估时刻 -%s/+%s，需要更宽用 --before/--after）：" % (DEFAULT_BEFORE, DEFAULT_AFTER))
        for it in cand:
            a, r, l = it["alert"], it["route"], it["ledger"]
            tags = []
            if it.get("cluster"):
                tags.append("簇 %s" % it["cluster"])
            if it.get("refire_of"):
                tags.append("同指纹再触发：[%d] 之后 %dm" % (it["refire_of"], it["refire_gap_s"] // 60))
            if l.get("recurred"):
                tags.append("复发（上次 %s）" % l.get("active_incident"))
            lines.append("  [%d] %s %s | %s | %s (%s) | 模板 %s%s" % (it["n"], r.get("rid"), r.get("rule_name"), a["subject"] or "-",
                                                             local(a["eval_epoch"]), a["state"], r.get("template"),
                                                             ("  ← " + "；".join(tags)) if tags else ""))
        clusters = {}
        for it in cand:
            if it.get("cluster"):
                clusters.setdefault(it["cluster"], []).append(it)
        refires = [it for it in cand if it.get("refire_of")]
        if clusters or refires:
            lines.append("读法（代码算好的，不必自己推断）：")
            for cid in sorted(clusters, key=lambda c: int(c[1:])):
                members = sorted(clusters[cid], key=lambda it: it["alert"]["eval_epoch"])   # earliest first, whatever the item numbering
                first = members[0]
                lines.append("  %s：%s 起 %d 件同一分钟内触发 → %s。大概率同一根因；挖其中任意一件即覆盖整簇（窗内含全部成员），建议先挖 [%d]"
                             % (cid, local(first["alert"]["eval_epoch"]), len(members), " ".join("[%d]" % m["n"] for m in members), first["n"]))
            for it in refires:
                lines.append("  [%d] 是 [%d] 同指纹在 %dm 后的再触发（超出冷却窗所以没被折叠）：先挖 [%d]；[%d] 的默认窗盖不到 [%d] 的时刻，同因就记 duplicate_of，不要用它代替 [%d]"
                             % (it["n"], it["refire_of"], it["refire_gap_s"] // 60, it["refire_of"], it["n"], it["refire_of"], it["refire_of"]))
    if supp:
        lines.append("冷却抑制（并入活跃件，`run dive <n> --force` 可强开）：")
        for it in supp:
            a, l = it["alert"], it["ledger"]
            lines.append("  [%d] %s | %s | %s → %s 第 %d 次" % (it["n"], a["rule_name"], a["subject"] or "-", local(a["eval_epoch"]),
                                                          l.get("active_incident"), l.get("occurrence", 0)))
    if kb:
        lines.append("known_bug（确定性判定，不花模型）：")
        for it in kb:
            lines.append("  [%d] %s | %s | %s" % (it["n"], it["route"].get("rid"), it["alert"]["subject"] or "-", it["route"]["reason"]))
    if unr:
        lines.append("unrouted（先在 routes.yaml 对号、补 triage 模板，再 dive）：")
        for it in unr:
            a = it["alert"]
            lines.append("  [%d] %s | uid %s | %s | %s" % (it["n"], a["rule_name"], a["rule_uid"] or "<空>", a["subject"] or "-", it["route"]["reason"]))
    if dropped:
        lines.append("filter 丢弃：" + "；".join("%s(%s)" % (a["rule_name"], why) for a, why in dropped[:8]) + ("…" if len(dropped) > 8 else ""))
    return "\n".join(lines)
