# Integration contract (implementation in progress)

Profile configuration: `$AGENT_AUTOLOOP_HOME/herdr/profiles.json` (default home `~/.agent-autoloop`).

```json
{"profiles":{"developer":{"template":"aal-codex","access":"edit","hc":["hc"],"session":"autoloop","rpcTimeoutMs":15000,"turnTimeoutMs":10800000,"monitorIntervalMs":1000,"cwd":"/optional/pinned/directory"}}}
```

`Turn.options.profile` is required. `template` and `access` are required profile fields; `hc`, `session`, deadlines and cwd are optional. `access` must exactly match Turn.access. `hc` is a trusted executable argv prefix, and `connect --session <session>` is appended. No shell. This profile declares the native policy and is not a sandbox. Optional cwd is canonicalized and pins the profile.

`agent.check(options?: Record<string, unknown>): string | null` does local profile/executable validation; it is synchronous and receives agent.options. Runtime hello/template/status validation is performed by runTask. `capabilities={resume:true,persistent:true}`.

Public `task.ts` exports:
- `prepareTask(turn: Turn): string` returns the private durable task path; contains no hub token. Intended for agent.command.
- `runTask(turn: Turn, options?: {signal?:AbortSignal;onUpdate?:(reading:Reading)=>void}): Promise<Reading>` for worker/delivery reuse. It prepares if necessary and executes/reconciles the durable turn without resending unknown delivery.
- `recoverTask(turn: Turn): Promise<Reading>` is inspection only and never dispatches.
- `stopTask(turn: Turn, reason:'cancel'|'timeout'): Promise<boolean>` only true after actual terminal stop is confirmed.

Turn includes agreed `options?:Record<string,unknown>` and `execution?:{run:number,attempt:number,turn:number}`. For deterministic delivery tasks, caller must provide stable positive integer run/attempt/turn identity; folder/contextFile are accepted but the private worker folder is never exposed to native agents. A final Reading is `{finished:true,text,session,usage?}`, with the existing business receipt text unchanged. `state:'running'|'uncertain'` is not failure/retry eligibility.

`control.ts` syntax: `list`, `inspect <session>`, `pause <session>`, `resume <session>`, `stop <session>`. Root CLI can spawn Node and forward args. Outputs one JSON object. pause prevents future sends but does not claim to suspend a native process; stop verifies termination. resume never automatically resends an ambiguous request.

Public request/context/receipt directories are separate from worker/runs and contain no hub token. Every turn gets a distinct context copy, nonce and helper command. Native agent must write response JSON `{text:"...",usage?:{input?,output?,cached?,cost?}}` and execute the supplied generic receipt helper command. Screens and terminal status alone are never parsed as a business receipt. Templates must support native status reporting; keep=false, no_parent=true, no_notify=true. Lost terminals are never silently recreated for resumed work.

## Integration status

Implementation files now exist. Seven behavior tests pass (`node --test tests/herdr.test.ts`), including lost send acknowledgment, failed first message, resume context refresh, directory occupancy, and verified cancellation. `agent.ts` exports `control` on its default adapter, ready for the generic CLI plugin command. `control stop` returns `{session,stopRequested:true,run,attempt,stopped,note}`; these numeric fields are diagnostic only; the root CLI must not cancel by run number without matching the full worker/session/plugin identity. Active top-level business cancellation uses `agent-autoloop recover <run> --stop`. The plugin never imports worker internals or reads a run token.

Locking has been separated into persistent occupancy and an exclusive mkdir lease; a separate mkdir reaper serializes dead-process lease replacement. Reaper interruption fails closed. Stop requests are files independent of mutable task state; the current bridge receives them and kills/verifies the owned terminal, or a later observer takes the dead lease and finishes the same stop. No automatic retry dispatch occurs on unknown delivery.

Cancellation can stop completed idle sessions while preserving their completed task receipt; `lastTask` remains in each binding for cleanup. `control stop` for an idle completed session returns `stopRequested:false`, so it should not request worker cancellation for an already finished business run.

The old command-valued `link` was removed. `control inspect` returns `attach: {argv:[...profile.hc,"attach",terminal],env:{HC_SESSION:profile.session}}`. Actual 0.1.17 `hc attach --help` does **not** accept `--session`; that flag is for `hc connect` (and machine config). An explicit HC_SESSION environment is the supported attach namespace selection.

Completion now requires a bound receipt plus reported `done` and a native turn greater than `terminal.send.result.turn` / `first_message.turn`. Missing acknowledgments have no invented baseline: recovery must observe working then later done (or receive a real supported boundary); a late receipt with a stale done is uncertain. Fourteen behavior tests cover these paths.

Safe failures now terminate explicitly: missing template/hello/pre-dispatch validation yields durable `{finished:true,error,session}`. Preparation conflicts with any already-dispatched task remain uncertain. `agent.command` emits a small bridge failure envelope instead of throwing a conflicting dispatch into the worker's ordinary failed/retry path. A narrowly scoped unstarted-session marker lets a worker retry an initially failed setup without pretending a lost native conversation was resumed. `recoverTask` reads durable safe failures if the bridge output was lost.
