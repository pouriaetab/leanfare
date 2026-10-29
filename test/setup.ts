// Runs before every test file (bunfig.toml). Tests never touch your real
// ~/.leanfare, your keychain, your keys or the internet.
import { setDefaultTimeout } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake } from "./fake";

// Each test may take 20 seconds: a busy computer is slower than a quiet one. Bun 1.4 ignores bunfig.toml's
// [test] timeout, so the limit is set here (29 Oct: on his Mac, two tests failed at Bun's own 5 seconds).
setDefaultTimeout(20_000);
process.env.TZ = "UTC";
process.env.LEANFARE_DATA_DIR = mkdtempSync(join(tmpdir(), "leanfare-test-"));
// Your plans reads Claude Code's and Codex's log files: tests look only in their own folders, never your real ones.
process.env.CLAUDE_CONFIG_DIR = join(process.env.LEANFARE_DATA_DIR, "claude-logs");
process.env.CODEX_HOME = join(process.env.LEANFARE_DATA_DIR, "codex-logs");
process.env.LEANFARE_KEYSTORE = "file";
process.env.LEANFARE_NO_OPEN = "1";
process.env.LEANFARE_SHELL_ENV = "off"; // tests never read your login shell's variables (shellenv.test.ts uses a fake shell)
process.env.LEANFARE_LOCAL_PORTS = "none"; // nor look for model apps on this computer's ports (providers.test.ts points at fakes)
process.env.LEANFARE_UPDATE_CHECK = "off"; // nor ask GitHub for new versions (update.test.ts uses a stand in)
process.env.LEANFARE_NOW = "2026-10-21T12:00:00Z";
// Claude Code's own claude command is never run by a test: a test that needs one sets the stand in (fakeclaude.ts).
process.env.LEANFARE_CLAUDE_BIN = join(process.env.LEANFARE_DATA_DIR, "no-claude-command");
// Every provider's key variable, so no key of yours is ever used or read by a test.
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY",
  "PERPLEXITY_API_KEY", "PPLX_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (k.endsWith("_API_KEY")) delete process.env[k];
// A home of the tests' own: Find my keys and Use in your apps never read or write your real files.
process.env.HOME = mkdtempSync(join(tmpdir(), "leanfare-test-home-"));
// The apps Savings finds (found.ts) are looked for only in the tests' own Applications folder.
process.env.LEANFARE_APP_FOLDERS = join(process.env.HOME, "Applications");
// A project of the tests' own: plan_status saves the answers in .leanfare/ of the folder it runs in, never this repo's.
process.chdir(mkdtempSync(join(tmpdir(), "leanfare-test-project-")));

const fake = startFake();
fake.pointEnv();
process.env.LEANFARE_DATA_URL = `${fake.base}/data.json`;
process.env.LEANFARE_MODELSDEV_URL = `${fake.base}/models-dev/api.json`; // never the real models.dev
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
