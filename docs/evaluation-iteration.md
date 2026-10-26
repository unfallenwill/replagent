# 评估驱动的迭代

生产基线保持原样：1021 字符的 system prompt、持久 Node REPL、每次一条 step、deposit 向模型传递观察、say 结束回合。新提示词与新 harness 均先作为独立候选。

## 开发筛选

`eval/experiments/tasks.ts` 包含目录检查后修改、合法目录列表、已观察到失败的依赖调度、七轮连续需求。已查看和用于诊断的题明确属于开发集；不再把原调度失败题称为独立留出。

四组对照共享模型、任务、预算、重复次数和总并发上限，每个任务/重复块轮换候选顺序：

| 组   | Prompt                             | Harness                  |
| ---- | ---------------------------------- | ------------------------ |
| P0H0 | 当前最小提示词                     | 当前生产实现             |
| P1H0 | 增加一个观察→修改验证→完成的短示例 | 当前生产实现             |
| P0H1 | 当前最小提示词                     | 可主动调用的上下文检查点 |
| P1H1 | 短示例                             | 上下文检查点             |

H1 通过首条模型观察介绍 API，介绍本身属于 harness 处理的一部分。`harness.state()` 查看消息体积，`harness.checkpoint(summary)` 在本次执行成功后用摘要替换旧对话。所有用户原文逐行保留来源，完整移除被替换的推理及签名，不改写保留的签名；文件、REPL globals、模块、排队观察不变。失败执行取消检查点，过期调用拒绝。调用不会结束回合，也不代替 deposit/say。模型可以完全不使用它；评分不要求调用。

```sh
npm run eval:experiment -- --mode reference --trials 1 --concurrency 3 --out .evals/experiment-reference-new
npm run eval:experiment -- --mode live --trials 3 --concurrency 3 --out .evals/experiment-development
```

开始前写入 manifest，包括顺序、预算、各组指纹和筛选标准；结束检查源码是否漂移。候选指纹覆盖静态本地导入。`screening.json` 对每题和每条检查检查退步，再计算含失败消耗的 input+output tokens/成功次数。无退步且下降至少 15% 才提名独立验证，不自动替换生产。阈值是工程筛选规则，不是统计显著性证明。记录真实检查点次数，不能把未调用 API 的偶然改善归因于摘要。

重复三次主要用于发现问题。供应商未提供随机种子；缓存与异步执行仍可能影响结果，延迟不能单独归因于候选。输入 token 含缓存读，不等于费用。

开发筛选提名后，先冻结候选，在七轮需求题上做独立重复确认，再投入完整回归：

```sh
npm run eval:confirm -- --mode live --concurrency 3 --prompt-file .evals/experiment-development-v2/p1h0/prompt.txt --out .evals/example-confirmation-new
```

确认预先要求两组都通过 10/10 次，整体及配对中位数 token 至少下降 15%，且至少 9/10 组更省。出现任一失败、缺失计量或两组不节省时，标准已无法达到，停止未启动的配对，完成已启动配对；`stopped.json` 保存原因及跳过清单。提前结束的报告只计实际完成次数，不能宣称完成十次，也不根据停止后的部分均值估计总体提升。

## 真实仓库留出

`eval/repository/snapshot.json` 保存 replagent 固定提交 `33787c4` 的 61 个受版本控制文件；不含环境文件。快照和锁文件均校验 SHA-256，依赖来自本地安装的锁定版本，每次复制到独立临时工作区，不共享可写依赖目录，也不传模型 API 凭据。

三题分别为 read 新增 tail、修复非法行范围校验、抽取纯文本选择模块并保持兼容。每题从相同提交重新开始，隐藏验收检查实际行为，并保留和运行原 268 个测试及 TypeScript 检查。原测试与根配置受逐字节保护，允许新增测试。重构题还验证 read 确实委托给新模块。既不规定工具路线，也不规定最少调用次数。

这是完整仓库上的有界开发任务；当前评分未纳入格式与复杂度门禁，也不代表小时级真实开发能力。

```sh
npm run eval:repository:smoke -- --out .evals/repository-reference-new
node --import tsx eval/repository/calibrate.ts .evals/repository-calibration-new
npm run eval:repository -- --mode live --trials 3 --concurrency 3 --out .evals/repository-control
npm run eval:verify -- .evals/repository-control-reviewed/report.json .evals/repository-next/report.json
```

参考解只校准任务；空答复与三个“旧能力正常但新契约错误”的变体必须失败。校准不使用真实模型。依赖安装耗时单列在 setup.json；wallMs 统计 agent 执行，隐藏评分耗时不计入该值。

探索题默认仍标为 capability；一旦显式选定基线，`eval:verify` 对其中所有题和所有检查执行零退步门禁，包含 capability，避免新证明的能力被忽略。先运行下一版本到 `.evals/repository-next/`，再执行上面的只读验证命令。

修正规则时，`eval/regrade.ts` 仅允许移除有理由的旧检查，不允许改变题面、fixtures、预算条件或改写断言后复用旧判定。输出写入新目录，保存原报告哈希、删除项和新任务哈希；不能把重评分当作新的模型试验。新增或改写断言必须重新执行评分器。

## 晋级

先冻结开发候选，再与当前实现同条件运行基础 20×3、长任务 8×3、关键七轮任务 10 次和新仓库留出。逐题及逐项无退步、效率改善能独立复现，才替换生产并建立新基线。留出一旦用于分析和调优，后续作为回归/开发数据，另补新题。

本轮为真实仓库评分增加了显式超时和工作区准备，评分器指纹与上轮不同。旧报告保留；严格比较应拒绝跨评分器混用，需要以当前实现重建可比较控制组，不能放宽门禁掩盖变化。

Windows 试验还跟踪 worker 的子进程及其创建时间：中间 shell 超时退出后，仍能清理已观察到的孤儿进程，并避免仅凭复用的 PID 杀进程。POSIX 使用独立进程组。基础设施错误保留为该次失败，避免一个清理错误丢失整批报告；缺失的 token 用未知值表示，不按零成本计算。这仍属于状态隔离，并非针对恶意程序的安全边界。
