# Agent Autoloop

**让你的命令行 Agent 在后台自己接活、自己跟进到底；平时不烦你，遇到拿不准的事才发卡片找你拍板。**

**中文** | [English](README.en.md)

本分支基于 [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop)，保留原作者与 MIT 许可；这里维护统一 Herdr 执行入口的改造。

[上手](#上手) · [场景模板](#拿来即用的场景模板) · [插件](#插件体系四个方向都能自由替换) · [内核](#内核的四个机制) · [文档](#更多文档)

![架构图](docs/architecture.svg)

## 它解决什么问题？

平时我们用 Claude Code、Codex 这类命令行 Agent，大多是“人守着终端用”：你输一句话，盯着它跑，等它问你下一步；一旦关掉窗口或者人走开，事情就断了。

**Agent Autoloop** 是一个极轻量的自动化中台。它把任务调度做成一个零外部依赖的**内核**，把事件来源、Agent、通知通道，甚至代码上线流水线全部拆成可随时插拔的**插件**。AI 执行统一通过 `herdr-core` 插件进入 Herdr 的持久终端；原生 CLI 的启动、权限和工具配置留在本人维护的 Herdr 模板里。

- **一台电脑、一条命令就能跑。** 装在你的 Mac 或 Linux 上，不用买云服务器，也不用开放公网端口。
- **统一的 AI 执行入口。** 规则选择可信的 Herdr profile，插件负责会话绑定、任务提交、回执和恢复；更换原生 CLI 时修改模板。
- **没有后台界面。** 需要你拍板时把卡片推到飞书、钉钉、企微、Slack、Discord 或桌面通知；想看全局进展，敲一行命令。

## 上手

支持 macOS 和 Linux。运行前需要装好 Node 24、Git、curl、已运行的 [Herdr Core](docs/herdr-core.md)，以及已经登录且配置好模板的原生命令行 Agent，不需要 GitHub 账号。也可以直接把[安装说明](INSTALL.md)丢给你的 Agent，让它替你装好。

```bash
curl -fsSL https://raw.githubusercontent.com/NAMEWTA/agent-autoloop/main/install.sh | sh
```

按[配置手册](skills/agent-autoloop/SKILL.md#接一个-agent)设置本机 `developer` profile 后，用它真实走一遍“提问 → 结束本轮等回复 → 拍板 → 接着干完”：

```bash
agent-autoloop try
```

非交互终端会打印问题和回答命令，例如：

```text
事件发出去了，Agent 开始干活……

Agent 结束了这一轮，问了你一个问题。等待期间不安排新模型轮次，Herdr 终端可以保留。

【等你决定】#1 试跑：选一个颜色
这是一次试跑，选哪个都行。
  1. 蓝色
  2. 绿色
回答：agent-autoloop answer 1 <序号>
答完运行 agent-autoloop status，能看到它接着把活干完。
```

交互终端里直接输入数字回车；非交互终端运行 `agent-autoloop answer 1 2` 选择“绿色”。再跑 `agent-autoloop status`，就能看到它接上刚才的会话并显示“你选了绿色，试跑通过”，还有今天和最近 7 天的轮数、Token 和费用（[统计口径](skills/agent-autoloop/SKILL.md#看情况回答)）。

## 一件事怎么转起来

编号和上面的架构图一一对应：

1. **新事件进来。** 早上 9 点的定时任务、GitHub 上新提的 Issue、业务系统报的错，都变成一条标准事件送进内核。
2. **按规则派活。** 内核照你写的规则，决定交给哪个 Agent、去哪个目录干。同一件事排队时又来的消息，会合并成一轮处理。
3. **交回本轮结果。** Agent 通过本轮专用的回执 helper 提交最后回复；插件核实本轮关联和运行状态后交回中台。终端屏幕只供查看，不作为成功凭据。
4. **拿不准才问你。** 碰到删数据、重启服务、花钱、对外发消息这类事，内核通过飞书或桌面通知发一张卡片给你。等你回复期间，中台不安排新模型轮次；本轮桥接结束，Herdr 和原生 Agent 可以保持空闲，仍占用本机资源。
5. **点一下，接着干。** 你选完，它沿原逻辑会话绑定的终端继续处理。终端丢失或执行结果不明确时先核实，不自动重建并重做。

能自己搞定的事走图上方的自动闭环：直接办完，或者约个时间（比如半小时后）再醒来复查，全程不打扰你。

## 日常怎么配？

### 写一份规则（`rules.json`）

不需要写胶水代码。打开 `~/.agent-autoloop/rules.json`，在 `rules` 里写清楚**什么事、交给谁、在哪个目录干**。`to` 填 `agents` 里已有的名字，默认安装登记为 `agent`。比如每天早上 9 点写早报：

```json
{
  "name": "早报",
  "when": { "cron": "0 9 * * *" },
  "to": "agent",
  "cwd": "~/notes",
  "prompt": "整理昨天的笔记和提交，写今天的早报。"
}
```

外部事件写法一样，只是要先接好来源。比如有人提新 Issue 时交给开发 Agent，先按[说明](skills/agent-autoloop/SKILL.md#接一个事件插件)在 `sources` 里登记 `github`：

```json
{
  "name": "处理 issue",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "agent",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

保存后几秒内自动生效，可以运行 `agent-autoloop check` 检查。就算改错了，系统也会继续按旧规则跑，并发卡片提醒你哪里写错了。

### Agent 怎么跟中台配合？

业务回执格式不变：**最后回复交代结论，需要中台动作时附 `agent-autoloop` 代码块**。Herdr 插件会在每轮提示词中提供专用提交 helper；Agent 把整段最后回复交给它。只在终端打印代码块不会让本轮成功。需要向你请示时，回复可以写成：

````text
订单已经核对完毕，库存充足。

```agent-autoloop
{
  "ask": [{
    "title": "怎么发货？",
    "text": "两种方式今天都能发出。",
    "options": ["快递", "自提"],
    "key": "shipping"
  }]
}
```
````

除了提问（`ask`），还能发通知（`notice`）、关闭已解决的卡片（`resolve`）、预约复查（`later`）和触发新事件（`events`）。万一 JSON 写错了，中台只让它在原会话里重写最后这段回复，不会把已经干完的业务重做一遍；重写也失败时，保留原结论并通知你回执没有生效。

## 拿来即用的场景模板

每套模板都带规则、任务 Skill 和启用说明。

| 想做什么 | 已经封装好的流程 |
|---|---|
| [每日早报](examples/recipes/morning-brief/README.md) | 默认每天 8 点整理本地笔记和 Git 提交，写入 `briefs/YYYY-MM-DD.md` |
| [跟进 GitHub Issue](examples/recipes/github-issues/README.md) | 每 5 分钟查新 Issue，在本地改代码并通知你查看；不提交、不推送、不回复 Issue |
| [线上告警排查](examples/recipes/ops-alerts/README.md) | 接收报错、对照代码查原因，需要重启时发卡片询问，回答后继续 |
| [用户反馈处理](examples/recipes/feedback/README.md) | 重读反馈当前状态、修复、交付核实、准备回复；需要决定时飞书问你，回答后继续 |
| [网站巡检](examples/recipes/website-watch/README.md) | 每 5 分钟检查状态和关键内容，首次异常交给 Agent，持续异常不重复通知，恢复后更新原卡片 |
| [飞书周报与业务摘要](examples/recipes/feishu-brief/README.md) | 周日 18 点按你的权限读汇报和指定表格，生成本地摘要；飞书只发简短摘要，完整稿留在本机 |
| [PR 自动交付](skills/agent-autoloop/SKILL.md#交付流水线) | 打上 `deliver` 标签后，审查、等 CI、合并、等发布并核对线上版本 |

**启用：** 打开对应说明，先配置并验收它需要的 Herdr profile，把任务 Skill 放进原生 Agent 的 skills 目录，把示例规则合入 `~/.agent-autoloop/rules.json`，替换电脑名和路径，再运行 `agent-autoloop check`。

反馈处理、网站巡检和飞书摘要默认使用北京时间，只发给本人的飞书私聊。样例数据都是虚构的；脚本和回执只用本地 HTTP 与假飞书 CLI 验证过，没有在真实账号上跑过完整业务。

更多模板：[Herdr 浏览器任务交接](examples/recipes/browser-handoff/README.md)、[每周代码清理](examples/skills/weekly-sweep/SKILL.md)、[交付 PR](examples/skills/ship-pr/SKILL.md)。

## 插件体系：四个方向都能自由替换

内置插件随程序安装，填好配置即可启用；第三方插件用 `agent-autoloop add <git 地址>` 安装。

| 方向 | 内置 | 配置 |
|---|---|---|
| **事件**：怎么发现新活 | [GitHub Webhook](plugins/github/source.ts)、[HTTP 接口](docs/protocol.md#来源把世界变成事件)、[定时规则](skills/agent-autoloop/SKILL.md#改规则)、[Issue 轮询脚本](examples/watch-github-issues.sh) | [说明](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| **Agent**：谁来干活 | [Herdr Core](plugins/herdr-core/agent.ts)（AI 执行）、[固定脚本](plugins/script/agent.ts)（确定性采集） | [说明](skills/agent-autoloop/SKILL.md#接一个-agent) |
| **通道**：去哪找你拍板 | [桌面通知](plugins/desktop/channel.ts)（默认开启）、[飞书](plugins/feishu/channel.ts)、[钉钉 / 企微 / Slack / Discord](plugins/webhook/templates.ts) | [说明](skills/agent-autoloop/SKILL.md#接一个通道) |
| **交付**：把 CI/CD 也做成插件 | [`delivery`](plugins/delivery/delivery.ts) | [说明](skills/agent-autoloop/SKILL.md#交付流水线) |

**接入边界：** 内置 AI 执行统一走 Herdr。固定采集脚本使用 `script`，交付编排使用 `delivery`；它们不会承担另一套模型会话适配。通道仍使用飞书、桌面和 Webhook。文字通道靠回答链接拍板，要把 `hub.publicUrl` 配成手机或电脑能打开的地址。

**配置一个可信 profile。** 在本机 `~/.agent-autoloop/herdr/profiles.json` 把 profile 绑定到已验收的 Herdr 模板；规则里只引用名称：

```json
{ "name": "开发", "worker": "my-computer", "use": "herdr-core", "access": "edit", "options": { "profile": "developer" } }
```

原生 CLI、模型、权限和浏览器工具由模板配置。`access` 必须与 profile 声明一致，它本身不创建沙箱。能够打开终端不等于支持可靠完成检测；模板需要支持本轮回执提交与可核实的状态，详见 [Herdr 执行说明](docs/herdr-core.md)。

**恢复边界。** 投递结果不明时不重发；接单程序保持在线，无法证明在执行的任务停止续租，由原有内核标记 `unknown`。插件仍占用原 session 和目录，避免未知旧任务与新任务同时写入；真正并行修改使用独立 worktree。`pause` 只阻止新输入，`stop` 核实真实终端停止，详见[执行说明](docs/herdr-core.md)。

**交付流水线。** 给 GitHub PR 打上 `deliver` 标签后，它会自己跟进到上线：**审代码 → 等 CI → 合并 PR → 等部署 → 核对线上版本**。审查 profile 和交付配置只从 `main` 读取，绝不在接单电脑上检出或运行 PR 里的代码；排队、并发和重试直接复用内核。

**写自己的插件。** 从 [Agent](examples/plugins/hello-agent/agent.ts)、[通道](examples/plugins/hello-channel/channel.ts)、[事件](examples/plugins/hello-source/source.ts) 三个可运行的最小模板开始，见[插件开发说明](docs/plugins.md)。要让 Agent 操作网页，先看[浏览器接入](docs/plugins.md#浏览器接入)。命令行和 [MCP](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) 也能查看和回答卡片。

## 内核的四个机制

内核约 1650 行代码、零运行时依赖。它不读系统时钟、不用随机数、不向外发请求，插件主动连进来，账号凭据留在各自的插件里；同样的输入永远得出同样的结果。它把四个计算机领域的成熟做法用到了命令行 Agent 上：

- **业务等待不再生成轮次**：问题和等待状态存进 SQLite，收到回答后才继续派活。本轮桥接结束，持久终端可以保留，Herdr 和原生 Agent 仍占内存；这不是零进程或零资源承诺。
- **事件溯源**：中台业务状态都从一条只追加的日志算出来，日志和索引在同一个事务里写进磁盘，写完才应答。进程被强杀，已经确认的事不丢（整机断电没有单独测过）；任何一轮为什么跑、结果是什么，一条命令就能查清；数据格式变了就从日志重建，不用写迁移脚本。
- **指令数据分离**：思路和 SQL 参数化一样。Issue 的标题和正文等外部文字只作为资料放进文件，不拼进提示词，提示词里只有校验过字符的类型、编号和链接；用哪个 Agent、在哪个目录、什么权限，只由你本机的规则决定，事件里带 `cwd`、`agent`、`access` 字段会被直接拒收。
- **跳数熔断**：思路和网络包的 TTL 一样。Agent 交回的事件会再派给 Agent，层数一路累加，经过人工提问和定时复查也不清零，Agent 自己改不了；超过 8 层就只记录、不再派活，并发一张卡片告诉你。

### 自己跑一遍

在程序目录 `~/.agent-autoloop/app` 下运行：

| 验证什么 | 命令 |
|---|---|
| 任何一轮的来龙去脉 | `agent-autoloop why 1` |
| 原生会话绑定、核实与接管信息 | `agent-autoloop plugin herdr-core inspect <session>` |
| 真实 template 的两轮问答 | `node scripts/real-agents.ts <profile>` |
| 20 万步模拟断网、丢包、崩溃和重复提交，一个种子就能复现 | `node sim/random.ts 24301 200000` |
| 强杀进程 1000 次，已确认的记录一条不丢 | `node sim/crash.ts 1000 12648430` |
| 下面的性能数字 | `npm run benchmark` |

```text
第 1 轮 · 演示
11-03 20:47:25  规则版本 #1
11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
11-03 20:47:25  local 领取（演示程序）
11-03 20:47:25  结束：演示完成
```

### 实测性能

以下是原有中台内核的历史基准，不包含 Herdr 或原生 Agent 的进程、内存与模型用量。

Apple M5 Pro、24 GB、Node 24.21.0。写入逐条提交，事务落盘后才应答。`npm run benchmark` 的达标线按这台机器定，换台机器可能报未达标。

| 指标 | 实测 |
|---|---:|
| 冷启动 | 88.78 ms |
| 空闲内存 | 59.94 MB RSS |
| 1000 个同时等待的长轮询 | 170.49 MB RSS |
| 持久化写入 | 2394 条/秒 |
| 派活 p99 | 1.82 ms |
| 110 万条事实时的启动 | 99.8 ms |
| 内核行数（含空行和注释） | 1651 |
| 运行时依赖 | 0 |

历史变大后，状态汇总会变慢，日志和索引也继续占磁盘；格式变化后的首次启动要从日志全量重建，110 万条用时 43.1 秒。[完整数据和测法](docs/protocol.md#历史增长实测)。

## 用量与合规说明

中台通过 Herdr 运行你本机已经安装并登录好的命令行工具，不会读取或转存你的账号凭据。模型调用消耗算在你自己的账号名下，额度和使用范围遵循各家模型厂商的服务条款。

在高频自动化场景下，各家厂商通常更建议使用 API Key（个人订阅额度主要是为日常人工交互设计的，详见 [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) 与 [OpenAI](https://learn.chatgpt.com/docs/auth) 的官方说明）。如果你用它对外提供服务，请使用 API Key。本项目为独立开源项目，与上述厂商无隶属或背书关系。

## 更多文档

- [安装说明](INSTALL.md)
- [规则与交付流水线配置手册](skills/agent-autoloop/SKILL.md)
- [Herdr 接入、迁移与验收](docs/herdr-core.md)
- [如何编写插件](docs/plugins.md)
- [完整通信协议](docs/protocol.md)
- [安全边界说明](SECURITY.md)
- [参与贡献与交流](CONTRIBUTING.md)
- [项目开发约定](AGENTS.md)

<details>
<summary><strong>仓库目录</strong></summary>

| 位置 | 放什么 |
|---|---|
| `kernel/` | 内核：决策、事实日志、状态投影、到期任务、规则匹配、接口行为与卡片表单 |
| `host/` | 运行外壳：Node HTTP、文件与 SQLite 连接、时钟、配置、后台服务和插件加载 |
| `protocol/` | 通信格式、JSON Schema、输入校验、HTTP 客户端和一致性检查 |
| `worker/` | 接单程序：领活、运行 Agent、心跳与停止、读取和提交回执 |
| `cli/`、`bin/` | 用户命令及启动入口，包括状态、回答、`why`、MCP、更新与卸载 |
| `plugins/` | 内置 Agent、事件、通道和交付插件 |
| `examples/recipes/` | 完整场景：规则、任务 Skill 和启用说明 |
| `examples/plugins/`、`examples/skills/`、`examples/*.sh` | 最小插件模板、独立任务手册和 Shell 示例 |
| `skills/agent-autoloop/` | 中台的正式配置与操作手册，安装时也提供给 Agent 使用 |
| `docs/` | 通信协议、插件开发说明与中英文架构图 |
| `tests/`、`sim/` | 日常行为测试，以及模拟、穷举、强杀和变异检查 |
| `scripts/`、`.github/workflows/` | 性能与真机验证、安装冒烟脚本，以及 Linux / macOS CI |
| 根目录文档与 `install.sh` | 中英文 README、安装说明、安全边界、开发约定、许可证与安装脚本 |

读代码可以从 `bin/agent-autoloop.ts` → `cli/main.ts` 开始，再按功能进入 `host/`、`worker/` 或 `plugins/`；内核设计先看[协议](docs/protocol.md)。同名文件分属不同层：`host/http.ts` 转换 Node 请求，`kernel/http.ts` 定义接口行为；`protocol/rules.ts` 校验输入，`kernel/rules.ts` 定义规则类型和匹配。

</details>

[MIT License](LICENSE)
