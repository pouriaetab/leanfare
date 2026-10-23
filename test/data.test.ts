// The catalogue: built from llmledger's data, OpenRouter's list and Ollama.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { buildCatalog, buildOpenRouter, family, isRetired, loadCatalog, ollamaModels, store } from "../src/data";
import { BUILT_IN_CATALOG } from "../src/config";
import { localDay } from "../src/util";

const shipped = await Bun.file(BUILT_IN_CATALOG).json();

describe("the catalogue shipped with this release", () => {
  test("is llmledger schema 1 with prices for every provider Leanfare knows", () => {
    expect(shipped.schema).toBe(1);
    for (const p of ["openai", "anthropic", "google", "deepseek", "xai", "mistral"]) {
      expect(shipped.models.some((m: any) => m.provider === p)).toBe(true);
    }
  });
  test("every provider has a short list, and every short-listed model is rated, priced and live", () => {
    const day = localDay();
    for (const p of ["openai", "anthropic", "google", "deepseek", "xai", "mistral"]) {
      const top = shipped.models.filter((m: any) => m.provider === p && m.top);
      expect(top.length).toBeGreaterThan(0);
      for (const m of top) {
        expect(m.ratings.overall).toBeNumber();
        expect(m.input).not.toBeNull();
        expect(isRetired(m, day)).toBe(false);
      }
    }
  });
  test("no model retired more than 90 days ago is kept, and no music or image model", () => {
    const oldest = new Date(Date.parse(shipped.built) - 91 * 86_400_000).toISOString().slice(0, 10);
    for (const m of shipped.models) {
      if (m.retire) expect(m.retire >= oldest).toBe(true);
      expect(/lyria|imagen|veo|tts|embed|image|audio/i.test(m.name)).toBe(false);
    }
  });
  test("credits name open licences", () => {
    expect(shipped.credits.prices).toContain("MIT");
    expect(shipped.credits.ratings).toContain("CC BY 4.0");
  });
});

describe("building the catalogue", () => {
  const padding = Array.from({ length: 120 }, (_, i) => ({ key: `pad-${i}`, maker: "x", name: `pad-${i}`, host: "nowhere", mode: "chat", input: 1, output: 1 }));
  const raw = {
    schema: 1, built: "2026-10-21T00:00:00Z", litellm: { commit: "abc" }, credits: { prices: "MIT", ratings: "CC BY 4.0" },
    ratings: { date: "2026-10-20", tasks: {
      overall: [["anthropic / claude-haiku-4.5", "Claude Haiku 4.5 (High)", 1414.6], ["anthropic / claude-haiku-4.5", "Claude Haiku 4.5", 1400], ["google / gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite Preview", 1379]],
      coding: [["anthropic / claude-haiku-4.5", "Claude Haiku 4.5 (High)", 1420]],
    } },
    models: [
      ...padding,
      { key: "claude-haiku-4-5", maker: "anthropic", name: "claude-haiku-4.5", host: "anthropic", mode: "chat", input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, added: "2025-10-16" },
      { key: "claude-haiku-4-5-20251001", maker: "anthropic", name: "claude-haiku-4.5", host: "anthropic", mode: "chat", input: 1, output: 5, added: "2025-10-16" },
      { key: "claude-haiku-5-5", maker: "anthropic", name: "claude-haiku-5.5", host: "anthropic", mode: "chat", input: 0.1, output: 0.5, added: "2026-10-07" },
      { key: "gemini/gemini-2.5-flash-lite", maker: "google", name: "gemini-2.5-flash-lite", host: "gemini", mode: "chat", input: 0.1, output: 0.4, added: "2025-07-24" },
      { key: "gemini/lyria-3.5", maker: "google", name: "lyria-3.5", host: "gemini", mode: "chat", input: 0, output: 0 },
      { key: "gemini/old", maker: "google", name: "old", host: "gemini", mode: "chat", input: 1, output: 1, retire: "2025-01-01" },
      { key: "gpt-5-pro", maker: "openai", name: "gpt-5-pro", host: "openai", mode: "responses", input: 15, output: 120 },
    ],
  };
  const cat = buildCatalog(raw, new Date("2026-10-21T12:00:00Z"));
  const ids = cat.models.map((m) => m.id);
  test("keeps chat models on known providers, one entry per model, the alias over the dated copy", () => {
    expect(ids).toContain("anthropic/claude-haiku-4-5");
    expect(ids).not.toContain("anthropic/claude-haiku-4-5-20251001");
    expect(ids).toContain("google/gemini-2.5-flash-lite");
    expect(ids).not.toContain("google/lyria-3.5");
    expect(ids).not.toContain("google/old");
    expect(ids).not.toContain("openai/gpt-5-pro");
    expect(ids.some((i) => i.includes("pad-"))).toBe(false);
  });
  test("a model rated at several effort levels keeps its best rating; labels lose the effort note and a wrong 'Preview'", () => {
    const h = cat.models.find((m) => m.id === "anthropic/claude-haiku-4-5")!;
    expect(h.ratings.overall).toBe(1414.6);
    expect(h.ratings.coding).toBe(1420);
    expect(h.label).toBe("Claude Haiku 4.5");
    expect(cat.models.find((m) => m.id === "google/gemini-2.5-flash-lite")!.label).toBe("Gemini 2.5 Flash-Lite");
  });
  test("a new model without a rating borrows its older family member's, and says so", () => {
    const h55 = cat.models.find((m) => m.id === "anthropic/claude-haiku-5-5")!;
    expect(h55.ratings.overall).toBe(1414.6);
    expect(h55.ratingFrom).toBe("Claude Haiku 4.5");
    expect(h55.top).toBe(true); // cheaper at the same rating: it replaces 4.5 on the short list
    expect(cat.models.find((m) => m.id === "anthropic/claude-haiku-4-5")!.top).toBe(false);
  });
  test("refuses data that is not llmledger schema 1", () => {
    expect(() => buildCatalog({ schema: 2, models: [] })).toThrow();
  });
  test("families ignore version numbers and dates", () => {
    expect(family("claude-sonnet-4.6")).toBe("claude-sonnet");
    expect(family("claude-sonnet-5.5")).toBe("claude-sonnet");
    expect(family("gemini-3.1-pro-preview")).toBe("gemini-pro");
    expect(family("mistral-large-2512")).toBe("mistral-large");
  });
});

describe("OpenRouter and Ollama lists", () => {
  test("OpenRouter prices per token become prices per 1M, ':free' costs nothing, batch variants are skipped", () => {
    const ms = buildOpenRouter({ data: [
      { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", pricing: { prompt: "0.000001", completion: "0.000005" } },
      { id: "anthropic/claude-haiku-4.5:batch", pricing: { prompt: "0.0000005", completion: "0.0000025" } },
      { id: "acme/small:free", name: "Acme: Small (free)", pricing: { prompt: "0", completion: "0" } },
      { id: "~openai/latest", pricing: { prompt: "1", completion: "1" } },
    ] }, { models: [{ maker: "anthropic", name: "claude-haiku-4.5", label: "Claude Haiku 4.5", ratings: { overall: 1414.6 } }] } as any);
    expect(ms.map((m) => m.id)).toEqual(["openrouter/acme/small:free", "openrouter/anthropic/claude-haiku-4.5"]);
    const h = ms.find((m) => m.apiId === "anthropic/claude-haiku-4.5")!;
    expect(h.input).toBeCloseTo(1, 10);
    expect(h.output).toBeCloseTo(5, 10);
    expect(h.ratings.overall).toBe(1414.6);
    expect(ms.find((m) => m.free)!.input).toBe(0);
  });
  test("Ollama's local models cost nothing", () => {
    const ms = ollamaModels({ models: [{ name: "llama3.2:latest" }] });
    expect(ms[0]).toMatchObject({ id: "ollama/llama3.2:latest", label: "llama3.2", input: 0, output: 0, local: true });
  });
});

describe("loading", () => {
  test("the newer of the built-in copy and the last download wins", () => {
    loadCatalog(BUILT_IN_CATALOG);
    expect(store.catalogFrom).toBe("built-in");
    expect(existsSync(BUILT_IN_CATALOG)).toBe(true);
  });
});
