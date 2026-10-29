// Show who wrote what, a test switch (mcp.ts: markedBy): each paragraph of an answer Leanfare hands back starts with
// the model's name in a small mark, lists, tables and code keep their form, and nothing inside code is marked.
import { describe, expect, test } from "bun:test";
import { markedBy, whoNote } from "../src/mcp";

describe("who wrote what", () => {
  test("each paragraph starts with the model's mark", () => {
    expect(markedBy("The disk is full.\n\nRetry failed at 10:02.", "Gemini 3.5 Flash-Lite"))
      .toBe("`Gemini 3.5 Flash-Lite` The disk is full.\n\n`Gemini 3.5 Flash-Lite` Retry failed at 10:02.");
  });

  test("a list, a table or a heading keeps its form: the mark goes above it; inside code nothing is marked", () => {
    const text = "Errors:\n\n- disk full\n- retry failed\n\n| a | b |\n|---|---|\n\n```sh\necho hi\n\necho there\n```\n\n## Next";
    expect(markedBy(text, "M")).toBe("`M` Errors:\n\n`M`\n- disk full\n- retry failed\n\n`M`\n| a | b |\n|---|---|\n\n`M`\n```sh\necho hi\n\necho there\n```\n\n`M`\n## Next");
  });

  test("the app is asked to keep the marks and to mark its own paragraphs", () => {
    expect(whoNote(["DeepSeek V4 Flash"])).toBe("(Test, Show who wrote what is on in Leanfare: keep the `DeepSeek V4 Flash` marks on what you take from this answer, and start each paragraph you write yourself with your own model's name the same way, so the user sees who wrote what.)");
  });
});
