// Exercise the actual MCP process against a real temporary hub. No provider-specific CLI is involved.
// Failures: initialization or a tool call cannot cross stdio/HTTP; the test leaks a process or normal-home data.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert.equal(process.argv[2], "mcp", "用法：node scripts/real-protocols.ts mcp；AI 接入请跑 real-agents.ts <profile>");
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-real-mcp-"));
const started = Date.now();
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
writeFileSync(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify({ sources: {}, agents: {}, channels: {}, rules: [] }));
const hub = await import("../host/runtime.ts");
const { serve } = await import("../host/http.ts");
const server = serve(0);
await once(server, "listening");
let calls = 0;
server.on("request", (req) => {
  if (req.url === "/v1/state") calls++;
});

try {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      owner: hub.addKey("owner", "smoke"),
    }),
    { mode: 0o600 },
  );
  const requests = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "mcp"],
      { cwd: home, env: process.env, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, output, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(output)),
    );
    child.stdin!.end(requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n") + "\n");
  });
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 3);
  assert.equal(responses.find((reply) => reply.id === 1).result.protocolVersion, "2025-11-25");
  assert.ok(responses.find((reply) => reply.id === 2).result.tools.some((tool: { name: string }) => tool.name === "status"));
  const status = responses.find((reply) => reply.id === 3);
  assert.equal(status.error, undefined);
  assert.equal(status.result.isError, undefined);
  assert.equal(calls, 1);
  console.log(JSON.stringify({ protocol: "MCP", statusCalls: calls, ms: Date.now() - started }));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  hub.db.close();
  rmSync(home, { recursive: true, force: true });
}
