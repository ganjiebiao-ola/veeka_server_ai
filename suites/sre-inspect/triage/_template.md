# triage：{{rule_name}}（{{rid}}，层 {{layer}}）

告警：{{alert_title}}（主体 {{alert_subject}}，时间 {{alert_ts}}，rule_uid {{rule_uid}}）

先读背景 skill（若有）；写任何 SLS 语句前读 skill `grafana-sls` 与本部门的索引快照 skill（字段以快照为准；
检索段含冒号的 key 经 Grafana 路径**不加双引号**）。

1. **验真**：在窗 {{from_epoch}}–{{to_epoch}} 内，用主日志源（`sls_query.py query --datasource <logs ds>`）
   核对告警所述现象是否真实发生（先 `* | select count(*)` 锚点校验窗口，再按主体过滤统计）；指标侧用
   `query_prometheus`（datasourceUid 从 `list_datasources` 取，endTime 必填）对照同窗形态。
2. **降噪**：对照已知模式库（若本部门维护了 KP-xx）——命中且量级与历史相当，判 PASS 并引用模式号。
3. **三窗复核**：当前窗 vs 前一窗 vs 昨日同窗，只用于描述形态（持续/放大/单点），不改变判定。

判定标准：PASS 只有两种——窗内现象确未发生（告警为虚）、命中已知模式且量级正常；其余只要现象真实发生
就是 FAIL（量级只影响 severity），并进入深挖。查询不到数据 = FAIL 并申报 data_gaps。

纪律：结论正文里引用查询语句、字段名、日志原文一律用反引号；时间只用上面注入的 epoch；零结果先锚点校验。
