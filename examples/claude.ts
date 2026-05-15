/**
 * Drive interactive `claude` inside a tmux pane and read its responses
 * from the transcript file — same outcome as `claude -p`, but the process
 * stays alive across asks so context is preserved.
 *
 * Run with:  bun examples/claude.ts
 */
import { createClaudeSession, createTmux } from "../src/index.js";

async function main() {
  const tmux = createTmux();
  await tmux.shutdown(); // clean slate

  const session = createClaudeSession({
    tmux,
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    model: "haiku",
    extraArgs: ["--tools", ""], // no tools — keep the turn short and deterministic
  });

  console.log("starting claude…");
  console.log("  transcript:", session.transcriptPath);
  await session.start();
  console.log("  pane:", session.getPane().id);

  console.log("\nask #1: simple arithmetic");
  const a1 = await session.ask("What is 17 * 23? Answer with just the number.");
  console.log("→", a1.trim());

  console.log("\nask #2: follow-up that requires remembering the first turn");
  const a2 = await session.ask("Now divide that by 7 and round down. Just the number.");
  console.log("→", a2.trim());

  await session.close();
  await tmux.shutdown();
  console.log("\ndone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
