#!/usr/bin/env python3
"""A minimal MCP stdio server standing in for grafana/mcp-grafana in tests (newline-delimited JSON-RPC)."""
import json
import os
import sys

TOOLS = ["list_datasources", "query_prometheus", "alerting_manage_rules", "get_dashboard_panel_queries"]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid = msg.get("id")
    if mid is None:
        continue
    m = msg.get("method")
    if m == "initialize":
        res = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake-mcp-grafana", "version": "test"}}
    elif m == "tools/list":
        res = {"tools": [{"name": t, "inputSchema": {"type": "object"}} for t in TOOLS]}
    elif m == "tools/call":
        if not os.environ.get("GRAFANA_SERVICE_ACCOUNT_TOKEN"):
            res = {"isError": True, "content": [{"type": "text", "text": "no token in env"}]}
        else:
            res = {"content": [{"type": "text", "text": json.dumps({"datasources": [{"uid": "a"}, {"uid": "b"}]})}]}
    else:
        res = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": res}) + "\n")
    sys.stdout.flush()
