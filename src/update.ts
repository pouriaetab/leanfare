// Is a newer Leanfare out? Asked of GitHub's public releases list once a day: no account, nothing
// about you or your use is sent, only the request itself. LEANFARE_UPDATE_CHECK=off turns it off,
// and so does the setting in Settings ("Tell me when a new version is out").
import { VERSION } from "./config";
import { compiled } from "./self";

const RELEASES = () => process.env.LEANFARE_RELEASES_URL ?? "https://api.github.com/repos/pouriaetab/leanfare/releases/latest";
export const INSTALL_LINE = "curl -fsSL https://raw.githubusercontent.com/pouriaetab/leanfare/main/install.sh | sh";
export const INSTALL_LINE_WINDOWS = 'powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/pouriaetab/leanfare/main/install.ps1 | iex"';

export const update = { latest: null as string | null, url: null as string | null, checked: 0, error: null as string | null };

// "0.4.1" > "0.4.0"; a tag like "v0.5.0-beta.1" counts as 0.5.0 only once it has no suffix.
const parts = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;
export function newer(a: string, b: string): boolean {
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export async function checkUpdate(signal?: AbortSignal): Promise<void> {
  if (process.env.LEANFARE_UPDATE_CHECK === "off") return;
  try {
    const r = await fetch(RELEASES(), { headers: { accept: "application/vnd.github+json", "user-agent": `leanfare/${VERSION}` }, signal: signal ?? AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const j = (await r.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
    if (j.draft || j.prerelease || !j.tag_name || !parts(j.tag_name)) throw new Error("no release to compare with");
    update.latest = j.tag_name.replace(/^v/, "");
    update.url = typeof j.html_url === "string" && j.html_url.startsWith("https://github.com/") ? j.html_url : null;
    update.error = null;
  } catch (e: any) { update.error = String(e?.message ?? e); }
  update.checked = Date.now();
}

// How this copy is updated: the installer again for the one-file Leanfare, git for a copy of the code.
export function howToUpdate(): string {
  if (compiled()) return process.platform === "win32" ? `In PowerShell: ${INSTALL_LINE_WINDOWS}` : `In Terminal: ${INSTALL_LINE}`;
  return "In your Leanfare folder: git pull, then bun install, then start it again.";
}

export function updateNotice(on: boolean): { kind: "update"; level: "info"; text: string; url: string | null } | null {
  if (!on || !update.latest || !newer(update.latest, VERSION)) return null;
  return { kind: "update", level: "info", text: `Leanfare ${update.latest} is out (you have ${VERSION}). ${howToUpdate()}`, url: update.url };
}
