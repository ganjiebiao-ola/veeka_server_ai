# FIXNOTES — INCIDENT INC-20260101-000000-deadbeef

## 改了什么

- `app/service/ExampleSrv.php` isFeatureEnabled：RPC 抛异常 / 返回空 / 返回错误串三种情况改为记 warning 日志并返回 false，不再抛异常。

## 为什么这么改

下游返回空是灰度中的契约内行为（报告推理链第 2 步），调用方应把它当「未启用」处理。未上收到框架错误钩子：该钩子只做 500 页面渲染，没有按业务语义降级的位置。

## 既有防线普查结果（任务 4）

检索 `catch (\Throwable` / `RpcExample::` 未发现既有的 RPC 结果封装层；无可接入的既有防线。

## 降级后的行为

三种失败都降级为 false 并写 warning（含 uid 与 err）；其它异常仍上抛。

## 同构位点（任务 8）

未发现。

## 评审者请重点看什么

降级是否应只覆盖「返回空」而把 RPC 异常继续上抛（6b：若那是依赖故障，代码不该盖住）。

## 无法验证的部分

无 PHPUnit 套件；语法只做了 php -l。
