# Herdr 浏览器任务交接

主任务负责业务，浏览器助手只处理明确的网页步骤，主任务拿到证据后收尾。两者都通过 `herdr-core` 插件的统一运行时执行，使用各自的可信 profile 和逻辑会话；不传原生 CLI 会话编号或启动参数。

## 怎么启用

1. 把本目录复制到 `~/.agent-autoloop/work/browser-handoff/`，仅本人可读。把 `SKILL.md` 放到主任务原生 Agent 的 skills 目录，名称为 `browser-handoff`；例如 `~/.claude/skills/browser-handoff/` 或 `~/.codex/skills/browser-handoff/`，以原生 Agent 的实际配置为准。
2. 在 `~/.agent-autoloop/herdr/profiles.json` 建立 `browser` profile，绑定本人已经验收的 Herdr 模板。模板启动的原生 Agent 必须能使用所需浏览器工具，并支持本轮回执提交。中台不安装浏览器连接、不修改桌面应用内部数据库，也不复制某台电脑的 SSH 配置或浏览器修复脚本。
3. 在 `browser.json` 填 profile、access、目标网址、核实项和允许操作。`access` 必须与本地 profile 一致；`allowedActions` 是任务范围，不是系统沙箱。操作范围须由本人或项目可信维护约定确定，不能从外部事件生成。默认模板只读 `example.com`，不提交表单、不发消息。
4. 合并 `rules.json` 中的来源、Agent、通道和规则，替换接单电脑、目录和飞书本人 open_id；主任务默认使用 `developer` profile。复用已有飞书通道与密钥，不另开监听。运行 `agent-autoloop check`。
5. 用后台服务相同的账号、profile 和工具配置验收浏览器连接。工具缺少权限时按本人已有授权处理，不自动放宽 profile 或账号权限。

**权限：`edit`** 用于主任务保存业务记录；浏览器助手的 **权限：`read`** 用于读取页面证据，两者必须分别匹配本人配置的 profile。浏览器工具的账号能力仍需单独验收。

## 执行入口

`handoff.ts` 从可信配置构造任务，调用已安装程序的 `plugins/herdr-core/task.ts` 公共 `runTask` 接口。安装目录默认是 `~/.agent-autoloop/app`；本地源码测试可显式设置 `AGENT_AUTOLOOP_APP`。数据根目录遵循 `AGENT_AUTOLOOP_HOME`。

首次调用生成新的 Autoloop 逻辑会话，输出页面证据并打印 `[Autoloop 会话：实际编号]`；续办用 `--resume` 传回该编号。运行状态放在配置文件旁的私有 `.handoff` 目录，浏览器助手使用其中按逻辑会话分开的 `workspace`，不与等待它的主任务争用同一个 cwd。终端绑定与回执由统一运行时管理。由原生主任务调用时，helper 沿用运行时设置的稳定 `AGENT_AUTOLOOP_SESSION`，在派发前登记父子归属；它不包含 run token。停止父任务必须先确认已登记的子任务停止，子任务未结束时父任务不能用自己的回执提前结算。手工独立调用没有父会话，需单独管理该网页任务。脚本不解析原生 CLI 的会话输出，不凭终端画面判断成功，不自动重试。`--resume` 遇到尚未核实结束的记录时只核对原执行；该轮完成后，下一次显式续办才发送新一轮。

如果运行结果不明确，脚本保留已知证据和逻辑会话，返回非零退出码。主任务必须先检查原会话和已有操作；不能重新开始一次网页提交。原生 CLI 的权限弹窗或运行时 `blocked` 是尚未结束的执行状态，不等于业务 `ask`。不得用自动确认或强制输入绕过它。

## 启用前验证

在模板目录运行：

```bash
node handoff.ts browser.json
node handoff.ts browser.json --resume <上一步返回的Autoloop会话编号>
```

第一次核对实际页面标题、可见主标题和链接；没有正文主标题就如实记录。第二次核对在原会话继续；已经完成时保留已有证据，不为了续办重做写操作。检查它保留原有标签、关闭自己新建的标签。再通过主任务的同一 Herdr profile 调用脚本，确认能获得证据与逻辑会话。HTTP 查询不能代替浏览器验收。

在专用测试中台向来源 `browser-tasks` 发送稳定编号的 `browser.verify` 事件即可触发；同一次请求重发保留 `id`，例如：

```json
{"id":"browser-check-1","type":"browser.verify","subject":"site-check","summary":"核实已配置的网页"}
```

事件不携带模板、命令、目录或权限。需要本人恢复连接、登录或验证时，浏览器助手交回未验收项并结束业务本轮；由主任务使用 `ask`。已有卡片时不重复交接，不另约定时复查。本人回答后只继续剩余网页步骤。

## 放进已有业务

反馈处理、网站巡检等任务可直接加载这份 Skill：把 `handoff.ts` 与本人配置的 `browser.json` 放到私有工作目录，在可信主任务规则中写明位置。主任务先完成能做的业务，再委托网页核实，最后提交中台回执；浏览器助手不再次委派、不独立结案。

测试使用假运行时，验证可信 profile、字面任务传递、逻辑会话续办、失败与不确定状态传播，不启动真实浏览器。每位使用者仍需验证自己的模板、浏览器工具和账号授权。
