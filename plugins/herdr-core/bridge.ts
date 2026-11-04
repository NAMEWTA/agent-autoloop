import { runPreparedTask } from "./task.ts";
import type { Reading } from "./types.ts";

const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
let previous = "";

function output(reading: Reading) {
  const encoded = JSON.stringify(reading);
  if (encoded === previous) return;
  previous = encoded;
  process.stdout.write(encoded + "\n");
}

try {
  if (!process.argv[2]) throw Error("Herdr bridge 缺少持久化任务路径");
  if (process.argv[2] === "--reading") output(JSON.parse(process.argv[3]));
  else output(await runPreparedTask(process.argv[2], { signal: abort.signal, onUpdate: output }));
} catch (e) {
  output({ state: "uncertain", error: (e as Error).message });
}
