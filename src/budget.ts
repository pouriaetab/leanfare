// The monthly budget.
//
// Before a request goes out, its worst-case cost is reserved: the input it
// sends plus the longest answer it allows. A request is let through only if
// what was spent this month, plus everything reserved by requests still
// running, plus its own reservation, stays within the budget. JavaScript runs
// one piece of code at a time, so the check and the reservation cannot be
// split by another request: fifty requests at once cannot overrun it.
import { db } from "./db";
import { settings } from "./settings";
import { localMonth, randomId } from "./util";

let month = "";
let spent = 0;
const reserved = new Map<string, number>();

function sync() {
  const m = localMonth();
  if (m !== month) {
    month = m;
    const row = db.query("SELECT COALESCE(SUM(cost), 0) AS s FROM ledger WHERE month = ?").get(m) as { s: number };
    spent = row.s;
  }
}

export const resetBudget = () => { month = ""; reserved.clear(); };

export function budgetState() {
  sync();
  const budget = settings().budget;
  const held = [...reserved.values()].reduce((a, b) => a + b, 0);
  return {
    budget,
    spent,
    reserved: held,
    left: budget === null ? null : budget - spent - held,
    pct: budget ? (spent / budget) * 100 : null,
    warn: budget !== null && spent >= budget * 0.8,
    reached: budget !== null && spent >= budget,
    atLimit: settings().atLimit,
    month,
  };
}

// Returns a reservation id, or null when this request would pass the budget.
export function tryReserve(amount: number, force = false): string | null {
  sync();
  const budget = settings().budget;
  const held = [...reserved.values()].reduce((a, b) => a + b, 0);
  if (!force && budget !== null && spent + held + amount > budget + 1e-12) return null;
  const id = randomId();
  reserved.set(id, amount);
  return id;
}

// The same test without holding anything: for estimates on screen.
export function wouldFit(amount: number): boolean {
  sync();
  const budget = settings().budget;
  const held = [...reserved.values()].reduce((a, b) => a + b, 0);
  return budget === null || spent + held + amount <= budget + 1e-12;
}

export function release(id: string | null) { if (id) reserved.delete(id); }

// Called once per ledger row, with what the answer actually cost.
export function addSpent(cost: number | null, rowMonth: string) {
  sync();
  if (cost && rowMonth === month) spent += cost;
}

export const runningCount = () => reserved.size;
