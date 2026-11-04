// Failure modes: empty/failed/uncertain reviews pass; review inherits a development session or writes to a PR checkout;
// PR points/config replace main's trusted settings. Only a text snapshot reaches the configured read-only profile.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, reviewSnapshot, stopReview } from "../plugins/delivery/review.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings } from "../plugins/delivery/project.ts";
import type { Turn } from "../worker/agents.ts";

test("a review must explicitly report a valid findings list", () => {
  assert.deepEqual(parseReview('{"findings":[]}'), []);
  assert.equal(parseReview('{"findings":[{"title":"错误","text":"这里会丢数据"}]}').length, 1);
  for (const text of ["", "Reviewer failed", "{}", '{"findings":null}', '{"findings":[{}]}'])
    assert.throws(() => parseReview(text));
});

test("review uses main's points and a fresh read-only profile with a text-only snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-autoloop-review-"));
  try {
    const repo = join(root, "repo");
    const snap = join(root, "snapshot");
    const storage = join(root, "runtime");
    mkdirSync(repo);
    mkdirSync(join(repo, "docs"));
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = () => {
      git("add", "-A");
      git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nmain-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('must not execute');");
    const main = commit();
    const calls: Turn[] = [];
    const reviewer = async (turn: Turn) => {
      calls.push(turn);
      assert.match(turn.prompt, /main-points/);
      assert.doesNotMatch(turn.prompt, /branch-points/);
      assert.equal(turn.access, "read");
      assert.equal(turn.resume, null);
      assert.ok(turn.cwd.startsWith(storage + "/"));
      assert.ok(!turn.folder.startsWith(turn.cwd + "/"));
      assert.deepEqual(readdirSync(turn.cwd), ["changes.txt"]);
      assert.deepEqual(turn.execution, { run: 1, attempt: 1, turn: 1 });
      assert.equal(readFileSync(turn.contextFile, "utf8"), "{}");
      return { text: '{"findings":[]}', finished: true, session: turn.session };
    };
    const s = settings({
      repo: "example/app",
      internal: ["docs/*.md"],
      review: { points: "AGENTS.md", profile: "review", xhigh: ["app.ts"], xhighProfile: "review-deep" },
    });
    writeFileSync(join(repo, "docs/a.md"), "docs");
    const docs = commit();
    assert.deepEqual(await reviewSnapshot(repo, snap, main, docs, s, reviewer, storage), []);
    assert.equal(calls.length, 0);
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nbranch-points\n");
    writeFileSync(join(repo, "app.ts"), "throw new Error('changed');");
    const head = commit();
    assert.deepEqual(await reviewSnapshot(repo, snap, main, head, s, reviewer, storage), []);
    assert.equal(calls.length, 1);
    assert.deepEqual(await reviewSnapshot(repo, snap, main, head, s, reviewer, storage), []);
    assert.deepEqual(calls[0], calls[1], "same trusted review scope must reuse the durable task after interruption");
    assert.deepEqual(calls[0].options, { profile: "review-deep" });
    assert.ok(readFileSync(join(snap, "changes.txt"), "utf8").includes("changed"));
    await assert.rejects(
      reviewSnapshot(repo, snap, main, head, s, async () => ({ error: "runtime unavailable" }), storage),
      /runtime unavailable/,
    );
    await assert.rejects(
      reviewSnapshot(repo, snap, main, head, s, async () => ({ finished: true, text: "" }), storage),
      /审查没有交回/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a confirmed stop before the review marker prevents a later review dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoloop-review-stop-"));
  const previousContext = process.env.AGENT_AUTOLOOP_CONTEXT;
  try {
    const repo = join(root, "repo");
    const folder = join(root, "wrapper");
    mkdirSync(repo);
    mkdirSync(folder);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = () => {
      git("add", "-A");
      git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "AGENTS.md"), "## 审查要点\nDo not execute the PR\n");
    writeFileSync(join(repo, "app.ts"), "old");
    const main = commit();
    writeFileSync(join(repo, "app.ts"), "new");
    const head = commit();
    const configuration = settings({
      repo: "example/app",
      internal: [],
      review: { points: "AGENTS.md", profile: "review" },
    });
    process.env.AGENT_AUTOLOOP_CONTEXT = join(folder, "context.json");
    assert.equal(await stopReview(folder, "cancel"), true);
    let dispatched = false;
    await assert.rejects(
      reviewSnapshot(
        repo,
        join(root, "snapshot"),
        main,
        head,
        configuration,
        async () => {
          dispatched = true;
          return { finished: true, text: '{"findings":[]}' };
        },
        join(root, "reviews"),
      ),
      /停止/,
    );
    assert.equal(dispatched, false, "a late marker must not escape an already acknowledged stop");
  } finally {
    if (previousContext === undefined) delete process.env.AGENT_AUTOLOOP_CONTEXT;
    else process.env.AGENT_AUTOLOOP_CONTEXT = previousContext;
    rmSync(root, { recursive: true, force: true });
  }
});
