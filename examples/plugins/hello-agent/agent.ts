// The smallest protocol example. `echo` simulates an Agent, with no model or account.
// Production AI execution uses the herdr-core plugin and a trusted native-runtime profile.
// In rules.json: "agents": { "hello": { "name": "Hello", "worker": "mac-mini", "use": "hello-agent" } }
type Turn = { prompt: string; session: string; resume: string | null; access: "read" | "edit" | "full" };

export default {
  capabilities: { resume: true },
  command(turn: Turn) {
    const session = turn.resume ?? turn.session;
    const text = `收到了 ${turn.prompt.length} 字的提示词，权限 ${turn.access}。这是 hello-agent，什么也没做。`;
    return ["echo", JSON.stringify({ session, text })];
  },
  // Called while it runs too, with code null. A throw here stops the worker, so anything it can't read is an error it returns.
  read(stdout: string, code: number | null, stderr: string) {
    if (code === null) return {};
    if (code !== 0) return { error: stderr.trim() || `退出码 ${code}` };
    try {
      const { session, text } = JSON.parse(stdout);
      return { session, text };
    } catch {
      return { error: `读不懂它的输出：${stdout.slice(0, 200)}` };
    }
  },
  // A link is presentation only; capabilities.resume separately permits a receipt repair in this simulated session.
  link: (session: string) => `hello-agent://sessions/${session}`,
};
