// Search, export and import of chats.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { snippetOf } from "../src/archive";
import { ALL_TICKED, boot, keys, ledger, readSSE, reset, ui } from "./app";

let url = "";
beforeAll(async () => { url = (await boot()).url; });
beforeEach(async () => { await reset({ ticked: ALL_TICKED }); });

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const chatScreen = (body: unknown) => fetch(`${url}/api/chat`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
async function newChat(content: string, extra: Record<string, unknown> = {}) {
  const { events } = await readSSE(await chatScreen({ messages: [{ role: "user", content, ...extra }], model: "openai/gpt-5-mini" }));
  return events.find((e) => e.type === "chat").chatId as string;
}
const importFile = (body: BodyInit) => fetch(`${url}/api/import`, { method: "POST", headers: { "x-leanfare": "1", "content-type": "application/octet-stream" }, body });

// A one-file .zip, the way ChatGPT and Claude send their exports.
function makeZip(name: string, data: Uint8Array): Blob {
  const n = new TextEncoder().encode(name);
  const packed = deflateRawSync(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdStart = local.length + n.length + packed.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(cdStart, 16);
  return new Blob([Buffer.concat([local, n, packed, central, n, end])]);
}

describe("search", () => {
  test("finds chats by name and by what was said, with the words around the match", async () => {
    await keys("openai");
    const a = await newChat("Plan a trip to Lisbon in May");
    await newChat("Fix my pandas groupby");
    const r1 = (await ui(url, "/api/search?q=lisbon")).json.results;
    expect(r1.map((r: any) => r.id)).toEqual([a]);
    const r2 = (await ui(url, "/api/search?q=hello from")).json.results; // in the answers
    expect(r2).toHaveLength(2);
    expect(r2[0].snippet).toContain("Hello from gpt-5-mini");
    expect((await ui(url, "/api/search?q=x")).json.results).toEqual([]); // too short
    expect((await ui(url, "/api/search?q=100%")).json.results).toEqual([]); // % is a letter here, not a wildcard
  });

  test("removed chats are not found", async () => {
    await keys("openai");
    const a = await newChat("Plan a trip to Lisbon");
    await ui(url, `/api/chats/${a}`, undefined, "DELETE");
    expect((await ui(url, "/api/search?q=lisbon")).json.results).toEqual([]);
  });

  test("a snippet is cut around the match", () => {
    const long = "word ".repeat(40) + "needle" + " tail".repeat(40);
    const s = snippetOf(long, "NEEDLE");
    expect(s.startsWith("…")).toBe(true);
    expect(s).toContain("needle");
    expect(s.length).toBeLessThan(140);
  });
});

describe("export and import", () => {
  test("everything comes back after an export and an import, and importing twice adds nothing", async () => {
    await keys("openai");
    const id = await newChat("Look at this chart", { files: [{ name: "chart.png", type: "image/png", data: PNG }] });
    await ui(url, `/api/chats/${id}`, { system: "Be brief." }, "PATCH");
    const exported = (await ui(url, "/api/export")).json;
    expect(exported).toMatchObject({ app: "leanfare", format: 1 });
    expect(exported.chats).toHaveLength(1);
    expect(exported.chats[0]).toMatchObject({ title: "Look at this chart", system: "Be brief." });
    expect(exported.chats[0].messages[0].files[0]).toMatchObject({ name: "chart.png", kind: "image", data: PNG });
    expect(exported.chats[0].messages[1].meta.model.id).toBe("openai/gpt-5-mini");

    await reset({ ticked: ALL_TICKED });
    const r = await importFile(JSON.stringify(exported));
    expect(await r.json()).toMatchObject({ from: "leanfare", imported: 1, messages: 2, skipped: 0 });
    const list = (await ui(url, "/api/chats")).json.chats;
    expect(list).toHaveLength(1);
    const back = (await ui(url, `/api/chats/${list[0].id}`)).json;
    expect(back.chat.system).toBe("Be brief.");
    expect(back.messages[0].files[0].name).toBe("chart.png");
    expect((await ui(url, `/api/files/${back.messages[0].files[0].id}`)).json.data).toBe(PNG);
    expect(await (await importFile(JSON.stringify(exported))).json()).toMatchObject({ imported: 0, skipped: 1 });
    expect(ledger()).toHaveLength(0); // imported chats cost nothing
  });

  test("a ChatGPT export: the conversation you saw, without hidden messages", async () => {
    const conv = [{
      title: "Sourdough help", create_time: 1760000000.5, update_time: 1760000500, conversation_id: "c-1", current_node: "a2",
      mapping: {
        root: { id: "root", message: null, parent: null, children: ["sys"] },
        sys: { id: "sys", message: { author: { role: "system" }, content: { content_type: "text", parts: [""] }, metadata: { is_visually_hidden_from_conversation: true } }, parent: "root", children: ["u1"] },
        u1: { id: "u1", message: { author: { role: "user" }, create_time: 1760000001, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://x" }, "Why is my bread flat?"] }, metadata: {} }, parent: "sys", children: ["a1", "a2"] },
        a1: { id: "a1", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["An answer you regenerated away."] }, metadata: { model_slug: "gpt-4o" } }, parent: "u1", children: [] },
        a2: { id: "a2", message: { author: { role: "assistant" }, create_time: 1760000010, content: { content_type: "text", parts: ["Your starter may be weak."] }, metadata: { model_slug: "gpt-5" } }, parent: "u1", children: [] },
      },
    }];
    const r = await (await importFile(JSON.stringify(conv))).json();
    expect(r).toMatchObject({ from: "chatgpt", imported: 1, messages: 2 });
    const id = (await ui(url, "/api/chats")).json.chats[0].id;
    const back = (await ui(url, `/api/chats/${id}`)).json;
    expect(back.chat.title).toBe("Sourdough help");
    expect(back.messages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "[an image was attached here in ChatGPT]\nWhy is my bread flat?"],
      ["assistant", "Your starter may be weak."],
    ]);
    expect(back.messages[1].meta).toEqual({ imported: "ChatGPT", model: { id: "chatgpt/gpt-5", label: "gpt-5" } });
  });

  test("a Claude export, as the .zip it arrives in", async () => {
    const conv = [{ uuid: "k-1", name: "Lease questions", created_at: "2026-01-02T10:00:00Z", updated_at: "2026-01-02T10:05:00Z", chat_messages: [
      { sender: "human", text: "", content: [{ type: "text", text: "Is this clause fair?" }], attachments: [{ file_name: "lease.txt", extracted_content: "Clause 4: the tenant pays all repairs." }], created_at: "2026-01-02T10:00:00Z" },
      { sender: "assistant", text: "Clause 4 is unusual.", created_at: "2026-01-02T10:01:00Z" },
    ] }];
    const zip = makeZip("data-2026/conversations.json", new TextEncoder().encode(JSON.stringify(conv)));
    const r = await (await importFile(zip)).json();
    expect(r).toMatchObject({ from: "claude", imported: 1, messages: 2 });
    const id = (await ui(url, "/api/chats")).json.chats[0].id;
    const back = (await ui(url, `/api/chats/${id}`)).json;
    expect(back.messages[0].content).toBe("Is this clause fair?\n\n[File: lease.txt]\nClause 4: the tenant pays all repairs.\n[End of lease.txt]");
    expect(back.chat.created).toBe("2026-01-02T10:00:00.000Z");
  });

  test("a file Leanfare does not know is refused with a reason", async () => {
    const r1 = await importFile("not json");
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toContain("not JSON");
    const r2 = await importFile(JSON.stringify({ hello: 1 }));
    expect((await r2.json()).error).toContain("does not recognise");
    const r3 = await importFile(makeZip("other.json", new TextEncoder().encode("{}")));
    expect((await r3.json()).error).toContain("has no conversations.json");
  });
});
