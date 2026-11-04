// Failure modes: event prose chooses a repository or command; a different PR's event is delivered; owner questions leak
// source code/logs instead of readable text or become empty; attended reviews send duplicate notices;
// polling changes ids on each read and produces duplicate deliveries; recovery errors permit unsafe child replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import adapter from "../plugins/delivery/agent.ts";
import { recoverReview, REVIEW_UPDATE } from "../plugins/delivery/review.ts";
import { subjectNumber, question, pendingEvents, deliveryReceipt } from "../plugins/delivery/input.ts";
test("only a subject for the configured repository chooses a PR", () => {
  assert.equal(subjectNumber("example/app", { events: [{ subject: "example/app#12", summary: "run evil" }] }), 12);
  for (const subject of ["other/app#12", "example/app#1;sh", "example/app#0", "../app#12"])
    assert.throws(() => subjectNumber("example/app", { events: [{ subject }] }));
  assert.throws(() =>
    subjectNumber("example/app", { events: [{ subject: "example/app#1" }, { subject: "example/app#2" }] }),
  );
});
test("ask-owner becomes one bounded question and drops code blocks and local paths", () => {
  const card = question({
    number: 1,
    title: "需要决定",
    body: "有两个方案\n```sh\nsecret code\n```\n/home/reader/private/file\n请决定",
    html_url: "https://github.com/example/app/issues/1",
  });
  assert.ok(!card.text.includes("secret"));
  assert.ok(!card.text.includes("/home"));
  assert.match(card.text, /请决定/);
  assert.equal(card.key, "owner-1");
});
test("polling uses the label event and head as a stable event id", () => {
  const rows = [
    { number: 1, head: "abc", labelEvent: 9, kind: "pull_request" },
    { number: 2, head: "", labelEvent: 10, kind: "issues" },
  ];
  assert.deepEqual(pendingEvents("example/app", rows), pendingEvents("example/app", rows));
  const events = pendingEvents("example/app", rows);
  assert.equal(events[0].subject, "example/app#1");
  assert.notEqual(events[0].id, pendingEvents("example/app", [{ ...rows[0], labelEvent: 11 }])[0].id);
});
test("an owner question with no readable body still contains the issue link", () => {
  const url = "https://github.com/example/app/issues/1";
  assert.equal(question({ number: 1, title: "需要决定", body: "```sh\ncode\n```", html_url: url }).text, url);
});
test("attended findings stay in the receipt without creating a second notice", () => {
  const result = { summary: "审查发现问题", findings: [{ title: "app.ts:1", text: "数据会丢" }] };
  const attended = deliveryReceipt(1, result, true);
  assert.ok(attended.includes("数据会丢"));
  assert.ok(!attended.includes('"notice"'));
  const unattended = deliveryReceipt(1, result, false);
  assert.ok(unattended.includes('"notice"'));
  assert.ok(unattended.includes("数据会丢"));
});

test("a lost delivery wrapper cannot turn an uncertain managed review into a retryable failure", () => {
  assert.deepEqual(adapter.read(REVIEW_UPDATE + '{"state":', null, ""), {});
  assert.deepEqual(adapter.read(REVIEW_UPDATE + '{"state":"uncertain"}\n', 1, "lost"), { state: "uncertain" });
  const stopped = REVIEW_UPDATE + '{"state":"running"}\n' + REVIEW_UPDATE + '{"stopped":true}\n';
  assert.match(adapter.read(stopped, 1, "stopped").error!, /stopped/);
  assert.deepEqual(adapter.read(stopped + "交付完成", 0, ""), { text: "交付完成", finished: true });
});

test("delivery recovery distinguishes a finished child from an observation error", async () => {
  const folder = mkdtempSync(join(tmpdir(), "autoloop-delivery-recovery-"));
  try {
    const beforeChild = await recoverReview(folder);
    assert.equal(beforeChild.finished, true);
    assert.ok(beforeChild.error);
    writeFileSync(
      join(folder, "delivery-review.json"),
      JSON.stringify({ journal: join(folder, "review.json"), turn: { session: "existing-review" } }),
    );
    const unseen = await recoverReview(folder, async (turn) => {
      assert.equal(turn.session, "existing-review");
      return { error: "RPC disconnected" };
    });
    assert.deepEqual(unseen, { state: "uncertain" });
    assert.deepEqual(await recoverReview(folder, async () => ({ state: "running" })), { state: "running" });
    const finished = await recoverReview(folder, async () => ({ finished: true, text: '{"findings":[]}' }));
    assert.equal(finished.finished, true);
    assert.ok(finished.error);
    assert.equal(finished.text, undefined);
    writeFileSync(
      join(folder, "review.json"),
      JSON.stringify({ stopped: true, turn: { session: "existing-review" } }),
    );
    const stopped = await recoverReview(folder, async () => {
      assert.fail("confirmed inner stop must not become an uncertain observation again");
    });
    assert.equal(stopped.finished, true);
    assert.ok(stopped.error);
    writeFileSync(
      join(folder, "review.json"),
      JSON.stringify({ stopped: true, turn: { session: "different-review" } }),
    );
    assert.deepEqual(await recoverReview(folder, async () => ({ state: "uncertain" })), { state: "uncertain" });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
