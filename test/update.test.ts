// A newer Leanfare: GitHub's release list asked once a day, a notice with how to update, and a
// setting that turns it off.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { VERSION } from "../src/config";
import { checkUpdate, newer, update } from "../src/update";
import { boot, reset, ui } from "./app";

let url = "";
let release: any = {};
let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];
beforeAll(async () => {
  url = (await boot()).url;
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen.push(req.headers.get("user-agent") ?? ""); return Response.json(release); } });
  process.env.LEANFARE_RELEASES_URL = `http://127.0.0.1:${server.port}/repos/pouriaetab/leanfare/releases/latest`;
  delete process.env.LEANFARE_UPDATE_CHECK;
});
afterAll(() => { server.stop(true); process.env.LEANFARE_UPDATE_CHECK = "off"; delete process.env.LEANFARE_RELEASES_URL; Object.assign(update, { latest: null, url: null, checked: 0, error: null }); });
beforeEach(async () => { await reset(); Object.assign(update, { latest: null, url: null, checked: 0, error: null }); });
const notice = async () => (await ui(url, "/api/state")).json.notices.find((n: any) => n.kind === "update") ?? null;

describe("a newer Leanfare", () => {
  test("versions compare by number, and only plain releases count", () => {
    expect(newer("0.4.1", "0.4.0")).toBe(true);
    expect(newer("v0.10.0", "0.9.9")).toBe(true);
    expect(newer("1.0.0", "1.0.0")).toBe(false);
    expect(newer("0.3.9", "0.4.0")).toBe(false);
    expect(newer("0.5.0-beta.1", "0.4.0")).toBe(false);
  });
  test("a newer release: a notice with how to update this copy, and a link to what changed", async () => {
    release = { tag_name: "v9.9.9", html_url: "https://github.com/pouriaetab/leanfare/releases/tag/v9.9.9", draft: false, prerelease: false };
    await checkUpdate();
    expect(seen.at(-1)).toBe(`leanfare/${VERSION}`); // the request says only which Leanfare asks
    expect(await notice()).toEqual({ kind: "update", level: "info", text: `Leanfare 9.9.9 is out (you have ${VERSION}). In your Leanfare folder: git pull, then bun install, then start it again.`, url: "https://github.com/pouriaetab/leanfare/releases/tag/v9.9.9" });
  });
  test("the same version, a pre-release, or an answer that is not a release: no notice", async () => {
    for (const r of [{ tag_name: `v${VERSION}` }, { tag_name: "v9.9.9", prerelease: true }, { message: "Not Found" }]) {
      release = r;
      await checkUpdate();
      expect(await notice()).toBeNull();
    }
    expect(update.error).toBe("no release to compare with");
  });
  test("turned off in Settings, or with LEANFARE_UPDATE_CHECK=off: no notice, and nothing asked", async () => {
    release = { tag_name: "v9.9.9", html_url: "https://github.com/pouriaetab/leanfare/releases/tag/v9.9.9" };
    await checkUpdate();
    expect((await ui(url, "/api/settings", { updateCheck: false })).json.settings.updateCheck).toBe(false);
    expect(await notice()).toBeNull();
    process.env.LEANFARE_UPDATE_CHECK = "off";
    const before = seen.length;
    try { await checkUpdate(); } finally { delete process.env.LEANFARE_UPDATE_CHECK; }
    expect(seen.length).toBe(before);
  });
  test("a link that is not GitHub's is not shown", async () => {
    release = { tag_name: "v9.9.9", html_url: "https://example.com/evil" };
    await checkUpdate();
    expect((await notice()).url).toBeNull();
  });
});
