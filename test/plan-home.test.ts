// Naming the home folder in a plan: the shell's history and other dotfiles are left out.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPlan, forgetPlans, makePlan, runView, startRun } from "../src/planner";
import { ALL_TICKED, boot, fake, keys, reset } from "./app";

beforeAll(async () => { await boot(); });
beforeEach(async () => { fake.hooks.answer = null; forgetPlans(); await reset({ ticked: ALL_TICKED }); });
async function until(ok: () => boolean, ms = 10_000) { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); }

test("the home folder named in the Plan tab: ~/.zsh_history and ~/.zshrc never reach a model", async () => {
  await keys("openai", "google", "deepseek");
  const home = process.env.HOME!;
  // Made up keys, put together here so no scan takes this file for one that holds a key.
  const historyKey = ["sk", "live", "HISTORY", "SECRET", "123"].join("-"), shellKey = ["sk", "ant", "ZSHRC", "SECRET", "456"].join("-");
  writeFileSync(join(home, ".zsh_history"), `: 1761400000:0;export OPENAI_API_KEY=${historyKey}\n: 1761400100:0;ls\n`);
  writeFileSync(join(home, ".zshrc"), `export PATH=$HOME/bin:$PATH\nexport ANTHROPIC_API_KEY=${shellKey}\n`);
  mkdirSync(join(home, "notes"), { recursive: true });
  writeFileSync(join(home, "notes", "todo.md"), "- call the bank\n");
  const v = checkPlan({ task: "Sort out my notes and tell me what is left to do", paths: [home], split: "rules" }); // the home folder, by its full path (os.homedir() in tests is not the tests' HOME)
  if (typeof v === "string") throw new Error(v);
  const prompts: string[] = [];
  fake.hooks.answer = (p) => { prompts.push(p); return null; };
  const plan = await makePlan({ ...v, signal: new AbortController().signal });
  startRun(plan.id, { paid: true });
  await until(() => !runView(plan.id)!.running);
  expect(prompts.some((p) => p.includes(historyKey) || p.includes(shellKey))).toBe(false);
  expect(prompts.some((p) => p.includes("call the bank"))).toBe(true); // the notes themselves went
});
