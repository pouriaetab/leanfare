// The files a delegated task names (see delegate.ts), read by Leanfare itself, so their
// text never enters the caller's context. The MCP door uses this: it runs where the MCP
// client started it, so a relative path starts from the client's folder (Claude Code's
// project), or from the folder the caller names.
//
// What it never reads: anything that is not a plain file (a folder, a device, a pipe),
// anything that is not text (a NUL byte in its first 8 KB), and files that hold secrets:
// .env files and their kin, private keys and certificates, credential and token files
// (other AI tools' sign ins among them), and anything inside .ssh, .gnupg, .aws, .git, a
// keychain, or Leanfare's own folder (where its keys live). Names are compared without
// regard to case, as a Mac's disk does. A link is judged by its own name and by where it
// points. At most 50 files, 2 MB each, 4 MB in all, counted as they are read: a file's
// reported size is not trusted (some report 0 and never end).
//
// What a model sees as a file's name: the path from the folder when the file is inside it,
// otherwise the full path with the home folder written as ~ (your user name stays out).
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config";

export const DELEGATE_LIMITS = { file: 2 * 1024 * 1024, total: 4 * 1024 * 1024, count: 50, task: 200_000 };
export interface DelegateFile { name: string; text: string }

// Folders whose files are never read, wherever they are (compared in lower case).
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".git", "keychains", "keyrings"]);
// Folders under .config that hold sign ins (the GitHub and Google Cloud command line tools, 1Password).
const SECRET_CONFIG = new Set(["gh", "gcloud", "op", "hub"]);
const SECRET_NAME = [
  /^\.env(?:[._-].+)?$/i, // .env, .env.local, .env-production, .env_local (but not the samples below)
  /^.+\.env$/i, // production.env
  /^(\.envrc|\.dev\.vars)$/i, // direnv's and Cloudflare's local secrets
  /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg|pgp|keychain|keychain-db|tfvars|tfstate|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
  // Credential and token files, Claude Code's and Codex's own sign ins among them.
  /^(\.netrc|_netrc|\.npmrc|\.yarnrc\.yml|\.pypirc|\.pgpass|\.git-credentials|\.dockercfg|\.htpasswd|\.boto|\.s3cfg|\.vault-token|\.terraformrc|\.credentials\.json|auth\.json|credentials(\.[a-z]+)?|\.secrets?|secrets?\.(json|ya?ml|toml|env|txt))$/i,
  /(service[-_]?account|client[-_]?secret)[^/\\]*\.json$/i, // cloud service account keys, OAuth client secrets
];
const SAMPLE_ENV = /\.(example|sample|template|dist)$/i; // .env.example and the like

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

// Why a path must not be read, or null when it may be.
export function secretReason(path: string): string | null {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  const dirs = parts.slice(0, -1).map((d) => d.toLowerCase());
  const owns = [resolve(DATA_DIR)];
  try { owns.push(realpathSync(DATA_DIR)); } catch {}
  const low = path.toLowerCase();
  if (owns.some((o) => low === o.toLowerCase() || low.startsWith(o.toLowerCase() + sep))) return "it is inside Leanfare's own folder, where its keys live";
  const inDir = dirs.find((d) => SECRET_DIRS.has(d));
  if (inDir) return `it is inside ${inDir === "keychains" || inDir === "keyrings" ? "a keychain" : inDir}, which holds keys or sign ins`;
  const ci = dirs.indexOf(".config");
  if (ci >= 0 && SECRET_CONFIG.has(dirs[ci + 1] ?? "")) return `it is inside .config/${dirs[ci + 1]}, which holds a sign in`;
  if (!SAMPLE_ENV.test(name) && SECRET_NAME.some((re) => re.test(name))) return "files like it hold secrets (keys, passwords or tokens)";
  return null;
}

// A path as the caller wrote it: full, ~/..., file://..., or relative to the folder.
export function resolvePath(given: string, folder: string): string {
  const t = given.trim();
  if (/^file:\/\//i.test(t)) return fileURLToPath(t);
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return join(homedir(), t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(folder, t);
}

// A full path with the home folder written as ~.
export function tilde(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~/${path.slice(home.length + 1).split(sep).join("/")}` : path;
}

// What the model sees as the file's name. A file reached through a linked folder (a Mac's
// /var is /private/var) is also tried by its folder's real path, so it still gets its short name.
export function shownName(path: string, folder: string): string {
  const inside = (p: string) => { const rel = relative(folder, p); return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : null; };
  let name = inside(path);
  if (name === null) { try { name = inside(join(realpathSync(dirname(path)), basename(path))); } catch {} }
  return name ?? tilde(path);
}

const tooBig = (t: string) => `${t} is more than ${mb(DELEGATE_LIMITS.file)}; delegate reads at most ${mb(DELEGATE_LIMITS.file)} a file. Hand over the part that matters (for example the last lines of a log).`;
const tooMuch = `These files add up to more than ${mb(DELEGATE_LIMITS.total)}, the most delegate reads at once. Hand over fewer of them.`;

// At most `limit` bytes of a plain file, or null when it holds more. Opened without
// following a link (it was resolved already) and without waiting on a pipe, and checked
// again once open, so a file swapped after the checks above is not read either.
function readAtMost(path: string, limit: number): Buffer | null | "not a file" {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return "not a file";
    const CHUNK = 65536; // whole chunks: some files only take reads in steps of 8 bytes
    const buf = Buffer.allocUnsafe(limit + CHUNK);
    let n = 0;
    while (n <= limit) {
      const got = readSync(fd, buf, n, CHUNK, null);
      if (got === 0) break;
      n += got;
    }
    return n > limit ? null : buf.subarray(0, n);
  } finally { closeSync(fd); }
}

// The files, read, or one sentence saying what is wrong. Nothing is handed over unless every file can be.
export function readForDelegate(list: unknown, folderGiven?: unknown): DelegateFile[] | string {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string" || !p.trim())) return "files must be a list of file paths.";
  if (list.length > DELEGATE_LIMITS.count) return `At most ${DELEGATE_LIMITS.count} files go with one task.`;
  const named = typeof folderGiven === "string" && folderGiven.trim() !== "";
  let folder = process.cwd();
  if (named) {
    const f = resolvePath(folderGiven as string, process.cwd());
    try { if (!statSync(f).isDirectory()) return `${folderGiven} is not a folder.`; } catch { return `The folder ${folderGiven} does not exist.`; }
    folder = realpathSync(f);
  }
  const out: DelegateFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const given of list as string[]) {
    const t = given.trim();
    const isRelative = !isAbsolute(t) && !t.startsWith("~") && !/^file:\/\//i.test(t);
    if (isRelative && !named && folder === resolve("/")) return `${t} is a relative path, and Leanfare does not know your project's folder here. Give full paths, or the folder in folder.`;
    let path: string;
    try { path = resolvePath(t, folder); } catch { return `${t} is not a path Leanfare can read.`; }
    let real: string;
    try { real = realpathSync(path); } catch { return `${t} does not exist${isRelative ? ` (Leanfare looked in ${tilde(folder)})` : ""}.`; }
    const why = secretReason(path) ?? (real !== path ? secretReason(real) : null);
    if (why) return `${t} was not read: ${why}. Leanfare never hands those to a model.`;
    let st, bytes;
    try {
      st = statSync(real);
      if (st.isDirectory()) return `${t} is a folder. Name the files in it instead (at most ${DELEGATE_LIMITS.count}).`;
      if (!st.isFile()) return `${t} is not a plain file.`;
      if (seen.has(real)) continue; // named twice: read once
      seen.add(real);
      if (st.size > DELEGATE_LIMITS.file) return tooBig(t);
      bytes = readAtMost(real, Math.min(DELEGATE_LIMITS.file, DELEGATE_LIMITS.total - total));
    } catch (e: any) {
      return `${t} could not be read${e?.code === "EACCES" || e?.code === "EPERM" ? ": this computer does not let Leanfare open it" : ` (${String(e?.code ?? e?.message ?? e)})`}.`;
    }
    const room = Math.min(DELEGATE_LIMITS.file, DELEGATE_LIMITS.total - total);
    if (bytes === "not a file") return `${t} is not a plain file.`;
    if (bytes === null) return room < DELEGATE_LIMITS.file ? tooMuch : tooBig(t);
    total += bytes.length;
    if (bytes.subarray(0, 8192).includes(0)) return `${t} is not a text file. delegate reads text files only.`;
    out.push({ name: shownName(path, folder), text: new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "") });
  }
  return out;
}
