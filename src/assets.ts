// The screens and the price list that ship with Leanfare. Imported as files, so they are the files
// next to this code when Leanfare runs from its folder, and are carried inside the single file
// when Leanfare is compiled (bun build --compile, scripts/compile.ts): either way a path to read.
// @ts-ignore: a file import gives its path
import indexHtml from "../ui/index.html" with { type: "file" };
// @ts-ignore
import appJs from "../ui/app.js" with { type: "file" };
// @ts-ignore
import appCss from "../ui/app.css" with { type: "file" };
// @ts-ignore
import iconSvg from "../ui/icon.svg" with { type: "file" };
// @ts-ignore
import touchIcon from "../ui/apple-touch-icon.png" with { type: "file" };
// @ts-ignore
import manifest from "../ui/manifest.webmanifest" with { type: "file" };
// @ts-ignore
import catalog from "../data/catalog.json" with { type: "file" };

export const UI_FILES: Record<string, string> = {
  "index.html": indexHtml as unknown as string,
  "app.js": appJs as unknown as string,
  "app.css": appCss as unknown as string,
  "icon.svg": iconSvg as unknown as string,
  "apple-touch-icon.png": touchIcon as unknown as string,
  "manifest.webmanifest": manifest as unknown as string,
};
export const CATALOG_FILE = catalog as unknown as string;
