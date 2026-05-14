import { spawn } from "node:child_process";

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
 * Runs `tmux -L <socket> <...args>` and resolves with captured output.
 * Cross-runtime: uses node:child_process, which Bun implements.
 */
export function createRunner(socket: string, tmuxBin: string = "tmux") {
  const baseArgs = ["-L", socket];

  return async function run(
    args: readonly string[],
    opts: RunOptions = {},
  ): Promise<RunResult> {
    const fullArgs = [...baseArgs, ...args];
    const child = spawn(tmuxBin, fullArgs, {
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
  };
}

export type Runner = ReturnType<typeof createRunner>;
