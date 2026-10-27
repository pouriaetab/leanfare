// Provider keys. On a Mac they go in the macOS Keychain (through Bun's
// Bun.secrets); where no system keychain answers, in a file only your user can
// read (~/.leanfare/keys.json, permissions 600). Keys never go to a log, and
// each is sent only to its own provider. A key already in your environment
// (OPENAI_API_KEY and so on), or exported by your login shell for the Mac app
// (see shellenv.ts), is used when none is saved.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { allProviders, paths, provider, type ProviderId } from "./config";
import { shellEnv } from "./shellenv";

const SERVICE = "leanfare";
type Where = "keychain" | "file" | "environment" | "shell";

const cache = new Map<ProviderId, { key: string; where: Where }>();
let keychain: boolean | null = process.env.LEANFARE_KEYSTORE === "file" ? false : null; // null: not tried yet
let keychainError: string | null = null;

function readFileStore(): Record<string, string> {
  try { return existsSync(paths.keys) ? JSON.parse(readFileSync(paths.keys, "utf8")) : {}; } catch { return {}; }
}
function writeFileStore(all: Record<string, string>) {
  const tmp = `${paths.keys}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, paths.keys);
}

const secrets = (Bun as any).secrets as undefined | {
  get(o: { service: string; name: string }): Promise<string | null>;
  set(o: { service: string; name: string; value: string }): Promise<void>;
  delete(o: { service: string; name: string }): Promise<boolean>;
};

async function keychainWorks(): Promise<boolean> {
  if (keychain !== null) return keychain;
  if (!secrets) { keychain = false; keychainError = "this Bun has no Bun.secrets"; return false; }
  try { await secrets.get({ service: SERVICE, name: "probe" }); keychain = true; }
  catch (e: any) { keychain = false; keychainError = String(e?.message ?? e).slice(0, 160); }
  return keychain;
}

// Read every saved key once at start, so a request never waits on the keychain.
// The new set replaces the old one only when it is complete, so a request never sees a gap.
export async function loadKeys(opts: { shell?: boolean } = {}) {
  const next = new Map<ProviderId, { key: string; where: Where }>();
  const file = readFileStore();
  const useKeychain = await keychainWorks();
  // The login shell's variables, for a Leanfare that did not start from a terminal.
  const sh = opts.shell === false ? {} : await shellEnv();
  for (const p of allProviders()) {
    if (!p.needsKey) continue;
    let key: string | null = null, where: Where = "file";
    if (useKeychain) {
      try { key = await secrets!.get({ service: SERVICE, name: p.id }); where = "keychain"; } catch { key = null; }
    }
    if (!key && file[p.id]) { key = file[p.id]; where = "file"; }
    if (!key) for (const env of p.envKeys) if (process.env[env]) { key = process.env[env]!; where = "environment"; break; }
    if (!key) for (const env of p.envKeys) if (sh[env]) { key = sh[env]; where = "shell"; break; }
    if (key) next.set(p.id, { key, where });
  }
  cache.clear();
  for (const [id, v] of next) cache.set(id, v);
}

export const getKey = (id: ProviderId): string | null => cache.get(id)?.key ?? null;
export const keyWhere = (id: ProviderId): Where | null => cache.get(id)?.where ?? null;
export const allKeys = (): string[] => [...cache.values()].map((v) => v.key);
export const storeName = () => (keychain ? "the macOS Keychain" : `a file only you can read (${paths.keys})`);
export const keychainNote = () => keychainError;

export async function saveKey(id: ProviderId, key: string): Promise<Where> {
  let where: Where = "file";
  if (await keychainWorks()) {
    try { await secrets!.set({ service: SERVICE, name: id, value: key }); where = "keychain"; } catch { where = "file"; }
  }
  const file = readFileStore();
  if (where === "file") file[id] = key; else delete file[id];
  writeFileStore(file);
  cache.set(id, { key, where });
  return where;
}

export async function removeKey(id: ProviderId) {
  if (await keychainWorks()) { try { await secrets!.delete({ service: SERVICE, name: id }); } catch {} }
  const file = readFileStore();
  if (id in file) { delete file[id]; writeFileStore(file); }
  cache.delete(id);
  // A key from the environment comes back after a restart; say so on screen.
  const p = provider(id);
  for (const env of p?.envKeys ?? []) if (process.env[env]) return env;
  return null;
}
