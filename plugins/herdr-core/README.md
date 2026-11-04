# Herdr Agent 插件

这个插件把 Autoloop 的一次执行交给本机 Herdr 持久终端。中台继续负责事件、规则、领取、心跳、卡片、结果和重试；Herdr 负责原生交互进程。插件不调用 Claude 的打印模式、Codex exec 或 ACP，不从终端屏幕猜最后一条回复。

Herdr 是终端运行时，**不会自动配置每一种 AI CLI 的状态报告、权限或会话恢复**。请先把选用的 CLI 配成一个可工作的 Herdr template。当前实现面向本机 JSON-RPC generation 1，启动时核对 hello 和所需方法；协议行为依据 herdr-core 0.1.17。连接使用 `hc connect --session <name>`，只有 Node 内置模块。

## 本机配置

在 `~/.agent-autoloop/herdr/profiles.json` 写入可信配置；设置了 `AGENT_AUTOLOOP_HOME` 时使用该目录：

```json
{
  "profiles": {
    "developer": {
      "template": "aal-developer",
      "access": "edit",
      "hc": ["hc"],
      "session": "autoloop",
      "rpcTimeoutMs": 15000,
      "turnTimeoutMs": 10800000,
      "monitorIntervalMs": 1000
    }
  }
}
```

`template`、`access` 必填，其他字段可省略。`hc` 是本机可信可执行文件及固定参数，不经过 shell；默认 `["hc"]`。`session` 是 Herdr core 命名空间，不是模型对话 ID。可加 `cwd` 把 profile 固定在一个现有目录。超时、轮询间隔以毫秒计；创建模板终端额外留出至少 75 秒完成 Herdr 的原生启动握手。超时不会证明消息没有送到。

模型、CLI 选项和真实权限放在 Herdr template。profile 的 access 必须与规则完全一致，它是配置声明，不能把一个有写权限的进程变成只读沙箱。若应用需要只读保证，必须在原生 CLI 或操作系统中真正限制权限。

Herdr 官方模板位于 `~/.config/herdr-core/templates/<name>.md`；其 `command` 必须是你已安装、登录并配置好状态报告的交互式程序。模板本身不安装程序，也不提供状态报告。请按 [Herdr 模板文档](https://github.com/herdrdev/herdr-core/blob/master/docs/templates.md) 配置；不要为了通过启动检查而把 `ready` 改成 `quiet`，静默输出不能证明本轮结束。

规则中的代理使用：

```json
{
  "agents": {
    "developer": {
      "name": "开发 Agent",
      "worker": "my-mac",
      "use": "herdr-core",
      "access": "edit",
      "options": { "profile": "developer" }
    }
  }
}
```

每条规则继续指定 `cwd`、`prompt` 或 `skill`。不要再配置 agent.command。多个会话可用同一个 profile；同一个真实 cwd 同时只允许一个尚未确认结束的执行。需要并行开发时，请给每项任务独立的目录或 worktree。

`agent-autoloop doctor` 的插件检查只验证本机 profile 和可执行文件；运行时才验证 Herdr 连接、模板、终端身份及状态能力。这不等于已经验证模型账号登录或模型调用。

## 每轮如何交结果

插件先保存持久化任务，再为这次执行生成独立的 `request.json`、`context.json` 和 receipt 目的地。它把当前请求文件、当前资料文件和本地提交器 argv 明确写入本轮指令。原生程序的环境只额外设置稳定的 `AGENT_AUTOLOOP_HOME`；不设置会在续接后过期的 run/context 环境变量，也不传中台的轮次 token。

Agent 把最终回复写成 JSON 文件：

```json
{
  "text": "完成了本轮工作。\n```agent-autoloop\n{\"notice\":[]}\n```"
}
```

然后执行本轮给出的 `receipt.ts <request.json> <response.json>` 提交器。插件保留 text 原文，业务回执仍由现有 worker 解析。需要提问时仍提交 ask 并结束这一轮，人的答案会作为下一轮资料进入同一持久终端。

usage 只有取得真实计量时才提供，支持 input/output/cached/cost。未知计量必须省略，不填零来伪装准确。Herdr 自身不会从终端屏幕提供可靠的模型 Token 统计。

提交器验证请求身份，使用原子写入与 fsync 保存回执；重复交同一内容可接受，不同内容不会覆盖已有回执。需要修复格式时，worker 发起新的执行 turn 和新的请求，不重做业务。公开请求文件若被修改，插件拒绝采纳结果。

只有以下条件同时成立，插件才报告 `finished: true`：

1. 收到绑定当前 task、session、execution 和 nonce 的完整回执。
2. 验证仍是同一个 core、终端地址、创建时间、目录和 ownership labels。
3. 原生程序报告 done，且 Herdr turn 大于本次 `send` 或 `first_message` 返回的基线。

没有 `send` 回应或缺失 `first_message.turn` 时，不假设基线为 0。恢复必须实际观察 working，再观察后来的 done。若第一次恢复就只看见 done 和一份回执而无法确定本轮边界，会保留为 uncertain。blocked、error、静默、进程退出和任意文本代码块都不是成功证明。

## 会话、恢复与停止

首次创建使用 `terminal.run`，明确传 `keep:false`、`no_parent:true`、`no_notify:true`。续接使用同一个 core 和 terminal 的 `terminal.send`。地址和创建时间是身份，名称只帮助人工查找。`keep` 会把丢失的程序换成 shell，不能恢复 AI 对话，所以这里始终关闭。

发送意图在 RPC 前保存。RPC 回应丢失后不再自动发送；`recoverTask` 只读取原有终端和回执。新的 CLI 进程不会替代丢失的会话。安全的投递前失败会明确结束为失败，允许中台正常重试；已经存在外部执行的配置冲突、超时和未知投递状态保持 uncertain。

目录占用与当前观察进程的 lease 分开保存。观察进程死后可以核实同一次执行；原生任务仍占用其 cwd，其他任务不能抢进去。死 lease 的清理由独立的排他 reaper 串行执行；如果在很短的 reaper 清理窗口再次强杀，锁会保守保留，需要人工核实。

```sh
agent-autoloop plugin herdr-core list
agent-autoloop plugin herdr-core inspect <session>
agent-autoloop plugin herdr-core pause <session>
agent-autoloop plugin herdr-core resume <session>
agent-autoloop plugin herdr-core stop <session>
```

inspect 返回 attach 的 argv 与 `HC_SESSION` 环境。`hc attach` 没有 `--session` 选项；要使用返回的环境选择正确的 core。插件不把 shell 命令伪装成网页链接。

pause 只阻止之后的新消息，不暂停正在运行的原生 Agent。resume 恢复之后的投递，不重发不确定的旧消息。stop 只停止并核实原生终端；空闲终端也可以停止，已经完成的业务回执会保留。

**活动中台业务应使用 `agent-autoloop recover <顶层轮次ID> --stop`**，让 worker 确认原生终端停止后结算取消。单独调用插件 stop 不会结算中台业务。插件返回的 run 数字只是诊断字段，交付或浏览器子任务也可能使用它，不能据此取消任意同编号的顶层任务。

停止确认要求 `terminal.kill` 后读到同一终端的 finished 状态；只杀 bridge、RPC 失败、响应超时都不会返回停止成功。窗口关闭和客户端连接中断也不代表原生执行已终止。

## 程序调用

`task.ts` 导出 `runTask(turn, {signal?, onUpdate?})`、`recoverTask(turn)` 和 `stopTask(turn, reason)`，供其他可信插件复用。Turn 使用本地声明的结构，不导入中台私有模块：

```ts
{
  prompt, session, resume, cwd, access,
  contextFile, folder,
  options: { profile: "developer" },
  execution: { run, attempt, turn }
}
```

run、attempt、turn 必须是稳定的正整数。调用方负责自己的业务身份与调度，不要把子任务的数字当作中台顶层 run。相同身份重新调用只恢复已有执行。folder 用于兼容适配器契约，插件不会把该私有目录传给 Agent。

`Reading.state` 的 running 和 uncertain 都不允许当作失败后立即重做。`finished:true,error` 只用于明确尚未投递的安全失败。`capabilities.resume/persistent` 声明持久执行能力；它们与可点击会话链接无关。

## 数据与验证范围

`herdr/tasks` 保存每次执行的控制记录；`herdr/sessions` 保存终端绑定；`herdr/inbox` 保存给 Agent 的每轮请求、资料和回执；`herdr/locks` 保存占用与 lease。文件与目录采用本机私有权限，inbox 不包含 worker 的 entry.json 或中台 token。

这仍然是同一操作系统用户下的可信本地工具，不是隔离系统。过滤 hc 客户端的环境不能清除一个已运行 Herdr daemon 的原有环境；登录凭据、代理、PATH 与 CLI 权限必须在该 daemon 所在环境中正确配置。

自动测试通过 fake-hc 覆盖 JSON-RPC、结构化回执、持续会话、未知投递、桥接进程强杀、目录冲突、状态边界和远端停止确认。真实 CLI、账号授权和 OSC 报告需要在你的本机另行验证；未完成真实调用时不能把 fake-hc 通过称为原生端到端验收通过。
