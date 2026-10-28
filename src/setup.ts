// The first run's Set up: what is on this computer (the AI apps, and the models Leanfare can hand
// work to), and one press that puts Leanfare in each AI app found.
import { allProviders } from "./config";
import { store, type Model } from "./data";
import { appsView, setApp } from "./apps";
import { firstPicks, providerReady, tickTop, usableModels } from "./engine";
import { keyWhere } from "./keys";
import { saveSettings, settings } from "./settings";
import { setSwitch } from "./switch";
import { autoView, setAuto } from "./workers";

const short = (name: string) => name.replace(/ \(and Cowork\)$/, "");

// The AI apps that have Leanfare's tools (from this copy, or from another one).
export const appsIn = () => appsView().filter((a) => a.status === "added" || a.status === "old").map((a) => ({ id: a.id, name: short(a.name) }));

// The models Leanfare hands work to: the ticked ones that can be used now, or, the first time, when
// there are none of those, the first picks of each provider you have (a key found on this computer,
// Ollama), which Set up's press ticks.
function toUse(): { models: Model[]; first: boolean } {
  const usable = usableModels();
  if (usable.length) return { models: usable, first: false };
  return { models: allProviders().filter((p) => providerReady(p.id)).flatMap((p) => firstPicks(p.id)), first: true };
}

const WHERE: Record<string, string> = { keychain: "your key, in the Keychain", file: "your key, saved in Leanfare", environment: "your key, from this computer's settings", shell: "your key, from your Terminal's settings" };

export function setupView() {
  const apps = appsView().filter((a) => a.status !== "not installed")
    .map((a) => ({ id: a.id, name: short(a.name), status: a.status, after: a.after, note: a.note, plansItself: !!a.auto }));
  const use = toUse();
  const using = new Set(use.models.map((m) => m.provider));
  const models = allProviders().filter((p) => using.has(p.id)).map((p) => ({
    id: p.id, name: p.name,
    how: p.id === "ollama" ? `free, on this computer${store.ollama.length ? ` (${store.ollama.length} model${store.ollama.length === 1 ? "" : "s"})` : ""}`
      : p.local ? "on this computer" : p.id === "openrouter" ? "connected" : WHERE[keyWhere(p.id) ?? ""] ?? "ready",
  }));
  // Ollama running with no model yet: Set up offers the free model that fits this computer (Settings, Local models).
  // Done once pressed or skipped, or when Leanfare is in an app already: then the app opens on its screens.
  const setupDone = settings().setupDone || apps.some((a) => a.status === "added" || a.status === "old");
  return { apps, models, ready: use.models.length > 0, ollama: providerReady("ollama"), setupDone, busy };
}

// Set up's one press: Leanfare's tools in every AI app found, and where the app can, it plans by
// itself (a line in its instructions, so it hands simple work over without being asked). Each app is
// done on its own, so one that fails is said and the others still get it.
let busy = false; // a press is still going (after a Stop, until the app it is on is done)
export async function setUp(signal?: AbortSignal) {
  busy = true;
  try { return await setUpApps(signal); } finally { busy = false; }
}
async function setUpApps(signal?: AbortSignal) {
  const results: { id: string; name: string; ok: boolean; after: string; error?: string; note?: string }[] = [];
  const said = (e: any) => String(e?.message ?? e);
  for (const a of appsView()) {
    if (signal?.aborted) break; // Stop: the apps done so far keep Leanfare, the rest are left as they were
    if (a.status === "not installed" || a.status === "broken") continue;
    const name = short(a.name);
    try {
      if (a.status !== "added") await setApp(a.id, true);
    } catch (e: any) {
      results.push({ id: a.id, name, ok: false, after: a.after, error: said(e) });
      continue;
    }
    // Leanfare's tools are in. Planning by itself is extra: when it cannot be written, the app is still on.
    let note: string | undefined;
    try {
      const auto = autoView(a.id);
      if (auto && !auto.on) setAuto(a.id, true);
    } catch (e: any) { note = `${name} does not plan by itself yet: ${said(e)}`; }
    results.push({ id: a.id, name, ok: true, after: a.after, ...(note ? { note } : {}) });
  }
  if (results.some((r) => r.ok)) { // with Leanfare in no app, Set up is still to do
    if (toUse().first) for (const p of allProviders()) if (providerReady(p.id)) tickTop(p.id);
    saveSettings({ setupDone: true });
    setSwitch(true);
  }
  return { results, setup: setupView() };
}
