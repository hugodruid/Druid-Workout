// ============================================================================
// PROGRESSION ENGINE — pure functions, no React.
//
// Design: two speeds, kept deliberately separate.
//   1. DAY level  — the readiness check-in (sleep / stress) scales TODAY's number
//      of sets only. It resets tomorrow and never touches your targets.
//   2. TREND level — targets move only on repeated evidence from logged sessions:
//        holds: +step after 2 clean sessions (1 if it felt easy); −step after
//               2 sessions that came up short on normal-readiness days.
//        reps:  double progression — every set at the top of the range → add
//               load / harder variation; under the floor twice → ease off.
//      Sessions logged on low-readiness days can move you UP (you beat a bad day)
//      but never DOWN. Step sizes are small and holds are capped at 2× the
//      programmed time — past that, the variation should change, not the clock.
//
// Everything is derived by replaying the log in date order, so editing or
// deleting an old set simply recomputes — there is no hidden state to drift.
// ============================================================================

export const vals = (e) => (e?.reps || []).filter((x) => x != null);

export function parseDose(dose) {
  const d = dose || "";
  const m = /^(\d+)\s*×\s*(\d+)?(?:\s*[–-]\s*(\d+))?/.exec(d);
  if (m) return { sets: +m[1], lo: m[2] ? +m[2] : null, hi: m[3] ? +m[3] : m[2] ? +m[2] : null };
  const r = /^(\d+)(?:\s*[–-]\s*(\d+))?\s*\/\s*(leg|side)/.exec(d);
  if (r) return { sets: 1, lo: +r[1], hi: r[2] ? +r[2] : +r[1] };
  return { sets: 1, lo: null, hi: null };
}

// "hold" = timed strength/skill hold we can progress by time; "reps" = rep-based; null = not logged
export function exKind(ex) {
  if (!ex || ex.interval || /warm-up|cool-down/i.test(ex.name)) return null;
  if (ex.seconds) return !ex.perSide && ex.seconds <= 60 ? "hold" : null;
  if (/intervals?$|circuit|PNF/i.test(ex.name)) return null;
  return "reps";
}
export const isLoadable = (ex) => /weight|squat|deadlift|dip|lunge/i.test(ex.name);

// ---- readiness (day level) ----
export const READINESS = {
  full: { label: "Full session", factor: 1, color: "#6a8d3f",
    note: "Train as planned." },
  trim: { label: "Trimmed day", factor: 0.75, color: "#c9962e",
    note: "About ¾ of the sets, stop 2 reps shy. Holds stay full length. A short day can't lower your targets." },
  easy: { label: "Easy day", factor: 0.5, color: "#d9543f",
    note: "About half the sets, nothing near failure — or swap for mobility. Showing up is the win; this day can't lower your targets." },
};
export function readinessLevel(r) {
  if (!r) return "full";
  const s = r.sleep === "poor", t = r.stress === "high";
  return s && t ? "easy" : s || t ? "trim" : "full";
}

export function setFactor(session, level) {
  const base = session?.deload ? 0.55 : session?.ramp?.setsFactor ?? 1;
  return base * (READINESS[level]?.factor ?? 1);
}
export const plannedSets = (ex, factor) => Math.max(1, Math.round(parseDose(ex.dose).sets * factor));

function entriesFor(store, name, excludeKey) {
  return Object.entries(store || {})
    .filter(([k, e]) => k !== excludeKey && e.ex === name && vals(e).length)
    .map(([, e]) => e)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.week || 0) - (b.week || 0)));
}
export function lastEntryFor(store, name, excludeKey) {
  const es = entriesFor(store, name, excludeKey);
  return es[es.length - 1] || null;
}

const round5 = (x) => Math.round(x / 5) * 5;
export const holdStep = (t) => Math.max(5, round5(t * 0.1));

// ---- holds (trend level) ----
// override: { sec, date } — a manual target; replay restarts from it for later sessions.
export function holdProgression(ex, store, override, excludeKey) {
  const base = ex.seconds;
  const cap = base * 2;
  const floor = Math.max(5, round5(base * 0.6));
  let T = base, ok = 0, bad = 0, last = null;
  if (override) { T = override.sec; last = { dir: "set", date: override.date, text: `Target set by you: ${override.sec}s` }; }
  const es = entriesFor(store, ex.name, excludeKey).filter((e) => !override || e.date > override.date);
  for (const e of es) {
    const v = vals(e), t = e.target || T, need = e.planned || 1;
    const low = e.readiness && e.readiness !== "full";
    const clean = v.length >= need && v.every((x) => x >= t);
    const short = v.some((x) => x < t * 0.8) || (!clean && e.feel === "hard");
    if (clean) {
      bad = 0;
      if (e.feel === "hard") { ok = 0; continue; }
      ok += e.feel === "easy" ? 2 : 1;
      if (ok >= 2 && T < cap) {
        const from = T; T = Math.min(cap, T + holdStep(T)); ok = 0;
        last = { dir: "up", date: e.date, from, text: e.feel === "easy"
          ? `${from}s → ${T}s: every set clean and it felt easy`
          : `${from}s → ${T}s: two clean sessions in a row` };
      }
    } else if (short && !low) {
      ok = 0; bad += 1;
      if (bad >= 2 && T > floor) {
        const from = T; T = Math.max(floor, T - holdStep(T)); bad = 0;
        last = { dir: "down", date: e.date, from, text: `${from}s → ${T}s: came up short two sessions running` };
      }
    }
  }
  const pending = T >= cap ? null
    : ok === 1 ? `One more clean session → ${Math.min(cap, T + holdStep(T))}s`
    : bad === 1 ? "Short last time — if it happens again, the target eases" : null;
  return { kind: "hold", target: T, base, cap, atCap: T >= cap, last, pending, n: es.length };
}

// ---- reps (trend level): double progression ----
const kgTxt = (k) => `${Math.round(k * 10) / 10} kg`;
export function repProgression(ex, store, excludeKey) {
  const d = parseDose(ex.dose);
  const loadable = isLoadable(ex);
  const es = entriesFor(store, ex.name, excludeKey);
  let bad = 0, last = null;
  for (const e of es) {
    const v = vals(e), need = e.planned || d.sets;
    const low = e.readiness && e.readiness !== "full";
    const top = d.hi != null && v.length >= need && v.every((x) => x >= d.hi);
    const under = d.lo != null && v.some((x) => x < d.lo);
    if (top) {
      bad = 0;
      last = e.feel === "hard"
        ? { dir: "hold", date: e.date, text: `Top of the range, but it felt hard — repeat ${e.kg ? kgTxt(e.kg) : "this"} once more before moving up` }
        : { dir: "up", date: e.date, kg: loadable ? (e.kg || 0) + 2.5 : null,
            text: loadable ? `Every set at ${d.hi}+ — go to ${kgTxt((e.kg || 0) + 2.5)} next time`
                           : `Every set at ${d.hi}+ — step to a harder variation, or slow the lowering to 3 s` };
    } else if (under && low) {
      last = { dir: "hold", date: e.date, text: "Short on a low-readiness day — doesn't count against you" };
    } else if (under) {
      bad += 1;
      last = bad >= 2
        ? { dir: "down", date: e.date, kg: loadable && e.kg ? Math.max(0, e.kg - 2.5) : null,
            text: loadable && e.kg ? `Under ${d.lo} two sessions running — drop to ${kgTxt(Math.max(0, e.kg - 2.5))} and build back`
                                   : `Under ${d.lo} two sessions running — use an easier variation for a week or two` }
        : { dir: "hold", date: e.date, text: `Some sets under ${d.lo} — same load next time; if it repeats, ease off` };
    } else {
      bad = 0;
      last = { dir: "hold", date: e.date,
        text: d.hi ? (e.feel === "easy" ? `Felt easy — push every set toward ${d.hi}, then the load goes up` : `In the range — add reps until every set hits ${d.hi}`)
                   : "Logged — beat it next time" };
    }
  }
  return { kind: "reps", last, suggestKg: last?.kg ?? null, n: es.length };
}

export function progressionFor(ex, store, overrides, excludeKey) {
  const k = exKind(ex);
  if (k === "hold") return holdProgression(ex, store, overrides?.[ex.name], excludeKey);
  if (k === "reps") return repProgression(ex, store, excludeKey);
  return null;
}
