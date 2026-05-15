import { createRunner, TmuxError } from "./runner.js";
import { subscribePane, type Subscription } from "./stream.js";

export { TmuxError, createTmuxError } from "./runner.js";
export type { Subscription } from "./stream.js";
export { ask, createClaudeSession } from "./claude.js";
export type { ClaudeSession, ClaudeSessionOptions, AskOptions } from "./claude.js";


const DEFAULT_SOCKET = "agent"

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

/**
 * A headless, multiplexed tmux client. All operations run against a private
 * tmux server identified by `socket`, so the library never touches the user's
 * interactive tmux unless they explicitly point at the same socket.
 */
export function createTmux(opts: TmuxOptions = {}): Tmux {
  const socket = opts.socket ?? DEFAULT_SOCKET;
  const run = createRunner(socket, opts.tmuxBin);

  async function raw(args: readonly string[], stdin?: string | Buffer): Promise<string> {
    const { stdout } = await run(args, { stdin });
    return stdout;
  }

  // ---------- session lifecycle ----------

  async function createSession(opts: CreateSessionOptions = {}): Promise<Session> {
    const args = ["new-session", "-d", "-P", "-F", "#{session_id}\t#{session_name}"];
    if (opts.name !== undefined) args.push("-s", opts.name);
    if (opts.cwd !== undefined) args.push("-c", opts.cwd);
    if (opts.width !== undefined) args.push("-x", String(opts.width));
    if (opts.height !== undefined) args.push("-y", String(opts.height));
    if (opts.command !== undefined) args.push(opts.command);
    const { stdout } = await run(args);
    const line = stdout.trim().split("\n")[0] ?? "";
    const [id, name] = line.split("\t");
    if (!id || !name) {
      throw new Error(`unexpected new-session output: ${JSON.stringify(stdout)}`);
    }
    return { id, name };
  }

  async function killSession(target: string): Promise<void> {
    await run(["kill-session", "-t", target]);
  }

  async function listSessions(): Promise<Session[]> {
    const { stdout, code, stderr } = await run(
      ["list-sessions", "-F", "#{session_id}\t#{session_name}"],
      { check: false },
    );
    // "no server running" before any session exists — not an error to us.
    if (code !== 0) {
      if (/no server running/i.test(stderr) || /no sessions/i.test(stderr)) return [];
      throw TmuxError(`list-sessions exited ${code}: ${stderr.trim()}`, code, stderr, []);
    }
    return parseLines(stdout, (cols) => ({ id: cols[0]!, name: cols[1]! }));
  }

  async function listPanes(sessionTarget?: string): Promise<Pane[]> {
    const fmt =
      "#{pane_id}\t#{session_id}\t#{session_name}\t#{window_id}\t#{window_index}\t#{pane_width}\t#{pane_height}";
    const args = ["list-panes", "-F", fmt];
    if (sessionTarget !== undefined) {
      args.push("-s", "-t", sessionTarget); // -s = all windows in session
    } else {
      args.push("-a"); // all panes across all sessions
    }
    const { stdout } = await run(args);
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

  // ---------- writing ----------

  /**
   * Write arbitrary text into a pane as if it were pasted. Binary-safe;
   * shell-quote-free. Does NOT submit Enter unless your data contains a
   * newline. Use `sendKeys` for control keys (C-c, Enter alone, etc.).
   */
  async function write(paneId: string, data: string | Buffer): Promise<void> {
    // Buffer name is visible to `tmux list-buffers`; keep it brand-free.
    const buffer = `b${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await run(["load-buffer", "-b", buffer, "-"], { stdin: data });
    await run(["paste-buffer", "-b", buffer, "-t", paneId, "-d"]);
  }

  /**
   * Send key names directly: e.g. `sendKeys(p, ["C-c"])`, `sendKeys(p, ["Enter"])`,
   * `sendKeys(p, ["echo hi", "Enter"])`. Pass `-l` literal mode by using `write`
   * for arbitrary text — `send-keys` interprets its arguments as key names.
   */
  async function sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await run(["send-keys", "-t", paneId, ...keys]);
  }

  // ---------- reading ----------

  /** Snapshot a pane's visible contents (and optionally scrollback). */
  async function capture(paneId: string, opts: CaptureOptions = {}): Promise<string> {
    const args = ["capture-pane", "-p", "-t", paneId];
    if (opts.joinWrapped !== false) args.push("-J");
    if (opts.ansi) args.push("-e");
    if (opts.start !== undefined) args.push("-S", String(opts.start));
    if (opts.end !== undefined) args.push("-E", String(opts.end));
    const { stdout } = await run(args);
    return stdout;
  }

  /** Stream a pane's live output. Returns a Readable + close handle. */
  async function subscribe(paneId: string): Promise<Subscription> {
    return subscribePane(run, paneId);
  }

  // ---------- teardown ----------

  /** Kill the entire tmux server on this socket. */
  async function shutdown(): Promise<void> {
    await run(["kill-server"], { check: false });
  }

  return {
    socket,
    raw,
    createSession,
    killSession,
    listSessions,
    listPanes,
    write,
    sendKeys,
    capture,
    subscribe,
    shutdown,
  };
}

function parseLines<T>(stdout: string, mapRow: (cols: string[]) => T): T[] {
  return stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => mapRow(l.split("\t")));
}
