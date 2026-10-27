// Taking Leanfare's tools out of an app also takes out its Plan by itself pieces.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ALL_TICKED, boot, reset, ui } from "./app";
import { START } from "../src/workers";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => {
  rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
  mkdirSync(process.env.CODEX_HOME!, { recursive: true });
  await reset({ ticked: ALL_TICKED });
});

test("Remove (Leanfare's tools out of Codex) also takes out its block in AGENTS.md", async () => {
  expect((await ui(url, "/api/apps", { id: "codex", on: true })).status).toBe(200);
  expect((await ui(url, "/api/apps", { id: "codex", auto: true })).json.apps.find((a: any) => a.id === "codex").auto.on).toBe(true);
  const r = await ui(url, "/api/apps", { id: "codex", on: false }); // Settings, Use Leanfare in your apps: Remove
  const codex = r.json.apps.find((a: any) => a.id === "codex");
  const file = join(process.env.CODEX_HOME!, "AGENTS.md");
  expect(existsSync(file) ? readFileSync(file, "utf8").includes(START) : false).toBe(false);
  expect(codex.auto).toMatchObject({ on: false, partly: false });
});
