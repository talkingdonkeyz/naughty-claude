import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Pane, Session, Tmux } from "./tmux.js";

export interface ClaudeSessionOptions {
  /** Tmux primitives client. The caller owns its lifecycle. */
  tmux: Tmux;
  /** Project root claude should run in. Determines the transcript path. Defaults to process.cwd(). */
  cwd?: string;
  /** Session UUID. Auto-generated if omitted. */
  sessionId?: string;
  /** Display name shown in claude's prompt box. */
  name?: string;
  /** Model alias or full name (e.g. "opus", "sonnet"). */
  model?: string;
  /** Permission mode. Use "bypassPermissions" for unattended runs. */
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  /** Override the claude binary. */
  claudeBin?: string;
  /** Initial pane size. Wider is better — Claude's TUI wraps aggressively. */
  width?: number;
  height?: number;
  /** Extra CLI flags forwarded to claude. */
  extraArgs?: readonly string[];
}

export interface AskOptions {
  /** Max time to wait for the turn to complete. Default: 5 min. */
  timeoutMs?: number;
  /** Transcript poll interval. Default: 200ms. */
  pollMs?: number;
}

interface StartOptions {
  readyTimeoutMs?: number;
  idleMs?: number;
}

export interface ClaudeSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string;
  getPane(): Pane;
  start(opts?: StartOptions): Promise<void>;
  ask(prompt: string, opts?: AskOptions): Promise<string>;
  close(): Promise<void>;
}

interface ClaudeSessionState {
  readonly opts: ClaudeSessionOptions;
  readonly tmux: Tmux;
  readonly cwd: string;
  readonly sessionId: string;
  readonly transcriptPath: string;
  tmuxSession?: Session;
  pane?: Pane;
}

/**
 * One persistent interactive `claude` process running inside a tmux pane.
 * `ask()` may be called repeatedly; the conversation accumulates context
 * just as it would with a human user typing.
 */
export function createClaudeSession(opts: ClaudeSessionOptions): ClaudeSession {
  const state = createClaudeSessionState(opts);

  return {
    sessionId: state.sessionId,
    cwd: state.cwd,
    transcriptPath: state.transcriptPath,
    getPane: () => getPane(state),
    start: (opts) => startSession(state, opts),
    ask: (prompt, opts) => askSession(state, prompt, opts),
    close: () => closeSession(state),
  };
}

function createClaudeSessionState(opts: ClaudeSessionOptions): ClaudeSessionState {
  const tmux = opts.tmux;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const sessionId = opts.sessionId ?? randomUUID();
  const transcriptPath = join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectDir(cwd),
    `${sessionId}.jsonl`,
  );
  return {
    opts,
    tmux,
    cwd,
    sessionId,
    transcriptPath,
  };
}

function getPane(state: ClaudeSessionState): Pane {
  if (!state.pane) throw new Error("ClaudeSession not started");
  return state.pane;
}

/**
 * Spawn claude in a fresh tmux session and wait for the TUI to settle.
 *
 * Claude doesn't write the transcript file until the first prompt is
 * submitted, so we can't use file existence as a readiness signal. Instead
 * we subscribe to pane output and wait until it goes idle for `idleMs` —
 * the welcome animation finishes and the input box stabilizes.
 */
async function startSession(state: ClaudeSessionState, startOpts: StartOptions = {}): Promise<void> {
  const { opts, tmux } = state;
  const claudeBin = opts.claudeBin ?? "claude";
  const claudeArgs = ["--session-id", state.sessionId];
  if (opts.name) claudeArgs.push("-n", opts.name);
  if (opts.model) claudeArgs.push("--model", opts.model);
  if (opts.permissionMode) {
    claudeArgs.push("--permission-mode", opts.permissionMode);
  }
  if (opts.extraArgs) claudeArgs.push(...opts.extraArgs);

  const command = `exec ${shellQuote(claudeBin)} ${claudeArgs.map(shellQuote).join(" ")}`;

  // No `name:` — let tmux auto-assign (0, 1, …). A `claude-*` prefix would
  // be a brand-leaking fingerprint visible to anything that lists sessions.
  const session = await tmux.createSession({
    cwd: state.cwd,
    width: opts.width ?? 200,
    height: opts.height ?? 50,
    command,
  });
  state.tmuxSession = session;

  const panes = await tmux.listPanes(session.id);
  const firstPane = panes[0];
  if (!firstPane) throw new Error("no pane after createSession");
  state.pane = firstPane;

  await waitForIdle(state, {
    timeoutMs: startOpts.readyTimeoutMs ?? 30_000,
    idleMs: startOpts.idleMs ?? 800,
  });
}

/**
 * Wait for the pane's visible contents to stop changing. Implemented via
 * polled `capture-pane` rather than a streaming subscription so we don't
 * keep file handles or pipes open across the operation — important for
 * clean process exit on both Node and Bun.
 */
async function waitForIdle(
  state: ClaudeSessionState,
  waitOpts: { timeoutMs: number; idleMs: number },
): Promise<void> {
  const pollMs = 100;
  const deadline = Date.now() + waitOpts.timeoutMs;
  let last = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const snapshot = await state.tmux.capture(getPane(state).id);
    const now = Date.now();
    if (snapshot === last) {
      if (stableSince === 0) stableSince = now;
      if (now - stableSince >= waitOpts.idleMs) return;
    } else {
      last = snapshot;
      stableSince = 0;
    }
    await sleep(pollMs);
  }
  throw new Error(`pane never went idle within ${waitOpts.timeoutMs}ms`);
}

/**
 * Send a prompt and return the final assistant text, mirroring `claude -p`.
 * Intermediate tool-use turns are awaited; only the terminal assistant
 * message of the turn is returned.
 */
async function askSession(
  state: ClaudeSessionState,
  prompt: string,
  askOpts: AskOptions = {},
): Promise<string> {
  const activePane = getPane(state);
  const timeoutMs = askOpts.timeoutMs ?? 5 * 60_000;
  const pollMs = askOpts.pollMs ?? 200;

  // Transcript may not exist yet (first turn of a fresh session). Treat
  // missing as zero-length; new bytes will be picked up once claude creates
  // the file in response to the prompt.
  const startSize = await statSizeOrZero(state.transcriptPath);

  await state.tmux.write(activePane.id, prompt);
  // Small grace so the TUI renders the pasted text before we submit.
  await sleep(100);
  await state.tmux.sendKeys(activePane.id, ["Enter"]);

  const deadline = Date.now() + timeoutMs;
  let offset = startSize;
  let leftover = "";
  const records: TranscriptRecord[] = [];

  while (Date.now() < deadline) {
    const size = await statSizeOrZero(state.transcriptPath);
    if (size > offset) {
      const fh = await open(state.transcriptPath, "r");
      const buf = Buffer.alloc(size - offset);
      await fh.read(buf, 0, buf.length, offset);
      await fh.close();
      offset = size;

      const chunk = leftover + buf.toString("utf8");
      const lines = chunk.split("\n");
      leftover = lines.pop() ?? "";

      for (const line of lines) {
        if (!line) continue;
        const parsed = safeJsonParse(line);
        if (parsed) records.push(parsed);
      }

      const result = tryExtractFinalText(records);
      if (result !== null) return result;
    }
    await sleep(pollMs);
  }
  throw new Error(`ClaudeSession.ask timed out after ${timeoutMs}ms`);
}

/** Kill the underlying tmux session. The transcript file remains on disk. */
async function closeSession(state: ClaudeSessionState): Promise<void> {
  if (!state.tmuxSession) return;
  await state.tmux.killSession(state.tmuxSession.id).catch(() => {});
  state.tmuxSession = undefined;
  state.pane = undefined;
}

/**
 * One-shot helper: spin up a claude session, ask one question, tear down.
 * Closest analogue to `claude -p "..."`.
 */
export async function ask(
  prompt: string,
  opts: ClaudeSessionOptions & { askOptions?: AskOptions },
): Promise<string> {
  const { askOptions, ...sessionOpts } = opts;
  const session = createClaudeSession(sessionOpts);
  await session.start();
  try {
    return await session.ask(prompt, askOptions);
  } finally {
    await session.close();
  }
}

function encodeProjectDir(cwd: string): string {
  // Encode absolute path by replacing slashes with dashes, e.g. "/foo/bar" > "-foo-bar".
  return cwd.replace(/\//g, "-");
}

interface TranscriptRecord {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    stop_reason?: string;
    content?: unknown[];
  };
}

/**
 * Returns the final assistant text if the turn is complete, else null.
 *
 * A turn is "complete" when:
 *   1. there is at least one assistant record with a terminal stop_reason
 *      (anything other than "tool_use"), AND
 *   2. at least one non-assistant record has appeared *after* that terminal
 *      assistant record (claude writes a `system` record at the turn
 *      boundary; this is our cue that no more assistant blocks are coming).
 *
 * The returned text is the concatenation of all `text` content blocks from
 * every assistant record sharing the terminal record's message.id — claude
 * splits a single API response into multiple JSONL lines (one per content
 * block) correlated by message.id.
 */
function tryExtractFinalText(records: TranscriptRecord[]): string | null {
  let terminalIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    const stop = r.message?.stop_reason;
    if (r.type === "assistant" && stop && stop !== "tool_use") {
      terminalIdx = i;
      break;
    }
  }
  if (terminalIdx === -1) return null;

  let sawBoundary = false;
  for (let i = terminalIdx + 1; i < records.length; i++) {
    if (records[i]!.type !== "assistant") {
      sawBoundary = true;
      break;
    }
  }
  if (!sawBoundary) return null;

  const targetId = records[terminalIdx]!.message?.id;
  if (!targetId) return null;

  const texts: string[] = [];
  for (const r of records) {
    if (r.type !== "assistant" || r.message?.id !== targetId) continue;
    for (const b of r.message.content ?? []) {
      if (
        b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
      ) {
        texts.push((b as { text: string }).text);
      }
    }
  }
  return texts.join("");
}

async function statSizeOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function safeJsonParse(line: string): TranscriptRecord | null {
  try {
    return JSON.parse(line) as TranscriptRecord;
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./=:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
