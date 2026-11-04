import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readJSON, syncDirectory } from "./store.ts";
import type { Receipt, Request, Usage } from "./types.ts";

export function response(value: unknown): { text: string; usage?: Usage } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("回执必须是 JSON 对象");
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string" || !v.text.trim() || Buffer.byteLength(v.text) > 1024 * 1024) {
    throw Error("回执 text 必须是非空文字，且不超过 1 MiB");
  }
  const result: { text: string; usage?: Usage } = { text: v.text };
  if (v.usage !== undefined) {
    if (!v.usage || typeof v.usage !== "object" || Array.isArray(v.usage)) throw Error("回执 usage 无效");
    const usage: Usage = {};
    for (const [k, n] of Object.entries(v.usage)) {
      if (!["input", "output", "cached", "cost"].includes(k) || typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw Error("回执 usage 只能包含已知的非负计量");
      }
      usage[k as keyof Usage] = n;
    }
    result.usage = usage;
  }
  return result;
}

export function validatedReceipt(request: Request, value: unknown): Receipt {
  const v = value as Receipt;
  if (
    !v ||
    v.version !== 1 ||
    v.task !== request.task ||
    v.nonce !== request.nonce ||
    v.session !== request.session ||
    JSON.stringify(v.execution) !== JSON.stringify(request.execution)
  ) {
    throw Error("回执不属于当前任务或 nonce 不匹配");
  }
  return { version: 1, task: v.task, nonce: v.nonce, session: v.session, execution: v.execution, ...response(v) };
}

export function readReceipt(request: Request): Receipt | null {
  return existsSync(request.receiptFile) ? validatedReceipt(request, readJSON<unknown>(request.receiptFile)) : null;
}

export function submitReceipt(requestFile: string, value: unknown): Receipt {
  const request = readJSON<Request>(requestFile);
  const expected = path.join(path.dirname(path.resolve(requestFile)), "receipt.json");
  if (
    request.version !== 1 ||
    typeof request.nonce !== "string" ||
    request.nonce.length < 16 ||
    request.receiptFile !== expected
  ) {
    throw Error("回执请求文件无效");
  }
  const receipt: Receipt = {
    version: 1,
    task: request.task,
    nonce: request.nonce,
    session: request.session,
    execution: request.execution,
    ...response(value),
  };
  const tmp = `${expected}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, expected);
    syncDirectory(path.dirname(expected));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const current = validatedReceipt(request, readJSON<unknown>(expected));
    if (JSON.stringify(current) !== JSON.stringify(receipt)) {
      throw Error("已有不同回执，不能覆盖；请让接单程序发起新的修复轮次");
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [requestFile, responseFile] = process.argv.slice(2);
    if (!requestFile || !responseFile) throw Error("用法：receipt.ts <request.json> <response.json>");
    const r = submitReceipt(requestFile, JSON.parse(readFileSync(responseFile, "utf8")));
    process.stdout.write(JSON.stringify({ accepted: true, task: r.task }) + "\n");
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
