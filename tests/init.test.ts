// Failures: init silently reinstalls a removed headless adapter; a profile is replaced by CLI autodetection;
// a deterministic script path containing spaces is split into a shell command.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
function installed(args: string[], check: (result: ReturnType<typeof spawnSync>, home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "autoloop-init-"));
  try {
    const result = spawnSync(process.execPath, [program, "init", "--no-service", ...args], {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_RULES: join(home, "rules.json") },
      encoding: "utf8",
      timeout: 20_000,
    });
    check(result, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("init records the explicit Herdr profile and no provider executable", () => {
  installed(["--profile", "developer"], (done, home) => {
    assert.equal(done.status, 0, String(done.stderr));
    const { agents } = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
    assert.equal(agents.agent.use, "herdr-core");
    assert.deepEqual(agents.agent.options, { profile: "developer" });
    assert.equal(agents.agent.command, undefined);
  });
});

test("script setup keeps one literal executable path", () => {
  installed(["--script", "/my scripts/poll.sh"], (done, home) => {
    assert.equal(done.status, 0, String(done.stderr));
    const { agents } = JSON.parse(readFileSync(join(home, "rules.json"), "utf8"));
    assert.equal(agents.agent.use, "script");
    assert.deepEqual(agents.agent.command, ["/my scripts/poll.sh"]);
  });
});

test("removed AI setup flags fail before writing configuration", () => {
  for (const args of [["--command", "claude -p {prompt}"], ["--agent", "codex"]]) {
    installed(args, (done, home) => {
      assert.equal(done.status, 1);
      assert.match(String(done.stderr), /--profile/);
      assert.equal(existsSync(join(home, "config.json")), false);
    });
  }
});
