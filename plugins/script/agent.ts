// Deterministic local programs only. Prompt/session adaptation belongs to the persistent Agent runtime.
// Keep the plugin self-contained so an installed copy has no imports into the host's private modules.
type Turn = { command?: string[]; cwd: string; contextFile: string };
type Reading = { text?: string; error?: string };

export default {
  command(turn: Turn): string[] {
    if (!turn.command?.length) throw new Error("script 需要固定的 command 参数列表");
    return turn.command.map((part) => {
      if (/\{(?:prompt|model|effort|session)\}/.test(part)) {
        throw new Error("script 不支持模型或会话占位符；AI 任务请配置 herdr-core profile");
      }
      return part.replaceAll("{cwd}", turn.cwd).replaceAll("{context}", turn.contextFile);
    });
  },
  read(stdout: string, code: number | null, stderr: string): Reading {
    if (code === null) return {};
    if (code !== 0) return { error: `退出码 ${code}：${(stderr || stdout).trim().slice(-4000) || "没留下原因"}` };
    return { text: stdout };
  },
};
