"""INSPECT.md — the dive brief handed to whichever agent investigates (Claude Code / Codex / Holmes).

Ports the *structure* of the reference engine's buildDiveAsk (main.go) and triage.Render: the
injected fact block, the routed triage template with placeholders filled by code, the layered
requirements, the L7 change surface, and the output contract. Nothing project-specific lives here;
the department's triage/*.md carry that.
"""
import re

from . import window

PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

REQUIREMENTS = """【要求】
1. 先验真再深挖：按上面的验真模板走一遍，给出 **PASS / FAIL / INDETERMINATE** 与依据；PASS（告警为虚或命中已知模式）也要写结论，然后停止。
2. FAIL 才深挖。按分层顺序（L1 域名/CDN → L2 入口 → L3 消息队列 → L4 数据层 → L5 主机 → L6 进程 → L7 变更）**逐层下探**，每一步先说明"要验证什么、用哪个数据源"，再给查询结果。指标走 mcp-grafana 的 `query_prometheus` / `list_prometheus_*`（datasourceUid 从 `list_datasources` 取，start/end 用上面的 RFC3339）；日志走 `grafana-sls`（`sls_query.py`，先读该 skill 与索引快照，只用快照里存在的字段；含冒号的 key 不加双引号）；告警规则的真实表达式与状态用 `alerting_manage_rules`（operation=get，rule_uid 见上）。
3. **数据支撑的结论与推理出来的假设必须分开写**，各自标置信度（高/中/低）。机制性解释若无指标/日志直接佐证，一律归入"待确认假设"，不得写成结论。
4. 查询零结果时，先用已知锚点（如同窗口的总请求数 `* | select count(*)`）校验窗口传参是否正确，再下结论；零结果不等于无异常。
5. 关联 L7 变更面：**以下方「L7 变更面」段为准**，判断这些发布与本次异常的相关性；不要自行查询发布记录。依赖/基础设施异常（DNS 瞬断、下游宕机、滚动发布杀在途连接）不是本代码 bug，`cause_locus` 如实写 infra/dependency，不要为了开 PR 写成 code_defect。
6. 不编机制：证据不足以定因时明确写"未定因"并列出还缺什么数据（进 `data_gaps`）。
7. 只读：不改任何生产配置、不写任何 token、不做时区算术、同参数查询不重发。
8. **一次只挖本件**：摘要里的其他簇、再触发件、顺手看到的别的规律，只在 rca.md 末尾「后续项」列一行（含一句依据），**不要为它们发查询**——它们各自立件再挖。证据在约 40 次查询内仍未收敛，就停下写「未定因」+ data_gaps 并 finish，不要穷举。"""

OUTPUT = """【产出（写进本目录）】
- `rca.md`：结论 / 验真依据 / 证据引用（每条写清工具、查询语句、时间窗）/ 数据支撑 vs 待确认假设 / 置信度 / 影响面量级 / 建议动作。
- `report.json`：已放好 v1.1 骨架（incident 段已填），你只填 `verdict`、`root_cause`（statement/chain/confidence/cause_locus/severity/impact/suggested_fix）、`evidence[]`、`excluded_hypotheses[]`、`data_gaps[]`、`data_sources[]`、`suspect_change`（取自 L7 表的 `repo@短sha`，否则 `none`）。
- 然后运行 `suites/sre-inspect/run finish %(inc)s`（校验 + 脱敏 + 记台账）；`cause_locus=code_defect` 且置信 ≥ medium 的件再交给 `/sre-autofix`。"""


def render_template(text, values):
    missing = []

    def sub(m):
        k = m.group(1)
        if k in values and values[k] is not None:
            return str(values[k])
        missing.append(k)
        return m.group(0)
    return PLACEHOLDER.sub(sub, text or ""), sorted(set(missing))


def template_values(alert, rt, facts):
    return {
        "alert_title": alert.get("title", ""), "alert_subject": alert.get("subject", ""),
        "alert_ts": "%s（epoch %d）" % (facts["eval_local"], facts["eval_epoch"]),
        "rule_uid": alert.get("rule_uid", ""), "rid": rt.get("rid", ""), "rule_name": rt.get("rule_name", ""),
        "layer": rt.get("layer", ""), "eval_epoch": facts["eval_epoch"], "eval_local": facts["eval_local"],
        "from_epoch": facts["from_epoch"], "to_epoch": facts["to_epoch"], "window_sec": facts.get("window_sec") or "",
        "tz": facts["tz"],
    }


def l7_block(events, note):
    if events is None:
        return "【L7 变更面】\n- 未接入：%s" % (note or "无发布事实来源")
    if not events:
        return "【L7 变更面】\n- 窗内无发布完成事件（GitHub Actions）。%s" % (("注：" + note) if note else "")
    lines = ["【L7 变更面】（窗内发布完成事件，来自 GitHub Actions；`suspect_change` 只能取自这张表的 `repo@短sha`）",
             "| # | 完成时刻 (UTC) | epoch | repo@sha | 标题 | 分支 |", "|---|---|---|---|---|---|"]
    for i, e in enumerate(events, 1):
        lines.append("| %d | %s | %d | %s@%s | %s | %s |" % (i, e["completed_utc"], e["completed_epoch"], e["repo"], e["short_sha"],
                                                         (e.get("title") or "").replace("|", "\\|")[:80], e.get("branch") or ""))
    if note:
        lines.append("注：" + note)
    return "\n".join(lines)


def render(inc_id, alert, rt, facts, template_text, deploy_events, deploy_note, tenant, skills):
    values = template_values(alert, rt, facts)
    body, missing = render_template(template_text or "", values)
    labels = "\n".join("  - %s: %s" % (k, v) for k, v in sorted((alert.get("labels") or {}).items())) or "  - （无）"
    ann = "\n".join("  - %s: %s" % (k, str(v).replace("\n", " ")[:300]) for k, v in sorted((alert.get("annotations") or {}).items()))
    parts = [
        "# INSPECT：%s" % alert.get("title", ""),
        "",
        "- incident：`%s`（目录 `runs/sre-inspect/%s/`）" % (inc_id, inc_id),
        "- 告警：%s %s（rule_uid `%s`，层 %s）｜主体 `%s`｜来源 %s/%s" % (rt.get("rid", "-"), rt.get("rule_name", alert.get("rule_name", "")),
                                                                alert.get("rule_uid", ""), rt.get("layer", "-"), alert.get("subject", ""),
                                                                alert.get("source", ""), alert.get("state", "")),
        "- 指纹：`%s`（%s）" % (alert.get("fingerprint", ""), alert.get("fingerprint_source", "")),
        "- 租户：%s（时区 %s）｜背景 skill：%s｜查询 skill：%s" % (tenant.display_name, facts["tz"], tenant.background_skill or "（未配置）",
                                                        ", ".join(skills)),
        "",
        window.block(facts),
        "",
        "【告警 labels】",
        labels,
    ]
    if ann:
        parts += ["【告警 annotations】", ann]
    if alert.get("links", {}).get("generator"):
        parts += ["- generator：%s" % alert["links"]["generator"]]
    parts += ["", "【验真模板：%s】" % (rt.get("template") or "（无模板——unrouted，先补 routes.yaml 与 triage 模板）"), body.strip() or "（空）"]
    if missing:
        parts += ["", "> 模板里未识别的占位符：%s（按字面保留）" % ", ".join("{{%s}}" % m for m in missing)]
    parts += ["", REQUIREMENTS, "", l7_block(deploy_events, deploy_note), "", OUTPUT % {"inc": inc_id}, ""]
    return "\n".join(parts)
