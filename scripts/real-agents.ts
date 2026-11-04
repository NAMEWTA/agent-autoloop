// Failure modes: a real CLI never finishes; a receipt is unreadable; the answer loses the session; cleanup leaves a child
// process or a test database. The selected trusted profile owns CLI policy; all launches share a three-turn ceiling.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import type { Turn } from "../worker/agents.ts";
import { homedir, tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const profileName = process.argv[2];
assert.ok(profileName, "用法：node scripts/real-agents.ts <本机已验收的 profile>");
const profiles = JSON.parse(readFileSync(join(process.env.AGENT_AUTOLOOP_HOME ?? join(homedir(), ".agent-autoloop"), "herdr", "profiles.json"), "utf8"));
const profile = profiles.profiles?.[profileName];
assert.ok(profile && ["read", "edit", "full"].includes(profile.access), "profile 不存在或 access 不正确");
const use = "herdr-core";
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-real-herdr-"));
mkdirSync(join(home, "herdr"));
writeFileSync(join(home, "herdr", "profiles.json"), JSON.stringify({ profiles: { [profileName]: profile } }), { mode: 0o600 });
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
mkdirSync(join(home, "work"));
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    sources: { app: { name: "试跑" } },
    agents: {
      real: {
        name: use,
        worker: "test",
        use,
        access: profile.access,
        timeout: 3,
        options: { profile: profileName },
      },
    },
    channels: {},
    rules: [
      {
        name: "试跑",
        when: { source: "app", types: ["test"] },
        to: "real",
        cwd: join(home, "work"),
        prompt:
          '这是有限的接入测试，只读给出的资料文件，不执行其他动作。answers 为空时，第一行只写“问了一个问题”，附 agent-autoloop 代码块 {"ask":[{"title":"选一个颜色","text":"试跑","options":["蓝色","绿色"],"key":"color"}]}。answers 不为空时，最后一条消息只写“你选了绿色，试跑通过”，不要再提问。',
      },
    ],
  }),
);
const { adapterFor } = await import("../worker/agents.ts");
const adapter = await adapterFor(use);
const launch = adapter.command;
let launches = 0;
const launched = new Map<string, Turn>();
adapter.command = (turn) => {
  assert.ok(++launches <= 3, "已用完三轮额度");
  launched.set(turn.resume ?? turn.session, turn);
  return launch(turn);
};
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const server = serve(0);
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const owner = hubClient(url, hub.addKey("owner", "me"));
const source = hubClient(url, hub.addKey("source", "app"));
const worker = createWorker({ hub: hubClient(url, hub.addKey("worker", "test")), name: "test", wait: 0, capacity: 1 });
const started = Date.now();
async function until(predicate: (s: any) => boolean) {
  while (Date.now() - started < 240000) {
    await worker.tick();
    const state = await owner.state();
    const failed = state.runs.find((r: any) => r.state === "failed" || r.error);
    if (failed) throw new Error(failed.error ?? JSON.stringify(failed));
    if (predicate(state)) return state;
    await delay(200);
  }
  throw new Error("真机试跑超过四分钟");
}
try {
  const problem = adapter.check?.({ profile: profileName });
  if (problem) throw new Error(problem);
  await source.event({ id: "real", type: "test" });
  const waiting = await until((s) => s.cards.some((c: any) => c.kind === "ask"));
  await owner.answer(waiting.cards[0].id, { choice: 1 });
  const finished = await until((s) =>
    s.runs.some((r: any) => r.state === "done" && r.summary === "你选了绿色，试跑通过"),
  );
  const runs = finished.runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].session, runs[1].session);
  assert.ok(runs[0].session);
  console.log(
    JSON.stringify(
      {
        machine: cpus()[0].model,
        node: process.version,
        agent: use,
        profile: profileName,
        launches,
        runs: runs.length,
        resumed: true,
        ms: Date.now() - started,
        usage: runs.map((r: any) => r.usage),
      },
      null,
      2,
    ),
  );
} finally {
  let confirmed = true;
  for (const turn of launched.values()) {
    const stopped = await adapter.stop?.(turn, "cancel").catch(() => false);
    if (!stopped) confirmed = false;
  }
  for (const entry of worker.entries())
    if (confirmed && entry.pid) {
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {}
    }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  hub.db.close();
  if (confirmed) rmSync(home, { recursive: true, force: true });
  else throw new Error(`尚未确认测试终端结束，恢复资料保留在 ${home}；请检查后停止该测试会话`);
}
