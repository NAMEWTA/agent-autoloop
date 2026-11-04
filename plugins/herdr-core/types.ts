// Self-contained plugin boundary: this plugin can be installed outside the application's source tree.
export type Access = "read" | "edit" | "full";
export type Usage = { input?: number; output?: number; cached?: number; cost?: number };
export type Execution = { run: number; attempt: number; turn: number };
export type Parent = { session: string; task: string };

export type Turn = {
  parentSession?: string;
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  access: Access;
  contextFile: string;
  folder: string;
  options?: Record<string, unknown>;
  execution?: Execution;
  model?: string;
  effort?: string;
  command?: string[];
};

export type Reading = {
  text?: string;
  session?: string;
  usage?: Usage;
  error?: string;
  finished?: boolean;
  state?: "running" | "uncertain";
};

export type Profile = {
  template: string;
  access: Access;
  hc: string[];
  session: string;
  rpcTimeoutMs: number;
  turnTimeoutMs: number;
  monitorIntervalMs: number;
  cwd?: string;
};

export type Request = {
  version: 1;
  task: string;
  nonce: string;
  session: string;
  execution: Execution;
  cwd: string;
  prompt: string;
  contextFile: string;
  responseFile: string;
  receiptFile: string;
};

export type Receipt = Pick<Request, "version" | "task" | "nonce" | "session" | "execution"> & {
  text: string;
  usage?: Usage;
};

export type Phase =
  | "prepared"
  | "creating"
  | "sending"
  | "observing"
  | "uncertain"
  | "completed"
  | "stopping"
  | "stopped";

export type Task = {
  parent?: Parent;
  version: 1;
  id: string;
  home: string;
  session: string;
  execution: Execution;
  cwd: string;
  profileName: string;
  profile: Profile;
  fingerprint: string;
  promptDigest: string;
  requestDigest: string;
  requestFile: string;
  phase: Phase;
  resume: boolean;
  createdAt: number;
  updatedAt: number;
  dispatchAt?: number;
  nativeTurn?: number;
  note?: string;
  reading?: Reading;
};

export type Binding = {
  parentSession?: string;
  version: 1;
  session: string;
  profileName: string;
  fingerprint: string;
  cwd: string;
  coreId: string;
  terminal: string;
  createdMs: number;
  labels: Record<string, string>;
  activeTask: string | null;
  lastTask: string;
  paused: boolean;
  stopped: boolean;
};

export type Terminal = {
  address: string;
  created_ms: number;
  cwd: string;
  labels: Record<string, string>;
  state: string;
  reported?: boolean;
  status?: { state: string } | null;
  turn?: number;
  keep?: boolean;
  reason?: string | null;
  first_message?: {
    sent: boolean;
    started?: boolean | null;
    turn?: number | null;
    reason?: string;
  } | null;
};
