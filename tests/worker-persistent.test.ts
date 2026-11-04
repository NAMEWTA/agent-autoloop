// Failure modes: a dead bridge is mistaken for ended remote work; an uncertain run is retried or continues
// heartbeating as healthy; cancellation only kills the bridge; restart loses the token or re-sends a prompt;
// a linkless resumable adapter cannot repair its receipt; recovery polling double-counts usage.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Job } from "../protocol/job.ts";
import { setup } from "./helpers.ts";

const home = setup("worker-persistent");
const project = join(home, "project");
mkdirSync(project);
process.env.SHELL = "/bin/sh";
const { createWorker, requestRecoveryStop } = await import("../worker/worker.ts");
const plugin = join(home, "plugins", "persistent-fixture");
mkdirSync(plugin, { recursive: true });
writeFileSync(
  join(plugin, "agent.ts"),
  `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export default {
  capabilities: { resume: true, persistent: true },
  command(turn) {
    appendFileSync(join(turn.folder, "launches.jsonl"), JSON.stringify(turn) + "\\n");
    const script = turn.options?.hang
      ? "process.stdout.write(" + JSON.stringify(JSON.stringify(turn.options.reading ?? { state: "running" })) + ");setInterval(() => {}, 1000)"
      : "process.exit(7)";
    return [process.execPath, "-e", script];
  },
  read(stdout) { try { return JSON.parse(stdout); } catch { return { error: "bridge connection lost", finished: true }; } },
  async recover(turn) {
    appendFileSync(join(turn.folder, "recoveries.jsonl"), JSON.stringify(turn) + "\\n");
    const file = join(turn.folder, "recover-" + turn.execution.turn + ".json");
    if (!existsSync(file)) return { state: "uncertain", error: "runtime unavailable" };
    const reading = JSON.parse(readFileSync(file, "utf8"));
    if (reading.throw) throw new Error("runtime unavailable");
    return reading;
  },
  async stop(turn, reason) {
    appendFileSync(join(turn.folder, "stops.jsonl"), JSON.stringify({ execution: turn.execution, reason }) + "\\n");
    const file = join(turn.folder, "stop.json");
    return existsSync(file) && JSON.parse(readFileSync(file, "utf8")) === true;
  },
};`,
);

let nextRun = 1;
function job(options: Record<string, unknown> = {}, session: string | null = null): Job {
  return {
    run: nextRun++,
    token: `retained-token-${nextRun}`,
    attempt: 1,
    session,
    askFirst: [],
    rule: { name: "开发", cwd: project, prompt: "完成这次任务。" },
    agent: { id: "a", name: "开发", use: "persistent-fixture", access: "edit", options } as Job["agent"],
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}
const directory = (given: Job) => join(home, "worker", "runs", `${given.run}-${given.attempt}`);
function control(given: Job, reading: object, turn = 1) {
  mkdirSync(directory(given), { recursive: true });
  writeFileSync(join(directory(given), `recover-${turn}.json`), JSON.stringify(reading));
}
function lines(given: Job, file: string): any[] {
  const target = join(directory(given), file);
  return existsSync(target) ? readFileSync(target, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function fakeHub() {
  const hub = {
    jobs: [] as Job[],
    cancel: [] as number[],
    results: [] as any[],
    starts: [] as any[],
    claims: [] as any[],
    async work(query: any) {
      hub.claims.push(query);
      const cancel = hub.cancel.splice(0);
      return { job: query.capacity ? hub.jobs.shift() ?? null : null, cancel };
    },
    async started(run: number, token: string, body: object) {
      hub.starts.push({ run, token, ...body });
      return {};
    },
    async result(run: number, token: string, body: object) {
      hub.results.push({ run, token, ...body });
      return {};
    },
  };
  return hub;
}
const worker = (hub: ReturnType<typeof fakeHub>, extra: object = {}) =>
  createWorker({ hub: hub as any, name: "persistent-worker", wait: 0, ...extra });
async function until(w: { tick(): Promise<boolean> }, done: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, "worker did not reach the expected state");
    await w.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("bridge exit recovers the same running execution without re-sending, then submits its receipt once", async () => {
  const hub = fakeHub();
  const given = job({ template: "developer", terminal: { family: "interactive" } });
  control(given, { state: "running", session: "opaque-session", usage: { input: 2, output: 1 } });
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => lines(given, "recoveries.jsonl").length >= 2);
  assert.equal(hub.results.length, 0);
  assert.equal(lines(given, "launches.jsonl").length, 1);
  assert.deepEqual(hub.claims.at(-1).running, [given.run]);
  assert.ok(hub.starts.some((start) => start.session === "opaque-session" && start.link === undefined));
  const input = lines(given, "launches.jsonl")[0];
  assert.deepEqual(input.execution, { run: given.run, attempt: 1, turn: 1 });
  assert.deepEqual(input.options, (given.agent as any).options);
  assert.deepEqual(lines(given, "recoveries.jsonl")[0], input, "recovery uses the saved launch input");
  control(given, { text: "完成了开发", session: "opaque-session", finished: true, usage: { input: 5, output: 3 } });
  await until(w, () => hub.results.length === 1);
  assert.deepEqual(hub.results[0], {
    run: given.run, token: given.token, outcome: "done", summary: "完成了开发", session: "opaque-session", usage: { input: 5, output: 3 },
  });
});

test("uncertainty survives restart, withholds the heartbeat and capacity, and retains the issued token", async () => {
  const hub = fakeHub();
  const given = job();
  control(given, { throw: true });
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => lines(given, "recoveries.jsonl").length > 0);
  assert.equal(hub.results.length, 0);
  assert.equal((w.entries()[0] as any).state, "uncertain");
  assert.deepEqual(hub.claims.at(-1).running, []);
  assert.equal(hub.claims.at(-1).capacity, false);
  const next = job();
  control(next, { text: "后续任务完成", finished: true });
  hub.jobs.push(next);
  const restarted = worker(hub);
  await restarted.tick();
  assert.equal(hub.jobs.length, 1, "uncertain work must not release the worker for another job");
  assert.equal(restarted.entries()[0].token, given.token);
  assert.equal(lines(given, "launches.jsonl").length, 1);
  control(given, { text: "恢复了原来的结果", session: "same-session", finished: true });
  await until(restarted, () => hub.results.length === 2);
  assert.equal(hub.results[0].token, given.token);
  assert.equal(hub.results[0].outcome, "done");
  assert.equal(lines(given, "launches.jsonl").length, 1);
});

test("an unconfirmed recovery cannot turn an unknown remote execution into a terminal result", async () => {
  const hub = fakeHub();
  const given = job();
  control(given, {});
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => lines(given, "recoveries.jsonl").length > 0);
  assert.equal(hub.results.length, 0);
  assert.equal((w.entries()[0] as any).state, "uncertain");
  for (const reading of [{ text: "尚未确认的文本" }, { error: "只知道观察连接失败" }]) {
    control(given, reading);
    await w.tick();
    assert.equal(hub.results.length, 0, "text or an observer error alone does not confirm completion");
    assert.equal((w.entries()[0] as any).state, "uncertain");
  }
  control(given, { text: "已核实完成", finished: true });
  await until(w, () => hub.results.length === 1);
});

test("persistent resume failures never launch a fresh conversation", async () => {
  const hub = fakeHub();
  const given = job({}, "existing-session");
  control(given, { error: "会话已确认不可用", finished: true });
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => hub.results.length === 1);
  assert.equal(hub.results[0].outcome, "failed");
  assert.equal(lines(given, "launches.jsonl").length, 1, "business work must not be started from scratch");
  assert.equal(lines(given, "launches.jsonl")[0].resume, "existing-session");
});

for (const reason of ["cancel", "timeout"] as const) {
  test(`${reason} waits for the adapter to confirm remote stop, including after worker restart`, async () => {
    const hub = fakeHub();
    const given = job();
    given.agent.timeout = 1;
    control(given, { state: "running", session: "remote-session" });
    hub.jobs.push(given);
    let clock = 1_000;
    const w = worker(hub, { now: () => clock });
    await until(w, () => lines(given, "recoveries.jsonl").length > 0);
    if (reason === "cancel") hub.cancel.push(given.run);
    else clock += 61_000;
    await w.tick();
    await w.tick();
    assert.equal(hub.results.length, 0, "killing or losing a bridge is not confirmation of remote stop");
    assert.equal((w.entries()[0] as any).state, "uncertain");
    const restarted = worker(hub, { now: () => clock });
    await restarted.tick();
    assert.equal(hub.results.length, 0);
    writeFileSync(join(directory(given), "stop.json"), "true");
    await until(restarted, () => hub.results.length === 1);
    assert.equal(hub.results[0].token, given.token);
    assert.equal(hub.results[0].outcome, reason === "cancel" ? "cancelled" : "failed");
    assert.match(hub.results[0].summary ?? hub.results[0].error, /已停止/);
    assert.ok(lines(given, "stops.jsonl").every((call) => call.reason === reason));
    assert.equal(lines(given, "launches.jsonl").length, 1);
  });
}

test("a linkless resume capability repairs only the receipt with a new turn identity", async () => {
  const hub = fakeHub();
  const given = job({ template: "developer" });
  control(given, { text: "业务完成\n```agent-autoloop\n{bad\n```", session: "repair-session", finished: true, usage: { input: 3 } });
  control(given, { text: '业务完成\n```agent-autoloop\n{"notice":[{"title":"完成","text":"开发完成"}]}\n```', session: "repair-session", finished: true, usage: { input: 2 } }, 2);
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => hub.results.length === 1);
  assert.equal(hub.results[0].outcome, "done");
  assert.equal(hub.results[0].notice[0].title, "完成");
  assert.deepEqual(hub.results[0].usage, { input: 5 });
  const launches = lines(given, "launches.jsonl");
  assert.equal(launches.length, 2);
  assert.equal(launches[1].resume, "repair-session");
  assert.deepEqual(launches[1].execution, { run: given.run, attempt: 1, turn: 2 });
  assert.deepEqual(launches[1].options, launches[0].options);
  assert.match(launches[1].prompt, /不要重做/);
  assert.match(launches[1].prompt, /本地回执提交器/);
});

test("a failed recovered receipt repair preserves the original business outcome", async () => {
  const hub = fakeHub();
  const given = job();
  control(given, { text: "业务完成\n```agent-autoloop\n{bad\n```", session: "repair-session", finished: true });
  control(given, { error: "这次格式修复未成功", finished: true }, 2);
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => hub.results.length === 1);
  assert.equal(hub.results[0].outcome, "done");
  assert.equal(hub.results[0].summary, "业务完成");
  assert.match(hub.results[0].notice[0].title, /回执读不懂/);
  assert.match(readFileSync(join(directory(given), "receipt-1.txt"), "utf8"), /业务完成/);
  assert.equal(lines(given, "launches.jsonl").length, 2);
});


test("a local stop request for an unknown run is bound to its retained token and produces cancellation", async () => {
  const hub = fakeHub();
  const given = job();
  control(given, { state: "uncertain", error: "运行服务暂时离线" });
  hub.jobs.push(given);
  const w = worker(hub);
  await until(w, () => lines(given, "recoveries.jsonl").length > 0);
  writeFileSync(join(directory(given), "cancel.request"), JSON.stringify({ run: given.run, attempt: 1, token: "stale-token" }));
  await w.tick();
  assert.equal(lines(given, "stops.jsonl").length, 0, "another lease cannot request this stop");
  assert.equal(requestRecoveryStop(given.run), true);
  await w.tick();
  assert.equal(hub.results.length, 0);
  assert.ok(lines(given, "stops.jsonl").length > 0);
  writeFileSync(join(directory(given), "stop.json"), "true");
  await until(w, () => hub.results.length === 1);
  assert.equal(hub.results[0].outcome, "cancelled");
  assert.equal(hub.results[0].token, given.token);
  assert.equal(requestRecoveryStop(given.run), false, "settled executions cannot be cancelled locally");
});


test("a persistent completion marker without a receipt cannot trigger grace termination or completion", async () => {
  const hub = fakeHub();
  const given = job({ hang: true, reading: { finished: true, session: "marker-only" } });
  hub.jobs.push(given);
  let clock = 1_000;
  const w = worker(hub, { now: () => clock });
  await until(w, () => hub.starts.some((start) => start.session === "marker-only"));
  const pid = w.entries()[0].pid;
  try {
    clock += 31_000;
    await w.tick();
    await w.tick();
    assert.equal(hub.results.length, 0);
    assert.equal(w.entries()[0].stopping, undefined);
    assert.equal(lines(given, "stops.jsonl").length, 0);
    assert.equal((w.entries()[0] as any).state, "uncertain");
    hub.cancel.push(given.run);
    writeFileSync(join(directory(given), "stop.json"), "true");
    await until(w, () => hub.results.length === 1);
    assert.equal(hub.results[0].outcome, "cancelled");
  } finally {
    try { if (pid) process.kill(-pid, "SIGKILL"); } catch {}
  }
});
