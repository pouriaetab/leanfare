// Judging answers fairly (0.9). A judge never knows which model wrote an answer, and comes from another company
// when one can take it: models tend to favour answers like their own and their maker's, and a model may name
// itself in its answer ("As Gemini, I..."), so the judge's copy has such words masked. The checks (delegate.ts)
// and the side by side (sidebyside.ts) judge this way.
import { usableModels } from "./engine";
import type { Model } from "./data";

// A local model's maker, from its name (qwen3.5 on this computer is Alibaba's Qwen).
const LOCAL_MAKERS: [RegExp, string][] = [
  [/^qwen|^qwq/, "alibaba"], [/^llama|^codellama/, "meta"], [/^gemma|^codegemma/, "google"], [/^mistral|^mixtral|^codestral|^devstral|^magistral/, "mistral"],
  [/^phi/, "microsoft"], [/^deepseek/, "deepseek"], [/^gpt-oss/, "openai"], [/^granite/, "ibm"], [/^glm/, "zhipu"], [/^kimi/, "moonshot"], [/^nemotron/, "nvidia"],
];

// The company that made a model: its maker, or for a local model the maker its name gives. Null when not known
// ("other"): such a model counts as another company's.
export function companyOf(m: Model): string | null {
  if (m.local) {
    const name = (m.apiId || m.name).toLowerCase();
    return LOCAL_MAKERS.find(([re]) => re.test(name))?.[1] ?? null;
  }
  const maker = (m.maker || "").toLowerCase();
  return maker && maker !== "other" && maker !== "local" ? maker : null;
}

export const sameCompany = (a: Model, b: Model) => { const x = companyOf(a); return x !== null && x === companyOf(b); };

// Of the models a judge may be, those of another company than every model whose answer it judges, when any of
// them can take it now; otherwise all of them, so a judge is still found.
export function fromAnotherCompany(judged: Model[], ok: (m: Model) => boolean): { only: (m: Model) => boolean; other: boolean } {
  const other = (m: Model) => ok(m) && !judged.some((j) => sameCompany(j, m));
  return usableModels(other).length ? { only: other, other: true } : { only: ok, other: false };
}

// What a model says of itself, masked in the judge's copy: "I am Claude", "As Gemini 3,", "I'm GPT-5",
// "developed by OpenAI". Names in the task's own subject stay ("the Google Maps API").
const NAMES = String.raw`Claude|Gemini|Gemma|ChatGPT|GPT(?:-?[\w.]+)?|DeepSeek|Grok|Mistral|Mixtral|Llama|Qwen|Kimi|GLM|Sonar|Phi|Codex|Command R`;
const MAKERS = String.raw`Anthropic|Google(?: DeepMind)?|DeepMind|OpenAI|xAI|Mistral AI|Meta(?: AI)?|Alibaba(?: Cloud)?|Moonshot(?: AI)?|Zhipu(?: AI)?|Perplexity|Microsoft|Cohere`;
const WORDS = "mini nano pro flash lite sonnet haiku opus turbo large small medium chat coder reasoner beta instruct".split(" ").map((w) => `[${w[0]}${w[0].toUpperCase()}]${w.slice(1)}`).join("|");
const VERSION = String.raw`(?:[ -](?:[vV]?\d[\w.]*|${WORDS}))*`; // "3 Pro", "V4 Flash", "-5 mini"
const AN = String.raw`(\s+an?\s+(?:AI\s+)?(?:model|assistant|language model)(?:\s+(?:called|named))?)?`;
const SELF = new RegExp(String.raw`\b(I am|I'm|this is)${AN}\s+(?:${NAMES})${VERSION}\b`, "gi");
const SELF_AS = new RegExp(String.raw`(^|[.!?]\s+|\n\s*)As${AN}\s+(?:${NAMES})${VERSION}(?=,|\s+I\b)`, "g"); // "As Gemini, I..." or "As Gemini I..." at a sentence's start
const MADE = new RegExp(String.raw`\b(made|built|developed|trained|created|provided)\s+by\s+(?:${MAKERS})\b`, "gi");
export function masked(text: string): string {
  return text
    .replace(SELF, (_m, lead: string, what: string | undefined) => `${lead}${what ?? ""} [a model]`)
    .replace(SELF_AS, (_m, start: string, what: string | undefined) => `${start}As${what ?? ""} [a model]`)
    .replace(MADE, (_m, verb: string) => `${verb} by [a company]`);
}
