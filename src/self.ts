// How another program starts this Leanfare: an MCP client (Claude Desktop, Cursor...) or Claude
// Code's status line. Either the single file Leanfare was compiled into, or Bun running this
// copy's cli.ts. Absolute paths, so it works whatever that program's PATH holds.
import { fileURLToPath } from "node:url";

// A path, not a URL's pathname: a folder with a space (or a Windows drive) must stay a real path.
const cli = () => fileURLToPath(new URL("./cli.ts", import.meta.url));

// A compiled Leanfare runs from Bun's own embedded file system ($bunfs, or ~BUN on Windows).
export const compiled = () => Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");

export function selfCommand(...args: string[]): { command: string; args: string[] } {
  return compiled() ? { command: process.execPath, args } : { command: process.execPath, args: [cli(), ...args] };
}
