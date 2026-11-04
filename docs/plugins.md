# 写插件

先看 [README 的内置插件目录](../README.md#插件体系四个方向都能自由替换)选择已有实现；需要扩展时，从下面三个可运行的最小模板开始，替换业务部分：

| 模板 | 已经演示了什么 | 你要替换什么 |
|---|---|---|
| [Agent 模板](../examples/plugins/hello-agent/agent.ts) | 用 `echo` 模拟执行，读取输出与会话编号 | 新 Agent 的启动命令和输出解析 |
| [通道模板](../examples/plugins/hello-channel/channel.ts) | 领卡片、写到文件、报告送达；通过命令行回答 | 目标平台的发送、更新和回答回调 |
| [事件插件模板](../examples/plugins/hello-source/source.ts) | 验证 HMAC-SHA256 签名，把模拟订单转换成事件 | 业务系统的验签方式和字段映射 |

事件插件、接单程序、通道和命令行共用同一套 HTTP + JSON 接口。只用 Shell 接协议，可以看 [接单脚本](../examples/worker.sh) 和 [通道脚本](../examples/channel.sh)：设置中台地址与密钥后运行，需要 `curl`、`jq`。它们适合演示短任务；长任务使用内置接单程序的心跳、停止和恢复能力。

一个插件就是一个目录，入口为 `agent.ts`、`channel.ts` 或 `source.ts`。只用 `node:` 模块和自己目录里的文件，类型在插件里声明；不要相对引用引擎源码。

用 `agent-autoloop add <git 地址>` 安装到 `~/.agent-autoloop/plugins/<仓库名>`，也接受本地 Git 仓库。它只克隆，不装依赖、不跑安装脚本、不自动更新。加载时会执行插件，安装目录的同名插件优先。

## 先跑起来

在引擎目录运行这条命令：它把三个例子分别装进临时中台，实际走完验签、派活、运行、通知和报告，退出后清理。

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

## Agent 插件

从 [hello-agent/agent.ts](../examples/plugins/hello-agent/agent.ts) 开始。它用 `echo` 代替模型，克隆到别处也能运行。

| 导出对象的方法 | 作用 |
|---|---|
| `command(turn)` | 返回命令参数数组；参数不作为 shell 代码执行 |
| `read(stdout, code, stderr)` | 返回 `text`、`session`、`usage`、`error`、`finished` 或待核实的 `state`；运行中 `code` 为 `null` |
| `capabilities` | 声明 `resume` 和 `persistent`；会话链接不等于续接能力 |
| `recover(turn)` | 持久插件恢复观察同一次执行；不能投递、重发或新建会话 |
| `stop(turn, reason)` | 确认实际执行停止后才返回 `true`；只杀 bridge 不够 |
| `link(session)` | 可选，仅真实可打开的会话 URL，不放命令字符串 |
| `check(options)` | 可选，本机配置可用返回 `null`，否则给出下一步 |
| `control(args)` | 可选，插件管理命令；由通用 `agent-autoloop plugin <名字> …` 入口调用 |

`turn` 包含 `prompt`、`session`、`resume`、`cwd`、`access`、`options`、`execution`、`contextFile`、`folder`，以及固定程序使用的 `command`。`execution` 是稳定的 `{ run, attempt, turn }`，每次明确调用或修复的身份不同。`contextFile` 是资料；持久运行时要为每轮刷新副本，不能让旧环境变量继续指向上一轮。

`read` 要能处理未写完的输出。持久插件用 `state: "running"` 表示已核实的在执行，用 `state: "uncertain"` 表示结果不明；即使 bridge 已退出，也不能把后者当成可重试失败。接单程序保持在线，停止为无法证明在执行的任务续租，并通过 `recover` 只读核实。真正完成才返回 `finished: true` 和最终文字。

在规则里选择这个插件：

```json
{ "name": "Hello", "worker": "my-computer", "use": "hello-agent", "access": "read" }
```

AI 执行统一使用内置 `herdr-core`。在可信规则中选 `options.profile`，原生程序与权限配置在本机 Herdr template。完整的 profiles、身份、回执与迁移说明见 [Herdr 接入](herdr-core.md)。确定性的固定采集程序使用 `script` 的 `command` 数组；它不接受提示词、模型或会话占位符，也不是另一个 AI 执行入口。

### 浏览器接入

浏览器工具装在运行原生 Agent 的电脑上，由 Herdr template 选择的原生工具配置提供。先用实际 template 验证目标页面、本人账号和第二轮会话；桌面应用能访问某个浏览器，并不证明这个终端也有相同的连接。

完整规则、Skill 和调用脚本见[浏览器交接模板](../examples/recipes/browser-handoff/README.md)。目标、profile、允许操作来自可信配置。网页助手调用同一个 `runTask / recoverTask`，返回证据和 Autoloop 逻辑 session；主任务负责业务决定与中台回执。

主任务和网页助手使用不同 cwd。父任务仍持有自己的目录占用时，子任务不能再申请同一目录。模板使用每个子会话独立的工作目录，未知结果时只核实原请求，不重发网页操作。

中台不捆绑浏览器驱动、不自动修改工具配置。原生 Agent 能正常结束本轮、但业务需要本人恢复连接、登录或验证时，保留未验收项，用 `ask` 等待；原生 CLI 自身卡在审批界面时，插件不能伪造 `ask`，需先查看对应终端。不能把 HTTP 查询当成已经完成网页验收。

## 通道插件

从 [hello-channel/channel.ts](../examples/plugins/hello-channel/channel.ts) 开始。它把卡片写进文件，用命令行回答。

默认导出异步函数，参数是 `{ hub, options, log, signal }`；`options` 来自 `config.json`，不含中台密钥。

| 调用 | 作用 |
|---|---|
| `hub.nextCard(50)` | 长轮询领卡片，没卡片返回 `{ card: null }` |
| `hub.delivered(id, version, ref)` | 报告送达，保存外部消息编号 |
| `hub.failed(id, version, error)` | 报告发送失败 |
| `hub.answer(id, { choice, by, ref })` | 转交回答；核对回答人和原消息 |

`ref` 为空就发新消息，有值就更新原消息；不能更新时只报告。没报告的卡片一分钟后重派。`signal` 中止时退出，函数异常退出后由外壳重启。

在 `rules.json` 登记通道、用 `agent-autoloop key new channel cards` 取密钥，再把下面这项放进 `config.json` 的 `channels`，重启中台：

```json
{ "cards": { "use": "hello-channel", "key": "通道密钥", "file": "/tmp/cards.txt" } }
```

能收回调的通道要在规则里设置 `answerers`；只能发文字的通道设置 `links: true`，发送 `card.link`。拿到链接的人能回答这张卡片。

通道和中台共用一个 Node 进程，外部调用应异步等待。内置飞书通道的用户查询、发送和更新均异步调用 CLI，发送期间中台仍能接收事件和心跳。

## 事件插件

从 [hello-source/source.ts](../examples/plugins/hello-source/source.ts) 开始。它检查 `x-shop-signature` 中的 HMAC-SHA256，再把订单变成事件。

默认导出同步函数，参数为 `{ headers, body, secret }`。先验签，再解析原文；返回事件数组，无事返回 `[]`，拒绝请求就抛异常。事件插件只翻译，不发请求。

在 `rules.json` 登记来源：

```json
{ "shop": { "name": "商店", "adapter": "hello-source" } }
```

请求地址是 `/v1/in/shop`；秘密放在 `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_SHOP`，不写进规则。事件必须有稳定的 `id` 和合法的 `type`，可带 `subject`、`summary`、`detail`、`link`，上限见[协议](protocol.md#来源把世界变成事件)。

来源能直接发标准 JSON 时不必写插件，用来源密钥调用 `POST /v1/events` 即可。

## access 实际能做什么

`access` 是可信规则中的策略声明，不是中台提供的系统沙箱。Herdr profile 的 `access` 必须与规则完全相同，原生工具的实际限制由管理者在 template 及系统隔离中配置。

| 声明 | 必须为实际 template 验证的边界 |
|---|---|
| `read` | 只读业务资料；仅给本轮回执文件及指定提交器必要权限 |
| `edit` | 允许在所选工作目录完成任务；核实目录外写入和网络能力 |
| `full` | 明确选择的更宽权限；中台不会额外提供沙箱 |

只读不等于读不到本机密钥。要隔离密钥，用单独系统账号或容器，并实测原生 CLI 的工具边界。profile 字段相同并不能证明不同原生工具有相同权限，也不能把未经验证的 template 标成安全。

场景模板据业务需要声明权限：早报、代码修改、反馈和摘要使用 `edit`；告警、网站排查、网页核实与交付审查使用 `read`。固定巡检和资料读取脚本负责确定性采集。`script`、交付的确定性外部步骤及第三方插件代码以本机账号运行，不受 `access` 字符串约束。

## 一致性测试

在引擎目录运行协议的现有 HTTP 检查，全部使用临时数据和随机端口：

```bash
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts
```

检查其他中台实现时，用 `agent-autoloop conformance <测试地址> --config <测试凭据文件>`，文件格式见[协议](protocol.md#一致性和复现)。它会写事件和卡片，只对专用测试中台运行。

插件本身的完整接入测试见 [tests/example-plugins.test.ts](../tests/example-plugins.test.ts)。用其他语言写独立进程也可以，参考 [curl/jq 通道](../examples/channel.sh)和[接单程序](../examples/worker.sh)。
