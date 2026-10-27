// The trial's report in words, for Terminal (leanfare trial) and for MCP clients (the trial tool):
// from the report the running Leanfare hands back (trial.ts reportOf), so this needs nothing else.
const usd = (v: number | null) => (v === null ? "cost unknown" : v === 0 ? "$0" : v < 0.01 ? `$${v.toPrecision(2)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`);
export const trialSecs = (x: number | null) => (x === null ? "—" : x < 1.5 ? "about a second" : x < 90 ? `${Math.round(x)} s` : `${(x / 60).toFixed(1)} min`);

export function reportText(r: any, how: "terminal" | "mcp" = "terminal"): string {
  const out: string[] = [];
  const say = (line = "") => out.push(line);
  say(`==== Report${r.status === "done" ? "" : ` (${r.status} after ${r.done} of ${r.total} answers)`} ====`);
  for (const a of r.arms) say(`${a.label.padEnd(17)} ${String(a.right).padStart(2)} of ${a.answered} right · half took under ${trialSecs(a.medianSeconds)} · ${usd(a.cost)} · ${a.models.map((m: any) => `${m.label} ×${m.count}`).join(", ") || "no answers"}${a.verdict === "not decided" ? "" : ` · ${a.verdict.toUpperCase()}`}`);
  const c = r.checks;
  say(`Checks at high effort: ${c.passed} passed, ${c.failed} failed (right after asking again: ${c.fixed}); wrong answers the check passed: ${c.missed}${c.other ? `; not checked or unclear: ${c.other}` : ""}.`);
  if (r.misses.length) { say("Wrong answers:"); for (const m of r.misses) say(`  ${m.effort.padEnd(7)}${m.what}: said "${m.said}", known ${m.known}`); }
  if (r.errors.length) { say("No answer:"); for (const x of r.errors) say(`  ${x.effort.padEnd(7)}${x.q}: ${x.error}`); }
  if (r.kept) say(`Kept out of the asking app's context: about ${r.kept.toLocaleString("en-US")} tokens of files (one read of each question's files).`);
  if (r.lowest) {
    say("");
    say(`${r.lowest[0].toUpperCase()}${r.lowest.slice(1)} effort passes (at most one miss): Claude can hand reading work to Leanfare at effort ${r.lowest}.`);
    say(`For Claude Code to do it on its own, add this line to CLAUDE.md:\n  ${r.claudeLine}`);
  } else if (r.status === "done") { say(""); say("No effort passed (at most one miss): keep checking what the delegate hands back, or tick stronger models and run it again."); }
  say("");
  say(how === "terminal" ? "To share these numbers on GitHub (you read them and press Submit yourself): leanfare trial --share"
    : `To share these numbers on GitHub, open this address; you read them and press Submit yourself, nothing is sent on its own: ${r.share.url}`);
  return out.join("\n");
}
