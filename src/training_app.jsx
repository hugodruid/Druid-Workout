import React, { useState, useEffect, useRef } from "react";
import { READINESS, readinessLevel, setFactor, plannedSets, exKind, isLoadable, parseDose, vals, lastEntryFor, progressionFor } from "./progression.js";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// ============================================================================
// STORAGE ADAPTER — works in BOTH environments, no separate versions to maintain:
//   • In the Claude artifact sandbox, window.storage exists → use it.
//   • When hosted (Vercel/Netlify) or run locally, it doesn't → fall back to
//     browser localStorage. localStorage persists per-browser-per-device, so your
//     logs survive refreshes/restarts. Use the in-app Export button as a backup
//     and to move data between devices.
// Both paths are async-shaped so the rest of the app doesn't care which is active.
// ============================================================================
const hasWindowStorage = typeof window !== "undefined" && window.storage && typeof window.storage.get === "function";
const Store = {
  async get(key) {
    if (hasWindowStorage) {
      const r = await window.storage.get(key);
      return r ? r.value : null;               // window.storage returns { value } or null
    }
    try { return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null; }
    catch (e) { return null; }                 // private-mode / disabled storage
  },
  async set(key, value) {
    if (hasWindowStorage) { await window.storage.set(key, value); return; }
    try { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); }
    catch (e) {}                               // quota/disabled — fail silently, app still runs in-memory
  },
};

// ============================================================================
// WAKE LOCK — keeps the screen awake while a timer is running so you can see
// holds/intervals mid-workout. Releases automatically when the timer stops, so
// it doesn't drain battery the rest of the day. Re-acquires if you tab away and
// back (the OS releases it on tab-hide, which is correct). Gracefully does
// nothing on browsers without support (older iOS) — the app still works.
// ============================================================================
function useWakeLock(active) {
  const lockRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
    if (!supported) return;

    const acquire = async () => {
      try {
        if (lockRef.current) return;
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) { lock.release().catch(() => {}); return; }
        lockRef.current = lock;
        lock.addEventListener("release", () => { lockRef.current = null; });
      } catch (e) { /* user gesture / permission / unsupported — ignore */ }
    };
    const release = () => {
      if (lockRef.current) { lockRef.current.release().catch(() => {}); lockRef.current = null; }
    };
    const onVisible = () => { if (active && document.visibilityState === "visible") acquire(); };

    if (active) {
      acquire();
      document.addEventListener("visibilitychange", onVisible);
    } else {
      release();
    }
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      release();
    };
  }, [active]);
}

// ============================================================================
// Shared mobility routine — defined BEFORE BLOCKS (which references it).
// seconds: timer length for held positions; null for rep-based drills.
// For per-side drills, seconds is per side.
// ============================================================================
const MOBILITY_ROUTINE = [
  { group: "Hips (external rotation / lotus depth)", items: [
    { name: "90/90 transitions", dose: "2–3 min flowing", seconds: 150, cue: "Rotate without hands; pause at end-range. Best single hip-rotation drill." },
    { name: "Frog stretch", dose: "60–90 sec", seconds: 75, cue: "Knees wide, shins parallel, rock back gently. No bouncing." },
    { name: "Lizard + rotation", dose: "60 sec / side", seconds: 60, perSide: true, cue: "Front foot outside hands, back knee down, rotate front knee out." },
    { name: "Active straddle lifts", dose: "8–10 / leg", seconds: null, cue: "Lift each leg a few cm off the floor — builds strength at end-range." },
  ]},
  { group: "Splits (front + middle)", items: [
    { name: "Front split slide", dose: "90 sec / side", seconds: 90, perSide: true, cue: "Hands on blocks, stay square, ease deeper on exhales. Back hip flexor is the limiter." },
    { name: "Loaded pancake", dose: "90 sec", seconds: 90, cue: "Wide straddle, flat back, reach actively (or light weight to chest)." },
    { name: "Cossack squats", dose: "6–8 / side", seconds: null, cue: "Shift side to side in a wide stance — middle-split range with strength." },
    { name: "PNF (optional)", dose: "when warm only", seconds: null, cue: "Contract 5–6 sec, relax, ease deeper. Use sparingly to break plateaus." },
  ]},
  { group: "Backbends (balances your front-body bias + helps handstand)", items: [
    { name: "Thoracic extension over roller", dose: "90 sec", seconds: 90, cue: "Roller across upper back, gently arch over it. Safest entry." },
    { name: "Cobra → upward dog", dose: "5–8 reps", seconds: null, cue: "Chest forward and up; glutes engaged to protect the low back." },
    { name: "Bridge / wheel", dose: "30 sec hold", seconds: 30, cue: "Extend from upper back + hips, NOT the low back. Pinching = back off." },
    { name: "Couch stretch", dose: "75 sec / side", seconds: 75, perSide: true, cue: "Rear foot up a wall, kneeling — lengthens hip flexors. Helps splits too." },
  ]},
];
const MOBILITY_NOTE = "Warm first (easy movement or sauna). End-range last when most open. ~30–40 min. Frequency beats perfection — the routine you repeat wins.";

// ============================================================================
// Handstand / wrist skill routine — MANUAL tier progression.
// Wrist prep is a fixed preamble shown at every tier (insurance, not a tier you outgrow).
// You advance tiers manually by feel/quality. Floor-first: parallettes noted
// where they'd reduce wrist strain, never required.
// ============================================================================
const HANDSTAND_WRIST_PREP = {
  group: "Wrist prep — every session, no exceptions",
  items: [
    { name: "Palms down, fingers forward — rock", dose: "30 sec", seconds: 30, cue: "Hands flat, rock weight fwd/back. Wakes up the load you'll put through the wrist." },
    { name: "Palms down, fingers BACKWARD — rock", dose: "30 sec", seconds: 30, cue: "Fingers toward knees. The one most people skip and most need. Go gently." },
    { name: "Backs of hands down, palms up", dose: "20 sec", seconds: 20, cue: "Opposite direction — opens the front of the wrist. Ease in." },
    { name: "Circles + side-to-side", dose: "20 sec", seconds: 20, cue: "Loose circles each way, then rock side to side. Finish warm." },
  ],
};
const HANDSTAND_ROUTINE = {
  tiered: true,
  preamble: HANDSTAND_WRIST_PREP,
  tiers: [
    {
      name: "Foundation",
      blurb: "Build the line and the shape. Default starting point.",
      groups: [
        { group: "Hold + shape", items: [
          { name: "Belly-to-wall holds", dose: "3 × 25 sec", seconds: 25, cue: "Chest to wall, push tall through shoulders, ribs down, posterior pelvic tilt. Quality over time." },
          { name: "Hollow body hold", dose: "3 × 20 sec", seconds: 20, cue: "Low back pressed to floor — the exact line you want inverted, trained where you can feel it." },
        ]},
      ],
    },
    {
      name: "Building",
      blurb: "Add load to the wrist and time to the hold.",
      groups: [
        { group: "Hold + load", items: [
          { name: "Belly-to-wall holds", dose: "3 × 40 sec", seconds: 40, cue: "Same cues, longer. Stop the set if the line breaks — don't grind a sagging hold." },
          { name: "Wrist push-ups (floor)", dose: "2 × 10 slow", seconds: null, cue: "Rock from knuckles onto flat palm under load, slow. Parallettes NOT needed — floor builds wrist tolerance." },
          { name: "Tuck hold", dose: "3 × 12 sec", seconds: 12, cue: "Knees to chest, support on hands. Floor is fine; parallettes here keep the wrist neutral if extension bothers you." },
        ]},
      ],
    },
    {
      name: "Balance",
      blurb: "Low-rep freestanding practice. Stop while sharp — never grind balance when tired.",
      groups: [
        { group: "Free balance", items: [
          { name: "Kick-up to balance", dose: "5–8 attempts", seconds: null, cue: "Full rest between. Tired days are fine for low-rep balance IF you stop while control is clean." },
          { name: "Chest-to-wall toe taps", dose: "5–8 reps", seconds: null, cue: "From chest-to-wall, tap toes off the wall toward free balance. Builds the find-balance reflex safely." },
          { name: "Belly-to-wall hold (finisher)", dose: "2 × 30 sec", seconds: 30, cue: "Bank some straight-line time at the end while fatigued — grooves the shape under tiredness." },
        ]},
      ],
    },
  ],
};
const HANDSTAND_NOTE = "Wrist prep every time — it's your injury insurance before loading. Advance tiers by control quality, not session count: move up only when the current tier feels clean and unrushed. On low-energy days, do the wrist prep well and cut the skill work short — a wobbly handstand just grooves a wobbly handstand.";

// ============================================================================
// BONUS LIBRARY — short, optional, skill + mobility ONLY (no extra strength,
// by design: extra load competes with the block's main sessions for recovery). These are the two things the plan under-serves, so
// spare-time energy points here. Logged separately as "bonus" — never distorts
// planned-session completion. Each reuses the RoutineGroup shape + timers.
// ============================================================================
// Bonus handstand progression — LEVELS you advance through by control quality
// (a self-test gate, not session count). Wrist prep is constant. Each level has a
// short (~5min) and full (~15min) variant sharing the same skill content.
const HS_BONUS_LEVELS = [
  {
    name: "Wall foundation",
    gate: "Advance when: belly-to-wall hold feels solid and tall for 40s+, ribs/pelvis controlled, no banana back.",
    short: [
      { name: "Wall drive — push tall", dose: "3 × 20 sec", seconds: 20, cue: "Belly-to-wall, actively push the floor away. Grooves the active shoulder line." },
      { name: "Belly-to-wall hold", dose: "2 × 25 sec", seconds: 25, cue: "Ribs down, posterior tilt, push tall. Quality over time." },
    ],
    full: [
      { name: "Wall drive — push tall", dose: "3 × 30 sec", seconds: 30, cue: "Belly-to-wall, ribs down, posterior tilt. Build the active line." },
      { name: "Belly-to-wall hold", dose: "3 × 40 sec", seconds: 40, cue: "Push tall, stack shoulders over hands. Stop the set if the line breaks." },
      { name: "Hollow body hold", dose: "3 × 25 sec", seconds: 25, cue: "The exact inverted line, trained where you can feel it." },
    ],
  },
  {
    name: "Finding balance",
    gate: "Advance when: you can consistently feel the balance point and hold a few seconds freestanding off a kick-up.",
    short: [
      { name: "Chest-to-wall toe taps", dose: "6–8 reps", seconds: null, cue: "Tap toes off the wall toward free balance — trains the find-balance reflex safely." },
      { name: "Kick-up to balance", dose: "5–6 attempts", seconds: null, cue: "Stop while sharp. A few clean attempts daily compound fast." },
    ],
    full: [
      { name: "Chest-to-wall toe taps", dose: "2 × 6–8 reps", seconds: null, cue: "Shift weight to fingertips, lift toes off. This is where balance is learned." },
      { name: "Kick-up to balance", dose: "8–10 attempts", seconds: null, cue: "Full rest between. Quality reps teach; tired wobbly reps groove wobble." },
      { name: "Wall-assisted balance hold", dose: "3 × 15 sec", seconds: 15, cue: "Kick up near the wall, find balance off it, only heels touching when needed." },
      { name: "Belly-to-wall hold (finisher)", dose: "2 × 30 sec", seconds: 30, cue: "Bank straight-line time at the end while tired — grooves shape under fatigue." },
    ],
  },
  {
    name: "Freestanding",
    gate: "Advance / mastery: working toward a consistent 15–30s freestanding hold. Keep refining — handstands are never 'done'.",
    short: [
      { name: "Freestanding kick-up + hold", dose: "6–8 attempts", seconds: null, cue: "Open floor, find and ride the balance. Bail safely (cartwheel out). Stop while clean." },
      { name: "Wrist-saver — wall hold", dose: "1 × 30 sec", seconds: 30, cue: "One controlled wall hold to finish and reinforce the line." },
    ],
    full: [
      { name: "Freestanding kick-up + hold", dose: "10–12 attempts", seconds: null, cue: "Chase consistency, not max time. Note your best clean hold. Full rest between." },
      { name: "Balance corrections drill", dose: "3 × max hold", seconds: null, cue: "Fingertip pressure to stop tipping forward; toe-point + open shoulders to stop falling back." },
      { name: "Tuck → extend (if stable)", dose: "5–6 attempts", seconds: null, cue: "From a balanced tuck, slowly extend to straight. Builds press-adjacent control." },
      { name: "Belly-to-wall hold (finisher)", dose: "2 × 40 sec", seconds: 40, cue: "End with banked straight-line time. Always finish with the clean shape." },
    ],
  },
];

const BONUS_SESSIONS = [
  {
    id: "hs-touch",
    title: "Handstand touch-up",
    minutes: 5,
    kind: "skill",
    levelled: true,        // pulls balance content from HS_BONUS_LEVELS[level].short
    variant: "short",
    blurb: "Short, fresh handstand reps. Frequency is the active ingredient — this is how the skill actually progresses, not just maintains. Do it FRESH, early in the day.",
  },
  {
    id: "hs-skill-15",
    title: "Handstand skill block",
    minutes: 15,
    kind: "skill",
    levelled: true,        // pulls from HS_BONUS_LEVELS[level].full
    variant: "full",
    blurb: "A fuller skill dose for days you have time. Still low fatigue — skill work doesn't compete with your priority quality the way extra strength would.",
  },
  {
    id: "mob-daily",
    title: "Daily 5-min mobility",
    minutes: 5,
    kind: "mobility",
    blurb: "Near-zero cost, aids recovery, compounds on consistency. The classic side-quest — a little every day beats a lot occasionally.",
    groups: [
      { group: "Quick open-up", items: [
        { name: "90/90 transitions", dose: "90 sec", seconds: 90, cue: "Rotate hip to hip without hands. Your best single hip-rotation drill." },
        { name: "Cat–cow + thoracic rotation", dose: "60 sec", seconds: 60, cue: "Flow the spine, then thread-the-needle each side. Wakes up the mid-back." },
        { name: "Couch / hip-flexor stretch", dose: "45 sec / side", seconds: 45, perSide: true, cue: "Counters the bike-flexed position directly. Glutes on to protect the low back." },
      ]},
    ],
  },
  {
    id: "back-care",
    title: "Back-care core (bike support)",
    minutes: 8,
    kind: "mobility",
    blurb: "Anti-extension core endurance — directly targets the erector-spinae fatigue you get on the aggressive bike position. Low fatigue, high carryover. Sub-maximal: endurance, not a grind.",
    groups: [
      { group: "Trunk endurance", items: [
        { name: "Front plank", dose: "3 × 30 sec", seconds: 30, cue: "Ribs down, glutes on, neutral spine. Build the endurance the bike demands." },
        { name: "Dead bug", dose: "2 × 8 / side", seconds: null, cue: "Low back glued to floor, opposite arm/leg extend slowly. Anti-extension control." },
        { name: "Bird dog", dose: "2 × 8 / side", seconds: null, cue: "Reach long, no rotation through the hips. Trains the erectors to stabilise without overworking." },
        { name: "Side plank", dose: "2 × 20 sec / side", seconds: 20, perSide: true, cue: "Stacks the lateral chain — the other half of trunk stability on the bike." },
      ]},
    ],
  },
  {
    id: "split-snack",
    title: "Split progress snack",
    minutes: 10,
    kind: "mobility",
    blurb: "A focused flexibility nibble for the splits when you have a spare moment and you're warm. Frequency drives flexibility too — small doses add up.",
    groups: [
      { group: "Front + middle", items: [
        { name: "Front split slide", dose: "90 sec / side", seconds: 90, perSide: true, cue: "Square hips, ease deeper on exhales. Only when warm — never cold." },
        { name: "Loaded pancake", dose: "90 sec", seconds: 90, cue: "Flat back, reach actively. Active reaching beats passive hanging." },
        { name: "Active straddle lifts", dose: "8–10 / leg", seconds: null, cue: "Lift each leg off the floor — strength at end-range is what makes range permanent." },
      ]},
    ],
  },
];
// Weekly bonus targets — what makes the bonuses visible in the Week tab.
// Handstand frequency + trunk work are what the skill goals (front lever, L-sit,
// HSPU) actually run on, so they get a light weekly target. Not a quota to grind:
// a nudge so they don't get forgotten.
const BONUS_TARGETS = [
  { key: "hs", label: "Handstand", ids: ["hs-touch", "hs-skill-15"], target: 3, color: "#2e6e8e" },
  { key: "core", label: "Core", ids: ["back-care"], target: 2, color: "#6a8d3f" },
];
// Which bonus fits which day, by the planned session's type. Main days get only the
// 5-min touch-up (do it FRESH, before the session or early in the day); lighter days
// get the fuller doses.
function bonusFor(session) {
  const t = session?.type, title = (session?.title || "").toLowerCase();
  if (t === "main") return ["hs-touch"];
  if (t === "short" && title.includes("handstand")) return ["back-care"];
  if (t === "short") return ["hs-skill-15", "back-care"];
  return ["hs-skill-15", "back-care"];                 // open / rest days
}
const bonusById = (id) => BONUS_SESSIONS.find((b) => b.id === id);

const BONUS_NOTE = "Bonuses are optional and complementary — skill and mobility only, on purpose. They're logged separately so they never distort your planned-session tracking. The rule of thumb: if you have spare energy, spend it here (the things the plan under-serves), not on extra strength volume — even in the Strength block, recovery is the limiter, not the number of sets.";

// ============================================================================
// PROGRAM DEFINITION — 3 blocks x 8 weeks
// dayKey: 0=Sun ... 6=Sat (matches JS getDay)
// ============================================================================
const BLOCKS = [
  {
    id: "strength", name: "Strength", weeks: [1, 8], accent: "#2e6e8e",
    tag: "Rebuild first, then overload. Weeks 1–2 are re-entry after the break; real progression starts week 3. Heavy legs are the gap bodyweight can't fill.",
    // Endurance in a strength block = a floor, not a goal.
    //  1. Every week: 60–90 min EASY aerobic time. Main vehicle: the evening hill
    //     climb home (2.3 km, +139 m, ~6%) — ~15 min × 5 evenings ≈ 75 min.
    //     Frequency beats duration for a floor; easy = nose-breathing, lowest gear.
    //  2. Weeks 4, 6, 8: ride the hill ONCE as intervals (4 × 1 min hard / 2 min easy
    //     ≈ the length of the climb) — primes the Endurance block starting week 9.
    aerobicFloor: { min: 60, max: 90, touchWeeks: [4, 6, 8],
      text: "60–90 min easy aerobic per week. Hill climbs home, easy rides and uphill walks all count. Easy = you could breathe through your nose: lowest gear, high cadence." },
    // Re-entry ramp after a ~3-month layoff. Keyed by week-within-block.
    // Why: muscle memory brings strength back fast, but tendons/connective tissue
    // re-adapt slower than muscle — and life stress draws on the same recovery budget.
    ramp: {
      1: { label: "RE-ENTRY W1", setsFactor: 0.5, text: "Do ~half the listed sets. RPE 6 — stop with 3–4 reps in reserve. Bodyweight only on 'weighted' moves. Don't test old numbers.",
           short: "Leave the session wanting more — the goal this week is just to show up and move well." },
      2: { label: "RE-ENTRY W2", setsFactor: 0.75, text: "Do ~¾ of the listed sets. RPE 7 — 2–3 reps in reserve. Still no added load. Note which moves feel back and which don't.",
           short: "Closer to normal, still no grinding. Full sets and load arrive in week 3." },
    },
    days: {
      1: { type: "main", title: "Upper push + core", body: "HSPU progression 5×4–6 · dips/weighted dips 4×6–8 · planche-lean prog · hollow body.", sauna: "avoid",
        exercises: [
          { name: "HSPU progression", dose: "5 × 4–6", cue: "Full rest between sets (2–3 min). Add a rep before adding range. Quality over numbers." },
          { name: "Dips / weighted dips", dose: "4 × 6–8", cue: "Add load once 8 is clean. Shoulders down, don't sink into the bottom." },
          { name: "Planche lean", dose: "3 × 20 sec", seconds: 20, cue: "Lean forward over the hands, protract shoulders. Lean further as it gets easy — the timer paces it." },
          { name: "Hollow body hold", dose: "3 × 30 sec", seconds: 30, cue: "Hard line, low back down. Bend knees to scale if it breaks early." },
        ] },
      2: { type: "short", title: "Skill — handstand + wrists", body: "Handstand balance + wrist/forearm prep.", sauna: "ideal", routine: HANDSTAND_ROUTINE },
      3: { type: "main", title: "Legs (loaded)", body: "Goblet/KB or gym squats 4×6–8 · Romanian deadlifts 3×8 · walking lunges.", sauna: "avoid",
        exercises: [
          { name: "Goblet / KB / barbell squats", dose: "4 × 6–8", cue: "The leg-loading gap bodyweight can't fill. Progress load weekly. Full rest." },
          { name: "Romanian deadlifts", dose: "3 × 8", cue: "Hinge from the hips, soft knees, feel the hamstrings. Control the lowering." },
          { name: "Walking lunges", dose: "2 × 10/leg", cue: "Long stride, knee tracks over foot. Add load when bodyweight is easy." },
        ] },
      4: { type: "short", title: "Mobility — splits/hips", body: "Splits + hip work + easy skill. Evening preferred.", sauna: "ideal", routine: MOBILITY_ROUTINE },
      5: { type: "main", title: "Upper pull + core", body: "Weighted pull-ups 5×4–6 · ring/bar rows 4×8 · front-lever prog · L-sit holds.", sauna: "avoid",
        exercises: [
          { name: "Weighted pull-ups", dose: "5 × 4–6", cue: "Add load once 6 is clean. Full hang to chin over bar. Long rest." },
          { name: "Ring / bar rows", dose: "4 × 8", cue: "Body straight, pull chest to the bar/rings, squeeze the back. Lower the feet to scale up." },
          { name: "Front-lever progression", dose: "4 × 10 sec", seconds: 10, cue: "Tuck → advanced tuck → straddle as you progress. The timer caps each clean hold." },
          { name: "L-sit hold", dose: "3 × 15 sec", seconds: 15, cue: "On the bar, parallettes, or floor. Legs straight, push the floor away. Tuck to scale." },
        ] },
      6: { type: "open", title: "Open / easy ride or hike", body: "Rest, or an easy ride/hike. Counts toward your aerobic floor (2 easy rides/week). Keep it conversational — hard rides eat the recovery the lifting needs.", sauna: "best" },
      0: { type: "open", title: "Open / rest", body: "Full rest. Easy bike commutes alone keep an aerobic floor under you.", sauna: "best" },
    },
  },
  {
    id: "endurance", name: "Endurance", weeks: [9, 16], accent: "#d9543f",
    tag: "Built on the strength base. VO2max is the weak link — intervals are the protected session; strength drops to maintenance.",
    days: {
      1: { type: "main", title: "Intervals", body: "10 min warm-up → 6–8 × (1 min hard / 90 sec easy) → 5 min cool-down. Add one interval/week (cap 10).", sauna: "good",
        exercises: [
          { name: "Warm-up", dose: "10 min easy", seconds: 600, cue: "Build gradually — last couple of minutes near interval pace to prime the legs and lungs." },
          { name: "Hard / easy intervals", dose: "6–8 rounds", cue: "1 min hard (hard but repeatable), 90 sec easy spin/jog. Add one round per week, cap at 10.", interval: { work: 60, rest: 90, rounds: 7, workLabel: "HARD", restLabel: "easy" } },
          { name: "Cool-down", dose: "5 min easy", seconds: 300, cue: "Let the heart rate drift down. Don't skip — it's where adaptation settles." },
        ] },
      2: { type: "short", title: "Skill — handstand + wrists", body: "Handstand balance practice + wrist/forearm prep. Low fatigue, sub-maximal.", sauna: "ideal", routine: HANDSTAND_ROUTINE },
      3: { type: "main", title: "Strength maintenance", body: "3 supersets: pull-ups ×5 + HSPU ×5 · pistol prog ×5/leg + push-ups ×12 · hollow + arch holds. ~25 min.", sauna: "gap",
        exercises: [
          { name: "Pull-ups + HSPU", dose: "3 × (5 + 5)", cue: "Superset, minimal rest between the pair. Stop 1–2 reps shy of failure — this is maintenance, not a grind." },
          { name: "Pistol progression + push-ups", dose: "3 × (5/leg + 12)", cue: "Pistols to your current depth (box/assisted is fine), then push-ups. Superset." },
          { name: "Hollow hold", dose: "3 × 25 sec", seconds: 25, cue: "Low back glued to floor. The timer keeps you honest when it starts to shake." },
          { name: "Arch (superman) hold", dose: "3 × 20 sec", seconds: 20, cue: "Balances the hollow — posterior chain. Squeeze glutes, lift chest and thighs." },
        ] },
      4: { type: "short", title: "Mobility — splits/hips", body: "Splits + hip work + easy skill. Best in evening (warmer). Sauna BEFORE stretch deepens range.", sauna: "ideal", routine: MOBILITY_ROUTINE },
      5: { type: "main", title: "Bike base (commute)", body: "32 km easy round-trip ~1×/week. Replaces long run — same job, low impact. Not the day after intervals.", sauna: "good" },
      6: { type: "open", title: "Open / hike", body: "Rest or an easy hike/run — bonus aerobic base.", sauna: "best" },
      0: { type: "open", title: "Open / rest", body: "Full rest, or light movement.", sauna: "best" },
    },
  },
  {
    id: "flexibility", name: "Flexibility", weeks: [17, 24], accent: "#6a8d3f",
    tag: "Specific end-ranges: splits + deeper hip rotation. Loaded, frequent, sub-maximal.",
    days: {
      1: { type: "main", title: "Front splits", body: "Hip-flexor & hamstring PNF · lunge-stretch prog · active leg raises (strength in new range = permanent).", sauna: "best",
        exercises: [
          { name: "Warm-up flow", dose: "5 min", seconds: 300, cue: "Easy lunges, leg swings, hip circles. Never PNF cold." },
          { name: "Front split slide", dose: "90 sec / side", seconds: 90, perSide: true, cue: "Hands on blocks, stay square, ease deeper on exhales. Back hip flexor is the limiter." },
          { name: "Hip-flexor / hamstring PNF", dose: "2 rounds / side", cue: "Contract 5–6 sec into the stretch, relax, ease deeper. You know the protocol — use it sparingly." },
          { name: "Active leg raises", dose: "8–10 / leg", cue: "Lift the leg under its own power near end-range. Strength in the new range is what makes it permanent." },
        ] },
      2: { type: "short", title: "Skill — handstand + wrists", body: "Handstand balance + wrist/forearm prep.", sauna: "ideal", routine: HANDSTAND_ROUTINE },
      3: { type: "main", title: "Middle splits + hips", body: "Loaded pancake/straddle · cossack squats · deep squat holds · external-rotation drills.", sauna: "best",
        exercises: [
          { name: "Loaded pancake", dose: "90 sec", seconds: 90, cue: "Wide straddle, flat back, reach actively (or light weight to chest)." },
          { name: "Cossack squats", dose: "6–8 / side", cue: "Shift side to side in a wide stance — middle-split range with strength under it." },
          { name: "Deep squat hold", dose: "2 × 60 sec", seconds: 60, cue: "Heels down, chest up, pry knees out with elbows. Pure end-range time." },
          { name: "External-rotation drills", dose: "90 sec", seconds: 90, cue: "90/90 transitions or frog — open the hip rotation that feeds the middle split." },
        ] },
      4: { type: "short", title: "Mobility flow", body: "Easy end-range flow + skill. Evening. Sauna before = deeper range.", sauna: "ideal", routine: MOBILITY_ROUTINE },
      5: { type: "main", title: "Strength + endurance maint.", body: "Short circuit (pull-ups, HSPU, squats) + 15 min easy intervals or bike commute.", sauna: "good",
        exercises: [
          { name: "Strength circuit", dose: "2–3 rounds", cue: "Pull-ups, HSPU, squats — moderate effort, keep it short. Maintenance, not a peak." },
          { name: "Easy intervals", dose: "~15 min", cue: "Or swap for the bike commute. Keeps the aerobic base ticking over in a flexibility block.", interval: { work: 60, rest: 60, rounds: 7, workLabel: "moderate", restLabel: "easy" } },
        ] },
      6: { type: "open", title: "Open / hike", body: "Rest or easy hike/run.", sauna: "best" },
      0: { type: "open", title: "Open / rest", body: "Full rest.", sauna: "best" },
    },
  },
];

// Hill intervals: the evening climb (~12–15 min) ridden as 4 × (1 min hard / 2 min easy).
const HILL_INTERVALS = { work: 60, rest: 120, rounds: 4, workLabel: "HARD", restLabel: "easy" };

// Quick-log presets for the Cardio tab. Minutes are what count toward the weekly floor.
const QUICK_LOGS = [
  { kind: "hill", icon: "⛰", label: "Hill climb", km: 2.3, effort: "Easy", minKey: "hillMins", defMin: 15, note: "Easy climb home" },
  { kind: "walk", icon: "🚶", label: "Hill walk", km: 2.3, effort: "Easy", minKey: "walkMins", defMin: 38, note: "Walked up the hill" },
  { kind: "hill-intervals", icon: "⚡", label: "Hill intervals", km: 2.3, effort: "Hard", minKey: "hillMins", defMin: 15, note: "4 × 1 min hard / 2 min easy", touchOnly: true },
];
const KIND_ICON = { hill: "⛰", walk: "🚶", "hill-intervals": "⚡", ride: "🚲" };

// Local Monday (YYYY-MM-DD) of the current week — the floor resets Monday.
function mondayKey() {
  const d = new Date(); const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Older ride entries have no minutes — estimate ~3 min/km (easy ~20 km/h).
const aerobicMins = (r) => (r.minutes != null ? r.minutes : Math.round((r.km || 0) * 3));
const weekAerobic = (rides) => (rides || []).filter((r) => r.date >= mondayKey()).reduce((n, r) => n + aerobicMins(r), 0);
function isTouchWeek(block, week) {
  const f = block.aerobicFloor; if (!f) return false;
  return f.touchWeeks.includes(week - block.weeks[0] + 1);
}

// Resolve which session sits on a canonical dayKey in a given week (block template + per-week overrides).
function daySession(block, week, dayKey) {
  const wib = week - block.weeks[0] + 1;
  const o = block.weekOverrides?.[wib]?.[dayKey];
  return o || block.days[dayKey];
}

const SAUNA_MEANING = {
  best: { label: "Sauna: ideal today", color: "#6a8d3f", note: "Rest/cardio day — pure recovery, nothing to blunt." },
  ideal: { label: "Sauna: great pairing", color: "#6a8d3f", note: "Low-fatigue day. On mobility days, sauna BEFORE stretching deepens range." },
  good: { label: "Sauna: good after", color: "#2e6e8e", note: "Heat complements endurance adaptation." },
  gap: { label: "Sauna: leave a gap", color: "#c9962e", note: "Fine, but not right after — wait a few hours / evening." },
  avoid: { label: "Sauna: not right after", color: "#c9962e", note: "Heat may blunt the strength signal. Sauna later that evening instead." },
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TYPE_LABEL = { main: "Main session", short: "Short session", open: "Open day", optional: "Optional" };

// ---------- helpers ----------
function blockForWeek(week) {
  return BLOCKS.find((b) => week >= b.weeks[0] && week <= b.weeks[1]) || BLOCKS[0];
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// CYCLE 2 (Sep 2026): restarted after a ~3-month break, Strength-first order.
// Bumping this archives the previous cycle's week/done/deload/swap state on load
// (date-based logs — progress, sauna, bike, bonus — are kept untouched).
const CYCLE_VERSION = 2;

// ramp: re-entry after a layoff — like a deload, but scaling UP toward full volume
function rampFor(week) {
  const b = blockForWeek(week);
  return b.ramp ? b.ramp[week - b.weeks[0] + 1] || null : null;
}
function applyRamp(session, r) {
  if (!r || session.type === "open" || session.type === "optional") return session;
  if (session.type === "short") return { ...session, body: session.body + ` (${r.short})` };
  return { ...session, title: session.title + " — re-entry", ramp: r, body: `${r.label}: ${r.text} ` + session.body };
}
// one place that decides what a calendar day's session looks like this week
function shapeSession(s, isDeload, ramp) {
  return isDeload ? applyDeload(s) : applyRamp(s, ramp);
}

// deload: lighten a main session's prescription, leave skill/open mostly alone
function applyDeload(session) {
  if (session.type === "open") return session;
  if (session.type === "optional")
    return { ...session, title: "Easy ride (deload)", body: "Deload week — skip the intervals, just an easy ride or rest.", exercises: undefined };
  if (session.type === "short")
    return { ...session, body: session.body + " (deload: keep it light, just movement quality.)" };
  return {
    ...session,
    title: session.title + " — deload",
    deload: true,
    body: "DELOAD WEEK: cut volume ~40–50% and keep 1–2 reps in reserve. " +
          session.body.replace(/Add one interval\/week.*?\)\.?/, "") +
          " Reduce sets, stop well short of failure. Recovery is the goal this week.",
  };
}

// Existing names kept verbatim so older log entries still chart under the same lift.
// Manual measures = only what session logging doesn't capture (tests, body metrics).
// Names of older entries still chart; they just aren't offered for new entries.
const MEASURES = ["Split depth (cm to floor)", "Freestanding handstand (sec)", "Max pull-ups (test)", "Max push-ups (test)", "Bodyweight (kg)", "Resting HR (bpm)"];

// ---------- program calendar: the week derives from a start date ----------
const DAY_MS = 864e5;
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoLocal(d); };
const mondayOf = (iso) => { const d = parseIso(iso); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return isoLocal(d); };
function weekFromStart(startIso) {
  const days = Math.round((parseIso(todayKey()) - parseIso(mondayOf(startIso))) / DAY_MS);
  return Math.min(24, Math.max(1, Math.floor(days / 7) + 1));
}
const fmtDate = (iso) => parseIso(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

// ---------- cloud sync (Vercel + Upstash Redis via /api/sync) ----------
// Local-first: every change saves to this device immediately, then pushes in the
// background. The server merges per key (newest edit wins), so a sauna logged on
// the laptop and sets logged on the phone both survive.
const SYNC_KEYS = ["logs", "saunas", "rides", "done", "deloads", "swaps", "bonusLog", "hsTier", "hsBonusLevel", "sets", "startDate", "readiness", "targets"];
const isEmptyVal = (v) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === "object" ? Object.keys(v).length === 0 : false);
const localGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const localSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// ============================================================================
// MAIN
// ============================================================================
export default function TrainingApp() {
  const [startDate, setStartDateRaw] = useState(mondayKey());
  const [logs, setLogs] = useState([]);
  const [saunas, setSaunas] = useState([]);          // [{date, minutes, context, note}]
  const [rides, setRides] = useState([]);            // [{date, km, minutes, effort, kind, note}]
  const [done, setDone] = useState({});              // { "W3-1": true|false } explicit override of auto-tick
  const [deloads, setDeloads] = useState({});        // { "3": true } week -> deload on
  const [swaps, setSwaps] = useState({});            // { week: { dayKey: srcDayKey } } per-week session overrides
  const [bonusLog, setBonusLog] = useState([]);      // [{date, id, title, kind, minutes}]
  const [hsTier, setHsTier] = useState(0);
  const [hsBonusLevel, setHsBonusLevel] = useState(0);
  const [sets, setSets] = useState({});              // { "W3-1|Weighted pull-ups": {date, week, ex, kind, reps:[..], kg, feel, target, planned, readiness} }
  const [readiness, setReadiness] = useState({});    // { "2026-09-28": {sleep, stress} }
  const [targets, setTargets] = useState({});        // { "L-sit hold": {sec, date} } manual hold-target overrides
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("today");
  const [logSub, setLogSub] = useState("cardio");
  const [viewWeek, setViewWeek] = useState(null);    // Week-tab browsing; null = follow the calendar
  const [showSettings, setShowSettings] = useState(false);
  const [sync, setSync] = useState({ state: localGet("syncToken") ? "idle" : "off" });

  const setters = { logs: setLogs, saunas: setSaunas, rides: setRides, done: setDone, deloads: setDeloads, swaps: setSwaps,
    bonusLog: setBonusLog, hsTier: setHsTier, hsBonusLevel: setHsBonusLevel, sets: setSets, startDate: setStartDateRaw,
    readiness: setReadiness, targets: setTargets };
  const dataRef = useRef({});      // latest value of every synced key (closures go stale; refs don't)
  const metaRef = useRef({});      // key -> last-edited ms on this device
  const fromStore = useRef({});    // key -> value came from storage (vs. a fresh default)
  const pushTimer = useRef(null);

  useEffect(() => {
    (async () => {
      const safeGet = async (k, def) => {
        try { const v = await Store.get(k); if (v != null) { fromStore.current[k] = true; return JSON.parse(v); } return def; }
        catch (e) { return def; }
      };
      // ---- cycle migration: archive old week-structured state, restart at week 1 ----
      const cycle = await safeGet("cycleVersion", null);
      if (cycle !== CYCLE_VERSION) {
        const old = { currentWeek: await safeGet("currentWeek", null), done: await safeGet("done", {}),
          deloads: await safeGet("deloads", {}), swaps: await safeGet("swaps", {}) };
        const hadHistory = old.currentWeek != null || Object.keys(old.done).length > 0;
        if (hadHistory && !(await safeGet("archiveCycle1", null)))
          await Store.set("archiveCycle1", JSON.stringify({ program: "Endurance → Strength → Flexibility", archivedAt: new Date().toISOString(), ...old }));
        for (const [k, v] of [["done", {}], ["deloads", {}], ["swaps", {}], ["startDate", mondayKey()], ["cycleVersion", CYCLE_VERSION]])
          await Store.set(k, JSON.stringify(v));
      }
      // ---- start-date migration: older versions stored a manual week number ----
      let sd = await safeGet("startDate", null);
      if (!sd) {
        const cw = await safeGet("currentWeek", null);
        sd = addDays(mondayKey(), -7 * ((cw || 1) - 1));
        if (cw != null) { fromStore.current.startDate = true; await Store.set("startDate", JSON.stringify(sd)); }
      }
      const loadedVals = {
        startDate: sd, logs: await safeGet("logs", []), saunas: await safeGet("saunas", []), rides: await safeGet("rides", []),
        done: await safeGet("done", {}), deloads: await safeGet("deloads", {}), swaps: await safeGet("swaps", {}),
        bonusLog: await safeGet("bonusLog", []), hsTier: await safeGet("hsTier", 0), hsBonusLevel: await safeGet("hsBonusLevel", 0),
        sets: await safeGet("sets", {}), readiness: await safeGet("readiness", {}), targets: await safeGet("targets", {}),
      };
      for (const [k, v] of Object.entries(loadedVals)) { setters[k](v); dataRef.current[k] = v; }
      metaRef.current = await safeGet("syncMeta", {});
      setLoaded(true);
      syncNow();
    })();
    const onVis = () => { if (document.visibilityState === "visible") syncNow(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line
  }, []);

  // ---- sync ----
  const syncNow = async () => {
    const token = localGet("syncToken");
    if (!token) { setSync({ state: "off" }); return; }
    const data = {}, meta = {};
    for (const k of SYNC_KEYS) {
      const v = dataRef.current[k], m = metaRef.current[k] || 0;
      // never push an untouched default — a fresh device must not overwrite real history
      if (m > 0 || (fromStore.current[k] && !isEmptyVal(v))) { data[k] = v; meta[k] = m; }
    }
    setSync((s) => ({ ...s, state: "syncing" }));
    try {
      const r = await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json", "x-sync-token": token }, body: JSON.stringify({ data, meta }) });
      if (r.status === 501) { setSync({ state: "unconfigured" }); return; }
      if (r.status === 401) { setSync({ state: "badtoken" }); return; }
      if (!r.ok) throw new Error(String(r.status));
      const out = await r.json();
      for (const k of SYNC_KEYS) {
        const rt = out.meta?.[k] || 0;
        if (out.data && k in out.data && rt > (metaRef.current[k] || 0)) {
          const v = out.data[k];
          setters[k](v); dataRef.current[k] = v; metaRef.current[k] = rt; fromStore.current[k] = true;
          Store.set(k, JSON.stringify(v));
        } else if (rt && !metaRef.current[k]) metaRef.current[k] = rt;   // server stamped our first upload
      }
      Store.set("syncMeta", JSON.stringify(metaRef.current));
      setSync({ state: "ok", at: Date.now() });
    } catch (e) { setSync({ state: "offline" }); }
  };
  const schedulePush = () => { clearTimeout(pushTimer.current); pushTimer.current = setTimeout(syncNow, 1500); };

  const save = (k, v) => {
    dataRef.current[k] = v; metaRef.current[k] = Date.now();
    Store.set(k, JSON.stringify(v)); Store.set("syncMeta", JSON.stringify(metaRef.current));
    if (localGet("syncToken")) schedulePush();
  };
  const persist = (k) => (v) => { setters[k](v); save(k, v); };
  const persistLogs = persist("logs"), persistSaunas = persist("saunas"), persistRides = persist("rides"),
    persistDone = persist("done"), persistDeloads = persist("deloads"), persistSwaps = persist("swaps"),
    persistBonusLog = persist("bonusLog"), persistHsTier = persist("hsTier"), persistHsBonusLevel = persist("hsBonusLevel"),
    persistSets = persist("sets"), persistReadiness = persist("readiness"), persistTargets = persist("targets"),
    persistStartDate = persist("startDate");

  // ---- calendar ----
  const currentWeek = weekFromStart(startDate);
  const week = viewWeek ?? currentWeek;               // the week the Week tab is showing
  const curBlock = blockForWeek(currentWeek);
  const block = blockForWeek(week);
  const accent = (view === "week" ? block : curBlock).accent;
  const isDeloadW = (w) => !!deloads[w];
  const curRamp = rampFor(currentWeek);
  const openBonus = () => { setLogSub("bonus"); setView("log"); window.scrollTo?.(0, 0); };
  const todayLevel = readinessLevel(readiness[todayKey()]);

  // ---- per-week session swaps (for the week being viewed) ----
  const swapsFor = (w) => swaps[w] || {};
  const srcFor = (w) => (k) => (swapsFor(w)[k] !== undefined ? swapsFor(w)[k] : k);
  const swapDays = (a, b) => {
    const cur = { ...swapsFor(week) };
    const srcA = cur[a] !== undefined ? cur[a] : a;
    const srcB = cur[b] !== undefined ? cur[b] : b;
    cur[a] = srcB; cur[b] = srcA;
    Object.keys(cur).forEach((k) => { if (Number(cur[k]) === Number(k)) delete cur[k]; });
    const next = { ...swaps };
    if (Object.keys(cur).length === 0) delete next[week]; else next[week] = cur;
    persistSwaps(next);
  };
  const resetWeekSwaps = () => { const next = { ...swaps }; delete next[week]; persistSwaps(next); };
  const hardDayWarnings = (() => {
    const order = [1, 2, 3, 4, 5, 6, 0], warns = [], src = srcFor(week);
    for (let i = 0; i < order.length - 1; i++) {
      const s1 = daySession(block, week, src(order[i])), s2 = daySession(block, week, src(order[i + 1]));
      if (s1?.type === "main" && s2?.type === "main") warns.push([order[i], order[i + 1]]);
    }
    return warns;
  })();

  const exportData = () => {
    const payload = { version: 2, cycleVersion: CYCLE_VERSION, exportedAt: new Date().toISOString(), startDate, currentWeek,
      logs, saunas, rides, done, deloads, swaps, bonusLog, hsTier, hsBonusLevel, sets, readiness, targets };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `training-data-${todayKey()}.json`; a.click();
    URL.revokeObjectURL(url);
  };
  const importData = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        const sameCycle = d.cycleVersion === CYCLE_VERSION;
        if (sameCycle) {
          if (d.startDate) persistStartDate(d.startDate);
          else if (d.currentWeek != null) persistStartDate(addDays(mondayKey(), -7 * (d.currentWeek - 1)));
          if (d.done && typeof d.done === "object") persistDone(d.done);
          if (d.deloads && typeof d.deloads === "object") persistDeloads(d.deloads);
          if (d.swaps && typeof d.swaps === "object") persistSwaps(d.swaps);
          if (d.sets && typeof d.sets === "object") persistSets(d.sets);
          if (d.targets && typeof d.targets === "object") persistTargets(d.targets);
        }
        if (Array.isArray(d.logs)) persistLogs(d.logs);
        if (Array.isArray(d.saunas)) persistSaunas(d.saunas);
        if (Array.isArray(d.rides)) persistRides(d.rides);
        if (Array.isArray(d.bonusLog)) persistBonusLog(d.bonusLog);
        if (d.readiness && typeof d.readiness === "object") persistReadiness(d.readiness);
        if (typeof d.hsTier === "number") persistHsTier(d.hsTier);
        if (typeof d.hsBonusLevel === "number") persistHsBonusLevel(d.hsBonusLevel);
        alert(sameCycle ? "Data imported successfully." : "Imported logs from an earlier cycle. Week progress was left as-is (different block order).");
      } catch (err) {
        alert("Couldn't read that file — make sure it's a training-data export.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // props every session card needs
  const cardProps = { sets, setSets: persistSets, targets, setTargets: persistTargets, done, setDone: persistDone,
    hsTier, setHsTier: persistHsTier, currentWeek, todayLevel };

  const NAV = [["today", "Today", "◉"], ["week", "Week", "▦"], ["log", "Log", "＋"], ["progress", "Progress", "↗"], ["coach", "Coach", "✦"]];
  const syncDot = { ok: "#6a8d3f", syncing: "#c9962e", offline: "#c9962e", badtoken: "#d9543f", unconfigured: "#d9543f" }[sync.state];

  return (
    <div style={S.shell}>
      <style>{CSS}</style>

      <header style={{ ...S.header, borderColor: curBlock.accent }}>
        <div style={{ minWidth: 0 }}>
          <div style={S.kicker}>Cycle 2 · {fmtDate(todayKey())}</div>
          <h1 style={S.h1}>
            Week {currentWeek} <span style={{ color: curBlock.accent }}>· {curBlock.name}</span>
            {isDeloadW(currentWeek) && <span style={S.deloadBadge}>DELOAD</span>}
            {!isDeloadW(currentWeek) && curRamp && <span style={{ ...S.deloadBadge, background: curBlock.accent }}>{curRamp.label}</span>}
          </h1>
        </div>
        <button onClick={() => setShowSettings(true)} style={S.gear} aria-label="Settings">
          ⚙
          {syncDot && <span style={{ ...S.gearDot, background: syncDot }} />}
        </button>
      </header>

      <BlockBar week={currentWeek} />

      {!loaded ? <div style={S.muted}>Loading…</div> : (
        <>
          {/* Today + Week stay mounted so a running timer survives a tab switch */}
          <div style={{ display: view === "today" ? "block" : "none" }}>
            <TodayView week={currentWeek} accent={curBlock.accent} isDeload={isDeloadW(currentWeek)} ramp={curRamp} rides={rides}
              srcForDay={srcFor(currentWeek)} readiness={readiness} setReadiness={persistReadiness} cardProps={cardProps}
              bonusLog={bonusLog} setBonusLog={persistBonusLog} hsLevel={hsBonusLevel} openBonus={openBonus} />
          </div>
          <div style={{ display: view === "week" ? "block" : "none" }}>
            <WeekView week={week} currentWeek={currentWeek} setViewWeek={setViewWeek} accent={block.accent} block={block}
              isDeload={isDeloadW(week)} toggleDeload={() => persistDeloads({ ...deloads, [week]: !isDeloadW(week) })}
              ramp={rampFor(week)} rides={rides} srcForDay={srcFor(week)} swapDays={swapDays} resetWeekSwaps={resetWeekSwaps}
              hasSwaps={Object.keys(swapsFor(week)).length > 0} hardDayWarnings={hardDayWarnings} cardProps={cardProps}
              weekMonday={addDays(mondayOf(startDate), 7 * (week - 1))} bonusLog={bonusLog} setBonusLog={persistBonusLog}
              hsLevel={hsBonusLevel} openBonus={openBonus} />
          </div>
          {view === "log" && (
            <div style={S.body}>
              <div style={S.segRow}>
                {[["cardio", "Cardio"], ["sauna", "Sauna"], ["bonus", "Bonus"]].map(([k, l]) => (
                  <button key={k} onClick={() => setLogSub(k)}
                    style={{ ...S.segBtn, ...(logSub === k ? { background: curBlock.accent, color: "#fff", borderColor: curBlock.accent } : {}) }}>{l}</button>
                ))}
              </div>
              {logSub === "cardio" && <RideView rides={rides} setRides={persistRides} accent={curBlock.accent} block={curBlock} week={currentWeek} />}
              {logSub === "sauna" && <SaunaView saunas={saunas} setSaunas={persistSaunas} accent={curBlock.accent} />}
              {logSub === "bonus" && <BonusView bonusLog={bonusLog} setBonusLog={persistBonusLog} accent={curBlock.accent} hsLevel={hsBonusLevel} setHsLevel={persistHsBonusLevel} />}
            </div>
          )}
          {view === "progress" && <ProgressView logs={logs} setLogs={persistLogs} sets={sets} accent={curBlock.accent} />}
          {view === "coach" && <CoachView week={currentWeek} block={curBlock} logs={logs} saunas={saunas} rides={rides} bonusLog={bonusLog}
            isDeload={isDeloadW(currentWeek)} ramp={curRamp} accent={curBlock.accent} sets={sets} targets={targets} setTargets={persistTargets}
            readiness={readiness} setDeload={() => persistDeloads({ ...deloads, [currentWeek]: true })} />}
        </>
      )}

      <nav style={S.bottomNav}>
        {NAV.map(([k, label, icon]) => (
          <button key={k} onClick={() => { setView(k); if (k === "week" && view !== "week") setViewWeek(null); window.scrollTo(0, 0); }}
            style={{ ...S.bottomBtn, color: view === k ? curBlock.accent : "#9a958c" }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span>
            <span style={{ fontWeight: view === k ? 700 : 500 }}>{label}</span>
          </button>
        ))}
      </nav>

      {showSettings && (
        <SettingsSheet onClose={() => setShowSettings(false)} accent={curBlock.accent}
          startDate={startDate} setStartDate={persistStartDate} currentWeek={currentWeek}
          sync={sync} syncNow={syncNow} exportData={exportData} importData={importData} />
      )}
    </div>
  );
}

function SettingsSheet({ onClose, accent, startDate, setStartDate, currentWeek, sync, syncNow, exportData, importData }) {
  const [token, setToken] = useState(localGet("syncToken") || "");
  const saveToken = () => { localSet("syncToken", token.trim()); if (!token.trim()) { try { localStorage.removeItem("syncToken"); } catch (e) {} } syncNow(); };
  const syncText = {
    off: "Off — data lives only on this device.",
    idle: "Ready.",
    syncing: "Syncing…",
    ok: `Synced ${sync.at ? new Date(sync.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}.`,
    offline: "Couldn't reach the server — changes are saved here and will sync next time.",
    badtoken: "The server rejected this sync key. Check it matches SYNC_TOKEN in Vercel.",
    unconfigured: "The server isn't set up yet: add an Upstash Redis store and a SYNC_TOKEN variable in Vercel.",
  }[sync.state];
  return (
    <div style={S.sheetBackdrop} onClick={onClose}>
      <div style={S.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.cardTop}>
          <h2 style={{ ...S.cardTitle, margin: 0 }}>Settings</h2>
          <button onClick={onClose} style={S.delBtn} aria-label="Close">×</button>
        </div>

        <div style={S.sheetSection}>Program</div>
        <label style={S.sheetRow}>
          <span>Week 1 started</span>
          <input type="date" value={startDate} onChange={(e) => e.target.value && setStartDate(mondayOf(e.target.value))} style={{ ...S.input, flex: "0 0 auto" }} />
        </label>
        <p style={S.muted2}>You're in week {currentWeek}. Weeks advance every Monday on their own.</p>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={() => setStartDate(addDays(startDate, 7))} style={{ ...S.dataBtn, flex: 1 }} disabled={currentWeek <= 1}>
            ⏸ Missed a week — push plan back</button>
          <button onClick={() => setStartDate(addDays(startDate, -7))} style={S.dataBtn}>⏭ skip ahead</button>
        </div>

        <div style={S.sheetSection}>Sync between devices</div>
        <div style={S.formRow}>
          <input type="password" placeholder="sync key" value={token} onChange={(e) => setToken(e.target.value)} style={S.input} autoComplete="off" />
          <button onClick={saveToken} style={{ ...S.primaryBtn, background: accent }}>Save & sync</button>
        </div>
        <p style={{ ...S.muted2, marginTop: 6 }}>{syncText}</p>
        <p style={S.muted2}>Set it up on the device with your history first; a fresh device then pulls everything down.</p>

        <div style={S.sheetSection}>Backup</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={exportData} style={{ ...S.dataBtn, flex: 1 }}>↓ Export data</button>
          <label style={{ ...S.dataBtn, flex: 1, textAlign: "center" }}>
            ↑ Import data
            <input type="file" accept="application/json,.json" onChange={importData} style={{ display: "none" }} />
          </label>
        </div>
      </div>
    </div>
  );
}


function BlockBar({ week }) {
  return (
    <div style={S.blockBar}>
      {BLOCKS.map((b) => {
        const active = week >= b.weeks[0] && week <= b.weeks[1];
        const span = b.weeks[1] - b.weeks[0] + 1;
        const fill = active ? ((week - b.weeks[0] + 1) / span) * 100 : week > b.weeks[1] ? 100 : 0;
        return (
          <div key={b.id} style={{ flex: span, ...S.blockSeg }}>
            <div style={{ ...S.blockSegLabel, color: active ? b.accent : "#9a958c", fontWeight: active ? 700 : 500 }}>
              {b.name} <span style={S.blockWeeks}>w{b.weeks[0]}–{b.weeks[1]}</span>
            </div>
            <div style={S.blockTrack}>
              <div style={{ width: `${fill}%`, background: b.accent, height: "100%", borderRadius: 4, transition: "width .4s" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Weekly easy-aerobic progress: minutes logged since Monday vs the block's floor.
function FloorCard({ block, week, rides, compact }) {
  const f = block.aerobicFloor; if (!f) return null;
  const mins = weekAerobic(rides);
  const touch = isTouchWeek(block, week);
  const touchDone = (rides || []).some((r) => r.date >= mondayKey() && r.kind === "hill-intervals");
  const RED = "#d9543f";
  const pct = Math.min(100, (mins / f.max) * 100);
  const status = mins >= f.max ? "Floor covered — more isn't needed this block."
    : mins >= f.min ? "In the range. Anything extra is a bonus."
    : `${f.min - mins} min to go — about ${Math.ceil((f.min - mins) / 15)} hill climb${Math.ceil((f.min - mins) / 15) === 1 ? "" : "s"}.`;
  return (
    <div style={{ ...S.tagBox, borderColor: RED }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <strong style={{ color: RED }}>Easy aerobic this week</strong>
        <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 18, color: mins >= f.min ? "#6a8d3f" : RED }}>
          {mins}<span style={{ fontSize: 12, color: "#9a958c" }}> / {f.min}–{f.max} min</span>
        </span>
      </div>
      <div style={{ ...S.timerTrack, height: 7, marginTop: 6, position: "relative" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: mins >= f.min ? "#6a8d3f" : RED, borderRadius: 3, transition: "width .4s" }} />
        <div style={{ position: "absolute", left: `${(f.min / f.max) * 100}%`, top: 0, bottom: 0, width: 2, background: "#fff" }} />
      </div>
      <div style={{ fontSize: 12.5, marginTop: 6 }}>{status}{!compact && ` ${f.text}`}</div>
      {touch && (
        <div style={{ fontSize: 12.5, marginTop: 6, color: touchDone ? "#6a8d3f" : "#8a5a1e" }}>
          {touchDone ? "✓ Hill intervals done this week." : "⚡ Interval week: one evening, ride the hill as 4 × (1 min hard / 2 min easy). Best Tue or Fri — not the evening before legs. Skip if sleep or stress is off."}
        </div>
      )}
    </div>
  );
}

// Two-tap morning check-in. Changes TODAY's dose only — never your targets.
function ReadinessCheck({ value, onChange, accent }) {
  const [open, setOpen] = useState(!value?.sleep || !value?.stress);
  const lvl = readinessLevel(value);
  const R = READINESS[lvl];
  const pick = (field, v) => {
    const next = { ...(value || {}), [field]: value?.[field] === v ? undefined : v };
    onChange(next);
    if (next.sleep && next.stress) setOpen(false);
  };
  if (!open) {
    return (
      <div style={S.readyBar}>
        <span style={{ ...S.readyDot, background: R.color }} />
        <span style={{ flex: 1 }}><strong>{R.label}</strong><span style={S.muted2}> · sleep {value?.sleep || "–"}, stress {value?.stress || "–"}</span></span>
        <button onClick={() => setOpen(true)} style={S.timerReset}>change</button>
      </div>
    );
  }
  const Row = ({ field, label, opts }) => (
    <div style={S.readyRow}>
      <span style={S.readyLbl}>{label}</span>
      {opts.map((o) => (
        <button key={o} onClick={() => pick(field, o)}
          style={{ ...S.readyOpt, ...(value?.[field] === o ? { background: accent, color: "#fff", borderColor: accent } : {}) }}>{o}</button>
      ))}
    </div>
  );
  return (
    <div style={{ ...S.card, padding: 14 }}>
      <div style={{ ...S.cardTop, marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>Quick check-in</strong>
        <span style={S.muted2}>optional</span>
      </div>
      <Row field="sleep" label="Sleep" opts={["good", "ok", "poor"]} />
      <Row field="stress" label="Stress" opts={["low", "med", "high"]} />
      {(value?.sleep || value?.stress) && (
        <div style={{ fontSize: 12.5, marginTop: 8, color: R.color, lineHeight: 1.45 }}><strong>{R.label}.</strong> {R.note}</div>
      )}
      {!(value?.sleep || value?.stress) && <div style={{ ...S.muted2, marginTop: 6 }}>Only scales today's number of sets. Your progression targets never drop because of a bad day.</div>}
    </div>
  );
}

function TodayView({ week, accent, isDeload, ramp, rides, srcForDay, readiness, setReadiness, cardProps, bonusLog, setBonusLog, hsLevel, openBonus }) {
  const block = blockForWeek(week);
  const td = new Date().getDay();
  const tm = (td + 1) % 7;
  const get = (k) => shapeSession(daySession(block, week, srcForDay(k)), isDeload, ramp);
  const swapped = (k) => srcForDay(k) !== k;
  const tk = todayKey();
  return (
    <div style={S.body}>
      <ReadinessCheck value={readiness[tk]} onChange={(v) => setReadiness({ ...readiness, [tk]: v })} accent={accent} />
      <SessionCard label={swapped(td) ? "TODAY · swapped" : "TODAY"} dayKey={td} week={week} session={get(td)} accent={accent} big {...cardProps} />
      <BonusStrip date={tk} session={get(td)} bonusLog={bonusLog} setBonusLog={setBonusLog} hsLevel={hsLevel} accent={accent} openBonus={openBonus} />
      <FloorCard block={block} week={week} rides={rides} compact />
      <SessionCard label={swapped(tm) ? "TOMORROW · swapped" : "TOMORROW"} dayKey={tm} week={week} session={get(tm)} accent={accent} compact {...cardProps} />
      <div style={{ ...S.tagBox, borderColor: accent }}>
        <strong style={{ color: accent }}>{block.name} block.</strong> {block.tag}
        {ramp && !isDeload && <> <strong style={{ color: accent }}>Why ease in?</strong> Strength returns fast after a break, but tendons re-adapt more slowly than muscle — and life stress draws on the same recovery budget. Two easy weeks buy the next six.</>}
      </div>
    </div>
  );
}

// Weekly bonus summary: progress toward the light targets + a Mon–Sun dot row.
function BonusWeekCard({ weekMonday, bonusLog, accent, openBonus }) {
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekMonday, i));
  const inWeek = (bonusLog || []).filter((b) => b.date >= days[0] && b.date <= days[6]);
  const today = todayKey();
  return (
    <div style={{ ...S.card, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 15 }}>Bonus this week</div>
        <button onClick={openBonus} style={{ ...S.timerReset, color: accent }}>all bonuses ›</button>
      </div>
      {BONUS_TARGETS.map((t) => {
        const n = inWeek.filter((b) => t.ids.includes(b.id)).length;
        return (
          <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ width: 78, fontSize: 12.5, fontWeight: 700, color: t.color }}>{t.label}</span>
            <div style={{ flex: 1, height: 7, background: "#efe9dd", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, (n / t.target) * 100)}%`, height: "100%", background: t.color, borderRadius: 4 }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: n >= t.target ? t.color : "#9a958c", minWidth: 34, textAlign: "right" }}>{n}/{t.target}{n >= t.target ? " ✓" : ""}</span>
          </div>
        );
      })}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        {days.map((d, i) => {
          const n = inWeek.filter((b) => b.date === d).length;
          return (
            <div key={d} style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 10.5, color: d === today ? accent : "#9a958c", fontWeight: d === today ? 800 : 600 }}>{"MTWTFSS"[i]}</div>
              <div style={{ width: 18, height: 18, margin: "3px auto 0", borderRadius: 999, fontSize: 10, fontWeight: 800, lineHeight: "18px",
                color: "#fff", background: n ? accent : "transparent", border: n ? "none" : `1.5px ${d > today ? "dashed" : "solid"} #ddd6c8` }}>{n > 1 ? n : ""}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Per-day bonus chips under a session card. Tap to log for that date (today or
// past); tap a ticked chip to remove that entry. Future days show the suggestion only.
function BonusStrip({ date, session, bonusLog, setBonusLog, hsLevel, accent, openBonus }) {
  const today = todayKey();
  const future = date > today;
  const ids = bonusFor(session);
  const log = bonusLog || [];
  const extra = log.filter((b) => b.date === date && !ids.includes(b.id));   // other bonuses done that day
  const toggle = (id) => {
    if (future) { openBonus(); return; }
    const idx = log.map((b, i) => (b.date === date && b.id === id ? i : -1)).filter((i) => i >= 0).pop();
    if (idx !== undefined) { setBonusLog(log.filter((_, i) => i !== idx)); return; }
    const s = bonusById(id);
    setBonusLog([...log, { date, id: s.id, title: s.title, kind: s.kind, minutes: s.minutes, ...(s.levelled ? { level: (hsLevel ?? 0) + 1 } : {}) }]);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "7px 4px 2px" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "#9a958c", letterSpacing: 0.4 }}>＋ BONUS</span>
      {ids.map((id) => {
        const s = bonusById(id); if (!s) return null;
        const done = log.some((b) => b.date === date && b.id === id);
        const c = s.kind === "skill" ? "#2e6e8e" : "#6a8d3f";
        return (
          <button key={id} onClick={() => toggle(id)} title={future ? "Open the routine" : done ? "Tap to undo" : "Tap to log as done"}
            style={{ fontSize: 11.5, fontWeight: 700, fontFamily: FONT_BODY, padding: "3px 9px", borderRadius: 999, cursor: "pointer",
              border: `1px ${future ? "dashed" : "solid"} ${c}66`, background: done ? c : c + "12", color: done ? "#fff" : c }}>
            {done ? "✓ " : ""}{s.title.replace(" (bike support)", "")} · {s.minutes}′
          </button>
        );
      })}
      {extra.map((b, i) => <span key={i} style={{ fontSize: 11, color: accent, fontWeight: 700 }}>✓ {b.title}</span>)}
      <button onClick={openBonus} style={{ ...S.timerReset, color: accent, marginLeft: "auto" }}>routine ›</button>
    </div>
  );
}

// is a calendar slot done? explicit tick/untick wins; otherwise every loggable move has its planned sets
function slotStatus(id, session, done, sets, level) {
  const loggable = (session.exercises || []).filter(exKind);
  const f = setFactor(session, level);
  const logged = loggable.filter((ex) => vals(sets?.[`${id}|${ex.name}`]).length >= plannedSets(ex, f)).length;
  const auto = loggable.length > 0 && logged === loggable.length;
  const isDone = done[id] !== undefined ? !!done[id] : auto;
  return { isDone, auto, logged, total: loggable.length };
}

function WeekView({ week, currentWeek, setViewWeek, accent, block, isDeload, toggleDeload, ramp, rides, srcForDay, swapDays, resetWeekSwaps, hasSwaps, hardDayWarnings, cardProps, weekMonday, bonusLog, setBonusLog, hsLevel, openBonus }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const dateFor = (k) => addDays(weekMonday, (k + 6) % 7);
  const get = (k) => shapeSession(daySession(block, week, srcForDay(k)), isDeload, ramp);
  const td = new Date().getDay();
  const levelFor = (k) => (week === currentWeek && k === td ? cardProps.todayLevel : "full");
  const completed = order.filter((k) => slotStatus(`W${week}-${k}`, get(k), cardProps.done, cardProps.sets, levelFor(k)).isDone).length;
  const [swapMode, setSwapMode] = useState(null);
  const onSwapClick = (k) => {
    if (swapMode === null) { setSwapMode(k); return; }
    if (swapMode === k) { setSwapMode(null); return; }
    swapDays(swapMode, k); setSwapMode(null);
  };
  const go = (w) => { setSwapMode(null); setViewWeek(w === currentWeek ? null : Math.min(24, Math.max(1, w))); };

  return (
    <div style={S.body}>
      <div style={S.weekNav}>
        <button style={S.stepBtn} onClick={() => go(week - 1)} disabled={week <= 1}>‹</button>
        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 20, color: accent }}>Week {week} · {block.name}</div>
          <div style={S.muted2}>
            {week === currentWeek ? "this week" : <button onClick={() => go(currentWeek)} style={{ ...S.timerReset, color: accent }}>↩ back to this week (W{currentWeek})</button>}
            {" · "}{completed}/7 done
          </div>
        </div>
        <button style={S.stepBtn} onClick={() => go(week + 1)} disabled={week >= 24}>›</button>
      </div>

      <div style={S.deloadRow}>
        <span style={S.deloadLabel}>Deload week</span>
        <button onClick={toggleDeload} style={{ ...S.toggle, background: isDeload ? accent : "#ddd6c8" }} aria-label="Toggle deload">
          <span style={{ ...S.toggleKnob, transform: isDeload ? "translateX(20px)" : "translateX(0)" }} />
        </button>
        <span style={S.muted2}>{isDeload ? "On — volume cut, recover." : "Off"}</span>
      </div>

      {week === currentWeek && <FloorCard block={block} week={week} rides={rides} compact />}
      <BonusWeekCard weekMonday={weekMonday} bonusLog={bonusLog} accent={accent} openBonus={openBonus} />

      {hardDayWarnings.length > 0 && (
        <div style={S.warnBox}>
          ⚠️ Two main sessions back-to-back: {hardDayWarnings.map(([a, b]) => `${DAY_NAMES[a]}→${DAY_NAMES[b]}`).join(", ")}.
          Consider easing one, or sliding a rest/skill day between.
        </div>
      )}
      {hasSwaps && (
        <div style={S.swapBanner}>
          <span>This week has swapped days.</span>
          <button onClick={() => { resetWeekSwaps(); setSwapMode(null); }} style={S.swapResetBtn}>Reset to plan</button>
        </div>
      )}
      {swapMode !== null && (
        <div style={S.swapHint}>
          Swapping <strong>{DAY_NAMES[swapMode]}</strong> — tap another day to swap with it, or tap {DAY_NAMES[swapMode]} again to cancel.
        </div>
      )}

      {order.map((k) => {
        const swapped = srcForDay(k) !== k;
        const isPicking = swapMode === k;
        const isTarget = swapMode !== null && swapMode !== k;
        const isToday = week === currentWeek && k === td;
        return (
          <div key={k} style={{ outline: isPicking ? `2px solid ${accent}` : isTarget ? `2px dashed ${accent}88` : "none", borderRadius: 14, transition: "outline 0.15s" }}>
            <SessionCard label={`${DAY_NAMES[k].toUpperCase()}${isToday ? " · TODAY" : ""}${swapped ? " · swapped" : ""}`}
              dayKey={k} week={week} session={get(k)} accent={accent} compact {...cardProps}
              swapControl={
                <button onClick={() => onSwapClick(k)}
                  style={{ ...S.swapBtn, color: isPicking || isTarget ? "#fff" : accent,
                    background: isPicking ? "#c9962e" : isTarget ? accent : "#fff", borderColor: accent + "66" }}>
                  {isPicking ? "✕ cancel" : isTarget ? `⇄ swap with ${DAY_NAMES[swapMode]}` : "⇄"}
                </button>
              } />
            <BonusStrip date={dateFor(k)} session={get(k)} bonusLog={bonusLog} setBonusLog={setBonusLog} hsLevel={hsLevel} accent={accent} openBonus={openBonus} />
          </div>
        );
      })}
    </div>
  );
}

// Countdown for a hold. onDone(sec) fires once when it runs out; pausing mid-hold
// offers "log Xs" so a hold you bailed on still counts as data (that's what lowers
// a target that's too hard — and a clean full-length set is what raises it).
function DrillTimer({ seconds, perSide, accent, onDone }) {
  const [remaining, setRemaining] = useState(seconds);
  const [running, setRunning] = useState(false);
  const [side, setSide] = useState(1);
  const doneRef = useRef(onDone); doneRef.current = onDone;
  useWakeLock(running);

  useEffect(() => { if (!running) { setRemaining(seconds); setSide(1); } }, [seconds]);   // target changed
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => {
    if (!running || remaining > 0) return;
    setRunning(false);
    beep(660, 0.6, 250);
    if (perSide && side === 1) { setSide(2); setRemaining(seconds); }
    else doneRef.current?.(seconds);
    // eslint-disable-next-line
  }, [remaining, running]);

  const toggle = () => {
    if (remaining === 0) { setRemaining(seconds); setSide(1); setRunning(true); }
    else setRunning(!running);
  };
  const reset = () => { setRunning(false); setRemaining(seconds); setSide(1); };
  const elapsed = seconds - remaining;
  const partial = !running && !perSide && onDone && elapsed > 0 && remaining > 0;

  const mm = String(Math.floor(remaining / 60));
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <div style={S.timerWrap}>
      <button onClick={toggle} style={{ ...S.timerBtn, background: running ? "#c9962e" : accent }} aria-label="Start or pause">
        {remaining === 0 ? "↻" : running ? "❚❚" : "▶"}
      </button>
      <div style={S.timerBody}>
        <div style={S.timerTime}>
          {mm}:{ss}
          {perSide && <span style={S.timerSide}>side {side}/2</span>}
        </div>
        <div style={S.timerTrack}>
          <div style={{ width: `${(remaining / seconds) * 100}%`, height: "100%", background: accent, borderRadius: 3, transition: "width 1s linear" }} />
        </div>
      </div>
      {partial && <button onClick={() => { onDone(elapsed); reset(); }} style={{ ...S.swapBtn, color: accent, borderColor: accent + "66", background: "#fff" }}>log {elapsed}s</button>}
      {(running || remaining !== seconds) && <button onClick={reset} style={S.timerReset}>reset</button>}
    </div>
  );
}
function beep(freq, dur, vib) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = freq; o.type = "sine";
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur + 0.02);
  } catch (e) {}
  try { if (navigator.vibrate) navigator.vibrate(vib); } catch (e) {}
}


function IntervalTimer({ config, accent }) {
  const { work, rest, rounds, workLabel = "WORK", restLabel = "rest" } = config;
  const [phase, setPhase] = useState("work");   // "work" | "rest" | "done"
  const [round, setRound] = useState(1);
  const [remaining, setRemaining] = useState(work);
  const [running, setRunning] = useState(false);
  const intervalRef = useRef(null);
  useWakeLock(running);

  const beep = (high) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = high ? 880 : 440; o.type = "sine";
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.start(); o.stop(ctx.currentTime + 0.52);
    } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(high ? [120, 60, 120] : 200); } catch (e) {}
  };

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) { advance(); return 0; }
          return r - 1;
        });
      }, 1000);
    }
    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line
  }, [running, phase, round]);

  const advance = () => {
    clearInterval(intervalRef.current);
    if (phase === "work") {
      beep(false);                       // work just ended → low tone, easy now
      setPhase("rest"); setRemaining(rest);
    } else {
      if (round >= rounds) {
        beep(false); setRunning(false); setPhase("done"); return;
      }
      beep(true);                        // rest ended → high tone, go hard
      setRound((n) => n + 1); setPhase("work"); setRemaining(work);
    }
  };

  const start = () => {
    if (phase === "done") { setPhase("work"); setRound(1); setRemaining(work); }
    setRunning(true);
  };
  const reset = () => { setRunning(false); setPhase("work"); setRound(1); setRemaining(work); };

  const isWork = phase === "work";
  const phaseColor = phase === "done" ? "#6a8d3f" : isWork ? "#d9543f" : "#2e6e8e";
  const total = isWork ? work : rest;
  const pct = phase === "done" ? 100 : (remaining / total) * 100;
  const mm = String(Math.floor(remaining / 60));
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <div style={{ ...S.intervalBox, borderColor: phaseColor + "55" }}>
      <div style={S.intervalTop}>
        <span style={{ ...S.intervalPhase, color: phaseColor }}>
          {phase === "done" ? "✓ Done" : isWork ? workLabel : restLabel}
        </span>
        <span style={S.intervalRound}>round {Math.min(round, rounds)}/{rounds}</span>
      </div>
      <div style={S.intervalMain}>
        <button onClick={() => (running ? setRunning(false) : start())}
          style={{ ...S.timerBtn, background: running ? "#c9962e" : phaseColor }}>
          {phase === "done" ? "↻" : running ? "❚❚" : "▶"}
        </button>
        <div style={S.timerBody}>
          <div style={{ ...S.timerTime, color: phaseColor }}>{mm}:{ss}</div>
          <div style={S.timerTrack}>
            <div style={{ width: `${pct}%`, height: "100%", background: phaseColor, borderRadius: 3, transition: "width 1s linear" }} />
          </div>
        </div>
        {(running || phase !== "work" || round !== 1) && <button onClick={reset} style={S.timerReset}>reset</button>}
      </div>
    </div>
  );
}

function SessionCard({ label, dayKey, week, session, accent, big, compact, done, setDone, sets, setSets, targets, setTargets, hsTier, setHsTier, currentWeek, todayLevel, swapControl }) {
  const sa = SAUNA_MEANING[session.sauna];
  const id = `W${week}-${dayKey}`;
  const isToday = week === currentWeek && dayKey === new Date().getDay();
  const level = isToday ? todayLevel : "full";
  const st = slotStatus(id, session, done, sets, level);
  const toggle = () => {
    const next = { ...done };
    if (st.isDone) { if (st.auto) next[id] = false; else delete next[id]; }
    else { if (st.auto) delete next[id]; else next[id] = true; }
    setDone(next);
  };
  const [expanded, setExpanded] = useState(false);
  const hasDetail = session.exercises || session.routine;
  const showDetail = !compact || expanded;
  return (
    <div style={{ ...S.card, ...(big ? S.cardBig : {}), ...(compact ? { padding: 14 } : {}),
      borderLeft: `5px solid ${accent}`, opacity: st.isDone && !big ? 0.62 : 1 }}>
      <div style={S.cardTop}>
        <span style={{ ...S.cardLabel, color: accent }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {st.total > 0 && <span style={S.typePill}>{st.logged}/{st.total} logged</span>}
          {st.total === 0 && <span style={S.typePill}>{TYPE_LABEL[session.type]}</span>}
          <button onClick={toggle} title={st.auto ? "Done automatically — every move logged" : "Mark done"}
            style={{ ...S.check, background: st.isDone ? accent : "#fff", borderColor: st.isDone ? accent : "#d8d2c5",
              color: st.isDone ? "#fff" : "transparent" }}>✓</button>
        </div>
      </div>
      <h2 style={{ ...S.cardTitle, fontSize: big ? 24 : compact ? 17 : 20,
        textDecoration: st.isDone && !big ? "line-through" : "none" }}>{session.title}</h2>
      {!(big && session.exercises) && <p style={{ ...S.cardBody, fontSize: compact ? 13 : 14.5, marginBottom: compact ? 8 : 12 }}>{session.body}</p>}
      {big && session.exercises && (session.ramp || session.deload) && (
        <p style={{ ...S.cardBody, fontSize: 13 }}>{session.deload ? "Deload week: fewer sets, stop well short of failure — hold lengths stay the same." : `${session.ramp.label}: ${session.ramp.text}`}</p>
      )}
      {compact && hasDetail && (
        <button onClick={() => setExpanded(!expanded)}
          style={{ ...S.routineToggle, color: accent, borderColor: accent + "44", marginBottom: expanded ? 4 : 0 }}>
          {expanded ? "▾ Hide session" : "▸ Open session"}
        </button>
      )}
      {showDetail && session.exercises && (
        <ExerciseList exercises={session.exercises} accent={accent} session={session} level={level}
          slotId={id} week={week} sets={sets} setSets={setSets} targets={targets} setTargets={setTargets} />
      )}
      {showDetail && session.routine && (
        <div style={{ marginTop: 12 }}>
          {session.routine.tiered
            ? <TieredRoutine routine={session.routine} accent={accent} hsTier={hsTier} setHsTier={setHsTier} defaultOpen={big || (compact && expanded)} />
            : <ArrayRoutine routine={session.routine} accent={accent} defaultOpen={big || (compact && expanded)} />}
        </div>
      )}
      {!compact && (
        <div style={{ ...S.saunaChip, marginTop: 12, background: sa.color + "1a", color: sa.color, borderColor: sa.color + "55" }}>
          🔥 {sa.label} — <span style={{ opacity: 0.85 }}>{sa.note}</span>
        </div>
      )}
      {swapControl && <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>{swapControl}</div>}
    </div>
  );
}

// A session's exercises, each with its logger (and timer for holds / intervals).
function ExerciseList({ exercises, accent, session, level, slotId, week, sets, setSets, targets, setTargets }) {
  const factor = setFactor(session, level);
  return (
    <div style={{ marginTop: 4 }}>
      {level !== "full" && (
        <div style={{ ...S.tierBlurb, color: READINESS[level].color, fontStyle: "normal" }}>
          {READINESS[level].label}: set counts below are scaled to today.
        </div>
      )}
      {exercises.map((it, ii) => {
        const kind = exKind(it);
        return (
          <div key={ii} style={{ ...S.routineItem, padding: "12px 0" }}>
            <div style={S.routineItemTop}>
              <span style={S.routineName}>{it.name}</span>
              <span style={S.routineDose}>{it.dose}</span>
            </div>
            <div style={S.routineCue}>{it.cue}</div>
            {kind && <SetLogger ex={it} kind={kind} slotId={slotId} week={week} store={sets || {}} setStore={setSets}
              targets={targets || {}} setTargets={setTargets} factor={factor} level={level} accent={accent} />}
            {!kind && it.seconds && <DrillTimer seconds={it.seconds} perSide={it.perSide} accent={accent} />}
            {it.interval && <IntervalTimer config={session.deload ? { ...it.interval, rounds: Math.max(3, Math.round(it.interval.rounds * 0.6)) } : it.interval} accent={accent} />}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// SET LOGGER — reps or hold-seconds logged right under each exercise.
// Keyed by the calendar SLOT (W3-1 = week 3, Monday) so a swapped session keeps
// its own log. Tap an empty set → fills with the suggestion (last time's reps, or
// the hold target) — most sets are one tap. Tap a filled set → nudge or clear.
// The hold timer logs a set by itself when it runs out.
// ============================================================================
const FEELS = [["easy", "easy", "3+ reps / plenty left"], ["right", "right", "1–2 left — the target zone"], ["hard", "hard", "nothing left / form broke"]];

function SetLogger({ ex, kind, slotId, week, store, setStore, targets, setTargets, factor, level, accent }) {
  const key = `${slotId}|${ex.name}`;
  const entry = store[key];
  const reps = entry?.reps || [];
  const kg = entry?.kg;
  const hold = kind === "hold";
  const dose = parseDose(ex.dose);
  const planned = plannedSets(ex, factor);
  const slots = Math.max(planned, reps.length);
  const prev = lastEntryFor(store, ex.name, key);
  const prog = progressionFor(ex, store, targets, key);            // state BEFORE this session
  const ov = targets[ex.name];
  // a target you set by hand after logging this slot replaces the one it was logged against
  const target = hold ? (entry?.target && !(ov && ov.date >= entry.date) ? entry.target : prog.target) : null;
  const after = entry ? progressionFor(ex, store, targets) : null;  // state after it — what next time looks like
  const [active, setActive] = useState(null);
  const [editTarget, setEditTarget] = useState(false);

  const write = (nextReps, patch = {}) => {
    const r = [...nextReps]; while (r.length && r[r.length - 1] == null) r.pop();
    const merged = { kg, feel: entry?.feel, ...patch };
    const next = { ...store };
    if (!r.length && (merged.kg == null || merged.kg === "")) delete next[key];
    else next[key] = {
      date: entry?.date || todayKey(), week, ex: ex.name, kind, reps: r,
      target: hold ? target : ex.dose, planned, readiness: entry?.readiness || level,
      ...(merged.kg != null && merged.kg !== "" ? { kg: Number(merged.kg) } : {}),
      ...(merged.feel ? { feel: merged.feel } : {}),
    };
    setStore(next);
  };
  const suggest = (i) => {
    if (hold) return target;
    const pr = prev ? vals(prev) : [];
    return pr[i] ?? pr[pr.length - 1] ?? reps.filter((x) => x != null).slice(-1)[0] ?? dose.lo ?? 5;
  };
  const firstEmpty = () => { for (let i = 0; i < slots; i++) if (reps[i] == null) return i; return slots; };
  const fill = (i, v) => { const r = [...reps]; r[i] = v; write(r); };
  const tap = (i) => { if (reps[i] == null) { fill(i, suggest(i)); setActive(null); } else setActive(active === i ? null : i); };
  const step = hold ? 5 : 1;
  const nudge = (i, d) => fill(i, Math.max(0, (reps[i] || 0) + d));
  const setVal = (i, v) => fill(i, v === "" ? null : Math.max(0, parseInt(v, 10) || 0));
  const clear = (i) => { const r = [...reps]; r[i] = null; write(r); setActive(null); };

  const logged = vals(entry);
  const total = logged.reduce((a, b) => a + b, 0);
  const color = (v) => {
    if (v == null) return null;
    if (hold) return v >= target ? "#6a8d3f" : v >= target * 0.8 ? accent : "#c9962e";
    return dose.lo == null ? accent : v >= (dose.hi ?? dose.lo) ? "#6a8d3f" : v >= dose.lo ? accent : "#c9962e";
  };
  const unit = hold ? "s" : "";
  const fmt = (e) => vals(e).map((x) => `${x}${unit}`).join("·") + (e.kg ? ` @ ${e.kg}kg` : "");
  const dirColor = { up: "#6a8d3f", down: "#c9962e", hold: "#6b665d", set: accent };
  const nextLine = !after ? null : !hold ? after.last
    : after.target !== target ? { ...after.last, text: `Next time: ${after.last.text}` }
    : after.pending ? { dir: "hold", text: after.pending } : null;

  return (
    <div style={S.setWrap}>
      {hold && (
        <div style={S.targetRow}>
          <span>Target <button onClick={() => setEditTarget(!editTarget)} style={{ ...S.targetPill, borderColor: accent + "66", color: accent }}>{target}s ✎</button>
            {target !== ex.seconds && <span style={S.muted2}> (plan: {ex.seconds}s)</span>}</span>
          {!entry && prog.pending && <span style={S.muted2}>{prog.pending}</span>}
        </div>
      )}
      {hold && editTarget && (
        <div style={S.setEditor}>
          <span style={S.muted2}>Set the target</span>
          <button onClick={() => setTargets({ ...targets, [ex.name]: { sec: Math.max(5, target - 5), date: todayKey() } })} style={S.setNudge}>−</button>
          <strong style={{ fontFamily: FONT_DISPLAY, minWidth: 36, textAlign: "center" }}>{target}s</strong>
          <button onClick={() => setTargets({ ...targets, [ex.name]: { sec: target + 5, date: todayKey() } })} style={S.setNudge}>+</button>
          {targets[ex.name] && <button onClick={() => { const t = { ...targets }; delete t[ex.name]; setTargets(t); }} style={S.timerReset}>auto</button>}
          <button onClick={() => setEditTarget(false)} style={{ ...S.setNudge, background: accent, color: "#fff", borderColor: accent }}>✓</button>
        </div>
      )}
      {hold && <DrillTimer seconds={target} accent={accent} onDone={(sec) => fill(firstEmpty(), sec)} />}

      <div style={{ ...S.setRow, marginTop: hold ? 8 : 0 }}>
        {Array.from({ length: slots }).map((_, i) => {
          const v = reps[i]; const c = color(v);
          return (
            <button key={i} onClick={() => tap(i)} aria-label={`Set ${i + 1}`}
              style={{ ...S.setChip,
                ...(v != null ? { background: c, borderColor: c, color: "#fff" } : { color: "#b5afa2" }),
                ...(active === i ? { outline: `2px solid ${accent}`, outlineOffset: 2 } : {}) }}>
              {v != null ? `${v}${unit}` : <span style={{ fontSize: 11 }}>{suggest(i)}{unit}</span>}
            </button>
          );
        })}
        <button onClick={() => fill(slots, suggest(slots))} style={S.setAdd} title="Add a set">+</button>
        {!hold && isLoadable(ex) && (
          <label style={S.kgWrap}>
            <input type="number" inputMode="decimal"
              placeholder={prog.suggestKg != null ? String(prog.suggestKg) : prev?.kg != null ? String(prev.kg) : "kg"}
              value={kg ?? ""} onChange={(e) => write(reps, { kg: e.target.value })} style={S.kgInput} />
            <span style={S.kgUnit}>kg</span>
          </label>
        )}
      </div>

      {active != null && reps[active] != null && (
        <div style={S.setEditor}>
          <span style={S.muted2}>Set {active + 1}</span>
          <button onClick={() => nudge(active, -step)} style={S.setNudge}>−</button>
          <input type="number" inputMode="numeric" value={reps[active] ?? ""} onChange={(e) => setVal(active, e.target.value)} style={S.setEditInput} />
          <button onClick={() => nudge(active, step)} style={S.setNudge}>+</button>
          <button onClick={() => clear(active)} style={S.timerReset}>clear</button>
          <button onClick={() => setActive(null)} style={{ ...S.setNudge, background: accent, color: "#fff", borderColor: accent }}>✓</button>
        </div>
      )}

      {logged.length > 0 && (
        <div style={S.feelRow}>
          <span style={S.muted2}>Felt</span>
          {FEELS.map(([k, l, tip]) => (
            <button key={k} title={tip} onClick={() => write(reps, { feel: entry?.feel === k ? undefined : k })}
              style={{ ...S.feelBtn, ...(entry?.feel === k ? { background: accent, color: "#fff", borderColor: accent } : {}) }}>{l}</button>
          ))}
        </div>
      )}

      <div style={S.setMeta}>
        {logged.length > 0
          ? <strong style={{ color: "#2a261f" }}>{logged.length}/{planned} sets · {total}{hold ? "s" : " reps"}</strong>
          : <span>{hold ? "Run the timer — it logs the set" : "Tap a set to log it"}{factor < 1 ? ` · ${planned} sets today` : ""}</span>}
        {prev && <span> · last {prev.date.slice(5)}: {fmt(prev)}</span>}
      </div>
      {!entry && !hold && prog.last && <div style={{ ...S.setMeta, color: dirColor[prog.last.dir] }}>{prog.last.dir === "up" ? "↑ " : prog.last.dir === "down" ? "↓ " : ""}{prog.last.text}</div>}
      {nextLine && logged.length >= planned && (
        <div style={{ ...S.setMeta, color: dirColor[nextLine.dir], fontWeight: 600 }}>
          {`${nextLine.dir === "up" ? "↑ " : nextLine.dir === "down" ? "↓ " : ""}${nextLine.text}`}
        </div>
      )}
      {hold && after?.atCap && <div style={{ ...S.setMeta, color: accent }}>At 2× the programmed hold — time to progress the variation (e.g. tuck → advanced tuck) and set the target back down.</div>}
    </div>
  );
}


// Renders the original array-of-groups routine (mobility).
function ArrayRoutine({ routine, accent, defaultOpen }) {
  const [show, setShow] = useState(!!defaultOpen);
  const count = routine.reduce((n, g) => n + g.items.length, 0);
  return (
    <>
      <button onClick={() => setShow(!show)}
        style={{ ...S.routineToggle, color: accent, borderColor: accent + "44" }}>
        {show ? "▾ Hide routine" : "▸ Show routine"} · {count} drills
      </button>
      {show && (
        <div style={{ marginTop: 10 }}>
          {routine.map((g, gi) => <RoutineGroup key={gi} group={g} accent={accent} />)}
          <div style={S.routineFootnote}>{MOBILITY_NOTE}</div>
        </div>
      )}
    </>
  );
}

// Renders the tiered handstand routine: fixed wrist-prep preamble + manual tier selector.
function TieredRoutine({ routine, accent, hsTier, setHsTier, defaultOpen }) {
  const [show, setShow] = useState(!!defaultOpen);
  const tierIdx = Math.min(hsTier ?? 0, routine.tiers.length - 1);
  const tier = routine.tiers[tierIdx];
  const count = routine.preamble.items.length + tier.groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <>
      <button onClick={() => setShow(!show)}
        style={{ ...S.routineToggle, color: accent, borderColor: accent + "44" }}>
        {show ? "▾ Hide routine" : "▸ Show routine"} · {routine.tiers[tierIdx].name} · {count} drills
      </button>
      {show && (
        <div style={{ marginTop: 10 }}>
          <div style={S.tierRow}>
            {routine.tiers.map((t, i) => (
              <button key={i} onClick={() => setHsTier(i)}
                style={{ ...S.tierBtn,
                  ...(i === tierIdx ? { background: accent, color: "#fff", borderColor: accent } : {}) }}>
                {t.name}
              </button>
            ))}
          </div>
          <div style={S.tierBlurb}>{tier.blurb}</div>
          <RoutineGroup group={routine.preamble} accent={accent} />
          {tier.groups.map((g, gi) => <RoutineGroup key={gi} group={g} accent={accent} />)}
          <div style={S.routineFootnote}>{HANDSTAND_NOTE}</div>
        </div>
      )}
    </>
  );
}

// Shared group renderer used by both routine types.
function RoutineGroup({ group, accent }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...S.routineGroup, color: accent }}>{group.group}</div>
      {group.items.map((it, ii) => (
        <div key={ii} style={S.routineItem}>
          <div style={S.routineItemTop}>
            <span style={S.routineName}>{it.name}</span>
            <span style={S.routineDose}>{it.dose}</span>
          </div>
          <div style={S.routineCue}>{it.cue}</div>
          {it.seconds && <DrillTimer seconds={it.seconds} perSide={it.perSide} accent={accent} />}
        </div>
      ))}
    </div>
  );
}

function BonusCard({ session, accent, onLog, todayCount, hsLevel, setHsLevel }) {
  const [open, setOpen] = useState(false);
  const kindColor = session.kind === "skill" ? "#2e6e8e" : "#6a8d3f";

  // Build the routine groups: levelled handstand sessions pull from HS_BONUS_LEVELS;
  // others use their static groups.
  let groups, levelInfo = null;
  if (session.levelled) {
    const lvl = Math.min(hsLevel ?? 0, HS_BONUS_LEVELS.length - 1);
    const L = HS_BONUS_LEVELS[lvl];
    levelInfo = { idx: lvl, ...L };
    groups = [HANDSTAND_WRIST_PREP, { group: `${L.name} — balance work`, items: session.variant === "full" ? L.full : L.short }];
  } else {
    groups = session.groups;
  }

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <h2 style={{ ...S.cardTitle, marginBottom: 2 }}>{session.title}</h2>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ ...S.bonusTag, background: kindColor + "1a", color: kindColor, borderColor: kindColor + "55" }}>
              {session.kind === "skill" ? "skill" : "mobility"}
            </span>
            <span style={S.bonusMins}>~{session.minutes} min</span>
            {levelInfo && <span style={{ ...S.bonusTag, background: "#2e6e8e1a", color: "#2e6e8e", borderColor: "#2e6e8e55" }}>Lv {levelInfo.idx + 1} · {levelInfo.name}</span>}
            {todayCount > 0 && <span style={{ ...S.bonusTag, background: accent + "1a", color: accent, borderColor: accent + "55" }}>✓ done today{todayCount > 1 ? ` ×${todayCount}` : ""}</span>}
          </div>
        </div>
      </div>
      <p style={{ ...S.cardBody, fontSize: 13, margin: "4px 0 8px" }}>{session.blurb}</p>
      <button onClick={() => setOpen(!open)}
        style={{ ...S.routineToggle, color: accent, borderColor: accent + "44" }}>
        {open ? "▾ Hide" : "▸ Show routine"}
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {levelInfo && (
            <>
              <div style={S.tierRow}>
                {HS_BONUS_LEVELS.map((L, i) => (
                  <button key={i} onClick={() => setHsLevel(i)}
                    style={{ ...S.tierBtn, ...(i === levelInfo.idx ? { background: "#2e6e8e", color: "#fff", borderColor: "#2e6e8e" } : {}) }}>
                    Lv {i + 1}
                  </button>
                ))}
              </div>
              <div style={S.tierBlurb}>{levelInfo.gate}</div>
            </>
          )}
          {groups.map((g, gi) => <RoutineGroup key={gi} group={g} accent={accent} />)}
          {levelInfo && <div style={S.routineFootnote}>Wrist prep every time. Advance a level only when the gate above is met cleanly — skill is gated by control, not reps logged.</div>}
        </div>
      )}
      <button onClick={onLog} style={{ ...S.bonusLogBtn, background: accent }}>
        + Log done today
      </button>
    </div>
  );
}

function BonusView({ bonusLog, setBonusLog, accent, hsLevel, setHsLevel }) {
  const today = todayKey();
  const logToday = (s) => setBonusLog([...bonusLog, { date: today, id: s.id, title: s.title, kind: s.kind, minutes: s.minutes, ...(s.levelled ? { level: (hsLevel ?? 0) + 1 } : {}) }]);
  const undoLast = () => setBonusLog(bonusLog.slice(0, -1));
  const countToday = (id) => bonusLog.filter((b) => b.date === today && b.id === id).length;

  // simple 7-day tally
  const weekAgo = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  const last7 = bonusLog.filter((b) => b.date >= weekAgo);
  const skillCount = last7.filter((b) => b.kind === "skill").length;
  const mobCount = last7.filter((b) => b.kind === "mobility").length;
  const totalMin = last7.reduce((n, b) => n + (b.minutes || 0), 0);
  const recent = [...bonusLog].reverse().slice(0, 10);

  return (
    <div style={S.body}>
      <div style={{ ...S.tagBox, borderColor: accent }}>
        <strong style={{ color: accent }}>Bonus side-quests.</strong> {BONUS_NOTE}
      </div>

      <div style={S.bonusStats}>
        <div style={S.bonusStat}><div style={{ ...S.bonusStatNum, color: "#2e6e8e" }}>{skillCount}</div><div style={S.bonusStatLbl}>skill · 7d</div></div>
        <div style={S.bonusStat}><div style={{ ...S.bonusStatNum, color: "#6a8d3f" }}>{mobCount}</div><div style={S.bonusStatLbl}>mobility · 7d</div></div>
        <div style={S.bonusStat}><div style={{ ...S.bonusStatNum, color: accent }}>{totalMin}</div><div style={S.bonusStatLbl}>min · 7d</div></div>
      </div>

      <BonusHeatmap bonusLog={bonusLog} accent={accent} />

      {BONUS_SESSIONS.map((s) => (
        <BonusCard key={s.id} session={s} accent={accent} onLog={() => logToday(s)} todayCount={countToday(s.id)}
          hsLevel={hsLevel} setHsLevel={setHsLevel} />
      ))}

      {recent.length > 0 && (
        <div style={S.card}>
          <h2 style={S.cardTitle}>Recent bonuses</h2>
          {recent.map((b, i) => (
            <div key={i} style={S.bonusRow}>
              <span>{b.title}{b.level ? ` · Lv ${b.level}` : ""}</span>
              <span style={S.muted}>{b.date.slice(5)} · {b.minutes}m</span>
            </div>
          ))}
          <button onClick={undoLast} style={{ ...S.dataBtn, marginTop: 8 }}>↩ Undo last</button>
        </div>
      )}
    </div>
  );
}

// Month-view heatmap: last ~5 weeks, one cell per day, colour intensity by bonus count.
function BonusHeatmap({ bonusLog, accent }) {
  // tally per ISO date
  const tally = {};
  bonusLog.forEach((b) => { tally[b.date] = (tally[b.date] || 0) + 1; });

  // build 35 days (5 weeks) ending today, aligned so columns are weeks, rows Mon..Sun
  const days = 35;
  const cells = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 864e5);
    const iso = d.toISOString().slice(0, 10);
    cells.push({ iso, count: tally[iso] || 0, dow: (d.getDay() + 6) % 7, day: d.getDate() }); // dow 0=Mon
  }
  // group into weeks (columns)
  const weeks = [];
  let cur = [];
  cells.forEach((c, i) => {
    cur.push(c);
    if (c.dow === 6 || i === cells.length - 1) { weeks.push(cur); cur = []; }
  });
  const shade = (n) => n === 0 ? "#efeae0" : n === 1 ? accent + "55" : n === 2 ? accent + "99" : accent;
  const total = bonusLog.filter((b) => cells.some((c) => c.iso === b.date)).length;
  const activeDays = cells.filter((c) => c.count > 0).length;
  const rowLabels = ["M", "T", "W", "T", "F", "S", "S"];

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <h2 style={{ ...S.cardTitle, margin: 0 }}>Last 5 weeks</h2>
        <span style={S.muted}>{activeDays} active days · {total} sessions</span>
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginRight: 2 }}>
          {rowLabels.map((r, i) => <div key={i} style={S.heatRowLabel}>{r}</div>)}
        </div>
        {weeks.map((wk, wi) => {
          // pad each week to 7 rows aligned by dow
          const col = Array(7).fill(null);
          wk.forEach((c) => { col[c.dow] = c; });
          return (
            <div key={wi} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {col.map((c, ri) => (
                <div key={ri} title={c ? `${c.iso}: ${c.count} bonus${c.count === 1 ? "" : "es"}` : ""}
                  style={{ ...S.heatCell, background: c ? shade(c.count) : "transparent" }} />
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, justifyContent: "flex-end" }}>
        <span style={S.muted}>less</span>
        {[0, 1, 2, 3].map((n) => <div key={n} style={{ ...S.heatCell, background: shade(n) }} />)}
        <span style={S.muted}>more</span>
      </div>
    </div>
  );
}

function ProgressView({ logs, setLogs, sets, accent }) {
  // exercises that have inline set logs, newest-first
  const setEntries = Object.values(sets || {}).filter((e) => e.reps?.some((x) => x != null));
  const exNames = [...new Set([...setEntries].sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => e.ex))];
  const [ex, setEx] = useState(exNames[0] || "");
  const exSeries = setEntries.filter((e) => e.ex === ex).sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => { const r = e.reps.filter((x) => x != null); return { date: e.date.slice(5), total: r.reduce((a, b) => a + b, 0), best: Math.max(...r), kg: e.kg }; });
  const isHoldEx = setEntries.some((e) => e.ex === ex && e.kind === "hold");
  const legacy = [...new Set(logs.map((l) => l.lift))].filter((l) => !MEASURES.includes(l));
  const [lift, setLift] = useState(MEASURES[0]);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const add = () => {
    const num = parseFloat(value); if (isNaN(num)) return;
    setLogs([...logs, { date: todayKey(), lift, value: num, note: note.trim() }]);
    setValue(""); setNote("");
  };
  const removeAt = (i) => setLogs(logs.filter((_, idx) => idx !== i));
  const series = logs.filter((l) => l.lift === lift).map((l) => ({ date: l.date.slice(5), value: l.value }));
  const recent = [...logs].reverse().slice(0, 12);
  return (
    <div style={S.body}>
      {exNames.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTop}>
            <h2 style={S.cardTitle}>Session sets</h2>
            <span style={S.muted2}>{exSeries.length} sessions</span>
          </div>
          <select value={ex} onChange={(e) => setEx(e.target.value)} style={{ ...S.select, width: "100%", marginBottom: 8 }}>
            {exNames.map((n) => <option key={n}>{n}</option>)}
          </select>
          {exSeries.length < 2 ? <p style={S.muted}>Log this exercise in two sessions to see a trend. Latest: {exSeries.slice(-1)[0]?.total}{isHoldEx ? "s held" : " reps"}.</p> : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={exSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6b665d" }} />
                <YAxis tick={{ fontSize: 11, fill: "#6b665d" }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #ddd", fontSize: 13 }} />
                <Line type="monotone" dataKey="total" name={isHoldEx ? "total seconds" : "total reps"} stroke={accent} strokeWidth={2.5} dot={{ r: 3, fill: accent }} />
                <Line type="monotone" dataKey="best" name="best set" stroke="#9a958c" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
          <div style={S.muted2}>Logged under each exercise in Today / Week. Solid = total {isHoldEx ? "seconds" : "reps"}, dashed = best set.</div>
        </div>
      )}
      <div style={S.card}>
        <h2 style={S.cardTitle}>Other measures</h2>
        <p style={{ ...S.muted2, marginTop: -4, marginBottom: 8 }}>Tests and body numbers — your session sets are logged under each exercise.</p>
        <div style={S.formRow}>
          <select value={lift} onChange={(e) => setLift(e.target.value)} style={S.select}>
            {MEASURES.map((l) => <option key={l}>{l}</option>)}
            {legacy.length > 0 && <optgroup label="Older entries">{legacy.map((l) => <option key={l}>{l}</option>)}</optgroup>}
          </select>
          <input type="number" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} style={S.input} />
        </div>
        <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)}
          style={{ ...S.input, width: "100%", marginTop: 8 }} />
        <button onClick={add} style={{ ...S.primaryBtn, background: accent, marginTop: 10 }}>Add entry</button>
      </div>
      <div style={S.card}>
        <div style={S.cardTop}>
          <h2 style={S.cardTitle}>{lift}</h2>
          <span style={S.muted2}>{series.length} entries</span>
        </div>
        {series.length < 2 ? <p style={S.muted}>Add at least two entries to see a trend.</p> : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={series} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6b665d" }} />
              <YAxis tick={{ fontSize: 11, fill: "#6b665d" }} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #ddd", fontSize: 13 }} />
              <Line type="monotone" dataKey="value" stroke={accent} strokeWidth={2.5} dot={{ r: 3, fill: accent }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <div style={S.card}>
        <h2 style={S.cardTitle}>Recent entries</h2>
        {recent.length === 0 ? <p style={S.muted}>Nothing logged yet.</p> :
          recent.map((l, i) => (
            <div key={i} style={S.logRow}>
              <span style={{ fontWeight: 600 }}>{l.value}</span>
              <span style={S.logLift}>{l.lift}</span>
              <span style={S.muted2}>{l.date.slice(5)}</span>
              {l.note && <span style={S.logNote}>"{l.note}"</span>}
              <button onClick={() => removeAt(logs.length - 1 - i)} style={S.delBtn}>×</button>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------- Sauna logger ----------------
function RideView({ rides, setRides, accent, block, week }) {
  // typical durations for the one-tap presets — editable, remembered on this device
  const [mins, setMins] = useState({ hillMins: 15, walkMins: 38 });
  useEffect(() => { (async () => {
    try { const v = await Store.get("quickMins"); if (v) setMins((m) => ({ ...m, ...JSON.parse(v) })); } catch (e) {}
  })(); }, []);
  const setMin = (k, v) => { const n = { ...mins, [k]: v }; setMins(n); Store.set("quickMins", JSON.stringify(n)); };

  const [flash, setFlash] = useState(null);
  const [showTimer, setShowTimer] = useState(false);
  const touch = isTouchWeek(block, week) || !block.aerobicFloor;   // intervals: planned weeks, or any week outside the Strength block

  const quickLog = (q) => {
    const m = Number(mins[q.minKey]) || q.defMin;
    setRides([...rides, { date: todayKey(), km: q.km, minutes: m, effort: q.effort, kind: q.kind, note: q.note }]);
    setFlash(`${q.icon} ${q.label} logged · ${m} min`);
    setTimeout(() => setFlash(null), 2500);
  };

  // custom entry
  const [kind, setKind] = useState("ride");
  const [km, setKm] = useState("");
  const [minutes, setMinutes] = useState("");
  const [effort, setEffort] = useState("Easy");
  const [note, setNote] = useState("");
  const EFFORTS = ["Easy", "Moderate", "Hard"];
  const add = () => {
    const d = parseFloat(km), m = parseFloat(minutes);
    if (isNaN(d) && isNaN(m)) return;
    setRides([...rides, { date: todayKey(), km: isNaN(d) ? 0 : d, ...(isNaN(m) ? {} : { minutes: m }), effort, kind, note: note.trim() }]);
    setKm(""); setMinutes(""); setNote("");
  };
  const removeAt = (i) => setRides(rides.filter((_, idx) => idx !== i));

  const wk = rides.filter((r) => r.date >= mondayKey());
  const hardCount = wk.filter((r) => r.effort === "Hard").length;
  const recent = [...rides].reverse().slice(0, 12);

  return (
    <div style={S.body}>
      {block.aerobicFloor ? <FloorCard block={block} week={week} rides={rides} compact /> : (
        <div style={{ ...S.card, borderLeft: `5px solid ${accent}` }}>
          <div style={S.cardTop}>
            <h2 style={S.cardTitle}>This week</h2>
            <span style={{ fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 700, color: accent }}>
              {weekAerobic(rides)}<span style={{ fontSize: 14, color: "#9a958c" }}> min</span>
            </span>
          </div>
          <p style={S.muted}>{wk.length} session{wk.length === 1 ? "" : "s"}{hardCount ? ` · ${hardCount} hard` : ""}.
            {hardCount >= 2 ? " Two+ hard efforts — keep them well clear of intervals and legs." : ""}</p>
        </div>
      )}

      <div style={S.card}>
        <h2 style={S.cardTitle}>One-tap log</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {QUICK_LOGS.filter((q) => !q.touchOnly || touch).map((q) => (
            <div key={q.kind} style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <button onClick={() => quickLog(q)}
                style={{ ...S.primaryBtn, flex: 1, textAlign: "left", fontSize: 15, padding: "14px 16px",
                  background: q.effort === "Hard" ? "#d9543f" : accent }}>
                {q.icon} {q.label} <span style={{ opacity: 0.8, fontWeight: 500, fontSize: 13 }}>· {q.effort.toLowerCase()}</span>
              </button>
              <label style={S.quickMinBox} title="Typical minutes for this preset">
                <input type="number" value={mins[q.minKey]} onChange={(e) => setMin(q.minKey, e.target.value)}
                  style={S.quickMinInput} />
                <span style={{ fontSize: 10.5, color: "#9a958c" }}>min</span>
              </label>
            </div>
          ))}
        </div>
        {flash && <div style={{ ...S.swapBanner, marginTop: 10 }}>
          <span>✓ {flash}</span>
          <button onClick={() => { setRides(rides.slice(0, -1)); setFlash(null); }} style={S.swapResetBtn}>Undo</button>
        </div>}
        <p style={{ ...S.muted2, marginTop: 10 }}>
          Easy = you could breathe through your nose. On the climb: lowest gear, high cadence — if you're gasping, slow down. The minutes box sets your usual time for each button.
        </p>
        {touch && (
          <>
            <button onClick={() => setShowTimer(!showTimer)}
              style={{ ...S.routineToggle, color: "#d9543f", borderColor: "#d9543f44", marginTop: 8 }}>
              {showTimer ? "▾ Hide hill-interval timer" : "▸ Hill-interval timer · 4 × 1 min hard / 2 min easy"}
            </button>
            {showTimer && <>
              <p style={{ ...S.muted2, marginTop: 8 }}>Start at the bottom. Hard ≈ 8/10 — controlled, not all-out. The goal is a reminder, not exhaustion. Log it with ⚡ when you're home.</p>
              <IntervalTimer config={HILL_INTERVALS} accent="#d9543f" />
            </>}
          </>
        )}
      </div>

      <div style={S.card}>
        <h2 style={S.cardTitle}>Log something else</h2>
        <div style={S.formRow}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={S.select}>
            <option value="ride">🚲 Ride</option>
            <option value="walk">🚶 Walk / hike</option>
          </select>
          <select value={effort} onChange={(e) => setEffort(e.target.value)} style={S.select}>
            {EFFORTS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ ...S.formRow, marginTop: 8 }}>
          <input type="number" placeholder="minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} style={S.input} />
          <input type="number" placeholder="km (optional)" value={km} onChange={(e) => setKm(e.target.value)} style={S.input} />
        </div>
        <input placeholder="note (optional)" value={note}
          onChange={(e) => setNote(e.target.value)} style={{ ...S.input, width: "100%", marginTop: 8 }} />
        <button onClick={add} style={{ ...S.primaryBtn, background: accent, marginTop: 10 }}>Log</button>
        {effort === "Hard" &&
          <p style={{ ...S.muted2, marginTop: 8, color: "#c9962e" }}>A hard ride counts like an interval session for your legs — don't stack it next to leg day.</p>}
      </div>

      <div style={S.card}>
        <h2 style={S.cardTitle}>Recent</h2>
        {recent.length === 0 ? <p style={S.muted}>Nothing logged yet.</p> :
          recent.map((r, i) => (
            <div key={i} style={S.logRow}>
              <span style={{ fontWeight: 600 }}>{KIND_ICON[r.kind] || "🚲"} {aerobicMins(r)} min</span>
              <span style={S.logLift}>{r.km ? `${r.km} km · ` : ""}{r.effort}</span>
              <span style={S.muted2}>{r.date.slice(5)}</span>
              {r.note && <span style={S.logNote}>"{r.note}"</span>}
              <button onClick={() => removeAt(rides.length - 1 - i)} style={S.delBtn}>×</button>
            </div>
          ))}
      </div>
    </div>
  );
}

function SaunaView({ saunas, setSaunas, accent }) {
  const [minutes, setMinutes] = useState("");
  const [context, setContext] = useState("Rest day");
  const [note, setNote] = useState("");
  const CONTEXTS = ["Rest day", "After cardio", "After short session", "After strength (gap)", "Before mobility", "Standalone"];
  const add = () => {
    const m = parseFloat(minutes); if (isNaN(m)) return;
    setSaunas([...saunas, { date: todayKey(), minutes: m, context, note: note.trim() }]);
    setMinutes(""); setNote("");
  };
  const removeAt = (i) => setSaunas(saunas.filter((_, idx) => idx !== i));

  // this week's count (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const thisWeek = saunas.filter((s) => s.date >= weekAgo).length;
  const target = thisWeek >= 2 && thisWeek <= 4;
  const recent = [...saunas].reverse().slice(0, 10);

  return (
    <div style={S.body}>
      <div style={{ ...S.card, borderLeft: `5px solid ${accent}` }}>
        <div style={S.cardTop}>
          <h2 style={S.cardTitle}>This week</h2>
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 700,
            color: target ? "#6a8d3f" : "#c9962e" }}>{thisWeek}<span style={{ fontSize: 15, color: "#9a958c" }}>/2–4</span></span>
        </div>
        <p style={S.muted}>{target ? "In the sweet spot for recovery + cardiovascular benefit."
          : thisWeek < 2 ? "Room for more — aim for 2–4 sessions/week." : "Plenty this week; more isn't necessary."}</p>
      </div>
      <div style={S.card}>
        <h2 style={S.cardTitle}>Log a sauna session</h2>
        <div style={S.formRow}>
          <input type="number" placeholder="minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} style={S.input} />
          <select value={context} onChange={(e) => setContext(e.target.value)} style={S.select}>
            {CONTEXTS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <input placeholder="note (optional) — e.g. 2 rounds, felt great" value={note}
          onChange={(e) => setNote(e.target.value)} style={{ ...S.input, width: "100%", marginTop: 8 }} />
        <button onClick={add} style={{ ...S.primaryBtn, background: accent, marginTop: 10 }}>Log session</button>
        {context === "After strength (gap)" &&
          <p style={{ ...S.muted2, marginTop: 8, color: "#c9962e" }}>Reminder: leave a few hours after heavy lifting — heat may blunt the strength signal if too immediate.</p>}
        {context === "Before mobility" &&
          <p style={{ ...S.muted2, marginTop: 8, color: "#6a8d3f" }}>Good call — warm tissue reaches deeper range. Stretch right after.</p>}
      </div>
      <div style={S.card}>
        <h2 style={S.cardTitle}>Recent sessions</h2>
        {recent.length === 0 ? <p style={S.muted}>No sauna sessions logged yet.</p> :
          recent.map((s, i) => (
            <div key={i} style={S.logRow}>
              <span style={{ fontWeight: 600 }}>{s.minutes}m</span>
              <span style={S.logLift}>{s.context}</span>
              <span style={S.muted2}>{s.date.slice(5)}</span>
              {s.note && <span style={S.logNote}>"{s.note}"</span>}
              <button onClick={() => removeAt(saunas.length - 1 - i)} style={S.delBtn}>×</button>
            </div>
          ))}
      </div>
    </div>
  );
}

// ============================================================================
// COACH — PROGRESSION PANEL (rule-based, transparent, reversible)
// Reads every logged set, shows what the engine changed and why, and only raises
// a block-level flag (deload) when several signals agree — one bad day never does.
// ============================================================================
const ALL_EXERCISES = (() => {
  const m = new Map();
  BLOCKS.forEach((b) => Object.values(b.days).forEach((d) => (d.exercises || []).forEach((ex) => { if (exKind(ex) && !m.has(ex.name)) m.set(ex.name, ex); })));
  return [...m.values()];
})();

function coachSignals(sets, targets) {
  return ALL_EXERCISES.map((ex) => ({ ex, p: progressionFor(ex, sets, targets) }))
    .filter(({ p }) => p && p.n > 0)
    .map(({ ex, p }) => {
      const last = p.last;
      const lastDate = Object.values(sets).filter((e) => e.ex === ex.name && vals(e).length).map((e) => e.date).sort().pop();
      return { ex, p, last, lastDate, dir: last?.dir || "hold" };
    })
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
}

function readinessStats(readiness, days = 7) {
  const from = addDays(todayKey(), -(days - 1));
  const entries = Object.entries(readiness || {}).filter(([d]) => d >= from);
  const low = entries.filter(([, r]) => readinessLevel(r) !== "full").length;
  return { answered: entries.length, low };
}

function ProgressionPanel({ sets, targets, setTargets, readiness, isDeload, setDeload, week, accent }) {
  const sig = coachSignals(sets || {}, targets || {});
  const rs = readinessStats(readiness);
  const recent = addDays(todayKey(), -10);
  const downs = sig.filter((s) => s.dir === "down" && s.last?.date >= recent);
  const shortish = sig.filter((s) => s.lastDate >= recent && /under|short/i.test(s.last?.text || "")).length;
  // deload only when evidence converges: 2+ targets eased, or a rough week AND performance slipping
  const suggestDeload = !isDeload && (downs.length >= 2 || (rs.low >= 3 && shortish >= 2));
  const icon = { up: "↑", down: "↓", hold: "→", set: "✎" };
  const col = { up: "#6a8d3f", down: "#c9962e", hold: "#9a958c", set: accent };

  if (!sig.length) {
    return (
      <div style={{ ...S.tagBox, borderColor: accent }}>
        <strong style={{ color: accent }}>Progression.</strong> Log a few sessions (reps under each exercise, holds via the timer, and how it felt) — this panel then shows what should move up, hold, or ease off, and why.
      </div>
    );
  }
  return (
    <div style={S.card}>
      <div style={S.cardTop}>
        <h2 style={{ ...S.cardTitle, margin: 0 }}>Progression</h2>
        <span style={S.muted2}>{rs.answered ? `${rs.low}/${rs.answered} low days this week` : "no check-ins yet"}</span>
      </div>
      {suggestDeload && (
        <div style={{ ...S.warnBox, margin: "8px 0" }}>
          <strong>Consider a deload for week {week}.</strong>{" "}
          {downs.length >= 2 ? `${downs.length} targets eased in the last 10 days` : `${rs.low} low-readiness days and performance slipping`} — that's the pattern of accumulated fatigue, not one bad day.
          <div style={{ marginTop: 8 }}><button onClick={setDeload} style={S.swapResetBtn}>Make week {week} a deload</button></div>
        </div>
      )}
      {sig.map(({ ex, p, last, dir }) => {
        const canUndo = p.kind === "hold" && (dir === "up" || dir === "down") && last?.from != null;
        return (
          <div key={ex.name} style={S.progRow}>
            <span style={{ ...S.progIcon, color: col[dir] }}>{icon[dir]}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 13.5 }}>{ex.name}</strong>
                {p.kind === "hold" && <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, color: col[dir] }}>{p.target}s</span>}
              </div>
              <div style={{ fontSize: 12.5, color: "#6b665d", lineHeight: 1.4 }}>
                {last?.text || (p.kind === "hold" ? `Holding at ${p.target}s` : "Logged — keep going")}{p.pending ? ` · ${p.pending}` : ""}{p.atCap ? " · at 2× the plan: progress the variation" : ""}
              </div>
              {canUndo && (
                <button onClick={() => setTargets({ ...targets, [ex.name]: { sec: last.from, date: todayKey() } })} style={{ ...S.timerReset, paddingLeft: 0 }}>
                  keep it at {last.from}s instead
                </button>
              )}
              {targets?.[ex.name] && (
                <button onClick={() => { const t = { ...targets }; delete t[ex.name]; setTargets(t); }} style={{ ...S.timerReset, paddingLeft: 0, marginLeft: canUndo ? 10 : 0 }}>
                  back to automatic
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div style={{ ...S.routineFootnote, fontStyle: "normal" }}>
        Holds: +5s after two clean sessions (one, if it felt easy); −5s after two short ones. Reps: every set at the top of the range → add load. Days you checked in as low can move you up but never down.
      </div>
    </div>
  );
}

function CoachView({ week, block, logs, saunas, rides, bonusLog, isDeload, ramp, accent, sets, targets, setTargets, readiness, setDeload }) {
  // Day-aware bonus suggestion: pick the most fitting side-quest for today's context.
  const bonusSuggestion = (() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const td = new Date().getDay();
    const todaySession = daySession(block, week, td);
    const doneToday = (bonusLog || []).filter((b) => b.date === todayIso);
    const didSkillToday = doneToday.some((b) => b.kind === "skill");
    const didMobToday = doneToday.some((b) => b.kind === "mobility");
    const rodeHardToday = (rides || []).some((r) => r.date === todayIso && r.effort === "Hard");
    const isMainDay = todaySession?.type === "main";
    const isOpenOrShort = todaySession?.type === "open" || todaySession?.type === "short";

    if (rodeHardToday && !didMobToday)
      return "You rode hard today — the Back-care core or Daily mobility bonus would aid recovery and ease the lower back.";
    if (isOpenOrShort && !didSkillToday)
      return "Light day today and fresh — a great window for the Handstand touch-up. Frequency is what progresses the skill.";
    if (isMainDay && !didMobToday)
      return "Main session today — keep bonuses light: 5-min mobility only, save energy for the priority work.";
    if (!didSkillToday && !didMobToday)
      return "No bonus yet today — even a 5-min handstand touch-up or mobility flow compounds.";
    if (didSkillToday && !didMobToday)
      return "Skill done — a short mobility flow would round out the day and help recovery.";
    return "Nice — you've already logged a bonus today. Don't force more; consistency over volume.";
  })();

  const [messages, setMessages] = useState([
    { role: "assistant", text: `Hi! You're in week ${week} (${block.name} block${isDeload ? ", DELOAD" : ramp ? `, ${ramp.label.toLowerCase()}` : ""}). ${bonusSuggestion} Ask me to adjust today's session, plan around soreness, sauna timing, or anything else.` },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages, busy]);

  const send = async () => {
    if (!input.trim() || busy) return;
    const next = [...messages, { role: "user", text: input.trim() }];
    setMessages(next); setInput(""); setBusy(true);
    const logSummary = logs.length ? logs.slice(-15).map((l) => `${l.date} ${l.lift}=${l.value}`).join("; ") : "none";
    const saunaSummary = saunas.length ? `${saunas.slice(-7).length} recent (last: ${saunas[saunas.length-1].context})` : "none";
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const wkRides = rides.filter((r) => r.date >= weekAgo);
    const wkMon = rides.filter((r) => r.date >= mondayKey());
    const rideSummary = wkMon.length ? `${weekAerobic(rides)} easy-aerobic min since Monday over ${wkMon.length} sessions (${wkMon.filter(r=>r.kind==="hill").length} hill climbs, ${wkMon.filter(r=>r.kind==="walk").length} walks, ${wkMon.filter(r=>r.effort==="Hard").length} hard)` : "none since Monday";
    const wkBonus = (bonusLog || []).filter((b) => b.date >= weekAgo);
    const bonusSummary = wkBonus.length ? `${wkBonus.filter(b=>b.kind==="skill").length} skill + ${wkBonus.filter(b=>b.kind==="mobility").length} mobility this week` : "none this week";
    const since = addDays(todayKey(), -14);
    const setLines = Object.values(sets || {}).filter((e) => e.date >= since && vals(e).length)
      .sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-30)
      .map((e) => `${e.date} ${e.ex}: ${vals(e).join("/")}${e.kind === "hold" ? "s (target " + e.target + "s)" : ""}${e.kg ? " @" + e.kg + "kg" : ""}${e.feel ? " felt " + e.feel : ""}${e.readiness && e.readiness !== "full" ? " [" + e.readiness + " day]" : ""}`);
    const sigLines = coachSignals(sets || {}, targets || {}).map((x) => `${x.ex.name}: ${x.p.kind === "hold" ? "target " + x.p.target + "s; " : ""}${x.last?.text || ""}`);
    const rs = readinessStats(readiness);
    const todayR = readiness?.[todayKey()];
    const system = `You are a concise S&C coach in a training app.
PROGRAM: 24-week concurrent, CYCLE 2, 8-week blocks — Strength(w1-8), Endurance(w9-16), Flexibility(w17-24). One priority/block, others maintain (~1/3 vol).
CONTEXT: Cycle 1 (endurance-first) stopped at week 5 when high work stress plus VO2max intervals exceeded his recovery; then ~3 months off. Aerobic gains largely gone, strength starting to fade. The coming months will be intense in life, so favour sustainable load: training stress and life stress share one recovery budget. Strength weeks 1-2 are a re-entry ramp (w1 ~half sets RPE6, w2 ~3/4 sets RPE7, no added load); normal progression from w3. Endurance in this block is a floor: 60-90 easy aerobic min/week. Main vehicle is the evening bike climb home (2.3km, +139m, ~6%, ~15min) — keep it easy (lowest gear, nose breathing). Uphill walk (~38min) is the winter/ice fallback. Main bike under repair; morning commute is dark, so no long commutes for now. Weeks 4, 6, 8: ride the hill once as 4×(1min hard/2min easy), ideally Tue or Fri, not the evening before Wed legs; skip if sleep/stress is poor. No other hard rides. Weekly: Mon/Wed/Fri main ~45min, Tue/Thu short skill+mobility, Sat/Sun open. Bodyweight-first; intermediate athlete (8-10 HSPU, 12 pull-ups, full lotus, endurance weak). Has pull-up bar, sauna, work gym, a second bike for short rides; plans rings+kettlebell.
RECOVERY/SAUNA: best on rest/cardio/short days; not right after heavy strength (blunts hypertrophy signal); before stretching deepens range. ~48h between HARD same-tissue sessions; sub-maximal skill/mobility can be daily.
STATE: week ${week}, ${block.name} block${isDeload ? ", DELOAD WEEK (cut volume ~40-50%, reps in reserve)" : ramp ? `, ${ramp.label}: ${ramp.text}` : ""}. Logs: ${logSummary}. Sauna: ${saunaSummary}. Bike: ${rideSummary}. Bonus: ${bonusSummary}.
SETS (last 14 days, logged per exercise; holds in seconds): ${setLines.length ? setLines.join("; ") : "none yet"}.
PROGRESSION ENGINE (rule-based, already applied in the app): ${sigLines.length ? sigLines.join("; ") : "no data yet"}. Rules: holds +5s after 2 clean sessions (1 if felt easy), −5s after 2 short sessions on normal days, capped at 2× plan (then progress the variation); reps use double progression (all sets at top of range → +2.5kg or harder variation; under the floor twice → ease off). Low-readiness days can raise but never lower targets.
READINESS: today ${todayR ? `sleep ${todayR.sleep || "?"}, stress ${todayR.stress || "?"} → ${readinessLevel(todayR)}` : "no check-in"}; ${rs.low} low of ${rs.answered} check-ins in 7 days. Readiness scales only the day's sets (trim ¾, easy ½).
When reading progress: build on the engine's signals, explain the why, and only recommend overriding them with a concrete reason (pain, technique breakdown, a pattern across several exercises or weeks). Prefer stability: one session is noise, two agree is a signal, a week of convergent signals justifies a deload.
BONUS: optional short skill+mobility side-quests (no extra strength by design — it competes with the block priority). Encourage handstand-skill frequency and daily mobility; these are what the plan under-serves. Don't add strength volume beyond the plan — recovery, not sets, is the limiter right now. If he reports high life stress or poor sleep, suggest trimming volume before skipping sessions. Today's fitting bonus: ${bonusSuggestion}
STYLE: practical, <120 words unless asked. Concrete adjustments. Flag recovery conflicts. Don't invent data. Not medical advice; caution with pain.`;
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, system,
          messages: next.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text })) }),
      });
      const data = await res.json();
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim() || "Couldn't generate a reply — try rephrasing?";
      setMessages([...next, { role: "assistant", text }]);
    } catch (e) {
      setMessages([...next, { role: "assistant", text: "Connection error — try again in a moment." }]);
    }
    setBusy(false);
  };
  const quick = ["I'm sore — adjust today", "Should I deload this week?", "Sauna timing for today?", "Read my progress"];
  return (
    <div style={S.body}>
      <ProgressionPanel sets={sets} targets={targets} setTargets={setTargets} readiness={readiness} isDeload={isDeload} setDeload={setDeload} week={week} accent={accent} />
      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div ref={scrollRef} style={S.chatScroll}>
          {messages.map((m, i) => (
            <div key={i} style={{ ...S.bubbleRow, justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ ...S.bubble, background: m.role === "user" ? accent : "#f3efe6",
                color: m.role === "user" ? "#fff" : "#2a261f",
                borderBottomRightRadius: m.role === "user" ? 4 : 16, borderBottomLeftRadius: m.role === "user" ? 16 : 4 }}>{m.text}</div>
            </div>
          ))}
          {busy && <div style={{ ...S.bubbleRow, justifyContent: "flex-start" }}>
            <div style={{ ...S.bubble, background: "#f3efe6", color: "#9a958c" }}>thinking…</div></div>}
        </div>
        <div style={S.quickRow}>
          {quick.map((q) => <button key={q} onClick={() => setInput(q)} style={S.quickBtn}>{q}</button>)}
        </div>
        <div style={S.chatInputRow}>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Ask your coach…" style={S.chatInput} disabled={busy} />
          <button onClick={send} disabled={busy} style={{ ...S.primaryBtn, background: accent, opacity: busy ? 0.5 : 1 }}>Send</button>
        </div>
      </div>
      <p style={S.muted}>The coach sees your week, sets and how they felt, check-ins, cardio, sauna and bonuses.</p>
    </div>
  );
}

// ============================================================================
const CSS = `
  * { box-sizing: border-box; }
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Spline+Sans:wght@400;500;600&display=swap');
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #d8d2c5; border-radius: 4px; }
  input:focus, select:focus { outline: 2px solid #00000022; }
`;
const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'Spline Sans', system-ui, sans-serif";
const PAPER = "#faf7f0";

const S = {
  shell: { fontFamily: FONT_BODY, background: PAPER, minHeight: "100vh", maxWidth: 720, margin: "0 auto", padding: "16px 16px calc(96px + env(safe-area-inset-bottom))", color: "#2a261f" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "3px solid", paddingBottom: 10, marginBottom: 10, gap: 12 },
  kicker: { fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#9a958c", fontWeight: 600 },
  h1: { fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, margin: "4px 0 0", lineHeight: 1.1, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 },
  deloadBadge: { fontSize: 10, fontFamily: FONT_BODY, letterSpacing: 1, background: "#c9962e", color: "#fff", padding: "3px 8px", borderRadius: 6, fontWeight: 700 },
  stepper: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  stepBtn: { width: 34, height: 34, borderRadius: "50%", border: "1px solid #d8d2c5", background: "#fff", fontSize: 20, cursor: "pointer", color: "#6b665d", lineHeight: 1 },
  stepNum: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 18, minWidth: 34, textAlign: "center" },
  blockBar: { display: "flex", gap: 8, marginBottom: 14 },
  blockSeg: {},
  blockSegLabel: { fontSize: 11, marginBottom: 4, display: "flex", justifyContent: "space-between" },
  blockWeeks: { opacity: 0.6, fontWeight: 400 },
  blockTrack: { height: 6, background: "#ece7dc", borderRadius: 4, overflow: "hidden" },
  deloadRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "8px 12px", background: "#fff", borderRadius: 10, boxShadow: "0 1px 3px #0000000d" },
  deloadLabel: { fontWeight: 600, fontSize: 13.5 },
  toggle: { width: 44, height: 24, borderRadius: 14, border: "none", cursor: "pointer", position: "relative", padding: 0, transition: "background .2s" },
  toggleKnob: { display: "block", width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: 2, transition: "transform .2s", boxShadow: "0 1px 2px #00000033" },
  nav: { display: "flex", gap: 6, marginBottom: 18, overflowX: "auto", paddingBottom: 2 },
  navBtn: { flex: "1 0 auto", padding: "9px 8px", borderRadius: 10, border: "1px solid #e2dcd0", background: "#fff", fontFamily: FONT_BODY, fontSize: 12.5, fontWeight: 600, cursor: "pointer", color: "#6b665d", transition: "all .15s" },
  body: { display: "flex", flexDirection: "column", gap: 14 },
  card: { background: "#fff", borderRadius: 14, padding: 18, boxShadow: "0 1px 3px #0000000d, 0 8px 24px #0000000a" },
  bonusTag: { fontSize: 11, fontWeight: 700, fontFamily: FONT_BODY, padding: "2px 8px", borderRadius: 999, border: "1px solid", textTransform: "uppercase", letterSpacing: 0.4 },
  bonusMins: { fontSize: 12, color: "#9a958c", fontWeight: 600 },
  bonusLogBtn: { marginTop: 12, width: "100%", color: "#fff", border: "none", borderRadius: 10, padding: "11px 0", fontSize: 13.5, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer" },
  bonusStats: { display: "flex", gap: 8 },
  bonusStat: { flex: 1, background: "#fff", borderRadius: 12, padding: "12px 8px", textAlign: "center", boxShadow: "0 1px 3px #0000000d" },
  bonusStatNum: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 24, lineHeight: 1 },
  bonusStatLbl: { fontSize: 11, color: "#9a958c", marginTop: 3, fontWeight: 600 },
  bonusRow: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "7px 0", borderBottom: "1px solid #f0ece3" },
  heatCell: { width: 22, height: 22, borderRadius: 5 },
  heatRowLabel: { width: 12, height: 22, fontSize: 10, color: "#b3aea3", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600 },
  cardBig: { padding: 22 },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 },
  cardLabel: { fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 700 },
  typePill: { fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", background: "#f0ece2", color: "#8a857b", padding: "3px 8px", borderRadius: 20, fontWeight: 600 },
  check: { width: 26, height: 26, borderRadius: "50%", border: "2px solid", cursor: "pointer", fontSize: 14, lineHeight: 1, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
  cardTitle: { fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 20, margin: "2px 0 8px" },
  cardBody: { fontSize: 14.5, lineHeight: 1.5, color: "#4a463e", margin: "0 0 12px" },
  saunaChip: { fontSize: 12.5, padding: "8px 11px", borderRadius: 9, border: "1px solid", lineHeight: 1.4 },
  routineToggle: { fontSize: 12.5, fontWeight: 600, fontFamily: FONT_BODY, background: "transparent", border: "1px solid", borderRadius: 8, padding: "7px 12px", cursor: "pointer", width: "100%", textAlign: "left" },
  tierRow: { display: "flex", gap: 6, marginBottom: 8 },
  tierBtn: { flex: 1, fontSize: 12, fontWeight: 600, fontFamily: FONT_BODY, padding: "7px 6px", borderRadius: 8, border: "1px solid #e2dcd0", background: "#fff", cursor: "pointer", color: "#6b665d" },
  tierBlurb: { fontSize: 12.5, fontStyle: "italic", color: "#6b665d", lineHeight: 1.45, marginBottom: 10 },
  intervalBox: { marginTop: 8, padding: "10px 12px", borderRadius: 10, border: "1px solid", background: "#fff" },
  intervalTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 },
  intervalPhase: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 15, letterSpacing: 0.5, textTransform: "uppercase" },
  intervalRound: { fontSize: 12, color: "#9a958c", fontWeight: 600 },
  intervalMain: { display: "flex", alignItems: "center", gap: 10 },
  routineGroup: { fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6, marginTop: 2 },
  routineItem: { padding: "7px 0", borderBottom: "1px solid #f3efe6" },
  routineItemTop: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" },
  routineName: { fontSize: 14, fontWeight: 600, color: "#2a261f" },
  routineDose: { fontSize: 12, color: "#9a958c", whiteSpace: "nowrap", flexShrink: 0 },
  routineCue: { fontSize: 12.5, color: "#6b665d", lineHeight: 1.45, marginTop: 2 },
  timerWrap: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 },
  timerBtn: { width: 38, height: 38, borderRadius: "50%", border: "none", color: "#fff", fontSize: 14, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  timerBody: { flex: 1 },
  timerTime: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 17, color: "#2a261f", display: "flex", alignItems: "baseline", gap: 8 },
  timerSide: { fontFamily: FONT_BODY, fontSize: 11, fontWeight: 500, color: "#9a958c", textTransform: "uppercase", letterSpacing: 0.5 },
  timerTrack: { height: 5, background: "#ece7dc", borderRadius: 3, overflow: "hidden", marginTop: 3 },
  timerReset: { background: "none", border: "none", color: "#b5afa2", fontSize: 11.5, cursor: "pointer", flexShrink: 0, textDecoration: "underline" },
  routineFootnote: { fontSize: 12, fontStyle: "italic", color: "#9a958c", lineHeight: 1.5, marginTop: 4, paddingTop: 8, borderTop: "1px solid #ece7dc" },
  tagBox: { fontSize: 13.5, lineHeight: 1.5, padding: "12px 14px", background: "#fff8", borderLeft: "4px solid", borderRadius: "0 10px 10px 0", color: "#4a463e" },
  warnBox: { fontSize: 13, lineHeight: 1.5, padding: "11px 13px", background: "#fbecd8", border: "1px solid #e0b873", borderRadius: 10, color: "#8a5a1e" },
  swapBanner: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "9px 12px", background: "#eef2e6", border: "1px solid #c3d3a8", borderRadius: 10, color: "#4a5a30" },
  swapResetBtn: { fontSize: 12, fontWeight: 600, fontFamily: FONT_BODY, padding: "5px 10px", borderRadius: 8, border: "1px solid #b7c79a", background: "#fff", cursor: "pointer", color: "#4a5a30", whiteSpace: "nowrap" },
  swapHint: { fontSize: 12.5, lineHeight: 1.45, padding: "9px 12px", background: "#fff", border: "1px dashed #cfc8b8", borderRadius: 10, color: "#5a554c" },
  swapBtn: { fontSize: 12, fontWeight: 700, fontFamily: FONT_BODY, height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 },
  setWrap: { marginTop: 8 },
  setRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 },
  setChip: { minWidth: 40, height: 40, padding: "0 6px", borderRadius: 10, border: "1.5px dashed #d8d2c5", background: "#fff", fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "background .15s" },
  setAdd: { width: 32, height: 40, borderRadius: 10, border: "1px solid #e2dcd0", background: "#faf8f3", color: "#9a958c", fontSize: 18, cursor: "pointer" },
  kgWrap: { display: "flex", alignItems: "center", gap: 3, marginLeft: "auto" },
  kgInput: { width: 58, height: 40, padding: "0 8px", borderRadius: 10, border: "1px solid #e2dcd0", fontFamily: FONT_BODY, fontSize: 14, textAlign: "right" },
  kgUnit: { fontSize: 12, color: "#9a958c" },
  setEditor: { display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "6px 8px", background: "#faf8f3", borderRadius: 10 },
  setNudge: { width: 38, height: 38, borderRadius: 10, border: "1px solid #e2dcd0", background: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer" },
  setEditInput: { width: 56, height: 38, textAlign: "center", borderRadius: 10, border: "1px solid #e2dcd0", fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 17 },
  setMeta: { fontSize: 12, color: "#9a958c", marginTop: 6, lineHeight: 1.4 },
  formRow: { display: "flex", gap: 8 },
  quickMinBox: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: 58, background: "#faf7f0", border: "1px solid #e2dcd0", borderRadius: 9, padding: 4 },
  quickMinInput: { width: 44, border: "none", background: "transparent", textAlign: "center", fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 16, color: "#2a261f" },
  select: { flex: 2, padding: "10px 12px", borderRadius: 9, border: "1px solid #e2dcd0", fontFamily: FONT_BODY, fontSize: 14, background: "#fff" },
  input: { flex: 1, minWidth: 0, padding: "10px 12px", borderRadius: 9, border: "1px solid #e2dcd0", fontFamily: FONT_BODY, fontSize: 14 },
  primaryBtn: { color: "#fff", border: "none", borderRadius: 9, padding: "11px 18px", fontFamily: FONT_BODY, fontWeight: 600, fontSize: 14, cursor: "pointer" },
  logRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #f0ece2", fontSize: 13.5, flexWrap: "wrap" },
  logLift: { color: "#6b665d", flex: 1 },
  logNote: { fontStyle: "italic", color: "#9a958c", flexBasis: "100%", fontSize: 12.5 },
  delBtn: { border: "none", background: "none", color: "#c9b8a8", fontSize: 18, cursor: "pointer", lineHeight: 1 },
  chatScroll: { height: 360, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 },
  bubbleRow: { display: "flex" },
  bubble: { maxWidth: "82%", padding: "10px 14px", borderRadius: 16, fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" },
  quickRow: { display: "flex", gap: 6, flexWrap: "wrap", padding: "0 12px 10px" },
  quickBtn: { fontSize: 11.5, padding: "6px 10px", borderRadius: 16, border: "1px solid #e2dcd0", background: "#faf7f0", cursor: "pointer", color: "#6b665d", fontFamily: FONT_BODY },
  chatInputRow: { display: "flex", gap: 8, padding: 12, borderTop: "1px solid #f0ece2" },
  chatInput: { flex: 1, padding: "11px 14px", borderRadius: 10, border: "1px solid #e2dcd0", fontFamily: FONT_BODY, fontSize: 14 },
  muted: { color: "#9a958c", fontSize: 13.5, lineHeight: 1.5 },
  gear: { position: "relative", width: 40, height: 40, borderRadius: "50%", border: "1px solid #e2dcd0", background: "#fff", fontSize: 19, color: "#6b665d", cursor: "pointer", flexShrink: 0, lineHeight: 1 },
  gearDot: { position: "absolute", top: 2, right: 2, width: 9, height: 9, borderRadius: "50%", border: "2px solid #fff" },
  bottomNav: { position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 20, display: "flex", justifyContent: "center", gap: 0, background: "#fffdf8ee", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", borderTop: "1px solid #e7e1d4", padding: "6px 8px calc(6px + env(safe-area-inset-bottom))" },
  bottomBtn: { flex: "0 1 120px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "6px 0", border: "none", background: "none", fontFamily: FONT_BODY, fontSize: 11, cursor: "pointer" },
  segRow: { display: "flex", gap: 6, background: "#efeae0", padding: 4, borderRadius: 12 },
  segBtn: { flex: 1, padding: "9px 6px", borderRadius: 9, border: "1px solid transparent", background: "transparent", fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, color: "#6b665d", cursor: "pointer" },
  sheetBackdrop: { position: "fixed", inset: 0, background: "#0006", zIndex: 40, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  sheet: { background: PAPER, width: "100%", maxWidth: 720, borderRadius: "18px 18px 0 0", padding: "18px 18px calc(24px + env(safe-area-inset-bottom))", maxHeight: "88vh", overflowY: "auto" },
  sheetSection: { fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 700, color: "#9a958c", margin: "18px 0 8px" },
  sheetRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 14, fontWeight: 600 },
  readyBar: { display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, padding: "10px 14px", background: "#fff", borderRadius: 12, boxShadow: "0 1px 3px #0000000d" },
  readyDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  readyRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 6 },
  readyLbl: { width: 52, fontSize: 13, fontWeight: 600, color: "#6b665d" },
  readyOpt: { flex: 1, height: 36, borderRadius: 9, border: "1px solid #e2dcd0", background: "#fff", fontFamily: FONT_BODY, fontSize: 13, fontWeight: 600, color: "#6b665d", cursor: "pointer" },
  weekNav: { display: "flex", alignItems: "center", gap: 10 },
  targetRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 13, marginTop: 8, color: "#4a463e" },
  targetPill: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 14, padding: "3px 10px", borderRadius: 999, border: "1px solid", background: "#fff", cursor: "pointer", marginLeft: 4 },
  progRow: { display: "flex", gap: 10, padding: "10px 0", borderBottom: "1px solid #f3efe6" },
  progIcon: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 18, width: 16, textAlign: "center", lineHeight: 1.2 },
  feelRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 8 },
  feelBtn: { flex: 1, height: 32, borderRadius: 8, border: "1px solid #e2dcd0", background: "#fff", fontFamily: FONT_BODY, fontSize: 12.5, fontWeight: 600, color: "#6b665d", cursor: "pointer" },
  muted2: { color: "#9a958c", fontSize: 12 },
  footer: { marginTop: 14, textAlign: "center", fontSize: 11.5, color: "#b5afa2", lineHeight: 1.5 },
  dataRow: { display: "flex", gap: 8, justifyContent: "center", marginTop: 24 },
  dataBtn: { fontSize: 12.5, fontWeight: 600, fontFamily: FONT_BODY, color: "#6b665d", background: "#fff", border: "1px solid #e2dcd0", borderRadius: 9, padding: "9px 16px", cursor: "pointer", textAlign: "center" },
};
