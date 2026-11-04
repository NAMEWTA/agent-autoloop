// Protect against duplicate dispatch after lost RPC replies, screen text mistaken for a receipt, stale context,
// unsafe session reuse, overlapping directory writers, and acknowledging cancellation before a terminal stops.
import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  prepareTask,
  preparationFailure,
  runTask,
  runPreparedTask,
  recoverTask,
  stopTask,
} from "../plugins/herdr-core/task.ts";
import { acquireResources, acquireWriter } from "../plugins/herdr-core/store.ts";
import { submitReceipt } from "../plugins/herdr-core/receipt.ts";
import type { Turn } from "../plugins/herdr-core/types.ts";

const fixture = path.join(import.meta.dirname, "fixtures/fake-hc.mjs");

function setup(flags: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "aal-herdr-"));
  const cwd = path.join(dir, "project");
  mkdirSync(cwd);
  const home = path.join(dir, "home");
  mkdirSync(path.join(home, "herdr"), { recursive: true });
  const state = path.join(dir, "hc.json");
  writeFileSync(state, JSON.stringify(flags));
  writeFileSync(
    path.join(home, "herdr", "profiles.json"),
    JSON.stringify({
      profiles: {
        developer: {
          template: "aal-codex",
          access: "edit",
          hc: [process.execPath, fixture, "--state", state],
          session: "autoloop",
          rpcTimeoutMs: 1000,
          turnTimeoutMs: 120,
          monitorIntervalMs: 20,
        },
      },
    }),
  );
  const privateDir = path.join(home, "worker", "runs", "1");
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(path.join(privateDir, "entry.json"), JSON.stringify({ token: "SECRET_HUB_RUN_TOKEN" }));
  const contextFile = path.join(privateDir, "context.json");
  writeFileSync(contextFile, JSON.stringify({ events: [{ detail: "外部资料" }] }));
  const turn: Turn = {
    prompt: "完成这个任务。",
    session: "session-one",
    resume: null,
    cwd,
    access: "edit",
    contextFile,
    folder: privateDir,
    options: { profile: "developer" },
    execution: { run: 1, attempt: 1, turn: 1 },
  };
  const previous = process.env.AGENT_AUTOLOOP_HOME;
  process.env.AGENT_AUTOLOOP_HOME = home;
  return {
    dir,
    home,
    cwd,
    state,
    turn,
    read: () => JSON.parse(readFileSync(state, "utf8")),
    set: (patch: Record<string, unknown>) =>
      writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), ...patch })),
    calls: () =>
      readFileSync(`${state}.calls`, "utf8")
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x)),
    close: () => {
      if (previous === undefined) delete process.env.AGENT_AUTOLOOP_HOME;
      else process.env.AGENT_AUTOLOOP_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Herdr receipt completes once and resume updates context without recreating the terminal", async () => {
  const f = setup({ usage: { input: 7, output: 4 } });
  try {
    const result = await runTask(f.turn);
    assert.equal(result.finished, true);
    assert.equal(result.text, "完成了测试任务");
    assert.deepEqual(result.usage, { input: 7, output: 4 });
    const create = f.calls().find((c) => c.method === "terminal.run");
    assert.equal(create.params.keep, false);
    assert.equal(create.params.no_parent, true);
    assert.equal(create.params.no_notify, true);
    assert.deepEqual(create.params.env, { AGENT_AUTOLOOP_HOME: f.home, AGENT_AUTOLOOP_SESSION: f.turn.session });
    assert.equal(JSON.stringify(create).includes("SECRET_HUB_RUN_TOKEN"), false);
    assert.equal(JSON.stringify(create).includes(f.turn.folder), false);
    writeFileSync(f.turn.contextFile, JSON.stringify({ answers: [{ value: "第二轮答案" }] }));
    const next = { ...f.turn, resume: f.turn.session, execution: { run: 2, attempt: 1, turn: 1 } };
    const second = await runTask(next);
    assert.equal(second.finished, true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
    assert.equal(f.calls().filter((c) => c.method === "terminal.send").length, 1);
    const inbox = path.join(f.home, "herdr", "inbox");
    const dirs = readdirSync(inbox);
    assert.equal(dirs.length, 2);
    assert(dirs.some((d) => readFileSync(path.join(inbox, d, "context.json"), "utf8").includes("第二轮答案")));
    assert.equal((await recoverTask(next)).text, second.text);
  } finally {
    f.close();
  }
});

test("Herdr validates local profile and exact access before any dispatch", async () => {
  const f = setup();
  try {
    assert.throws(() => prepareTask({ ...f.turn, access: "full" }), /权限|access/);
    assert.throws(() => prepareTask({ ...f.turn, options: { profile: "missing" } }), /profile|配置/);
    assert.equal(readdirSync(path.dirname(f.state)).includes("hc.json.calls"), false);
  } finally {
    f.close();
  }
});

test("Herdr never treats status or screen-like text as a receipt and retains directory occupancy", async () => {
  const f = setup({ autoReceipt: false });
  try {
    const result = await runTask(f.turn);
    assert.equal(result.finished, undefined);
    assert.equal(result.state, "uncertain");
    const other = await runTask({ ...f.turn, session: "session-two", execution: { run: 2, attempt: 1, turn: 1 } });
    assert.equal(other.finished, true);
    assert.match(other.error!, /占用|等待/);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
    assert.equal(f.calls().filter((c) => c.method === "terminal.read").length, 0);
  } finally {
    f.close();
  }
});

test("Herdr recovers a lost send response from the same receipt without sending again", async () => {
  const f = setup();
  try {
    assert.equal((await runTask(f.turn)).finished, true);
    f.set({ dropAfterSend: true });
    const next = { ...f.turn, resume: f.turn.session, execution: { run: 2, attempt: 1, turn: 1 } };
    const result = await runTask(next);
    assert.equal(result.finished, undefined);
    assert.equal(result.state, "uncertain");
    assert.equal((await recoverTask(next)).state, "uncertain");
    const state = f.read();
    state.terminals[0].status = { state: "working" };
    f.set(state);
    await recoverTask(next);
    state.terminals[0].status = { state: "done" };
    state.terminals[0].turn++;
    f.set(state);
    assert.equal((await recoverTask(next)).finished, true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.send").length, 1);
  } finally {
    f.close();
  }
});

test("Herdr keeps failed first-message delivery uncertain without resending or recreating", async () => {
  const f = setup({ firstMessageFalse: true });
  try {
    assert.equal((await runTask(f.turn)).state, "uncertain");
    assert.equal((await recoverTask(f.turn)).state, "uncertain");
    assert.equal((await runTask(f.turn)).state, "uncertain");
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
    assert.equal(f.calls().filter((c) => c.method === "terminal.send").length, 0);
  } finally {
    f.close();
  }
});

test("Herdr cancellation confirms remote stop and rejects identity mismatch", async () => {
  const f = setup({ autoReceipt: false, killFails: true });
  try {
    await runTask(f.turn);
    assert.equal(await stopTask(f.turn, "cancel"), false);
    f.set({ killFails: false });
    assert.equal(await stopTask(f.turn, "cancel"), true);
    const before = f.calls().filter((c) => c.method === "terminal.kill").length;
    f.set({ coreId: "different-core" });
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.kill").length, before);
  } finally {
    f.close();
  }
});

test(
  "Herdr receipt helper binds exact nonce, refuses replacement, and does not trust non-reported status",
  async () => {
    const f = setup({ autoReceipt: false, reported: false });
    try {
      const taskPath = prepareTask(f.turn);
      const task = JSON.parse(readFileSync(taskPath, "utf8"));
      const requestPath = task.requestFile;
      submitReceipt(requestPath, { text: "完成了" });
      assert.throws(() => submitReceipt(requestPath, { text: "另一份回执" }), /回执|receipt/);
      const reading = await runTask(f.turn);
      assert.equal(reading.finished, undefined);
      assert.equal(reading.state, "uncertain");
    } finally {
      f.close();
    }
  },
);

test("Herdr completed idle terminal can be stopped without destroying its receipt", async () => {
  const f = setup();
  try {
    const before = await runTask(f.turn);
    assert.equal(before.finished, true);
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.equal(f.read().terminals[0].state, "finished");
    assert.deepEqual(await recoverTask(f.turn), before);
  } finally {
    f.close();
  }
});

test(
  "Herdr serializes concurrent observers of one task and refuses a receipt from an unchanged terminal turn",
  async () => {
    const f = setup({ autoReceipt: false });
    try {
      const [a, b] = await Promise.all([runTask(f.turn), runTask(f.turn)]);
      assert.equal(a.finished, undefined);
      assert.equal(b.finished, undefined);
      assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
      const task = JSON.parse(readFileSync(prepareTask(f.turn), "utf8"));
      submitReceipt(task.requestFile, { text: "完成了" });
      const state = f.read();
      state.terminals[0].status = { state: "done" };
      f.set(state);
      assert.equal((await recoverTask(f.turn)).finished, undefined);
      state.terminals[0].turn = 1;
      f.set(state);
      const recovered = await Promise.all([recoverTask(f.turn), recoverTask(f.turn)]);
      assert(recovered.some((r) => r.finished === true));
      assert.equal(f.calls().filter((c) => c.method === "terminal.send").length, 0);
    } finally {
      f.close();
    }
  },
);

test("Herdr stop request reaches a live bridge and is confirmed before releasing occupancy", async () => {
  const f = setup({ autoReceipt: false });
  try {
    const profileFile = path.join(f.home, "herdr", "profiles.json");
    const profiles = JSON.parse(readFileSync(profileFile, "utf8"));
    profiles.profiles.developer.turnTimeoutMs = 5000;
    writeFileSync(profileFile, JSON.stringify(profiles));
    const pending = runTask(f.turn);
    for (let i = 0; i < 100 && !f.read().terminals?.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await stopTask(f.turn, "cancel"), false);
    const result = await pending;
    assert.equal(result.state, "uncertain");
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.equal(f.read().terminals[0].state, "finished");
  } finally {
    f.close();
  }
});

test("Herdr does not invent an initial turn boundary when a run reply omits first_message.turn", async () => {
  const f = setup({ noFirstTurn: true });
  try {
    assert.equal((await runTask(f.turn)).finished, undefined);
    assert.equal((await recoverTask(f.turn)).state, "uncertain");
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
  } finally {
    f.close();
  }
});

test("Herdr reclaims only a dead observer lease and continues the same terminal after a killed bridge", async () => {
  const f = setup({ autoReceipt: false });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const pf = path.join(f.home, "herdr", "profiles.json");
    const profiles = JSON.parse(readFileSync(pf, "utf8"));
    profiles.profiles.developer.turnTimeoutMs = 10000;
    writeFileSync(pf, JSON.stringify(profiles));
    const file = prepareTask(f.turn);
    child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        path.join(import.meta.dirname, "../plugins/herdr-core/bridge.ts"),
        file,
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100 && JSON.parse(readFileSync(file, "utf8")).phase !== "observing"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "observing");
    const closed = once(child, "exit");
    child.kill("SIGKILL");
    await closed;
    assert.equal((await recoverTask(f.turn)).state, "running");
    const task = JSON.parse(readFileSync(file, "utf8"));
    submitReceipt(task.requestFile, { text: "业务已经完成，只恢复结果" });
    const state = f.read();
    state.terminals[0].status = { state: "done" };
    state.terminals[0].turn++;
    f.set(state);
    assert.equal((await recoverTask(f.turn)).text, "业务已经完成，只恢复结果");
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
    assert.equal(f.calls().filter((c) => c.method === "terminal.send").length, 0);
    f.set({ autoReceipt: true });
    assert.equal(
      (await runTask({ ...f.turn, resume: f.turn.session, execution: { run: 2, attempt: 1, turn: 1 } })).finished,
      true,
    );
  } finally {
    child?.kill("SIGKILL");
    f.close();
  }
});

test("Herdr never sends or kills when the core identity changed beneath a pending execution", async () => {
  const f = setup({ autoReceipt: false });
  try {
    await runTask(f.turn);
    f.set({ coreId: "new-core" });
    assert.equal((await recoverTask(f.turn)).state, "uncertain");
    assert.equal(await stopTask(f.turn, "cancel"), false);
    assert.equal(f.calls().filter((c) => c.method === "terminal.kill").length, 0);
  } finally {
    f.close();
  }
});

test("Herdr rejects a request file changed after dispatch even when a receipt copies its new nonce", async () => {
  const f = setup({ autoReceipt: false });
  try {
    await runTask(f.turn);
    const task = JSON.parse(readFileSync(prepareTask(f.turn), "utf8"));
    const req = JSON.parse(readFileSync(task.requestFile, "utf8"));
    req.nonce = "a-different-nonce-that-is-long-enough";
    writeFileSync(task.requestFile, JSON.stringify(req));
    submitReceipt(task.requestFile, { text: "不应采纳" });
    const state = f.read();
    state.terminals[0].status = { state: "done" };
    state.terminals[0].turn++;
    f.set(state);
    const recovered = await recoverTask(f.turn);
    assert.equal(recovered.finished, undefined);
    assert.equal(recovered.state, "uncertain");
  } finally {
    f.close();
  }
});

test(
  "Herdr reports safe pre-dispatch failure as finished but keeps conflicts with a live execution uncertain",
  async () => {
    const f = setup({ noTemplate: true });
    try {
      const safe = await runTask(f.turn);
      assert.equal(safe.finished, true);
      assert.match(safe.error!, /template/);
      assert.equal((await recoverTask(f.turn)).finished, true);
      assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 0);
      f.set({ noTemplate: false, autoReceipt: false });
      const active = { ...f.turn, execution: { run: 2, attempt: 1, turn: 1 } };
      await runTask(active);
      const changed = await runTask({ ...active, prompt: "发生变化的提示词" });
      assert.equal(changed.finished, undefined);
      assert.equal(changed.state, "uncertain");
    } finally {
      f.close();
    }
  },
);

test("Herdr binds the response file to the dedicated request inbox", async () => {
  const f = setup();
  try {
    assert.equal((await runTask(f.turn)).finished, true);
    const task = JSON.parse(readFileSync(prepareTask(f.turn), "utf8"));
    const request = JSON.parse(readFileSync(task.requestFile, "utf8"));
    assert.equal(request.responseFile, path.join(path.dirname(task.requestFile), "response.json"));
    const dispatched = f.calls().find((c) => c.method === "terminal.run").params.argv[1];
    assert(dispatched.includes(JSON.stringify(request.responseFile)));
    assert.equal(dispatched.includes("<response.json>"), false);
  } finally {
    f.close();
  }
});

test("Herdr preserves UTF-8 when RPC replies split a multi-byte character", async () => {
  const f = setup({ splitUtf8: true });
  try {
    const cwd = path.join(f.dir, "开发目录");
    mkdirSync(cwd);
    const result = await runTask({ ...f.turn, cwd });
    assert.equal(result.finished, true);
    assert.equal(result.text, "完成了测试任务");
  } finally {
    f.close();
  }
});

test("Herdr re-reads task state under the lease before sending a prepared snapshot", async () => {
  const f = setup();
  const original = fs.readFileSync;
  try {
    const file = prepareTask(f.turn);
    const stale = readFileSync(file, "utf8");
    assert.equal((await runTask(f.turn)).finished, true);
    let intercepted = false;
    fs.readFileSync = ((p: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (!intercepted && String(p) === file) {
        intercepted = true;
        fs.readFileSync = original;
        syncBuiltinESMExports();
        return stale;
      }
      return Reflect.apply(original, fs, [p, ...args]);
    }) as typeof readFileSync;
    syncBuiltinESMExports();
    assert.equal((await runPreparedTask(file)).finished, true);
    assert.equal(intercepted, true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.send").length, 0);
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
    f.close();
  }
});

test("Herdr confirms a never-dispatched failure can be stopped without changing its receipt", async () => {
  const f = setup({ noTemplate: true });
  try {
    const failed = await runTask(f.turn);
    assert.equal(failed.finished, true);
    assert(failed.error);
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.deepEqual(await recoverTask(f.turn), failed);
    assert.equal(f.calls().filter((c) => c.method === "terminal.kill").length, 0);
  } finally {
    f.close();
  }
});

test("Herdr original dispatch waits for a temporary observer lease and re-reads afterwards", async () => {
  const f = setup();
  try {
    const file = prepareTask(f.turn);
    const task = JSON.parse(readFileSync(file, "utf8"));
    const release = acquireWriter(task);
    const pending = runPreparedTask(file);
    setTimeout(release, 30);
    assert.equal((await pending).finished, true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
  } finally {
    f.close();
  }
});

test("Herdr queues an original prepared task until the previous cwd owner completes", async () => {
  const f = setup({ autoReceipt: false });
  try {
    const pf = path.join(f.home, "herdr", "profiles.json");
    const config = JSON.parse(readFileSync(pf, "utf8"));
    config.profiles.developer.turnTimeoutMs = 2000;
    writeFileSync(pf, JSON.stringify(config));
    const first = runTask(f.turn);
    const file = prepareTask(f.turn);
    for (let i = 0; i < 100 && JSON.parse(readFileSync(file, "utf8")).phase !== "observing"; i++)
      await new Promise((r) => setTimeout(r, 10));
    const second = runTask({ ...f.turn, session: "session-queued", execution: { run: 2, attempt: 1, turn: 1 } });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
    const task = JSON.parse(readFileSync(file, "utf8"));
    submitReceipt(task.requestFile, { text: "已释放目录" });
    const state = f.read();
    state.terminals[0].status = { state: "done" };
    state.terminals[0].turn++;
    state.autoReceipt = true;
    f.set(state);
    assert.equal((await first).finished, true);
    assert.equal((await second).finished, true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 2);
  } finally {
    f.close();
  }
});

test("Herdr preserves a stop fence recorded before task preparation", async () => {
  const f = setup();
  try {
    assert.equal(await stopTask(f.turn, "cancel"), true);
    const result = await runTask(f.turn);
    assert.equal(result.finished, undefined);
    assert.equal(result.state, "uncertain");
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.equal(
      readdirSync(f.dir).includes("hc.json.calls") && f.calls().some((c) => c.method === "terminal.run"),
      false,
    );
  } finally {
    f.close();
  }
});

test("Herdr confirms an owned finished terminal after losing its creation response", async () => {
  const f = setup({ autoReceipt: false, dropAfterRun: true });
  try {
    assert.equal((await runTask(f.turn)).state, "uncertain");
    const state = f.read();
    state.terminals[0].state = "finished";
    state.terminals[0].status = null;
    f.set(state);
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
    assert.equal(f.calls().filter((c) => c.method === "terminal.kill").length, 0);
  } finally {
    f.close();
  }
});

function childTurn(f: ReturnType<typeof setup>, suffix: string): Turn {
  const cwd = path.join(f.dir, `child-${suffix}`);
  mkdirSync(cwd);
  return {
    ...f.turn,
    session: `child-${suffix}`,
    cwd,
    parentSession: f.turn.session,
    execution: { run: 1, attempt: 1, turn: 1 },
  };
}

function finish(f: ReturnType<typeof setup>, turn: Turn, text: string) {
  const task = JSON.parse(readFileSync(prepareTask(turn), "utf8"));
  submitReceipt(task.requestFile, { text });
  const state = f.read();
  const terminal = state.terminals.find(
    (t: { labels: Record<string, string> }) => t.labels["autoloop.initial-task"] === task.id,
  );
  terminal.status = { state: "done" };
  terminal.turn++;
  f.set(state);
}

test("Herdr parent receipt waits for its registered child and parent stop closes idle children first", async () => {
  const f = setup({ autoReceipt: false });
  try {
    assert.equal((await runTask(f.turn)).state, "uncertain");
    const child = childTurn(f, "owned");
    assert.equal((await runTask(child)).state, "uncertain");
    finish(f, f.turn, "父结果");
    const waiting = await recoverTask(f.turn);
    assert.equal(waiting.finished, undefined);
    assert.equal(waiting.state, "uncertain");
    finish(f, child, "子结果");
    assert.equal((await recoverTask(child)).finished, true);
    assert.equal((await recoverTask(f.turn)).finished, true);
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.deepEqual(f.calls().filter((c) => c.method === "terminal.kill").map((c) => c.params.terminal), ["t2", "t1"]);
  } finally {
    f.close();
  }
});

test("Herdr registers a child before the parent creation response and freezes the current parent task", async () => {
  const f = setup({ autoReceipt: false, delayRunReplyMs: 180 });
  try {
    const parent = runTask(f.turn);
    const parentFile = prepareTask(f.turn);
    for (let i = 0; i < 100 && !f.read().terminals?.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(JSON.parse(readFileSync(parentFile, "utf8")).phase, "creating");
    const child = childTurn(f, "early");
    const childFile = prepareTask(child);
    const record = JSON.parse(readFileSync(childFile, "utf8"));
    assert.deepEqual(record.parent, { session: f.turn.session, task: JSON.parse(readFileSync(parentFile, "utf8")).id });
    await parent;
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.equal((await runTask(child)).finished, undefined);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
  } finally {
    f.close();
  }
});

test("Herdr parent stop fences a child creation in flight and waits for confirmed child stop", async () => {
  const f = setup({ autoReceipt: false });
  try {
    await runTask(f.turn);
    f.set({ delayRunReplyMs: 180 });
    const child = childTurn(f, "racing");
    const pending = runTask(child);
    for (let i = 0; i < 100 && (f.read().terminals?.length ?? 0) < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(await stopTask(f.turn, "cancel"), false);
    assert.equal(f.read().terminals[0].state, "live");
    await pending;
    assert.equal(await stopTask(f.turn, "cancel"), true);
    assert.deepEqual(f.calls().filter((c) => c.method === "terminal.kill").map((c) => c.params.terminal), ["t2", "t1"]);
    const late = await runTask(childTurn(f, "late"));
    assert.equal(late.finished, true);
    assert(late.error);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 2);
  } finally {
    f.close();
  }
});

test("Herdr resolves child ownership from the current resumed parent turn", async () => {
  const f = setup();
  try {
    assert.equal((await runTask(f.turn)).finished, true);
    f.set({ autoReceipt: false });
    const parent = { ...f.turn, resume: f.turn.session, execution: { run: 2, attempt: 1, turn: 1 } };
    await runTask(parent);
    const child = childTurn(f, "resumed");
    const file = prepareTask(child);
    const task = JSON.parse(readFileSync(file, "utf8"));
    const expected = JSON.parse(readFileSync(prepareTask(parent), "utf8"));
    assert.equal(task.parent.task, expected.id);
    assert.equal(await stopTask(parent, "cancel"), true);
  } finally {
    f.close();
  }
});


test("Herdr keeps a preparation failure terminal for the same identity until a new attempt", async () => {
  const f = setup();
  try {
    const turn = { ...f.turn, options: { profile: "missing" } };
    const failed = await runTask(turn);
    assert.equal(failed.finished, true);
    assert(failed.error);
    const profileFile = path.join(f.home, "herdr", "profiles.json");
    const profiles = JSON.parse(readFileSync(profileFile, "utf8"));
    profiles.profiles.missing = profiles.profiles.developer;
    writeFileSync(profileFile, JSON.stringify(profiles));
    assert.deepEqual(await runTask(turn), failed);
    assert.equal(fs.existsSync(`${f.state}.calls`), false);
    const retry = await runTask({ ...turn, execution: { run: 1, attempt: 2, turn: 1 } });
    assert.equal(retry.finished, true);
    assert.equal(retry.text, "完成了测试任务");
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
  } finally {
    f.close();
  }
});

test("Herdr cannot declare a preparation failure while another writer owns the task", async () => {
  const f = setup();
  try {
    const file = prepareTask(f.turn);
    const task = JSON.parse(readFileSync(file, "utf8"));
    const release = acquireWriter(task);
    try {
      const reading = preparationFailure(f.turn, new Error("concurrent preparation failure"));
      assert.equal(reading.finished, undefined);
      assert.equal(reading.state, "uncertain");
    } finally {
      release();
    }
    assert.equal((await runTask(f.turn)).finished, true);
    assert.equal(f.calls().filter((c) => c.method === "terminal.run").length, 1);
  } finally {
    f.close();
  }
});

test("Herdr pre-dispatch stop releases occupancy left by a dead bridge", async () => {
  const f = setup();
  try {
    const task = JSON.parse(readFileSync(prepareTask(f.turn), "utf8"));
    acquireResources(task)(false);
    assert.equal(await stopTask(f.turn, "cancel"), true);
    const next = await runTask({ ...f.turn, session: "after-cancel", execution: { run: 2, attempt: 1, turn: 1 } });
    assert.equal(next.finished, true);
    assert.equal(next.error, undefined);
    assert.equal(f.calls().filter((call) => call.method === "terminal.run").length, 1);
  } finally {
    f.close();
  }
});

test("Herdr parent recovery reconciles a finished child after its bridge was killed without re-sending", async () => {
  const f = setup({ autoReceipt: false });
  let bridge: ReturnType<typeof spawn> | undefined;
  try {
    assert.equal((await runTask(f.turn)).state, "uncertain");
    const profileFile = path.join(f.home, "herdr", "profiles.json");
    const profiles = JSON.parse(readFileSync(profileFile, "utf8"));
    profiles.profiles.child = { ...profiles.profiles.developer, turnTimeoutMs: 10000 };
    writeFileSync(profileFile, JSON.stringify(profiles));
    const child = { ...childTurn(f, "killed-bridge"), options: { profile: "child" } };
    const file = prepareTask(child);
    bridge = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        path.join(import.meta.dirname, "../plugins/herdr-core/bridge.ts"),
        file,
      ],
      { stdio: "ignore" },
    );
    for (let i = 0; i < 100 && JSON.parse(readFileSync(file, "utf8")).phase !== "observing"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "observing");
    const closed = once(bridge, "exit");
    bridge.kill("SIGKILL");
    await closed;
    finish(f, child, "子结果");
    finish(f, f.turn, "父结果");
    const reading = await recoverTask(f.turn);
    assert.equal(reading.finished, true);
    assert.equal(reading.text, "父结果");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "completed");
    assert.equal(f.calls().filter((call) => call.method === "terminal.run").length, 2);
    assert.equal(f.calls().filter((call) => call.method === "terminal.send").length, 0);
  } finally {
    bridge?.kill("SIGKILL");
    f.close();
  }
});
