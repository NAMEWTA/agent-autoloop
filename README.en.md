# Agent Autoloop

**Let your command-line agents pick up work and follow it through in the background — staying quiet when they can handle it, and sending you a card only when a decision is yours to make.**

[中文](README.md) | **English**

This fork builds on [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop), preserving the original authorship and MIT license. It maintains the unified Herdr execution integration.

[Get started](#get-started) · [Recipes](#ready-to-use-recipes) · [Plugins](#plugin-ecosystem-swap-any-of-the-four-sides) · [Kernel](#four-kernel-mechanisms) · [Docs](#documentation)

![Architecture](docs/architecture.en.svg)

## What problem does it solve?

Most of us use command-line agents like Claude Code or Codex by babysitting a terminal: you type a prompt, watch it run, and answer its questions. Close the window or walk away, and the work stops.

**Agent Autoloop** turns your command-line agents into a background loop. At the center is a deterministic **kernel** with zero runtime dependencies. Around it, event sources, agents, notification channels, and even CI/CD delivery pipelines are all swappable **plugins**. AI execution uses one `herdr-core` plugin and persistent Herdr terminals. Native CLI startup, permissions, and tools belong to trusted local Herdr templates.

- **One machine, one install command.** Runs on your Mac or Linux machine. No cloud server or inbound ports required.
- **One AI execution path.** Rules choose a trusted Herdr profile; the plugin binds sessions, sends tasks, receives explicit receipts, and reconciles interrupted execution. Change the template to select another native CLI.
- **No web dashboard.** Cards reach you on Feishu, DingTalk, WeCom, Slack, Discord, or desktop notifications when you are needed. Everything else is one command away.

## Get started

Works on macOS and Linux. You need Node 24, Git, curl, a running [Herdr Core](docs/herdr-core.md), and a signed-in native CLI with a configured template; no GitHub account required. You can also hand the [installation guide](INSTALL.md) to your agent and let it install everything for you.

```bash
curl -fsSL https://raw.githubusercontent.com/NAMEWTA/agent-autoloop/main/install.sh | sh
```

Configure the local `developer` profile using the [setup guide](skills/agent-autoloop/SKILL.md#接一个-agent), then run a real loop: ask, finish this turn, make the call, and resume:

```bash
agent-autoloop try
```

> CLI output and default notification strings are currently in Chinese.

A non-interactive terminal prints the question and the answer command, for example:

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

In an interactive terminal, just type the option number. In a non-interactive terminal, run `agent-autoloop answer 1 2` to pick green. Then `agent-autoloop status` shows that the agent resumed its conversation and finished, along with rounds, tokens, and cost for today and the past seven days ([how they are counted](skills/agent-autoloop/SKILL.md#看情况回答)).

## How a piece of work flows

The numbers match the diagram above:

1. **An event comes in.** A 9:00 AM schedule, a new GitHub issue, or a production alert becomes a standard event sent to the kernel.
2. **Dispatched by your rules.** Your rules decide which agent handles it and in which folder. New events for the same subject while it is queued merge into one round.
3. **Submit this turn’s result.** The agent uses a turn-specific receipt helper to submit its final reply. The plugin checks its identity and runtime state before returning it to the hub. Terminal screen text is for inspection, not proof of completion.
4. **Asks only when needed.** For sensitive actions like deleting data, restarting a service, spending money, or messaging people, the kernel sends you a card through Feishu or a desktop notification. While you decide, the hub starts no new model turns. The turn bridge ends; Herdr and the native agent may remain idle and still use local resources.
5. **One tap resumes it.** Your answer continues in the terminal bound to the same logical session. A missing terminal or uncertain execution must be reconciled before another task is submitted.

Anything the agent can handle alone takes the auto-loop at the top of the diagram: finish outright, or schedule a follow-up check (say, in 30 minutes) without bothering you.

## Day-to-day usage

### Write your rules (`rules.json`)

No glue code needed. Open `~/.agent-autoloop/rules.json` and, under `rules`, declare **what happened, who handles it, and where they work**. Set `to` to a name already under `agents`; the default installation registers `agent`. For example, write a brief every morning at 9:

```json
{
  "name": "Morning brief",
  "when": { "cron": "0 9 * * *" },
  "to": "agent",
  "cwd": "~/notes",
  "prompt": "Summarize yesterday's notes and commits into today's brief."
}
```

External events work the same way once the source is connected. To hand new GitHub issues to the development agent, first register `github` under `sources` ([guide](skills/agent-autoloop/SKILL.md#接一个事件插件)):

```json
{
  "name": "Handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "agent",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

Changes take effect within seconds of saving. Run `agent-autoloop check` to validate. If you make a mistake, the hub keeps running the previous valid rules and sends you a card pointing out the error.

### How agents talk back to the hub

The business receipt format stays the same: **a final reply with an optional `agent-autoloop` block**. Every Herdr turn provides a dedicated receipt helper. The native agent submits the complete reply through that helper; printing a block in the terminal is not enough to complete a turn. A question can look like this:

````text
Order checked. We have enough stock in the warehouse.

```agent-autoloop
{
  "ask": [{
    "title": "How should we ship it?",
    "text": "Both options can go out today.",
    "options": ["Courier", "Pickup"],
    "key": "shipping"
  }]
}
```
````

Besides `ask`, receipts can send notifications (`notice`), resolve open cards (`resolve`), schedule follow-up checks (`later`), and emit new events (`events`). If the JSON is invalid, the hub has the agent rewrite just that final message in the same session, without repeating completed work. If rewriting also fails, it keeps the original conclusion and tells you the receipt was not applied.

## Ready-to-use recipes

Each recipe includes rules, a task Skill, and setup instructions (written in Chinese).

| Task | Included workflow |
|---|---|
| [Morning brief](examples/recipes/morning-brief/README.md) | Summarize local notes and Git commits at 8 AM by default; write `briefs/YYYY-MM-DD.md` |
| [GitHub issues](examples/recipes/github-issues/README.md) | Poll every five minutes, edit code locally, and notify you to review; no commits, pushes, or issue replies |
| [Production alerts](examples/recipes/ops-alerts/README.md) | Receive an error, investigate local code, ask before restarting, and continue after your answer |
| [User feedback](examples/recipes/feedback/README.md) | Re-read current feedback, fix, deliver and verify, then prepare a reply; ask you in Feishu and resume after your answer |
| [Website watch](examples/recipes/website-watch/README.md) | Check status and expected content every five minutes; wake the agent on a new incident, keep ongoing failures quiet, and update the card on recovery |
| [Feishu weekly and business brief](examples/recipes/feishu-brief/README.md) | Read selected reports and tables with your permissions at 6 PM Sunday; summarize locally and send only a short summary to Feishu |
| [PR delivery](skills/agent-autoloop/SKILL.md#交付流水线) | Add `deliver` to a PR to review it, wait for CI, merge, wait for deployment, and verify the live version |

**To enable one:** open its instructions, put the task Skill in your agent's skills directory, merge the sample rules into `~/.agent-autoloop/rules.json`, replace worker names and paths, then run `agent-autoloop check`.

Feedback, website watch, and Feishu briefs default to Asia/Shanghai and send only to the owner's private Feishu chat. Sample data is fictional; scripts and receipts have been verified only with local HTTP and a fake Feishu CLI, not run end to end on a live account.

More: [Herdr browser task handoff](examples/recipes/browser-handoff/README.md), [weekly code cleanup](examples/skills/weekly-sweep/SKILL.md), [ship a PR](examples/skills/ship-pr/SKILL.md).

## Plugin ecosystem: swap any of the four sides

Built-in plugins ship with the program and are enabled through configuration. Use `agent-autoloop add <git URL>` for third-party plugins.

| Side | Built in | Setup |
|---|---|---|
| **Events**: how work is found | [GitHub Webhook](plugins/github/source.ts), [HTTP API](docs/protocol.md#来源把世界变成事件), [cron rules](skills/agent-autoloop/SKILL.md#改规则), [issue polling script](examples/watch-github-issues.sh) | [Guide](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| **Agents**: who does the work | [Herdr Core](plugins/herdr-core/agent.ts) for AI, [fixed scripts](plugins/script/agent.ts) for deterministic collection | [Guide](skills/agent-autoloop/SKILL.md#接一个-agent) |
| **Channels**: how cards reach you | [Desktop notifications](plugins/desktop/channel.ts) (on by default), [Feishu](plugins/feishu/channel.ts), [DingTalk / WeCom / Slack / Discord](plugins/webhook/templates.ts) | [Guide](skills/agent-autoloop/SKILL.md#接一个通道) |
| **Delivery**: CI/CD as a plugin | [`delivery`](plugins/delivery/delivery.ts) | [Guide](skills/agent-autoloop/SKILL.md#交付流水线) |

**Execution boundary:** all built-in AI execution uses Herdr. `script` runs deterministic collectors and `delivery` runs the existing release workflow; neither introduces another model-session adapter. Channels still use Feishu, desktop, and Webhooks. Text-only channels use answer links, so set `hub.publicUrl` to an address reachable from your phone or computer.

**Configure a trusted profile.** Bind a profile in `~/.agent-autoloop/herdr/profiles.json` to a verified local Herdr template, then refer to it by name in rules:

```json
{ "name": "Development", "worker": "my-computer", "use": "herdr-core", "access": "edit", "options": { "profile": "developer" } }
```

The template configures the native CLI, model, permissions, and browser tools. Rule `access` must match the profile declaration; it does not create a sandbox. A terminal that starts successfully is not enough for reliable completion: the template must support explicit receipts and verifiable state. See the [Herdr runtime guide](docs/herdr-core.md).

**Recovery boundary.** An uncertain dispatch is never resent. The worker stays online but stops renewing tasks it cannot prove are running; the existing kernel lease then marks them `unknown`. The plugin retains their session and directory occupancy so new writers cannot collide with old work. Use separate worktrees for concurrent edits. `pause` blocks new input; `stop` verifies the actual terminal has stopped. See the [runtime guide](docs/herdr-core.md).

**Delivery pipeline.** Add the `deliver` label to a GitHub PR and it follows through to release: **review → wait for CI → merge → wait for deploy → verify the live version**. Review profiles and delivery settings are read only from `main`, and PR code is never checked out or run on the worker machine. Queueing, concurrency, and retries come from the kernel.

**Write your own.** Start from the runnable [agent](examples/plugins/hello-agent/agent.ts), [channel](examples/plugins/hello-channel/channel.ts), and [event](examples/plugins/hello-source/source.ts) templates and the [plugin guide](docs/plugins.md). For web tasks, read [browser access](docs/plugins.md#浏览器接入) first. The CLI and [MCP](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) can also inspect and answer cards.

## Four kernel mechanisms

The kernel is about 1,650 lines with zero runtime dependencies. It reads no clock, uses no randomness, and makes no outbound requests; plugins connect in, and credentials stay with the plugins that use them. Identical inputs always give identical results. It brings four proven systems patterns to command-line agents:

- **Business waits start no new model turns**: questions and waiting state live in SQLite, and the hub dispatches again after an answer. The turn bridge ends, but persistent Herdr terminals and native agents may stay resident. This is not a promise of zero processes or zero resource use.
- **Event sourcing**: Hub business state is derived from an append-only fact log, committed in the same SQLite transaction as its indexes before the hub replies. Confirmed facts survive `SIGKILL` (whole-machine power loss is not separately tested), every run can be traced with a single command, and format changes rebuild from the log without migration scripts.
- **Code / data split**: Like parameterized SQL. Issue titles, bodies, and other external text are written only to a local data file, never into the prompt, which carries only character-checked types, IDs, and links; `rules.json` alone decides which agent runs, in which folder, and with what access. Events carrying `cwd`, `agent`, or `access` fields are rejected outright.
- **Hop circuit breaker**: Like packet TTL in networking. Events returned by an agent can dispatch more agents, and the hop count keeps growing — across human questions and scheduled follow-ups too — and an agent cannot reset it. Past 8 hops, the kernel records the event, stops dispatching, and sends you a notice card.

### Check it yourself

Run these from `~/.agent-autoloop/app`:

| What it checks | Command |
|---|---|
| The full story of any round | `agent-autoloop why 1` |
| Native session binding and takeover information | `agent-autoloop plugin herdr-core inspect <session>` |
| Two real turns through a native template | `node scripts/real-agents.ts <profile>` |
| 200,000 simulated steps of network loss, dropped packets, crashes, and duplicate requests, reproducible from one seed | `node sim/random.ts 24301 200000` |
| 1,000 process kills with no acknowledged record lost | `node sim/crash.ts 1000 12648430` |
| The benchmarks below | `npm run benchmark` |

```text
第 1 轮 · 演示
11-03 20:47:25  规则版本 #1
11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
11-03 20:47:25  local 领取（演示程序）
11-03 20:47:25  结束：演示完成
```

### Benchmarks

These are historical measurements of the hub only. They exclude Herdr, native agents, tools, and model usage.

Apple M5 Pro, 24 GB, Node 24.21.0. Each write is a separate request, acknowledged only after its transaction is durable. The pass marks in `npm run benchmark` are set for this machine, so another machine may report a miss.

| Metric | Measured |
|---|---:|
| Cold start | 88.78 ms |
| Idle memory | 59.94 MB RSS |
| 1,000 concurrent waiting polls | 170.49 MB RSS |
| Durable writes | 2,394 events/s |
| Dispatch p99 | 1.82 ms |
| Startup at 1.1 million facts | 99.8 ms |
| Kernel lines (with comments and blanks) | 1,651 |
| Runtime dependencies | 0 |

As history grows, the status summary slows down and the log and indexes keep using disk. The first start after a format change rebuilds from the log, which took 43.1 seconds for 1.1 million facts. [Full numbers and method](docs/protocol.md#历史增长实测) (in Chinese).

## Usage and provider terms

The hub uses Herdr to run command-line tools you have already installed and signed into on your machine; it never reads or exports their credentials. Model usage is billed to your own account under each provider's terms.

For automated workloads, providers generally recommend using API keys rather than personal subscription quotas (which are designed around interactive personal use — see [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth)). Use API keys if you are running services for others. This project is independent and is not affiliated with or endorsed by those providers.

## Documentation

- [Installation guide](INSTALL.md)
- [Configuration & delivery pipeline manual](skills/agent-autoloop/SKILL.md)
- [Herdr setup, migration, and acceptance](docs/herdr-core.md)
- [Writing plugins](docs/plugins.md)
- [Full HTTP protocol specification](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Contributing and community](CONTRIBUTING.md)
- [Development guidelines](AGENTS.md)

<details>
<summary><strong>Repository layout</strong></summary>

| Location | Contents |
|---|---|
| `kernel/` | Decisions, fact log, projections, deadlines, rule matching, endpoint behavior, and card forms |
| `host/` | Node HTTP, files and SQLite connections, clock, configuration, background services, and plugin loading |
| `protocol/` | Wire formats, JSON Schema, input validation, HTTP client, and conformance checks |
| `worker/` | Claim work, run agents, handle heartbeats and cancellation, read and submit receipts |
| `cli/`, `bin/` | User commands and entry point: status, answers, `why`, MCP, updates, and uninstall |
| `plugins/` | Built-in agent, event, channel, and delivery plugins |
| `examples/recipes/` | Complete recipes with rules, a task Skill, and setup instructions |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh` | Minimal plugin templates, standalone task guides, and Shell examples |
| `skills/agent-autoloop/` | The hub's configuration and operation manual, also made available to agents during installation |
| `docs/` | Protocol, plugin guide, and Chinese / English architecture diagrams |
| `tests/`, `sim/` | Everyday behavior tests, simulation, enumeration, crash tests, and mutation checks |
| `scripts/`, `.github/workflows/` | Performance and real-agent checks, installation smoke scripts, and Linux / macOS CI |
| Root documents and `install.sh` | Chinese / English READMEs, installation, security, development guidelines, license, and installer |

Start reading at `bin/agent-autoloop.ts` → `cli/main.ts`, then follow the feature into `host/`, `worker/`, or `plugins/`. Read the [protocol](docs/protocol.md) for kernel design. Similarly named files serve different layers: `host/http.ts` adapts Node requests while `kernel/http.ts` defines endpoint behavior; `protocol/rules.ts` validates input while `kernel/rules.ts` defines rule types and matching.

</details>

[MIT License](LICENSE)
