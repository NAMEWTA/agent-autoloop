// Failures: model prompts leak into a deterministic script's argv; an unfinished process is accepted as a receipt;
// shell metacharacters are interpreted by the adapter; a script error is silently called success.
import assert from "node:assert/strict";
import { test } from "node:test";
import script from "../plugins/script/agent.ts";

const turn = {
  prompt: "untrusted task text $(touch /tmp/should-not-exist)",
  session: "ignored",
  resume: null,
  cwd: "/workspace/project with spaces",
  access: "edit" as const,
  contextFile: "/private/context file.json",
  folder: "/private/run",
};

test("scripts receive fixed argv and explicit context paths, without a shell or model prompt", () => {
  assert.deepEqual(script.command({ ...turn, command: ["./poll", "{cwd}", "--data={context}", "$(literal)"] }), [
    "./poll",
    turn.cwd,
    `--data=${turn.contextFile}`,
    "$(literal)",
  ]);
  for (const placeholder of ["{prompt}", "{model}", "{effort}", "{session}"]) {
    assert.throws(() => script.command({ ...turn, command: ["tool", placeholder] }), /script.*不支持/);
  }
  assert.throws(() => script.command({ ...turn, command: [] }), /command/);
});

test("only process exit completes a script and nonzero exit preserves the failure", () => {
  assert.deepEqual(script.read("unfinished", null, ""), {});
  assert.deepEqual(script.read("完成了\n", 0, ""), { text: "完成了\n" });
  assert.match(script.read("", 3, "connection failed").error!, /退出码 3：connection failed/);
});
