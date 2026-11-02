> 本票由 Agentic SRE 自动创建（incident `INC-20260101-000000-deadbeef`）。证据充分度 **88/100（充分）**。

## 1. 问题

example-api /feature/status 500：RPC 返回空时 ExampleSrv 抛未捕获异常

<sub>#26 映射：对应「问题陈述」。</sub>

## 2. 影响面与时间窗

- 影响范围：接口 /feature/status；调用它的客户端首页开关
- 影响量级：42 次 500 / 1352 次请求（3.1%），持续 28 分钟
- 时间窗：1786439000–1786440680 (epoch)

## 3. 严重程度

**medium** —— 30 分钟窗内 42 次 500，占该接口请求 3.1%，无级联影响

## 4. 复现条件

- 条件：下游 RpcExample::IsFeatureEnabled 返回 false/空时，ExampleSrv.php:21 直接 throw
- 频率：间歇：与下游返回空的比例一致

## 5. 根因与推理链

**根因**：ExampleSrv.php:21 在 RPC 返回 false/空时抛出未捕获异常，被框架转为 500

**置信度**：high —— 异常栈直接指向 ExampleSrv.php:21，且 RPC 返回空的比例与 500 比例吻合

**推理链**：

1. [数据] t=1786439012 起 app 日志出现 Exception ERROR_SERVICE_ABNORMAL_TRY_AGAIN，File: ExampleSrv.php:21
2. [数据] 同窗 RPC 侧日志显示 IsFeatureEnabled 对 3% 请求返回空（下游灰度中）
3. [推断] ExampleSrv 未区分「下游按契约返回空」与「下游故障」，两者都抛异常 → 500

## 6. 证据引用

| # | 论断 | 工具 | 时间窗 | 引用 |
|---|---|---|---|---|
| 1 | 500 由 ExampleSrv.php:21 的异常引起 | `sls_execute_sql` | 1786439000–1786440680 | `ev://INC-20260101-000000-deadbeef/tool/call_0001` |
| 2 | RPC 对 3% 请求返回空，与 500 比例一致 | `sls_execute_sql` | 1786439000–1786440680 | `ev://INC-20260101-000000-deadbeef/tool/call_0002` |
| 3 | 下游 RPC 服务本身健康，无错误率上升 | `execute_prometheus_range_query` | 1786435400–1786440680 | `ev://INC-20260101-000000-deadbeef/tool/call_0003` |

## 7. 已排除的假设

- **下游 RPC 服务故障** → Prometheus 错误率为 0，返回空是灰度中的契约内行为

## 8. 数据缺口

- 未拿到灰度开关的具体配置值

## 9. 修复建议（观测侧）

ExampleSrv.php 里区分「返回空=未启用」与真正的调用失败；返回空时应返回 false 而不是抛异常。

## 10. 关联与判重

未发现重复。

## 11. 机器标记

<!-- sre-agent:eval_epoch=1786440000 fingerprint=deadbeefcafe0001 incident=INC-20260101-000000-deadbeef rule_uid=rule-example-5xx -->

## 12. 签收清单

- [ ] 根因方向认可
- [ ] 影响面评估认可
