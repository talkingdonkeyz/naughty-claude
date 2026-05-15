import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const DEFAULT_SOCKET = "agent";

interface TmuxContext {
  readonly socket: string;
  readonly tmuxBin: string;
}

export interface TmuxOptions {
  /** tmux -L socket name. */
  socket?: string;
  /** Override the tmux binary path. */
  tmuxBin?: string;
}

export interface CreateSessionOptions {
  /** Friendly session name. If omitted, tmux assigns one. Must be unique. */
  name?: string;
  /** Initial pane size; defaults match a typical terminal. */
  width?: number;
  height?: number;
  /** Command to run in the first pane. Default: the user's shell. */
  command?: string;
  /** Working directory for the first pane. Defaults to tmux's cwd (typically the caller's). */
  cwd?: string;
}

export interface Session {
  id: string; // e.g. "$0"
  name: string;
}

export interface Pane {
  id: string; // e.g. "%0"
  sessionId: string; // "$0"
  sessionName: string;
  windowId: string; // "@0"
  windowIndex: number;
  width: number;
  height: number;
}

export interface CaptureOptions {
  /** Start line (negative = into scrollback). */
  start?: number;
  /** End line. */
  end?: number;
  /** Include ANSI escape sequences. Default false (plain text). */
  ansi?: boolean;
  /** Join wrapped lines into single logical lines. Default true. */
  joinWrapped?: boolean;
}

export interface Subscription {
  /** Raw pane bytes as they arrive. Consume with `for await (const chunk of stream)` or `stream.on('data', ...)`. */
  readonly stream: Readable;
  /** Stop the pipe and release resources. Safe to call multiple times. */
  close(): Promise<void>;
}

export interface Tmux {
  readonly socket: string;
  /** Run an arbitrary tmux subcommand. Escape hatch for anything not modeled here. */
  raw(args: readonly string[], stdin?: string | Buffer): Promise<string>;
  createSession(opts?: CreateSessionOptions): Promise<Session>;
  killSession(target: string): Promise<void>;
  listSessions(): Promise<Session[]>;
  listPanes(sessionTarget?: string): Promise<Pane[]>;
  write(paneId: string, data: string | Buffer): Promise<void>;
  sendKeys(paneId: string, keys: readonly string[]): Promise<void>;
  capture(paneId: string, opts?: CaptureOptions): Promise<string>;
  subscribe(paneId: string): Promise<Subscription>;
  shutdown(): Promise<void>;
}

export interface RunOptions {
  stdin?: string | Buffer;
  /** Throw on non-zero exit. Default: true. */
  check?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface TmuxError extends Error {
  readonly code: number;
  readonly stderr: string;
  readonly args: readonly string[];
}

export function createTmuxError(
  message: string,
  code: number,
  stderr: string,
  args: readonly string[],
): TmuxError {
  return Object.assign(new Error(message), {
    name: "TmuxError",
    code,
    stderr,
    args,
  });
}

export const TmuxError = createTmuxError;

/**
 * A headless, multiplexed tmux client. All operations run against a private
 * tmux server identified by `socket`, so the library never touches the user's
 * interactive tmux unless they explicitly point at the same socket.
 */
export function createTmux(opts: TmuxOptions = {}): Tmux {
  const ctx: TmuxContext = {
    socket: opts.socket ?? DEFAULT_SOCKET,
    tmuxBin: opts.tmuxBin ?? "tmux",
  };

  return {
    socket: ctx.socket,
    raw: (args, stdin) => raw(ctx, args, stdin),
    createSession: (opts) => createSession(ctx, opts),
    killSession: (target) => killSession(ctx, target),
    listSessions: () => listSessions(ctx),
    listPanes: (sessionTarget) => listPanes(ctx, sessionTarget),
    write: (paneId, data) => writePane(ctx, paneId, data),
    sendKeys: (paneId, keys) => sendKeys(ctx, paneId, keys),
    capture: (paneId, opts) => capturePane(ctx, paneId, opts),
    subscribe: (paneId) => subscribePane(ctx, paneId),
    shutdown: () => shutdown(ctx),
  };
}

async function runTmux(
  ctx: TmuxContext,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const fullArgs = ["-L", ctx.socket, ...args];
  const child = spawn(ctx.tmuxBin, fullArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (stdout += c));
  child.stderr.on("data", (c: string) => (stderr += c));

  if (opts.stdin !== undefined) {
    child.stdin.end(opts.stdin);
  } else {
    child.stdin.end();
  }

  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 0));
  });

  if (code !== 0 && opts.check !== false) {
    throw TmuxError(
      `tmux ${fullArgs.join(" ")} exited ${code}: ${stderr.trim()}`,
      code,
      stderr,
      fullArgs,
    );
  }
  return { stdout, stderr, code };
}

async function raw(ctx: TmuxContext, args: readonly string[], stdin?: string | Buffer): Promise<string> {
  const { stdout } = await runTmux(ctx, args, { stdin });
  return stdout;
}

async function createSession(ctx: TmuxContext, opts: CreateSessionOptions = {}): Promise<Session> {
  const args = ["new-session", "-d", "-P", "-F", "#{session_id}\t#{session_name}"];
  if (opts.name !== undefined) args.push("-s", opts.name);
  if (opts.cwd !== undefined) args.push("-c", opts.cwd);
  if (opts.width !== undefined) args.push("-x", String(opts.width));
  if (opts.height !== undefined) args.push("-y", String(opts.height));
  if (opts.command !== undefined) args.push(opts.command);
  const { stdout } = await runTmux(ctx, args);
  const line = stdout.trim().split("\n")[0] ?? "";
  const [id, name] = line.split("\t");
  if (!id || !name) {
    throw new Error(`unexpected new-session output: ${JSON.stringify(stdout)}`);
  }
  return { id, name };
}

async function killSession(ctx: TmuxContext, target: string): Promise<void> {
  await runTmux(ctx, ["kill-session", "-t", target]);
}

async function listSessions(ctx: TmuxContext): Promise<Session[]> {
  const { stdout, code, stderr } = await runTmux(
    ctx,
    ["list-sessions", "-F", "#{session_id}\t#{session_name}"],
    { check: false },
  );
  // "no server running" before any session exists - not an error to us.
  if (code !== 0) {
    if (/no server running/i.test(stderr) || /no sessions/i.test(stderr)) return [];
    throw TmuxError(`list-sessions exited ${code}: ${stderr.trim()}`, code, stderr, []);
  }
  return parseLines(stdout, (cols) => ({ id: cols[0]!, name: cols[1]! }));
}

async function listPanes(ctx: TmuxContext, sessionTarget?: string): Promise<Pane[]> {
  const fmt =
    "#{pane_id}\t#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{pane_width}\t#{pane_height}";
  const args = ["list-panes", "-F", fmt];
  if (sessionTarget !== undefined) {
    args.push("-s", "-t", sessionTarget); // -s = all windows in session
  } else {
    args.push("-a"); // all panes across all sessions
  }
  const { stdout } = await runTmux(ctx, args);
  return parseLines(stdout, (cols) => ({
    id: cols[0]!,
    sessionId: cols[1]!,
    sessionName: cols[2]!,
    windowId: cols[3]!,
    windowIndex: Number(cols[4]),
    width: Number(cols[5]),
    height: Number(cols[6]),
  }));
}

/**
 * Write arbitrary text into a pane as if it were pasted. Binary-safe;
 * shell-quote-free. Does NOT submit Enter unless your data contains a
 * newline. Use `sendKeys` for control keys (C-c, Enter alone, etc.).
 */
async function writePane(ctx: TmuxContext, paneId: string, data: string | Buffer): Promise<void> {
  // Buffer name is visible to `tmux list-buffers`; keep it brand-free.
  const buffer = `b${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await runTmux(ctx, ["load-buffer", "-b", buffer, "-"], { stdin: data });
  await runTmux(ctx, ["paste-buffer", "-b", buffer, "-t", paneId, "-d"]);
}

/**
 * Send key names directly: e.g. `sendKeys(p, ["C-c"])`, `sendKeys(p, ["Enter"])`,
 * `sendKeys(p, ["echo hi", "Enter"])`. Pass `-l` literal mode by using `write`
 * for arbitrary text - `send-keys` interprets its arguments as key names.
 */
async function sendKeys(ctx: TmuxContext, paneId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await runTmux(ctx, ["send-keys", "-t", paneId, ...keys]);
}

/** Snapshot a pane's visible contents (and optionally scrollback). */
async function capturePane(
  ctx: TmuxContext,
  paneId: string,
  opts: CaptureOptions = {},
): Promise<string> {
  const args = ["capture-pane", "-p", "-t", paneId];
  if (opts.joinWrapped !== false) args.push("-J");
  if (opts.ansi) args.push("-e");
  if (opts.start !== undefined) args.push("-S", String(opts.start));
  if (opts.end !== undefined) args.push("-E", String(opts.end));
  const { stdout } = await runTmux(ctx, args);
  return stdout;
}

/** Stream a pane's live output. Returns a Readable + close handle. */
async function subscribePane(
  ctx: TmuxContext,
  paneId: string,
  opts: { pollMs?: number } = {},
): Promise<Subscription> {
  const pollMs = opts.pollMs ?? 100;
  // mktemp(1)-style: `tmp.XXXXXXXX` under the system temp dir. Nothing in the
  // filename hints at the library or its purpose.
  const path = join(tmpdir(), `tmp.${randomBytes(8).toString("hex")}`);
  if (path.includes("'")) {
    throw new Error(`refusing to use log path with single quote: ${path}`);
  }

  // Create the file empty so tmux's `>>` append doesn't race us.
  await writeFile(path, "");

  await runTmux(ctx, ["pipe-pane", "-t", paneId, `cat >> '${path}'`]);

  let offset = 0;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const stream = new Readable({
    read() {
      // Pull-mode is a no-op; the poll loop pushes data as it arrives.
    },
  });

  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      const s = await stat(path);
      if (s.size > offset) {
        const fh = await open(path, "r");
        try {
          const buf = Buffer.alloc(s.size - offset);
          await fh.read(buf, 0, buf.length, offset);
          offset = s.size;
          if (!closed) stream.push(buf);
        } finally {
          await fh.close();
        }
      }
    } catch {
      // File may have been unlinked during close; ignore.
    }
    if (!closed) pollTimer = setTimeout(tick, pollMs);
  };
  pollTimer = setTimeout(tick, pollMs);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    await runTmux(ctx, ["pipe-pane", "-t", paneId], { check: false });
    stream.push(null); // signal end-of-stream
    await unlink(path).catch(() => {});
  };

  return { stream, close };
}

/** Kill the entire tmux server on this socket. */
async function shutdown(ctx: TmuxContext): Promise<void> {
  await runTmux(ctx, ["kill-server"], { check: false });
}

function parseLines<T>(stdout: string, mapRow: (cols: string[]) => T): T[] {
  return stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => mapRow(l.split("\t")));
}
