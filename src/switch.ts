// The one switch, at the top of Leanfare's page. Off: Leanfare's tools in your apps hand nothing over (each
// says so, and the app does the work itself) and Claude Code's prompt hook says nothing. It is a
// file in the data folder, so the door and the hook, which run as their own processes, know at once
// without asking the server.
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config";

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
export const switchedOn = () => !isFile(paths.off); // a folder of that name is not the switch

export function setSwitch(on: boolean): boolean {
  if (on) { if (isFile(paths.off)) rmSync(paths.off, { force: true }); }
  else {
    mkdirSync(dirname(paths.off), { recursive: true, mode: 0o700 });
    writeFileSync(paths.off, "Leanfare is switched off: its tools in your apps hand nothing over until it is on again.\n", { mode: 0o600 });
  }
  return switchedOn();
}

export const OFF_TEXT = "Leanfare is switched off (the switch at the top of the Leanfare app), so nothing was handed over. Do this yourself, as usual.";
export const OFF_TRIAL = "Leanfare is switched off (the switch at the top of the Leanfare app). Turn it on to run the trial.";
export const OFF_TEST = "Leanfare is switched off (the switch at the top of the Leanfare app). Turn it on to test a model.";
