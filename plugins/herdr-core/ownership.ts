import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { atomic, digest, ownershipGate, readJSON, saveTask, taskFile } from "./store.ts";
import type { Parent, Reading, Task } from "./types.ts";

type Child = { task: string; session: string; parentTask: string };
const folder = (h: string, session: string) => path.join(h, "herdr", "ownership", digest(session));
const stopFile = (task: Task) => `${taskFile(task.home, task.id)}.stop`;
const active = (task: Task) => ["creating", "sending", "observing", "uncertain"].includes(task.phase);

function checkParent(task: Task, parent: Parent) {
  const dir = folder(task.home, parent.session);
  if (existsSync(path.join(dir, "stopping.json"))) throw Error("父 Herdr 会话正在停止，不能启动子任务");
  const current = readJSON<Parent>(path.join(dir, "current.json"));
  if (current.session !== parent.session || current.task !== parent.task) {
    throw Error("父 Herdr 执行轮次已经改变，不能把子任务归入新轮次");
  }
  const owner = readJSON<Task>(taskFile(task.home, parent.task));
  if (owner.session !== parent.session || !active(owner) || existsSync(stopFile(owner))) {
    throw Error("父 Herdr 执行已经结束或正在停止，不能启动子任务");
  }
  return owner;
}

function register(task: Task) {
  const parent = task.parent!;
  const record: Child = { task: task.id, session: task.session, parentTask: parent.task };
  atomic(path.join(folder(task.home, parent.session), "children", `${task.id}.json`), record);
}

// A child is registered before any native side effect. The parent gate also protects
// completion and stop fences, so registration cannot cross either boundary unnoticed.
export function prepareOwnedTask(task: Task, parentSession?: string) {
  if (parentSession === undefined) {
    saveTask(task);
    return;
  }
  if (typeof parentSession !== "string" || !parentSession || parentSession.length > 512) {
    throw Error("Herdr parentSession 必须是有效的逻辑 session");
  }
  const release = ownershipGate(task.home, parentSession);
  try {
    const parent = readJSON<Parent>(path.join(folder(task.home, parentSession), "current.json"));
    const owner = checkParent(task, parent);
    const seen = new Set([task.session]);
    let ancestor: Task | undefined = owner;
    while (ancestor) {
      if (seen.has(ancestor.session) || seen.size > 64) throw Error("Herdr 子任务归属出现循环或层级过深");
      seen.add(ancestor.session);
      ancestor = ancestor.parent ? readJSON<Task>(taskFile(task.home, ancestor.parent.task)) : undefined;
    }
    task.parent = parent;
    saveTask(task);
    register(task);
  } finally {
    release();
  }
}

export function assertParent(task: Task) {
  if (!task.parent) return;
  const release = ownershipGate(task.home, task.parent.session);
  try {
    checkParent(task, task.parent);
    register(task);
  } finally {
    release();
  }
}

// Publish before terminal.run/send: native tools may start a child before the RPC reply.
// The native environment contains the stable logical session, never an initial task ID.
export function publishCurrent(task: Task) {
  const release = ownershipGate(task.home, task.session);
  try {
    const dir = folder(task.home, task.session);
    if (existsSync(path.join(dir, "stopping.json")) || existsSync(stopFile(task))) {
      throw Error("Herdr 会话已经请求停止，不能派发新消息");
    }
    const file = path.join(dir, "current.json");
    if (existsSync(file)) {
      const current = readJSON<Parent>(file);
      if (current.task !== task.id) {
        const previous = readJSON<Task>(taskFile(task.home, current.task));
        if (!["completed", "stopped"].includes(previous.phase)) throw Error("Herdr 上一轮执行尚未结束");
      }
    }
    atomic(file, { session: task.session, task: task.id });
  } finally {
    release();
  }
}

function children(task: Task): Child[] {
  const dir = path.join(folder(task.home, task.session), "children");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
    const child = readJSON<Child>(path.join(dir, name));
    if (!/^[a-f0-9]{64}$/.test(child.task) || !/^[a-f0-9]{64}$/.test(child.parentTask)) {
      throw Error("Herdr 子任务登记已损坏");
    }
    return child;
  });
}

export function unfinishedChildren(task: Task): Task[] {
  const release = ownershipGate(task.home, task.session);
  try {
    const pending: Task[] = [];
    for (const child of children(task).filter((child) => child.parentTask === task.id)) {
      const file = taskFile(task.home, child.task);
      if (!existsSync(file)) {
        if (existsSync(`${file}.stop`)) continue;
        throw Error(`Herdr 子任务 ${child.task} 记录缺失`);
      }
      const execution = readJSON<Task>(file);
      if (execution.parent?.task !== task.id || execution.parent.session !== task.session) {
        throw Error("Herdr 子任务归属不匹配，保留父执行等待核实");
      }
      if (!["completed", "stopped"].includes(execution.phase)) pending.push(execution);
    }
    return pending;
  } finally {
    release();
  }
}

export function completeWithChildren(task: Task, complete: () => Reading): Reading {
  const release = ownershipGate(task.home, task.session);
  try {
    if (existsSync(stopFile(task)) || existsSync(path.join(folder(task.home, task.session), "stopping.json"))) {
      return { session: task.session, state: "uncertain", error: "Herdr 父执行正在停止，保留回执等待核实" };
    }
    let waiting = false;
    for (const child of children(task).filter((child) => child.parentTask === task.id)) {
      const file = taskFile(task.home, child.task);
      if (!existsSync(file)) {
        if (existsSync(`${file}.stop`)) continue;
        return { session: task.session, state: "uncertain", error: `Herdr 子任务 ${child.task} 记录缺失` };
      }
      const execution = readJSON<Task>(file);
      if (execution.parent?.task !== task.id || execution.parent.session !== task.session) {
        throw Error("Herdr 子任务归属不匹配，保留父执行等待核实");
      }
      if (["uncertain", "creating", "sending", "stopping"].includes(execution.phase)) {
        return { session: task.session, state: "uncertain", error: `Herdr 子任务 ${child.task} 尚未确认结束` };
      }
      if (!["completed", "stopped"].includes(execution.phase)) waiting = true;
    }
    return waiting ? { session: task.session, state: "running" } : complete();
  } finally {
    release();
  }
}

export function fenceChildren(task: Task): string[] {
  const release = ownershipGate(task.home, task.session);
  try {
    const dir = folder(task.home, task.session);
    const file = path.join(dir, "current.json");
    if (existsSync(file)) {
      const current = readJSON<Parent>(file);
      if (current.task !== task.id) {
        const owner = readJSON<Task>(taskFile(task.home, current.task));
        if (!["completed", "stopped"].includes(owner.phase)) throw Error("Herdr 会话已属于另一执行，拒绝停止");
      }
    }
    atomic(path.join(dir, "stopping.json"), { task: task.id });
    // Include earlier settled children: their idle terminals still belong to this session.
    return children(task).map((child) => child.task);
  } finally {
    release();
  }
}
