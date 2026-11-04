// Failure modes: scope becomes shell syntax; a follow-up starts a different logical session; untrusted URL/session
// reaches the runtime; incomplete execution is called successful or retried; a copied recipe depends on source-relative imports.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "autoloop-browser-template-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const dir = mkdtempSync(join(root, "case-"));
  copyFileSync(join(import.meta.dirname, "../examples/recipes/browser-handoff/handoff.ts"), join(dir, "handoff.ts"));
  const app = join(dir, "installed app");
  mkdirSync(join(app, "plugins/herdr-core"), { recursive: true });
  writeFileSync(
    join(app, "plugins/herdr-core/task.ts"),
    `import fs from 'node:fs';
export async function recoverTask(turn) {
  fs.appendFileSync('recovered.jsonl', JSON.stringify(turn)+'\\n');
  return {finished:true,session:turn.session,text:'已核实原网页结果'};
}
export async function runTask(turn) {
  fs.appendFileSync('called.jsonl', JSON.stringify(turn)+'\\n');
  return process.env.RUNTIME_RESULT === 'uncertain'
    ? {state:'uncertain',session:turn.session,text:'已打开网页，提交结果尚未核实'}
    : process.env.RUNTIME_RESULT === 'failed'
      ? {error:'浏览器执行失败',session:turn.session,text:'页面证据：示例页面标题'}
      : {finished:true,session:turn.session,text:'页面证据：示例页面标题'};
}
`,
  );
  const task = {
    profile: "browser",
    access: "read",
    url: "https://example.com/页面",
    checks: ["核实标题", "保留字面量 $(touch SHOULD_NOT_EXIST) 和 `echo x`"],
    allowedActions: ["只读页面", "仅关闭本次新建的标签"],
  };
  writeFileSync(join(dir, "browser.json"), JSON.stringify(task));
  const run = (args: string[] = [], result = "done") =>
    spawnSync(process.execPath, ["handoff.ts", "browser.json", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, AGENT_AUTOLOOP_APP: app, RUNTIME_RESULT: result },
    });
  return { dir, task, run };
}

test("the copied recipe uses a trusted profile and passes literal scope with a logical session", () => {
  const { dir, run } = fixture();
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /页面证据/);
  assert.match(first.stdout, /Autoloop 会话：browser-/);
  assert.equal(existsSync(join(dir, "SHOULD_NOT_EXIST")), false);
  const session = /Autoloop 会话：(browser-[^\]]+)/.exec(first.stdout)![1];
  const again = run(["--resume", session]);
  assert.equal(again.status, 0, again.stderr);
  const calls: any[] = readFileSync(join(dir, "called.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls[0].resume, null);
  assert.deepEqual(calls[0].options, { profile: "browser" });
  assert.equal(calls[0].access, "read");
  assert.deepEqual(calls[0].execution, { run: 1, attempt: 1, turn: 1 });
  assert.deepEqual(calls[1].execution, { run: 1, attempt: 1, turn: 2 });
  assert.notEqual(calls[0].cwd, dir);
  assert.equal(calls[0].cwd, calls[1].cwd);
  assert.ok(calls[0].prompt.includes("$(touch SHOULD_NOT_EXIST)"));
  assert.ok(calls[0].prompt.includes(new URL("https://example.com/页面").href));
  assert.equal(calls[1].resume, session);
  assert.equal(calls[1].session, session);
  assert.notEqual(calls[0].folder, calls[1].folder);
});

test("invalid scope or resume arguments do not reach the runtime", () => {
  const { dir, task, run } = fixture();
  for (const args of [["--resume", "bad; command"], ["--resume"], ["--other"]])
    assert.notEqual(run(args).status, 0);
  writeFileSync(join(dir, "browser.json"), JSON.stringify({ ...task, url: "javascript:alert(1)" }));
  assert.notEqual(run().status, 0);
  writeFileSync(join(dir, "browser.json"), JSON.stringify({ ...task, command: ["old-entry"] }));
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(join(dir, "called.jsonl")), false);
});

test("failed and uncertain runtime results keep their evidence and session, with no retry", () => {
  for (const state of ["failed", "uncertain"]) {
    const { dir, run } = fixture();
    const result = run([], state);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /页面|网页/);
    assert.match(result.stdout, /Autoloop 会话：browser-/);
    assert.equal(readFileSync(join(dir, "called.jsonl"), "utf8").trim().split("\n").length, 1);
  }
});

test("resuming an uncertain browser task only reconciles the same execution", () => {
  const { dir, run } = fixture();
  const first = run([], "uncertain");
  const session = /Autoloop 会话：(browser-[^\]]+)/.exec(first.stdout)![1];
  const recovered = run(["--resume", session]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /已核实原网页结果/);
  const firstTurn = JSON.parse(readFileSync(join(dir, "called.jsonl"), "utf8"));
  const recoveredTurn = JSON.parse(readFileSync(join(dir, "recovered.jsonl"), "utf8"));
  assert.deepEqual(recoveredTurn, firstTurn);
});
