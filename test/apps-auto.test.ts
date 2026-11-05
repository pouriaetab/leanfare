// Taking Leanfare's tools out of an app also takes out its Plan by itself pieces.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ALL_TICKED, boot, reset, ui } from "./app";
import { START, setAuto } from "../src/workers";
import { setApp } from "../src/apps";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  await reset({ ticked: ALL_TICKED });
});

test("Remove (Leanfare's tools out of Codex, which an older Leanfare added) also takes out its block in AGENTS.md", async () => {
  await setApp("codex", true); // Leanfare lives in Claude only now (0.15): only an older one added it to Codex
  setAuto("codex", true);
  expect((await ui(url, "/api/apps")).json.apps.find((a: any) => a.id === "codex").auto.on).toBe(true);
  const r = await ui(url, "/api/apps", { id: "codex", on: false }); // Settings, Use Leanfare in your apps: Remove
  const codex = r.json.apps.find((a: any) => a.id === "codex");
  const file = join(process.env.CODEX_HOME!, "AGENTS.md");
  expect(existsSync(file) ? readFileSync(file, "utf8").includes(START) : false).toBe(false);
  expect(codex.auto).toMatchObject({ on: false, partly: false });
});
