// The adapter owns execution details. A local process may perform the work itself or bridge a persistent runtime.
// Installed plugins take precedence over the built-in plugins.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadPlugin } from "../host/plugins.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  command?: string[];
  options?: Record<string, unknown>;
  execution?: { run: number; attempt: number; turn: number };
  contextFile: string;
  folder: string;
};
export type Reading = {
  text?: string;
  session?: string;
  usage?: Usage;
  error?: string;
  finished?: boolean;
  /** Pending readings cannot conclude a run, even when their bridge has exited. */
  state?: "running" | "uncertain";
};
export type Adapter = {
  capabilities?: { resume?: boolean; persistent?: boolean };
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Observe the same execution without starting or sending work. Terminal text/errors require `finished: true`. */
  recover?(turn: Turn): Promise<Reading>;
  /** True only after confirming that the actual execution stopped, including work outside the bridge process. */
  stop?(turn: Turn, reason: "cancel" | "timeout"): Promise<boolean>;
  /** Where a person can open this session. This does not imply resume support. */
  link?(session: string): string;
  /** Whether it's installed and signed in: what's wrong, in words a person can act on, or nothing. */
  check?(configuration?: Record<string, unknown>): string | null;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

const found = new Map<string, string | null>();

/** Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), or in one of these. */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  if (!found.has(name)) {
    const shell = process.env.SHELL ?? "/bin/sh";
    let onPath: string | null = null;
    try {
      const printed = execFileSync(shell, ["-lc", `command -v ${name}`], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      onPath = printed.trim().split("\n").at(-1) || null;
    } catch {}
    found.set(name, onPath ?? elsewhere().find(existsSync) ?? null);
  }
  const program = found.get(name);
  if (!program) throw new Error(`找不到 ${name}：先装好并登录`);
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
