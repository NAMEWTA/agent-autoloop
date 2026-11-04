// The deterministic delivery process owns its receipt; AI review uses the shared Herdr runtime.
import { join } from "node:path";
import { tail, type Adapter } from "../../worker/agents.ts";
import { recoverReview, stopReview, REVIEW_UPDATE } from "./review.ts";

export default {
  capabilities: { persistent: true },
  command: (turn) => [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "run.ts"),
    ...(turn.command ?? []),
  ],
  read(stdout, code, stderr) {
    const lines = stdout.split("\n");
    const updates = lines.flatMap((line) => {
      if (!line.startsWith(REVIEW_UPDATE)) return [];
      try { return [JSON.parse(line.slice(REVIEW_UPDATE.length))]; } catch { return []; }
    });
    const state = updates.at(-1)?.state;
    if (code === null) return state ? { state } : {};
    if (code !== 0 && state) return { state: "uncertain" };
    if (code !== 0) return { error: `退出码 ${code}：${tail(stderr || stdout) || "没留下原因"}` };
    return { text: lines.filter((line) => !line.startsWith(REVIEW_UPDATE)).join("\n"), finished: true };
  },
  recover: (turn) => recoverReview(turn.folder),
  stop: (turn, reason) => stopReview(turn.folder, reason),
} satisfies Adapter;
