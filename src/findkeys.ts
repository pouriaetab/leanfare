// Find my keys: the API keys you already have on this computer, so you do not paste them one
// by one. Nothing is read until you press Find my keys, nothing is imported until you tick it,
// and a key goes only to its own provider, to test it.
//
// Where it looks (each a key you made for pay per use):
//   - your environment and your login shell's (OPENAI_API_KEY and the like, see shellenv.ts)
//   - Simon Willison's llm: its keys.json
//   - aider: ~/.aider.conf.yml, ~/.env and ~/.aider/oauth-keys.env (its OpenRouter sign in makes a normal key)
//   - Gemini CLI: ~/.gemini/.env
//   - Codex CLI: ~/.codex/auth.json, only when it signs in with an API key
//   - OpenCode: ~/.local/share/opencode/auth.json, only entries of type "api"
//   - Continue: ~/.continue/.env
// Never a subscription login: Codex's ChatGPT tokens, OpenCode's and Gemini CLI's sign ins,
// Claude Code's login and the like are skipped, because other apps may not use them.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS, provider } from "./config";
import { getKey } from "./keys";
import { registry, registryForEnv } from "./providers";
import { shellEnv } from "./shellenv";

export interface FoundKey {
  ref: string; // where to read it again on import: "<source>:<name>"
  provider: string | null; // a built-in provider, or null when it is a models.dev one to add
  registry: { id: string; name: string; api: string } | null;
  label: string; // the provider's name
  where: string; // where it was found, for the screen
  hint: string; // its last four characters
  status: "new" | "same" | "different"; // against the key Leanfare has for that provider
}

const home = () => process.env.HOME || homedir(); // HOME first: it is what your shell and other tools use
const read = (p: string): string | null => { try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; } };
const json = (p: string): any => { const t = read(p); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };

// KEY=value lines (.env files): quotes and a leading "export" allowed, comments skipped.
export function dotenv(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (v) out[m[1]] = v;
  }
  return out;
}

// The few lines of aider's YAML that hold keys: openai-api-key, anthropic-api-key, and
// api-key entries of the form provider=key (a list, or one string).
export function aiderYaml(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  const unq = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  for (const m of text.matchAll(/^(openai|anthropic)-api-key\s*:\s*(\S.*)$/gm)) out[m[1] === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"] = unq(m[2]);
  const pairs = [...text.matchAll(/^\s*-?\s*(?:api-key\s*:\s*)?["']?([a-z][\w-]*)=([^\s"']+)["']?\s*$/gm)];
  for (const m of pairs) out[`${m[1].toUpperCase().replace(/-/g, "_")}_API_KEY`] = m[2];
  return out;
}

const LLM_NAMES: Record<string, string> = { openai: "OPENAI_API_KEY", claude: "ANTHROPIC_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY", groq: "GROQ_API_KEY", perplexity: "PERPLEXITY_API_KEY", deepseek: "DEEPSEEK_API_KEY", grok: "XAI_API_KEY", xai: "XAI_API_KEY", together: "TOGETHER_API_KEY", fireworks: "FIREWORKS_API_KEY", cerebras: "CEREBRAS_API_KEY" };

interface Source { id: string; where: string; vars: () => Promise<Record<string, string>> }

export function sources(): Source[] {
  const h = home();
  const llmDir = process.env.LLM_USER_PATH ?? (process.platform === "darwin" ? join(h, "Library", "Application Support", "io.datasette.llm") : join(h, ".config", "io.datasette.llm"));
  return [
    { id: "env", where: "your environment", vars: async () => Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string" && v) as [string, string][]) },
    { id: "shell", where: "your shell's settings (~/.zshrc and the like)", vars: async () => shellEnv() },
    { id: "llm", where: `llm (${tilde(join(llmDir, "keys.json"))})`, vars: async () => {
      const j = json(join(llmDir, "keys.json"));
      return j && typeof j === "object" ? Object.fromEntries(Object.entries(j).filter(([k, v]) => LLM_NAMES[k] && typeof v === "string").map(([k, v]) => [LLM_NAMES[k], v as string])) : {};
    } },
    { id: "aider", where: "aider (~/.aider.conf.yml, ~/.env, ~/.aider/oauth-keys.env)", vars: async () => ({ ...dotenv(read(join(h, ".env"))), ...dotenv(read(join(h, ".aider", "oauth-keys.env"))), ...aiderYaml(read(join(h, ".aider.conf.yml"))) }) },
    { id: "gemini", where: "Gemini CLI (~/.gemini/.env)", vars: async () => dotenv(read(join(h, ".gemini", ".env"))) },
    { id: "codex", where: "Codex CLI (~/.codex/auth.json)", vars: async (): Promise<Record<string, string>> => {
      const j = json(join(h, ".codex", "auth.json"));
      // A ChatGPT sign in also leaves an OPENAI_API_KEY here; only a sign in with an API key is yours to use elsewhere.
      return j && j.auth_mode === "apikey" && typeof j.OPENAI_API_KEY === "string" ? { OPENAI_API_KEY: j.OPENAI_API_KEY } : {};
    } },
    { id: "opencode", where: "OpenCode (~/.local/share/opencode/auth.json)", vars: async () => {
      const j = json(join(h, ".local", "share", "opencode", "auth.json"));
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries<any>(j ?? {})) if (v?.type === "api" && typeof v.key === "string") out[`${k.toUpperCase().replace(/-/g, "_")}_API_KEY`] = v.key;
      return out;
    } },
    { id: "continue", where: "Continue (~/.continue/.env)", vars: async () => dotenv(read(join(h, ".continue", ".env"))) },
  ];
}

const tilde = (p: string) => (p.startsWith(home()) ? "~" + p.slice(home().length) : p);
const looksLikeKey = (v: string) => v.length >= 16 && v.length <= 400 && !/\s/.test(v);

// Every key found, at most once per provider and key (the first place it was seen is shown).
export async function findKeys(): Promise<FoundKey[]> {
  const reg = await registry().catch(() => null);
  const out: FoundKey[] = [];
  const seen = new Set<string>();
  for (const src of sources()) {
    let vars: Record<string, string> = {};
    try { vars = await src.vars(); } catch { vars = {}; }
    for (const [name, value] of Object.entries(vars)) {
      if (!looksLikeKey(value)) continue;
      const builtIn = PROVIDERS.find((p) => p.needsKey && p.envKeys.includes(name));
      const fromReg = !builtIn && reg && /(_API_KEY|_TOKEN|_KEY)$/.test(name) ? registryForEnv(reg, name) : null;
      if (!builtIn && !fromReg) continue;
      const pid = builtIn?.id ?? `custom-${fromReg!.id}`;
      const dedupe = `${pid}|${value}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const have = getKey(builtIn?.id ?? pid);
      out.push({
        ref: `${src.id}:${name}`, provider: builtIn?.id ?? null, registry: fromReg, label: builtIn?.name ?? fromReg!.name,
        where: src.where, hint: `…${value.slice(-4)}`, status: !have ? "new" : have === value ? "same" : "different",
      });
    }
  }
  return out;
}

// The key itself, read again from where it was found (the screen never holds whole keys).
export async function readFound(ref: string): Promise<string | null> {
  const i = ref.indexOf(":");
  const src = sources().find((s) => s.id === ref.slice(0, i));
  if (!src) return null;
  const v = (await src.vars())[ref.slice(i + 1)];
  return typeof v === "string" && looksLikeKey(v) ? v : null;
}

// A pasted key's provider, by how its keys look: the most telling shapes first. A key that could
// be several (a bare sk-... is OpenAI's old shape and DeepSeek's) lists each, to test in turn.
// A Claude subscription login or an admin key is refused: neither works for answers here.
export function recognize(key: string): { providers: string[]; refuse: string | null } {
  const k = key.trim();
  if (/^sk-ant-oat\d\d-/.test(k)) return { providers: [], refuse: "That is a Claude subscription login, not an API key. Anthropic does not let other apps use it; make an API key at console.anthropic.com." };
  if (/^sk-ant-admin\d\d-/.test(k)) return { providers: [], refuse: "That is an Anthropic admin key; it cannot send messages. Make an API key at console.anthropic.com." };
  const strong = PROVIDERS.filter((p) => p.keyShape && p.id !== "mistral" && p.id !== "deepseek" && p.keyShape.test(k)).map((p) => p.id);
  if (strong.length) return { providers: strong, refuse: null };
  const loose: string[] = [];
  if (/^sk-[0-9a-f]{32}$/.test(k)) loose.push("deepseek", "openai");
  else if (/^sk-[\w-]{20,}$/.test(k)) loose.push("openai", "deepseek");
  if (/^[A-Za-z0-9]{32}$/.test(k)) loose.push("mistral");
  return { providers: loose.filter((id) => !!provider(id)), refuse: null };
}
