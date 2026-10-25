// Runs before every test file (bunfig.toml). Tests never touch your real
// ~/.leanfare, your keychain, your keys or the internet.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake } from "./fake";

process.env.TZ = "UTC";
process.env.LEANFARE_DATA_DIR = mkdtempSync(join(tmpdir(), "leanfare-test-"));
// Your plans reads Claude Code's and Codex's log files: tests look only in their own folders, never your real ones.
process.env.CLAUDE_CONFIG_DIR = join(process.env.LEANFARE_DATA_DIR, "claude-logs");
process.env.CODEX_HOME = join(process.env.LEANFARE_DATA_DIR, "codex-logs");
process.env.LEANFARE_KEYSTORE = "file";
process.env.LEANFARE_NO_OPEN = "1";
process.env.LEANFARE_NOW = "2026-10-21T12:00:00Z";
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY"]) delete process.env[k];

const fake = startFake();
fake.pointEnv();
process.env.LEANFARE_DATA_URL = `${fake.base}/data.json`;
(globalThis as any).__fake = fake;

// Every address Leanfare reaches is written down, for the privacy test.
const outgoing: string[] = [];
(globalThis as any).__outgoing = outgoing;
const realFetch = globalThis.fetch;
const recording = ((input: any, init?: any) => {
  outgoing.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = Object.assign(recording, { preconnect: (realFetch as any).preconnect });
