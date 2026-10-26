# 组合任务与长程评估

这组任务补充首批 20 项基础回归，评估跨模块实现、数据处理、连续需求及失败恢复。
目前是可重复的合成项目夹具，来源于常见工程问题；没有使用真实生产仓库的问题解决率作为标签。
不规定工具路径、最少步数或运行时长。实际产生多少轮调用、上下文和耗时，需要从真实运行判断。

## 固定任务集

| 分区        | 任务                       | 验收内容                                                     |
| ----------- | -------------------------- | ------------------------------------------------------------ |
| development | checkout-feature           | 优惠券贯穿计价、订单、发票和 CLI，保护旧调用                 |
| development | csv-pipeline               | 引号/换行/BOM、整数金额、去重、错误行、汇总和失败时保留输出  |
| development | cache-migration            | 旧接口、TTL/LRU、并发请求合并、失败重试和在途加载失效        |
| development | incremental-reconciliation | 96 个输入分片、重复版本、取消记录、外部更新和可复用 CLI      |
| development | evolving-policy            | 7 次连续需求，逐轮保护已有规则，最后接入批处理和 CLI         |
| holdout     | dependency-scheduler       | DAG 验证、并发上限、空闲槽推进、分支失败隔离和旧入口         |
| holdout     | config-context             | 40 层继承、多个父配置、递归合并、当前文档和延迟插值          |
| holdout     | recoverable-migration      | 7 次操作：预检失败、输入修正、迁移、重跑、新数据、回滚、重放 |

8 个任务均先归为 capability。通过本轮探索不自动提升为 regression。
模型、prompt、生产 harness 在建立本轮基线期间保持固定。
三个 holdout 任务不用于当前 prompt/harness 调整；评分器参考解验证与错误解校验不属于模型调优。
若未来依据其失败轨迹调优，应将其视为开发题并补充新的留出任务。

## 运行

```sh
# 离线验证参考解、检查点、外部输入变化和评分器
npm run eval:long:smoke -- --out .evals/long-reference

# 同一版本，每题独立运行三次，保留独立基线
npm run eval:long -- --trials 3 --concurrency 3 --out .evals/long-baseline

# 只用开发集做下一轮探索
npm run eval:long -- --partition development --out .evals/long-development

# 开发集调整完成后，冻结候选，再运行留出集
npm run eval:long -- --partition holdout --out .evals/long-holdout

# 对关键的连续需求任务单独增加到十次
npm run eval:long -- --task long/development/evolving-policy --trials 10 --concurrency 3 --out .evals/policy-reliability

# 旧的基础能力仍使用原预算单独检查
npm run eval:regression -- --concurrency 3
```

长任务固定预算：每次试验 900 秒，最多 80 次模型请求，每个 agent turn 最多 32 步，
每次回复最多 8192 个输出 token。默认三次重复，并发二；正式运行可显式固定并发三。
这是上限，任务不需要耗尽预算。总 token 消耗仍按服务端实际上报记录，失败试验也计入成本。
基础回归继续使用 180 秒 / 24 次请求 / 每 turn 12 步的原预算；不能直接将两种预算的报告相互比较。

初始三次重复用于发现问题。重要任务可单独增加到十次，作为可靠性确认；
十次报告与三次报告不直接走回归比较，后续应使用相同重复次数建立对应基线。
三次全过不代表已经证明长程可靠或优于原版本。

## 逐轮验收与外部输入

`EvalCheck.afterTurn` 是从零开始的用户轮次。省略时检查最终状态。
每轮结束后控制器暂停 subject，复制该轮 workspace，再允许下一轮继续。
所有隐藏功能断言在 subject 进程停止后，针对对应副本运行，不向模型反馈评分结果。
最终文件快照在评分前保存，避免将评分器自己创建的文件误当作 agent 产物。

```ts
checks: [
  { id: 'first-result', type: 'json', path: 'report.json', value: { count: 3 }, afterTurn: 0 },
  { id: 'retain-report', type: 'unchanged', path: 'report.json', sinceTurn: 0, afterTurn: 1 },
],
updates: [
  { beforeTurn: 1, files: { 'input.json': '[1,2,3,4]' } },
],
```

`unchanged.sinceTurn` 从指定轮次获取原始字节，不要求文件在初始 fixtures 中已经存在。
`updates` 由控制器在指定用户请求之前写入，subject 和 REPL 全局状态继续保留。
任务描述会说明有输入发布，但不会规定 agent 如何发现和处理。

检查点快照位于 `trials/<task>/<attempt>/checkpoints/<turn>.json`，同样有文件数和大小上限。
评分使用完整的临时副本，快照截断不改变评分内容。副本随试验清理，不是安全隔离容器。
报告记录检查点实现指纹；存在检查点指纹的基线不会与更换后的实现直接比较。
旧的无检查点基础报告仍可比较，但其已有任务定义与评分器必须保持一致。

## 评分器校验

每题都有经过生产 agent/REPL 的参考解。另跑两类反例：
- 每轮只宣称完成，保留未完成的工作区，必须失败。
- 在正确参考解上引入具体缺陷，例如舍入错误、取消请求合并、超出并发上限、丢记录、忘记旧费用或覆盖备份，必须失败。

功能评分采用额外进程并检查断言完成标记，防止被测模块在 import 时 `process.exit(0)` 跳过断言而误获成功。
这仍是工程正确性验证，不构成对恶意代码的安全沙箱。

判断优先看逐任务、逐检查点成功率，再看包含失败消耗的 token/成功与耗时。
将问题分别归因于评分、任务描述、模型行为、prompt 或 harness，只有观察到可复现的问题才调整对应层。
真实跨进程会话恢复、小时级任务、大型真实仓库和 TUI 交互仍需后续任务覆盖。
