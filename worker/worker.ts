// The worker: on a machine that nothing can reach, it keeps coming to the hub for work and starts an agent for each
// job. Each local process writes to files in a detached process group. A persistent adapter must also account for
// execution outside that group, so losing its observer cannot be mistaken for finished work. A job is saved before anything slow happens; a result is saved before it's handed
// in and stays until the hub has taken it.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubError, type Hub } from "../protocol/client.ts";
import { HOME } from "../host/home.ts";
import type { Job } from "../protocol/job.ts";
import { addUsage, type Notice, type Result } from "../protocol/validate.ts";
import { adapterFor, type Adapter, type Reading, type Turn, type Usage } from "./agents.ts";
import { promptFor, readMessage, repairPrompt, resultFrom } from "./contract.ts";

const RUNS = path.join(HOME, "worker", "runs");
const TIMEOUT_MINUTES = 180;
/** A reader of the turn's end that doesn't exit is given this long. */
const GRACE = 30_000;
/** A process told to stop is given this long. */
const STOP_GRACE = 10_000;
const REPAIRS = 2;
const KEEP_DAYS = 14;
const WAIT = 50;
const PAUSE = 30_000;
const UNREACHABLE = 10 * 60_000;
const TELL_TRIES = 5;
/** Enough of a long output to find what's at either end of it, while it runs. */
const HEAD = 64 * 1024;
const TAIL = 1024 * 1024;

type Entry = {
  run: number;
  token: string;
  attempt: number;
  job: Job;
  dir: string;
  prompt: string;
  turn: number;
  session: string;
  resume: string | null;
  repairs: number;
  triedFresh: boolean;
  input?: Turn;
  persistent?: boolean;
  state?: "running" | "uncertain";
  recoveryError?: string;
  stopConfirmed?: boolean;
  finishedReading?: Reading;
  originalReading?: Reading;
  usage?: Usage;
  pid?: number;
  launchedAt?: number;
  finishedAt?: number;
  told?: string;
  stopping?: number;
  why?: "cancel" | "timeout" | "finished";
  result?: Result;
};
export type WorkerHub = Pick<Hub, "work" | "started" | "result">;
export type WorkerOptions = {
  hub: WorkerHub;
  name: string;
  capacity?: number;
  log?: (line: string) => void;
  /** Run when the hub can't be reached for ten minutes, with {text} in it: nothing else can tell the owner then. */
  unreachable?: string[];
  wait?: number;
  now?: () => number;
};

function save(entry: Entry) {
  const file = path.join(entry.dir, "entry.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** What the agent's environment gets: never the hub's secrets, and nothing of a session the worker itself may be in. */
function agentEnvironment(entry: Entry) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(AGENT_AUTOLOOP_|CLAUDECODE$|CLAUDE_CODE_|CODEX_(?!HOME$))/.test(name)) continue;
    env[name] = value;
  }
  return {
    ...env,
    AGENT_AUTOLOOP_HOME: HOME,
    AGENT_AUTOLOOP_RUN: String(entry.run),
    AGENT_AUTOLOOP_CONTEXT: path.join(entry.dir, "context.json"),
  };
}

const files = (entry: Entry) => ({
  out: path.join(entry.dir, `stdout-${entry.turn}.log`),
  err: path.join(entry.dir, `stderr-${entry.turn}.log`),
  exit: path.join(entry.dir, `exit-${entry.turn}`),
});
const marker = (entry: Entry) => `agent-autoloop-run:${entry.run}:${entry.attempt}:${entry.turn}`;

function alive(entry: Entry) {
  if (!entry.pid) return false;
  try {
    const command = execFileSync("ps", ["-p", String(entry.pid), "-o", "command="], { encoding: "utf8" });
    return command.includes(marker(entry));
  } catch {
    return false;
  }
}

function signal(entry: Entry, name: NodeJS.Signals) {
  try {
    if (entry.pid) process.kill(-entry.pid, name);
  } catch {}
}

function groupAlive(entry: Entry) {
  // The wrapper can die before a child; zombies have already stopped and only their parent can reap them.
  return execFileSync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === entry.pid && !state.startsWith("Z");
    });
}

/** Ask the local worker to stop a retained execution whose hub lease may already be unknown. */
export function requestRecoveryStop(run: number): boolean {
  if (!Number.isSafeInteger(run) || run < 1 || !existsSync(RUNS)) return false;
  for (const id of readdirSync(RUNS)) {
    const dir = path.join(RUNS, id);
    let entry: Entry;
    try {
      entry = JSON.parse(readFileSync(path.join(dir, "entry.json"), "utf8")) as Entry;
    } catch {
      continue;
    }
    if (entry.run !== run || entry.result) continue;
    const file = path.join(dir, "cancel.request");
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ run, attempt: entry.attempt, token: entry.token }), { mode: 0o600 });
    renameSync(temporary, file);
    return true;
  }
  return false;
}

function requestedStop(entry: Entry) {
  try {
    const request = JSON.parse(readFileSync(path.join(entry.dir, "cancel.request"), "utf8"));
    return request.run === entry.run && request.attempt === entry.attempt && request.token === entry.token;
  } catch {
    return false;
  }
}

function snapshot(file: string) {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  if (size <= HEAD + TAIL) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(HEAD);
    const end = Buffer.alloc(TAIL);
    readSync(fd, head, 0, HEAD, 0);
    readSync(fd, end, 0, TAIL, size - TAIL);
    return `${head.toString("utf8")}\n${end.toString("utf8")}`;
  } finally {
    closeSync(fd);
  }
}

export function createWorker({
  hub,
  name,
  capacity = 2,
  log = () => {},
  unreachable,
  wait = WAIT,
  now = Date.now,
}: WorkerOptions) {
  let claim = randomUUID();
  let unreachableSince: number | null = null;
  let told = false;
  let tries = 0;
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });

  const entries = () =>
    readdirSync(RUNS).flatMap((id) => {
      try {
        return [JSON.parse(readFileSync(path.join(RUNS, id, "entry.json"), "utf8")) as Entry];
      } catch {
        return [];
      }
    });

  function turnFor(entry: Entry, prompt = entry.prompt): Turn {
    const { rule, agent } = entry.job;
    return {
      prompt,
      session: entry.session,
      resume: entry.resume,
      cwd: rule.cwd.replace(/^~(?=\/)/, homedir()),
      model: agent.model,
      effort: agent.effort,
      access: agent.access as Turn["access"],
      command: agent.command,
      options: agent.options,
      execution: { run: entry.run, attempt: entry.attempt, turn: entry.turn },
      contextFile: path.join(entry.dir, "context.json"),
      folder: entry.dir,
    };
  }

  /** Save the exact turn before dispatch; recovery observes it rather than constructing another prompt. */
  function launch(entry: Entry, adapter: Adapter, prompt: string) {
    entry.turn += 1;
    entry.launchedAt = now();
    entry.persistent = adapter.capabilities?.persistent === true;
    delete entry.finishedAt;
    delete entry.finishedReading;
    delete entry.pid;
    delete entry.stopping;
    delete entry.stopConfirmed;
    delete entry.why;
    delete entry.state;
    delete entry.recoveryError;
    entry.input = turnFor(entry, prompt);
    save(entry);
    const turn = entry.input;
    const { cwd } = turn;
    if (!existsSync(cwd)) throw new Error(`在 ${cwd} 启动不了：这个目录不存在`);
    const argv = adapter.command(turn);
    const { out, err, exit } = files(entry);
    // Output and the exit code go through the shell, so they land in their files even if this program has gone by then.
    const script = [
      "out=$1",
      "err=$2",
      "result=$3",
      "shift 3",
      "umask 077",
      '"$@" >"$out" 2>"$err"',
      'echo $? >"$result.tmp"',
      'mv "$result.tmp" "$result"',
      // A final external command can replace the shell before publishing its exit file.
      ":",
    ].join("\n");
    // The login shell gives it the PATH and sign-in its owner has in a terminal; launchd and systemd give neither.
    const login = [process.env.SHELL ?? "/bin/sh", "-lc", 'exec "$0" "$@"'];
    const child = spawn("/bin/sh", ["-c", script, marker(entry), out, err, exit, ...login, ...argv], {
      cwd,
      env: agentEnvironment(entry),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => log(`run ${entry.run}: ${error}`));
    child.unref();
    entry.pid = child.pid;
    save(entry);
    log(`run ${entry.run} (${entry.job.rule.name}) turn ${entry.turn} started, pid ${child.pid}`);
  }

  function endWith(entry: Entry, result: Result) {
    entry.result = result;
    save(entry);
  }

  async function start(job: Job) {
    const dir = path.join(RUNS, `${job.run}-${job.attempt}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry: Entry = {
      run: job.run,
      token: job.token,
      attempt: job.attempt,
      job,
      dir,
      prompt: "",
      turn: 0,
      session: job.session ?? randomUUID(),
      resume: job.session,
      repairs: 0,
      triedFresh: false,
    };
    // Kept before anything slow: a worker stopped from here on still has the job.
    save(entry);
    try {
      writeFileSync(path.join(dir, "context.json"), JSON.stringify(job.context, null, 2), { mode: 0o600 });
      const adapter = await adapterFor(job.agent.use);
      entry.prompt = promptFor(job, path.join(dir, "context.json"));
      save(entry);
      launch(entry, adapter, entry.prompt);
    } catch (error) {
      endWith(entry, { outcome: "failed", error: String((error as Error).message ?? error).slice(0, 500) });
    }
  }

  function read(entry: Entry, adapter: Adapter, code: number | null): Reading {
    const { out, err } = files(entry);
    return adapter.read(snapshot(out), code, code === null ? "" : snapshot(err));
  }

  function discardReceipt(entry: Entry, adapter: Adapter, problem: string) {
    const original = { ...entry, turn: entry.turn - entry.repairs };
    const reading = entry.originalReading ?? read(original, adapter, 0);
    const { result } = resultFrom(readMessage(reading.text ?? ""), {
      session: reading.session ?? (adapter.capabilities?.resume ? entry.session : undefined),
      usage: entry.usage,
    });
    const receipt = path.join(entry.dir, `receipt-${original.turn}.txt`);
    writeFileSync(receipt, reading.text ?? "", { mode: 0o600 });
    const notice: Notice = {
      title: `「${entry.job.rule.name}」的回执读不懂`,
      text: `这一轮按第一行算结束了，但它要中台做的事没有生效（${problem}）。回执原文在 ${receipt}，进程输出在 ${files(original).out}。`,
    };
    endWith(entry, { ...result, notice: [...(result.notice ?? []), notice] });
  }

  /** A turn has ended. What it said is a result, or a reason to ask it again without redoing anything. */
  function conclude(entry: Entry, adapter: Adapter, code: number | null, reading?: Reading) {
    // One ended because its turn was over but it wouldn't exit said what it had to say first.
    const seen = reading ?? entry.finishedReading ?? read(entry, adapter, entry.finishedAt !== undefined ? 0 : code);
    entry.usage = addUsage(entry.usage, seen.usage);
    const session = seen.session ?? (entry.turn > 0 && adapter.capabilities?.resume ? entry.session : undefined);
    if (seen.session) entry.session = seen.session;
    const usage = entry.usage && { usage: entry.usage };
    const known = session && { session };
    if (entry.why === "cancel") return endWith(entry, { outcome: "cancelled", summary: "已停止", ...known, ...usage });
    if (entry.why === "timeout") {
      const minutes = entry.job.agent.timeout ?? TIMEOUT_MINUTES;
      const error = `超过 ${minutes} 分钟还没结束，已停止`;
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      return endWith(entry, { outcome: "failed", error, ...known, ...usage });
    }
    if (seen.error !== undefined || !seen.text?.trim()) {
      const error = seen.error || "没留下结果";
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      // The conversation may not be there to go on in, or something else has it open: this go carries on in a new one.
      if (entry.resume && !entry.triedFresh && entry.repairs === 0 && !entry.persistent) {
        log(`run ${entry.run}: couldn't go on in ${entry.resume} (${error}); starting a new session`);
        entry.triedFresh = true;
        entry.resume = null;
        entry.session = randomUUID();
        try {
          launch(entry, adapter, entry.prompt);
          return;
        } catch (failure) {
          return endWith(entry, { outcome: "failed", error: String(failure).slice(0, 500) });
        }
      }
      return endWith(entry, { outcome: "failed", error: error.slice(0, 500), ...known, ...usage });
    }
    const { result, problem } = resultFrom(readMessage(seen.text), { session, usage: entry.usage });
    if (entry.repairs && !problem && result.outcome === "failed") return discardReceipt(entry, adapter, result.error!);
    if (!problem) return endWith(entry, result);
    // Its work is done and only the receipt is wrong: it writes the receipt again, and does nothing again.
    entry.originalReading ??= seen;
    if (adapter.capabilities?.resume && entry.repairs < REPAIRS && seen.session) {
      log(`run ${entry.run}: receipt not readable (${problem}); asking again`);
      entry.repairs += 1;
      entry.resume = seen.session;
      try {
        launch(entry, adapter, repairPrompt(problem));
        return;
      } catch (error) {
        return discardReceipt(entry, adapter, String(error));
      }
    }
    discardReceipt(entry, adapter, problem);
  }

  function pending(entry: Entry, state: "running" | "uncertain", error?: string) {
    if (entry.state !== state || entry.recoveryError !== error) {
      entry.state = state;
      entry.recoveryError = error;
      save(entry);
      if (state === "uncertain") log(`run ${entry.run}: 执行状态待核实${error ? `（${error}）` : ""}`);
    }
  }

  async function sayStarted(entry: Entry, adapter: Adapter, seen: Reading) {
    const session = seen.session ?? (adapter.capabilities?.resume ? entry.session : undefined);
    if (seen.session && seen.session !== entry.session) {
      entry.session = seen.session;
      save(entry);
    }
    if (!session || session === entry.told) return;
    try {
      await hub.started(entry.run, entry.token, { session, ...(adapter.link && { link: adapter.link(session) }) });
      entry.told = session;
      save(entry);
    } catch (error) {
      log(`run ${entry.run}: couldn't say it started: ${error}`);
    }
  }

  async function recover(entry: Entry, adapter: Adapter): Promise<Reading> {
    if (!adapter.recover) return { state: "uncertain", error: "连接已断开，插件不能核实实际执行状态" };
    try {
      const seen = await adapter.recover(entry.input ?? turnFor(entry));
      if (!seen.state && seen.finished !== true) {
        return { ...seen, state: "uncertain", error: seen.error ?? "恢复查询尚未确认实际执行已经结束" };
      }
      if (!seen.state && !seen.text?.trim() && seen.error === undefined) {
        return { ...seen, state: "uncertain", error: "恢复查询没有给出实际执行状态" };
      }
      return seen;
    } catch (error) {
      return { state: "uncertain", error: String((error as Error).message ?? error).slice(0, 500) };
    }
  }

  async function finishStopping(entry: Entry, adapter: Adapter) {
    const remote = entry.why !== "finished" && (entry.persistent || adapter.stop);
    if (remote && !entry.stopConfirmed) {
      let stopped = false;
      try {
        stopped = (await adapter.stop?.(entry.input ?? turnFor(entry), entry.why as "cancel" | "timeout")) === true;
      } catch (error) {
        pending(entry, "uncertain", String((error as Error).message ?? error).slice(0, 500));
        return;
      }
      if (!stopped) return pending(entry, "uncertain", "还不能确认实际执行已经停止");
      entry.stopConfirmed = true;
      entry.stopping = now();
      delete entry.state;
      delete entry.recoveryError;
      save(entry);
      signal(entry, "SIGTERM");
    }
    if (groupAlive(entry)) {
      if (now() - entry.stopping! > STOP_GRACE) signal(entry, "SIGKILL");
      return;
    }
    const { exit } = files(entry);
    const code = existsSync(exit) ? Number(readFileSync(exit, "utf8").trim()) : null;
    // A confirmed stop is authoritative even when the observer never printed a final envelope.
    let seen: Reading;
    try {
      seen = entry.finishedReading ?? read(entry, adapter, entry.why === "finished" ? 0 : code);
    } catch {
      seen = {};
    }
    conclude(entry, adapter, code, seen);
  }

  /** Looks at the execution, not just the lifetime of its local observer process. */
  async function check(entry: Entry) {
    if (entry.result) return;
    if (requestedStop(entry)) stop(entry, "cancel");
    if (entry.turn === 0 && entry.stopping !== undefined) return endWith(entry, { outcome: "cancelled", summary: "已停止" });
    let adapter: Adapter;
    try {
      adapter = await adapterFor(entry.job.agent.use);
    } catch (error) {
      const message = String((error as Error).message).slice(0, 500);
      if (entry.persistent) return pending(entry, "uncertain", message);
      return endWith(entry, { outcome: "failed", error: message });
    }
    if (entry.persistent === undefined) {
      entry.persistent = adapter.capabilities?.persistent === true;
      save(entry);
    }
    if (entry.turn === 0) {
      // The worker stopped while starting it, before anything was launched.
      if (!entry.prompt) entry.prompt = promptFor(entry.job, path.join(entry.dir, "context.json"));
      try {
        writeFileSync(path.join(entry.dir, "context.json"), JSON.stringify(entry.job.context, null, 2), {
          mode: 0o600,
        });
        return launch(entry, adapter, entry.prompt);
      } catch (error) {
        return endWith(entry, { outcome: "failed", error: String((error as Error).message ?? error).slice(0, 500) });
      }
    }
    if (entry.stopping !== undefined) return finishStopping(entry, adapter);
    const { exit } = files(entry);
    let code = existsSync(exit) ? Number(readFileSync(exit, "utf8").trim()) : null;
    const ended = code !== null || !alive(entry);
    // The shell can publish its exit between the first file check and ps returning.
    if (ended && code === null && existsSync(exit)) code = Number(readFileSync(exit, "utf8").trim());
    let seen: Reading;
    try {
      seen = entry.finishedReading ?? read(entry, adapter, code);
    } catch (error) {
      seen = { error: String((error as Error).message ?? error).slice(0, 500) };
    }
    const completed = seen.finished && !seen.state && seen.error === undefined && seen.text?.trim();
    if (ended && (entry.persistent || adapter.recover) && !completed) seen = await recover(entry, adapter);
    await sayStarted(entry, adapter, seen);
    if (seen.state) pending(entry, seen.state, seen.error);
    else if (entry.persistent && !ended && !completed) {
      pending(entry, seen.error !== undefined || seen.finished ? "uncertain" : "running",
        seen.error ?? (seen.finished ? "还没有收到这一轮的完整回执" : undefined));
    }
    else {
      delete entry.state;
      delete entry.recoveryError;
      if (ended) return conclude(entry, adapter, code, seen);
      if (seen.finished) {
        if (seen.text?.trim() || seen.error !== undefined) entry.finishedReading = seen;
        entry.finishedAt ??= now();
        save(entry);
      }
    }
    const moment = now();
    const limit = (entry.job.agent.timeout ?? TIMEOUT_MINUTES) * 60_000;
    if (moment - (entry.launchedAt ?? moment) > limit) return stop(entry, "timeout");
    if (entry.finishedAt !== undefined && moment - entry.finishedAt > GRACE) stop(entry, "finished");
  }

  function stop(entry: Entry, why: "cancel" | "timeout" | "finished") {
    if (entry.stopping !== undefined || entry.result) return;
    entry.stopping = now();
    entry.why = why;
    // Stopping the bridge proves nothing about a runtime outside its process group.
    if (entry.persistent && why !== "finished") entry.state = "uncertain";
    save(entry);
    if (!entry.persistent || why === "finished") signal(entry, "SIGTERM");
    log(`run ${entry.run}: stopping (${why})`);
  }

  /** Hands in what has ended. One the hub can't take now waits for next time; one it refuses is dropped and said so. */
  async function settle(entry: Entry) {
    if (!entry.result) return;
    try {
      const answer = await hub.result(entry.run, entry.token, entry.result);
      for (const item of answer?.rejected ?? []) log(`run ${entry.run}: not applied: ${JSON.stringify(item)}`);
      log(`run ${entry.run}: ${entry.result.outcome}`);
    } catch (error) {
      if (!(error instanceof HubError) || error.status >= 500) {
        return log(`run ${entry.run}: couldn't hand in the result: ${error}`);
      }
      log(`run ${entry.run}: the hub refused its result (${error.status}: ${error.message}); dropped`);
    }
    unlinkSync(path.join(entry.dir, "entry.json"));
  }

  /** Nothing else can tell the owner when the hub is what's gone. */
  function watchHub(reachable: boolean, moment: number) {
    if (reachable) {
      unreachableSince = null;
      told = false;
      tries = 0;
      return;
    }
    unreachableSince ??= moment;
    if (!unreachable?.length || told || tries >= TELL_TRIES || moment - unreachableSince < UNREACHABLE) return;
    tries += 1;
    const minutes = Math.floor((moment - unreachableSince) / 60_000);
    const text = `${name} 连不上中台已经 ${minutes} 分钟了，派给它的活暂时没人接；它还在一直重试。`;
    const [program, ...args] = unreachable;
    try {
      execFileSync(
        program,
        args.map((part) => part.replaceAll("{text}", text)),
        { timeout: 60_000, stdio: "ignore" },
      );
      told = true;
    } catch (error) {
      log(`couldn't tell anyone the hub is gone: ${error}`);
    }
  }

  /** One round: look at what's in hand, hand in what's ended, come for more. Whether the hub could be reached. */
  async function tick() {
    for (const entry of entries()) await check(entry);
    for (const entry of entries()) await settle(entry);
    const held = entries();
    let reachable = true;
    try {
      const answer = await hub.work({
        claim,
        wait: held.length ? 1 : wait,
        running: held.filter((entry) => entry.state !== "uncertain").map((entry) => entry.run),
        capacity: held.length < capacity && !held.some((entry) => entry.state === "uncertain"),
      });
      for (const id of answer?.cancel ?? []) {
        const entry = held.find((entry) => entry.run === id);
        if (entry) stop(entry, "cancel");
      }
      if (answer?.job) {
        claim = randomUUID();
        await start(answer.job);
      }
    } catch (error) {
      log(`couldn't reach the hub: ${error}`);
      reachable = false;
    }
    watchHub(reachable, now());
    return reachable;
  }

  /** Output of finished runs is kept a while for looking into, then goes. */
  function tidy(moment = now()) {
    for (const id of readdirSync(RUNS)) {
      const dir = path.join(RUNS, id);
      const expired = moment - statSync(dir).mtimeMs > KEEP_DAYS * 24 * 3600_000;
      if (!existsSync(path.join(dir, "entry.json")) && expired) rmSync(dir, { recursive: true, force: true });
    }
  }

  async function run(signalled: AbortSignal) {
    log(`worker ${name} started`);
    tidy();
    while (!signalled.aborted) {
      if (!(await tick())) await new Promise((resolve) => setTimeout(resolve, PAUSE));
    }
  }

  return { tick, run, entries, tidy };
}
