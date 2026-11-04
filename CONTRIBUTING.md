# 参与贡献

欢迎提交可复现的问题、文档修正、插件和通用能力改进，中文或英文都可以。

## 讨论和反馈

本分支维护地址是 [NAMEWTA/agent-autoloop](https://github.com/NAMEWTA/agent-autoloop)，原项目由 [KKKKhazix](https://github.com/KKKKhazix/agent-autoloop) 开源。本分支当前不依赖 Issues 或 Discussions 功能已开启；可复现的修改通过 PR 说明问题、范围和验证，讨论使用仓库当时实际开放的渠道。

Herdr 改造的需求、设计、故障规则、迁移和验收矩阵集中在 [docs/herdr-core.md](docs/herdr-core.md)。PR 应引用对应边界，写明已验证和仍需本机验收的项目。不要把无法运行的真实 Agent、权限或故障检查写成通过。

## 贡献范围

新 Agent、事件插件和通道接在插件层；完整业务流程可以做成场景模板。先看 [插件开发说明](docs/plugins.md) 和 [现有场景](README.md#拿来即用的场景模板)，避免重复实现。

内核保持零运行时依赖，不连接外部产品。总览页、工作流画布和其他界面属于独立客户端，不放进这个仓库。改协议或核心流程前，先说明具体场景和兼容影响；维护约定见 [AGENTS.md](AGENTS.md)，协议见 [docs/protocol.md](docs/protocol.md)。

## 提交改动

1. 从最新的 `main` 创建分支；外部贡献者使用 Fork。Agent 在独立工作树里开发，主目录保留在 `main`。
2. 使用 Node.js 24 或更新版本，运行 `npm ci`。一次 PR 解决一个问题，同步更新受影响的中英文说明、示例和配置。
3. 修 bug 先写能复现它的失败测试，测试文件开头说明防止什么失败。纯文档、模板或小范围可逆改动，不补照着实现抄的测试。
4. 提交前运行 `npm test`、`npm run typecheck`、`npm run format:check`。涉及日志、到期表或并发时，再运行 `npm run test:nightly`。CI 在 Linux 和 macOS 上检查，并用已提交的代码运行安装到卸载的冒烟验证；只改文档时跳过这些检查，没动 `kernel/`、`protocol/`、`sim/` 时跳过耗时的模拟，合并后再跑完整检查。
5. 向 `main` 提交 PR，说明问题、改后的行为、验证结果和兼容影响。未完成的工作使用草稿；合并前确认当前提交的两项系统检查通过。

测试使用临时 `AGENT_AUTOLOOP_HOME`、随机端口、本地假 HTTP 和假通知命令。不要连接真实业务数据库、发送消息，或给已在线的飞书应用再开事件监听。真实交付脚本会创建和删除指定测试仓库，只在用户明确要求时运行。

不要提交密钥、带权限的卡片链接、完整配置、数据库、运行输出或同事资料。问题中的日志和截图也要先脱敏。代码按 [MIT 许可证](LICENSE) 提交。

仓库通过 `main` 分发，安装和更新方式见 [INSTALL.md](INSTALL.md)；目前没有独立发布包或长期支持分支。仓库设置中的自动合并保持关闭，交付插件按 [交付协议](docs/protocol.md#交付插件) 完成审查、检查和合并。

AI 执行扩展优先完善 Herdr template/profile 和通用任务契约；本分支不再接受新的品牌启动适配器。固定脚本、通道和来源仍按原有插件接口扩展。
