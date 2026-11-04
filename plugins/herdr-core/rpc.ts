import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Profile } from "./types.ts";

export class Rpc {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  next = 0;
  buffer = "";
  ended = false;
  onEvent?: () => void;
  stderr = "";
  profile: Profile;

  constructor(profile: Profile) {
    this.profile = profile;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(AGENT_AUTOLOOP_|CLAUDECODE$|CLAUDE_CODE_|CODEX_(?!HOME$)|HC_TERMINAL_ID$)/.test(key)) delete env[key];
    }
    this.child = spawn(profile.hc[0], [...profile.hc.slice(1), "connect", "--session", profile.session], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-1000);
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) {
        this.fail(Error("Herdr RPC 消息过长"));
        this.close();
        return;
      }
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.line(line);
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () => {
      this.fail(Error(`Herdr 连接中断${this.stderr ? `：${this.stderr.trim()}` : ""}`));
    });
  }

  private line(line: string) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(Error("Herdr 返回了无效 JSON-RPC"));
      this.close();
      return;
    }
    if (message.id === undefined) {
      this.onEvent?.();
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(Error(`Herdr ${message.error.data?.kind ?? message.error.message ?? "RPC 失败"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error) {
    this.ended = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeout = this.profile.rpcTimeoutMs): Promise<T> {
    if (this.ended) return Promise.reject(Error("Herdr 连接已结束"));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Herdr ${method} 响应超时；投递是否发生尚未确定`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  close() {
    this.fail(Error("Herdr 连接已关闭"));
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.kill("SIGTERM");
  }
}

export async function handshake(rpc: Rpc) {
  const hello = await rpc.call<{ generation: number; core: { id: string }; methods: string[] }>("hello", {
    generation: 1,
  });
  if (
    hello.generation !== 1 ||
    typeof hello.core?.id !== "string" ||
    !hello.core.id ||
    !Array.isArray(hello.methods)
  ) {
    throw Error("Herdr 协议版本或 core 身份不受支持");
  }
  const required = [
    "templates.list",
    "terminal.run",
    "terminal.send",
    "terminal.get",
    "terminal.list",
    "terminal.kill",
  ];
  for (const method of required) {
    if (!hello.methods.includes(method)) throw Error(`Herdr 缺少必要能力 ${method}`);
  }
  return hello;
}
