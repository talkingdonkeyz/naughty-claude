import { open, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import type { Runner } from "./runner.js";

export interface Subscription {
  /** Raw pane bytes as they arrive. Consume with `for await (const chunk of stream)` or `stream.on('data', ...)`. */
  readonly stream: Readable;
  /** Stop the pipe and release resources. Safe to call multiple times. */
  close(): Promise<void>;
}

/**
 * Start streaming a pane's output via `tmux pipe-pane`.
 *
 * Mechanism: tmux appends pane bytes to a regular file; we poll the file
 * for growth and push new bytes into a Readable. No fifos, no long-lived
 * pipes — keeps libuv state minimal so the process exits cleanly when
 * the caller closes the subscription.
 */
export async function subscribePane(
  run: Runner,
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

  await run(["pipe-pane", "-t", paneId, `cat >> '${path}'`]);

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
    await run(["pipe-pane", "-t", paneId], { check: false });
    stream.push(null); // signal end-of-stream
    await unlink(path).catch(() => {});
  };

  return { stream, close };
}
