export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number; // -1 when timed out or the driver itself failed
  timedOut: boolean;
};

export type ExecOptions = {
  timeout?: number; // seconds
  cwd?: string;
  env?: Record<string, string>;
};

export type CreateOptions = {
  fullName: string; // "owner/name"
  pat: string; // decrypted token; "" is allowed for public repos
  labels?: Record<string, string>; // extra docker labels (e.g. devbox.session)
};

export type SandboxInfo = {
  id: string;
  provider: string;
  fullName: string | null;
  running: boolean;
};

// the swappable interface — docker today, a hosted/microVM sandbox tomorrow.
// implement these methods and register the driver in sandbox/index.ts
export interface Sandbox {
  readonly id: string;
  readonly provider: string;
  readonly fullName: string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  create(opts: CreateOptions): Promise<Sandbox>;
  get(id: string): Promise<Sandbox | null>;
  list(): Promise<SandboxInfo[]>;
}
