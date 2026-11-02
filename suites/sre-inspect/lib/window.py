"""Time facts — the one discipline the reference engine treats as hard.

Every query window is computed here and injected as epoch numbers; the model never converts time
zones (drill #1 of the reference implementation failed twice exactly because it did — a wrong window
does not error, it silently returns 0 rows).
"""
import datetime as _dt
import os
import sys

from .common import SuiteError, parse_duration

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "grafana-sls"))
import sls_query  # noqa: E402

DEFAULT_BEFORE = "15m"
DEFAULT_AFTER = "15m"


def tz_from(name):
    """IANA name (python >= 3.9 zoneinfo), or a fixed offset like +08:00. Falls back to UTC."""
    name = (name or "UTC").strip()
    if name.upper() in ("UTC", "Z"):
        return _dt.timezone.utc, "UTC"
    if len(name) == 6 and name[0] in "+-" and name[3] == ":":
        sign = 1 if name[0] == "+" else -1
        off = _dt.timedelta(hours=int(name[1:3]), minutes=int(name[4:6])) * sign
        return _dt.timezone(off), "UTC" + name
    try:
        from zoneinfo import ZoneInfo  # python >= 3.9
        return ZoneInfo(name), name
    except Exception:
        return _dt.timezone.utc, "UTC (zoneinfo for %r unavailable)" % name


def parse_at(value, now=None):
    """epoch s/ms, RFC3339, now, now-30m -> epoch seconds (int)."""
    try:
        return sls_query.parse_time_ms(value, now=now) // 1000
    except ValueError as e:
        raise SuiteError(str(e), 2)


def facts(eval_epoch, before=DEFAULT_BEFORE, after=DEFAULT_AFTER, tz=None, tzname="UTC", window_sec=None):
    before_s = parse_duration(before, 0)
    after_s = parse_duration(after, 0)
    tz = tz or _dt.timezone.utc
    ev = _dt.datetime.fromtimestamp(eval_epoch, _dt.timezone.utc)
    frm, to = eval_epoch - before_s, eval_epoch + after_s
    return {
        "eval_epoch": int(eval_epoch), "eval_ms": int(eval_epoch) * 1000,
        "eval_utc": ev.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "eval_local": ev.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S"), "tz": tzname,
        "window_sec": int(window_sec) if window_sec else None,
        "from_epoch": int(frm), "to_epoch": int(to), "from_ms": int(frm) * 1000, "to_ms": int(to) * 1000,
        "from_utc": _dt.datetime.fromtimestamp(frm, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "to_utc": _dt.datetime.fromtimestamp(to, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "before_sec": before_s, "after_sec": after_s,
    }


def block(f):
    """The injected fact block (mirrors buildDiveAsk's 【编排层注入·事实块】)."""
    lines = [
        "【注入的时间事实——直接使用，不要自行换算时区】",
        "- 评估时刻：epoch %d（%s %s；UTC %s）" % (f["eval_epoch"], f["eval_local"], f["tz"], f["eval_utc"]),
    ]
    if f.get("window_sec"):
        lines.append("- 告警评估窗：%ds" % f["window_sec"])
    lines.append("- 起始查询窗（单位秒；需要扩展时自行加减 epoch，不要写“最近 N 分钟”）：from=%d to=%d（UTC %s → %s）"
                 % (f["from_epoch"], f["to_epoch"], f["from_utc"], f["to_utc"]))
    lines.append("- 同一窗的毫秒形态（Grafana /api/ds/query、sls_query.py 均可直接吃秒或毫秒）：from_ms=%d to_ms=%d"
                 % (f["from_ms"], f["to_ms"]))
    lines.append("- query_prometheus 的 startTime/endTime 用 RFC3339：%s / %s" % (f["from_utc"], f["to_utc"]))
    return "\n".join(lines)
