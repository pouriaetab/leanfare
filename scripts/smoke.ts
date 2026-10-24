// The live check: start the real `leanfare` command in a
// throwaway folder against fake providers, use it the way a person and an app
// would, then stop it with `leanfare stop`. Exit code 1 if anything is wrong.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake, KEYS } from "../test/fake";

const root = new URL("..", import.meta.url).pathname;
const fake = startFake();
const port = 4700 + Math.floor(Math.random() * 40);
const env: Record<string, string> = { ...process.env as Record<string, string>, LEANFARE_DATA_DIR: mkdtempSync(join(tmpdir(), "leanfare-smoke-")), LEANFARE_KEYSTORE: "file", LEANFARE_NO_OPEN: "1", LEANFARE_DATA_URL: `${fake.base}/data.json` };
for (const [id, b] of Object.entries(fake.bases)) env[`LEANFARE_${id.toUpperCase()}_BASE`] = b;
const url = `http://127.0.0.1:${port}`;
const steps: [string, boolean, string][] = [];
const step = (name: string, ok: boolean, detail = "") => { steps.push([name, ok, detail]); console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`); };
const cli = (...args: string[]) => Bun.spawn([process.execPath, join(root, "src/cli.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });

const t0 = performance.now();
const app = cli("--port", String(port));
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  up = await fetch(`${url}/healthz`).then((r) => r.ok).catch(() => false);
  if (!up) await Bun.sleep(50);
}
const ms = Math.round(performance.now() - t0);
step("starts and answers", up, `${ms} ms`);
step("starts within 1 second", ms < 1000, `${ms} ms`);
const ui = (path: string, body?: unknown) => fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
try {
  const page = await fetch(url + "/");
  step("the app's page opens", page.status === 200 && (await page.text()).includes("Leanfare"));
  const key = await ui("/api/keys", { provider: "google", key: KEYS.google });
  step("a key is tested and saved", key.ok === true, key.message);
  const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Say hello [usage 2000 500]" }] }) });
  const j: any = await r.json();
  step("another app gets an answer through Auto", r.status === 200 && typeof j.choices?.[0]?.message?.content === "string", r.headers.get("x-leanfare-model") ?? "");
  step("the answer carries its cost", /^\d+\.\d{8}$/.test(r.headers.get("x-leanfare-cost-usd") ?? ""), r.headers.get("x-leanfare-cost-usd") ?? "none");
  const chat = await fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Hello from the chat" }] }) });
  const events = (await chat.text()).split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
  step("the chat streams an answer and its cost", events.some((e) => e.type === "delta") && events.some((e) => e.type === "done" && typeof e.result.cost === "number"));
  const s = await ui("/api/savings");
  step("the savings page counts both answers", s.answers === 2, `${s.answers} answers, $${s.spent.toFixed(6)}`);
  const status = cli("status");
  step("leanfare status says it is running", (await status.exited) === 0, (await new Response(status.stdout).text()).split("\n")[0]);
} catch (e) {
  step("no unexpected error", false, String(e));
}
const stop = cli("stop");
const stopCode = await stop.exited;
const appCode = await Promise.race([app.exited, Bun.sleep(5000).then(() => -1)]);
step("leanfare stop ends it cleanly", stopCode === 0 && appCode === 0, `stop ${stopCode}, app ${appCode}`);
if (appCode === -1) app.kill();
fake.server.stop(true);
const failed = steps.filter((s) => !s[1]).length;
console.log(failed ? `\nSmoke test: ${failed} of ${steps.length} steps failed.` : `\nSmoke test: all ${steps.length} steps passed.`);
process.exit(failed ? 1 : 0);
