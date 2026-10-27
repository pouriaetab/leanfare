// Big files and folders in a plan are measured, never read whole or copied while it is placed.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetPlans, makePlan } from "../src/planner";
import { sizesForPlan } from "../src/readfiles";
import { ALL_TICKED, boot, fake, keys, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });

describe("big files in a plan", () => {
  test("a 3 GB log named in the plan (as the MCP door sends it): the plan is made", async () => {
    await keys("openai", "google", "deepseek");
    const dir = mkdtempSync(join(tmpdir(), "r3a-"));
    const big = join(dir, "server.log");
    const fd = openSync(big, "w"); ftruncateSync(fd, 3 * 1024 ** 3); closeSync(fd); // sparse: no disk used
    const files = sizesForPlan([big], dir); // what mcp.ts does: a named file is counted whatever its size
    if (typeof files === "string") throw new Error(files);
    const r = await ui(url, "/api/plan", { task: "Find the errors in this log and tell me why the job fails", files: files.map((f) => ({ name: f.name, size: f.size })), split: "rules" });
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).toBe(200);
  });

  test("a 300 MB folder: the plan is quick, and holds no copy of it", async () => {
    await keys("openai", "google", "deepseek");
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const r = await makePlan({ task: "Find the errors in these logs and tell me why the job fails", files: [{ name: "logs/ (150 files)", size: 300 * 1024 ** 2 }], manager: null, split: "rules", signal: new AbortController().signal });
    const ms = performance.now() - t0;
    const rss1 = process.memoryUsage().rss;
    expect(ms).toBeLessThan(1000);
  });
});
