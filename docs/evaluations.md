# 可重复运行的 Agent 评估

评估对象是模型、system prompt 与运行框架的组合。默认候选直接使用生产的
`runAgentTurn` 和 `NodeReplSession`，将终端替换为事件收集器。JavaScript、
`step`、`say`、`deposit` 和有意保留的 REPL 状态保持原有语义。

任务的结果与验收标准固定，prompt 和 harness 可以共同演进。评分器不要求特定工具、
调用顺序或步数；只要满足任务的明确要求，使用 Node API、组合调用或其他有效实现都可以。

设计参考：[Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)。

本次 [prompt 收缩记录](prompt-evolution.md) 保留了失败原因、harness 调整依据与最终基线成绩。

## 日常使用

`npm run eval` 自动加载项目的 `.env.local`，支持与 CLI 相同的
`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、
`ANTHROPIC_MODEL`。已有环境变量优先于文件；命令行选项优先于环境变量。

```sh
# 不调用模型：验证任务、参考解、评分器及真实 REPL 的连接
npm run eval:smoke

# 首次建立真实模型基线：每个任务独立运行三次
npm run eval:baseline

# 修改功能、prompt 或 harness 后，用同一任务和预算检查旧能力
npm run eval:regression
```

基线保存在 `.evals/baseline/report.json`，不被自动覆盖。已有基线时再次执行
`eval:baseline` 会拒绝写入。需要主动更换基线时，给新运行使用另一个 `--out`，
阅读失败轨迹和比较结果，再在后续命令中显式指定该报告。

```sh
npm run eval -- list
npm run eval -- run --task files/ --trials 3 --out .evals/files
npm run eval -- run --trials 3 --out .evals/candidate --baseline .evals/baseline/report.json
npm run eval -- compare .evals/baseline/report.json .evals/candidate/report.json
```

默认每任务三次、并发二、每次试验总时限 180 秒、最多 24 次模型请求、每回复最多
8192 个输出 token、每个 agent turn 最多 12 步。全部可通过
`--trials`、`--concurrency`、`--timeout-ms`、`--max-calls`、
`--max-tokens`、`--max-steps` 调整。

退出码：`0` 通过；`1` 必过任务失败或发现回归；`2` 配置错误、报告损坏或比较条件不兼容。

## 两类运行和两类任务

| 类型            | 作用                                                 | 失败是否阻断                     |
| --------------- | ---------------------------------------------------- | -------------------------------- |
| reference 运行  | 预置参考程序经过真实 agent 与 REPL，验证评估体系本身 | 任何任务失败都阻断               |
| live 运行       | 使用配置的真实模型完成任务                           | regression 任务失败阻断          |
| regression 任务 | 已经期望具备的能力                                   | 默认不允许相对基线退步           |
| capability 任务 | 尚在探索的能力目标                                   | 报告成绩，不阻断真实模型回归检查 |

reference 成绩明确标注为框架自检，不能与 live 成绩混用。
现有单测继续保护确定性协议和实现；旧的 prompt 关键词断言已由行为评估替代。

GitHub Actions 在 Windows/Linux、Node 22/24 上运行质量检查和 reference 自检，
并保存自检报告。它不使用模型凭据；修改 prompt 或新增功能后，仍应执行
`npm run eval:regression` 检查真实模型表现。

首批 20 个任务在 `eval/tasks.ts`：文件查找、行范围提取、数据汇总、唯一与重复文本编辑、
无需修改的请求、函数修复、边界行为、CSV 解析、多文件 API 变更、路径纠错、测试保护、
输入中的伪指令、Unicode/CRLF、跨用户轮次状态及观察循环。它们是小型起始任务集，
不代表完整的软件工程能力；持续从实际失败中增加任务与输入变体。

## 回归判定

默认逐任务、逐检查点比较成功率，任何下降都阻断。只比较总平均分可能掩盖旧能力丢失，
因此新任务的进步不会抵消旧任务的退步。新增 regression 任务自身也必须通过。

新增任务可与旧基线一起运行。删除旧任务、修改旧任务内容或评分标准、改变重复次数或预算，
都会判定为不可直接比较；更换模型、端点或 reasoning effort 需要明确的
`--allow-model-change`。评分器实现也单独记录指纹，变化后需要重新校验参考解并审查基线。

模型具有随机性。三次试验只能提供初步信号；重要改动应增加重复次数并重建可比较的基线。
报告列出平均单次成功率（pass@1）、至少一次成功的任务比例和所有试验均成功的任务比例。
不要用多次尝试中偶尔成功代替稳定性。

耗时、调用次数、输入/输出/缓存 token 和 REPL 错误均记录。token/成功任务将失败试验的
消耗一并计入。端点没有完整上报用量时记为 unknown，不填零；不根据未知价格推算金额。
耗时包含 worker 启动与停止，不包含外部评分。

效率阈值默认只报告、不阻断，可显式开启：

```sh
npm run eval -- compare .evals/baseline/report.json .evals/candidate/report.json --max-token-ratio 1.20 --max-latency-ratio 1.50
```

`--max-pass-rate-drop 0.05` 可允许最多 5 个百分点的下降，默认是 0。
不要为了通过某次失败的运行而临时放宽阈值。

## 增加任务

在 `eval/tasks.ts` 增加一个 `EvalTask`，或使用
`--tasks path/to/tasks.ts` 加载导出 `TASKS` 的自定义模块。

```ts
const task: EvalTask = {
  id: 'coding/new-feature',
  suite: 'regression',
  description: '需要保护的用户能力',
  fixtures: { 'input.json': '[1,2,3]' },
  turns: ['读取 input.json，将数值之和写入 result.json，格式为 {sum: number}。'],
  checks: [
    { id: 'sum', type: 'json', path: 'result.json', value: { sum: 6 } },
    { id: 'source', type: 'unchanged', path: 'input.json' },
  ],
  reference: [
    'await step("sum", "sum input", async () => { const a = JSON.parse(await read("input.json", "read values")); require("node:fs").writeFileSync("result.json", JSON.stringify({sum:a.reduce((x,y)=>x+y,0)})); say("Done"); });',
  ],
};
```

每个任务必须有参考解，并先通过 reference 运行。参考解不发送给真实模型，也不包含在
任务指纹里；修正参考程序不会改变任务。输入、提示或验收要求的修改会改变任务指纹。

内置检查：`file`（精确文本）、`json`（结构相等）、`unchanged`、
`absent`、`answer`（可指定用户轮次）及 `node`（独立 Node 进程运行功能断言）。
`node` 评分器在 agent 停止后执行，不出现在模型上下文中。评分规则必须能从任务描述推导，
不应要求任务未指定的文件名或解法。参考解和反例都要检查，避免错误实现也被判为成功。

## 联合替换 prompt 与 harness

```sh
npm run eval -- run --candidate eval/candidate.ts --prompt-file experiments/prompt.txt --out .evals/experiment --baseline .evals/baseline/report.json
```

候选模块导出 `createSubject(context)`，返回：

```ts
interface EvalSubject {
  send(text: string, signal: AbortSignal): Promise<void>;
  close(): void | Promise<void>;
}
```

context 提供当前 workspace、代理模型接口、system prompt、预算与事件接收器。
一次试验内多个用户轮次复用 subject。候选可以让模型主动调度其 harness 能力，
不必复制默认候选的内部实现；评分标准和外部时限不随候选变化。
不同协议应在各自的实现测试中验证，不能把当前单 step 协议当作所有候选的统一评分规则。

输出 token 上限、模型请求次数和总时限由外部控制器限制，候选无法通过重置内部步数逃避计量。

## 运行轨迹与隔离

每次运行生成：

```text
report.json                    机器可读报告、版本指纹与逐任务成绩
report.md                      可阅读的成绩与失败详情
identity.json                  开始运行时固定的版本、prompt、预算与并发配置
comparison.json                使用 --baseline 时的回归判定
results.jsonl                  每次试验结束即追加，保留中途进度
trials/<task>/<attempt>/
  trace.jsonl                  模型请求、流事件、UI 事件及 worker 输出
  result.json                  各检查点结果与资源消耗
  final-files.json              有界的最终文件快照
```

每次试验启动新进程和临时目录，安装相同 fixtures，结束后终止进程树并清理目录。
同一任务的不同试验不共享全局变量、文件或模块状态。控制器持有模型凭据；
worker 环境只保留启动 Node 与 shell 所需的系统变量。

这是状态隔离，不是安全沙箱。REPL 保留完整 Node 能力，仍可访问宿主文件系统；
需要运行不可信程序时，将整个评估命令放入容器或虚拟机。网络与工具额外费用不由本框架计价。

模型端点的 prompt cache 可能跨试验共享；缓存 token 单列记录，不能把缓存命中解释为
REPL 状态复用。worker 通过控制器获得模型结果；流事件在控制器实时记录，worker 收齐后交给
生产循环，因此本框架不评估 TUI 流式显示、首 token 延迟或交互式中断。

`say` 和 `deposit` 仍是两个文本通道。传入对象时，harness 会保留其可读字段，
包括 stdout、stderr 与退出码，循环引用也可显示；不再将整个对象压成
`[object Object]`。字符串原样处理，既有长度上限继续生效。

实际 transcript 可能包含代码和任务数据，`.evals/` 与 `.env.local` 默认被 Git 忽略。
长期基线应由项目维护者选择保存位置和访问范围，框架不会自动提交或提升基线。
