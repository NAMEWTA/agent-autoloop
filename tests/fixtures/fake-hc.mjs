import { readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const file = process.argv[process.argv.indexOf("--state") + 1];

function read() {
  return JSON.parse(readFileSync(file, "utf8"));
}

function save(s) {
  const t = `${file}.${process.pid}.tmp`;
  writeFileSync(t, JSON.stringify(s));
  renameSync(t, file);
}

function receipt(s, terminal, text) {
  const match = text.match(/^AUTOLOOP_REQUEST=(.+)$/m);
  if (!match || s.autoReceipt === false) return;
  const request = JSON.parse(readFileSync(JSON.parse(match[1]), "utf8"));
  const result = {
    version: 1,
    task: request.task,
    nonce: request.nonce,
    session: request.session,
    execution: request.execution,
    text: s.text ?? "完成了测试任务",
    ...(s.usage ? { usage: s.usage } : {}),
  };
  writeFileSync(request.receiptFile, JSON.stringify(result));
  terminal.status = { state: s.resultStatus ?? "done" };
  terminal.turn++;
}

const methods = [
  "hello",
  "templates.list",
  "terminal.run",
  "terminal.send",
  "terminal.get",
  "terminal.list",
  "terminal.kill",
  "terminal.interrupt",
  "events.subscribe",
];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const msg = JSON.parse(line);
  const s = read();
  const p = msg.params ?? {};
  let result;
  appendFileSync(`${file}.calls`, JSON.stringify({ method: msg.method, params: p }) + "\n");
  try {
    switch (msg.method) {
      case "hello":
        result = {
          generation: 1,
          version: "0.1.17",
          core: { id: s.coreId ?? "core-test" },
          methods,
          features: [],
          framed: false,
        };
        break;
      case "templates.list":
        result = { templates: s.noTemplate ? [] : [{ name: "aal-codex" }] };
        break;
      case "terminal.run": {
        const t = {
          address: `t${(s.next ?? 0) + 1}`,
          created_ms: Date.now(),
          cwd: p.cwd,
          argv: p.argv,
          labels: p.labels,
          name: p.name,
          state: "live",
          reported: s.reported !== false,
          status: { state: "working" },
          turn: 0,
          keep: p.keep,
        };
        s.next = (s.next ?? 0) + 1;
        s.terminals ??= [];
        s.terminals.push(t);
        if (!s.firstMessageFalse) receipt(s, t, p.argv[1]);
        result = {
          ...t,
          first_message: {
            sent: !s.firstMessageFalse,
            started: !s.firstMessageFalse,
            turn: s.noFirstTurn ? null : 0,
          },
        };
        save(s);
        if (s.dropAfterRun) process.exit(0);
        if (s.delayRunReplyMs) await new Promise((resolve) => setTimeout(resolve, s.delayRunReplyMs));
        break;
      }
      case "terminal.send": {
        const t = s.terminals.find((t) => t.address === p.terminal);
        if (!t) throw Error("not_found");
        const baseline = t.turn;
        t.status = { state: "working" };
        receipt(s, t, p.text);
        save(s);
        result = { turn: baseline, started: true };
        if (s.dropAfterSend) process.exit(0);
        break;
      }
      case "terminal.get":
        result = s.terminals?.find((t) => t.address === p.terminal);
        if (!result) throw Error("not_found");
        break;
      case "terminal.list":
        result = {
          terminals: (s.terminals ?? []).filter((t) =>
            Object.entries(p.labels ?? {}).every(([k, v]) => t.labels[k] === v),
          ),
          hidden_finished: 0,
        };
        break;
      case "terminal.interrupt":
        result = { outcome: "unknown", key: "Escape" };
        break;
      case "terminal.kill": {
        const t = s.terminals.find((t) => t.address === p.terminal);
        if (!t) throw Error("not_found");
        if (!s.killFails) {
          t.state = "finished";
          t.status = null;
          t.reason = "killed";
        }
        save(s);
        result = t;
        break;
      }
      case "events.subscribe":
        result = { seq: 0, terminals: s.terminals ?? [] };
        break;
      default:
        throw Error("unsupported");
    }
    const output = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    const boundary = s.splitUtf8 ? output.findIndex((byte) => byte >= 0xc0) : -1;
    if (boundary >= 0) {
      process.stdout.write(output.subarray(0, boundary + 1));
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.stdout.write(output.subarray(boundary + 1));
    } else process.stdout.write(output);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: e.message, data: { kind: e.message } },
      }) + "\n",
    );
  }
}
