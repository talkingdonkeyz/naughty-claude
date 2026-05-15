/**
 * End-to-end smoke test. Creates two sessions on a private socket, writes to
 * each, reads via both `capture` (snapshot) and `subscribe` (stream), and
 * cleans up.
 *
 * Run with:  node --import tsx examples/basic.ts
 *       or:  bun examples/basic.ts
 */
import { createTmux } from "../src/index.js";

// Generic process title — hides the script path from `ps`.
process.title = "node";

async function main() {
  const t = createTmux();

  // Fresh slate.
  await t.shutdown();

  const [a, b] = await Promise.all([
    t.createSession({ name: "alpha", width: 120, height: 30 }),
    t.createSession({ name: "beta", width: 120, height: 30 }),
  ]);
  console.log("created:", a, b);

  const panes = await t.listPanes();
  console.log("panes:", panes);

  const paneA = panes.find((p) => p.sessionId === a.id)!;
  const paneB = panes.find((p) => p.sessionId === b.id)!;

  // Subscribe to pane A's live output BEFORE we write to it.
  const sub = await t.subscribe(paneA.id);
  let streamed = "";
  sub.stream.on("data", (chunk: Buffer) => {
    streamed += chunk.toString("utf8");
  });

  // Write a command to A, submit with Enter.
  await t.write(paneA.id, "echo hello-from-alpha");
  await t.sendKeys(paneA.id, ["Enter"]);

  // Write a different command to B in parallel — proves multiplexing.
  await t.write(paneB.id, "echo hello-from-beta");
  await t.sendKeys(paneB.id, ["Enter"]);

  // Give the shell a moment to render.
  await new Promise((r) => setTimeout(r, 300));

  const snapA = await t.capture(paneA.id);
  const snapB = await t.capture(paneB.id);
  console.log("--- capture(alpha) ---");
  console.log(snapA.trimEnd());
  console.log("--- capture(beta) ---");
  console.log(snapB.trimEnd());

  await sub.close();
  console.log("--- streamed bytes from alpha ---");
  console.log(streamed.trimEnd());

  await t.shutdown();
  console.log("ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
