// Looking for the apps on this computer never makes the server wait.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetFound } from "../src/found";
import { boot, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; await reset(); });
const realPlatform = process.platform;
const realPath = process.env.PATH;
let bin = "";
afterEach(() => {
  process.env.PATH = realPath;
  Object.defineProperty(process, "platform", { value: realPlatform });
  rmSync(join(process.env.HOME!, "Applications"), { recursive: true, force: true });
  if (bin) rmSync(bin, { recursive: true, force: true });
  forgetFound();
});

test("while Savings looks for apps, the server keeps answering", async () => {
  for (const b of ["Claude.app", "ChatGPT.app", "Perplexity.app", "Cursor.app"]) mkdirSync(join(process.env.HOME!, "Applications", b), { recursive: true });
  // A stand-in for macOS's mdls while Spotlight is busy: it answers after a second, for each app.
  bin = mkdtempSync(join(tmpdir(), "leanfare-mdls-"));
  writeFileSync(join(bin, "mdls"), "#!/bin/sh\nsleep 1\nprintf '2026-03-02 10:00:00 +0000\\0002026-10-20 09:00:00 +0000'\n");
  chmodSync(join(bin, "mdls"), 0o755);
  process.env.PATH = `${bin}:${realPath}`;
  Object.defineProperty(process, "platform", { value: "darwin" });
  forgetFound();
  const t0 = performance.now();
  const plans = ui(url, "/api/plans"); // the Savings page asks
  await Bun.sleep(50);
  const s0 = performance.now();
  const health = await fetch(`${url}/healthz`); // anything else, at the same time (a chat, the menu bar)
  const waited = performance.now() - s0;
  expect((await plans).status).toBe(200);
  expect(health.ok).toBe(true);
  expect(s0 - t0 - 50).toBeLessThan(500); // a 50 ms timer on the server's thread fired on time
  expect(waited).toBeLessThan(500); // and the other request did not wait for Spotlight
}, 30000);
