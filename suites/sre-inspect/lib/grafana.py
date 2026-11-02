"""Grafana HTTP client used by doctor / spike / intake — extends the client in
tools/grafana-sls/sls_query.py (single implementation of auth + /api/ds/query) with the alerting
and metadata endpoints the suite needs. Everything here is read-only.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "grafana-sls"))
import sls_query  # noqa: E402

GrafanaError = sls_query.GrafanaError
QueryError = sls_query.QueryError


class Client(sls_query.Grafana):
    def _get_ok(self, path, what=None):
        status, payload = self.get(path)
        if status != 200:
            raise GrafanaError(status, "GET %s -> %s %s" % (what or path, status, sls_query._short(payload)))
        return payload

    def frontend_settings(self):
        return self._get_ok("/api/frontend/settings")

    def build_info(self):
        return (self.frontend_settings() or {}).get("buildInfo") or {}

    def whoami(self):
        return self._get_ok("/api/user")

    def permissions(self):
        """Action -> [scopes] for the token's identity (access-control API)."""
        p = self._get_ok("/api/access-control/user/permissions")
        return p if isinstance(p, dict) else {}

    def can_query(self, uid):
        scopes = self.permissions().get("datasources:query") or []
        return "datasources:*" in scopes or ("datasources:uid:%s" % uid) in scopes

    def am_alerts(self):
        """Currently firing alert instances (Grafana-managed Alertmanager)."""
        p = self._get_ok("/api/alertmanager/grafana/api/v2/alerts")
        return p if isinstance(p, list) else []

    def alert_rules(self):
        """Provisioning API: every Grafana-managed rule (uid, title, folderUID, data[])."""
        p = self._get_ok("/api/v1/provisioning/alert-rules")
        return p if isinstance(p, list) else []

    def alert_rule(self, uid):
        return self._get_ok("/api/v1/provisioning/alert-rules/%s" % uid)

    def policies(self):
        return self._get_ok("/api/v1/provisioning/policies")

    def annotations_alert(self, frm_ms, to_ms, limit=5000):
        p = self._get_ok("/api/annotations?type=alert&from=%d&to=%d&limit=%d" % (int(frm_ms), int(to_ms), int(limit)))
        return p if isinstance(p, list) else []

    def rule_history(self, rule_uid, frm_s, to_s, limit=5000):
        """State history frame for one rule -> list of {time_ms, prev, next, text, data}."""
        p = self._get_ok("/api/v1/rules/history?ruleUID=%s&from=%d&to=%d&limit=%d" % (rule_uid, int(frm_s), int(to_s), int(limit)))
        fields = [f.get("name") for f in ((p or {}).get("schema") or {}).get("fields") or []]
        values = ((p or {}).get("data") or {}).get("values") or []
        out = []
        n = max((len(v) for v in values), default=0)
        for i in range(n):
            row = {fields[j]: values[j][i] for j in range(min(len(fields), len(values))) if i < len(values[j])}
            t = row.get("time")
            if isinstance(t, (int, float)) and t > 1e14:      # microseconds (measured 2026-08-28)
                t = int(t // 1000)
            row["time_ms"] = int(t) if t is not None else None
            out.append(row)
        return out

    def prom_query(self, uid, expr, frm_ms, to_ms, instant=True, step_ms=60000):
        q = {"refId": "A", "datasource": {"uid": uid}, "expr": expr, "instant": bool(instant),
             "range": not instant, "intervalMs": int(step_ms), "maxDataPoints": 500}
        results = self.ds_query([q], frm_ms, to_ms)
        return sls_query.parse_result(results.get("A"))


def from_env(env=None, timeout=60):
    return Client.from_env(env, timeout=timeout)
