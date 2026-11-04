// Cross the actual hub/worker/plugin boundary: a business ask must release the round, and the answer must reach
// the same native terminal with fresh context. A fake hc replaces only the external terminal service/model.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import type { Adapter } from "../worker/agents.ts";
import herdr from "../plugins/herdr-core/agent.ts";
import script from "../plugins/script/agent.ts";

const adapters: Adapter[] = [herdr, script];
assert.equal(adapters.length, 2);
const home = setup("runtime-loop");
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const cwd = join(home, "project");
mkdirSync(cwd);
mkdirSync(join(home, "herdr"));
const runtimeState = join(home, "fake-hc.json");
const question =
  '问了一个问题\n\n```agent-autoloop\n{"ask":[{"title":"选一个颜色","text":"试跑","options":["蓝色","绿色"],"key":"color"}]}\n```';
writeFileSync(runtimeState, JSON.stringify({ text: question }));
writeFileSync(
  join(home, "herdr", "profiles.json"),
  JSON.stringify({
    profiles: {
      developer: {
        template: "aal-codex",
        access: "edit",
        session: "autoloop-test",
        hc: [process.execPath, join(import.meta.dirname, "fixtures/fake-hc.mjs"), "--state", runtimeState],
        rpcTimeoutMs: 2000,
        turnTimeoutMs: 5000,
        monitorIntervalMs: 20,
      },
    },
  }),
);
writeFileSync(
  join(home, "rules.json"),
  JSON.stringify({
    sources: { app: { name: "测试" } },
    agents: { agent: { name: "Herdr", worker: "test", use: "herdr-core", options: { profile: "developer" } } },
    channels: {},
    rules: [
      { name: "业务闭环", when: { source: "app", types: ["start"] }, to: "agent", cwd, prompt: "读本轮资料；确认后继续。" },
    ],
  }),
);
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");

test("Herdr business ask and answer use one terminal through the real hub and worker", async () => {
  const server = serve(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = hubClient(url, hub.addKey("owner", "owner"));
  const source = hubClient(url, hub.addKey("source", "app"));
  const worker = createWorker({ hub: hubClient(url, hub.addKey("worker", "test")), name: "test", wait: 0, capacity: 1 });
  async function until(check: (state: any) => boolean) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await worker.tick();
      const state = await owner.state();
      assert.equal(state.runs.some((run: any) => run.state === "failed"), false, JSON.stringify(state.runs));
      if (check(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pending = worker.entries().map((entry: any) => ({
      run: entry.run,
      turn: entry.turn,
      state: entry.state,
      error: entry.recoveryError,
    }));
    const methods = readFileSync(`${runtimeState}.calls`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    assert.fail(`loop did not finish: ${JSON.stringify({ pending, methods })}`);
  }
  let session: string | undefined;
  try {
    await source.event({ id: "one-task", type: "start" });
    const waiting = await until((state) => state.cards.some((card: any) => card.kind === "ask"));
    assert.equal(waiting.runs[0].state, "done");
    assert.equal(worker.entries().length, 0, "the human decision does not retain an active worker round");
    session = waiting.runs[0].session;
    const state = JSON.parse(readFileSync(runtimeState, "utf8"));
    assert.equal(state.terminals[0].state, "live", "the native terminal remains available");
    writeFileSync(runtimeState, JSON.stringify({ ...state, text: "你选了绿色，完成了" }));
    await owner.answer(waiting.cards[0].id, { choice: 1 });
    const done = await until((now) => now.runs.filter((run: any) => run.state === "done").length === 2);
    assert.equal(done.cards.length, 0);
    assert.ok(done.runs.every((run: any) => run.session === session));
    const calls = readFileSync(`${runtimeState}.calls`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.method === "terminal.run").length, 1);
    const sends = calls.filter((call) => call.method === "terminal.send");
    assert.equal(sends.length, 1);
    const requestFile = JSON.parse(/^AUTOLOOP_REQUEST=(.+)$/m.exec(sends[0].params.text)![1]);
    const request = JSON.parse(readFileSync(requestFile, "utf8"));
    const context = JSON.parse(readFileSync(request.contextFile, "utf8"));
    assert.equal(context.answers[0].choice, 1);
  } finally {
    if (session) await herdr.control(["stop", session]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    hub.db.close();
  }
});
