import React, { useState, useEffect, useRef } from "react";
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
// by design: strength is maintained in this block and extra load competes with
// the priority quality). These are the two things the plan under-serves, so
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
const BONUS_NOTE = "Bonuses are optional and complementary — skill and mobility only, on purpose. They're logged separately so they never distort your planned-session tracking. The rule of thumb: if you have spare energy, spend it here (the things the plan under-serves), not on extra strength that competes with this block's priority.";

// ============================================================================
// PROGRAM DEFINITION — 3 blocks x 8 weeks
// dayKey: 0=Sun ... 6=Sat (matches JS getDay)
// ============================================================================
const BLOCKS = [
  {
    id: "endurance", name: "Endurance", weeks: [1, 8], accent: "#d9543f",
    tag: "Detrained quality = steepest gains. Lead here for fast momentum.",
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
    id: "strength", name: "Strength", weeks: [9, 16], accent: "#2e6e8e",
    tag: "Progressive overload on movements you own + the gap bodyweight can't fill: heavy legs.",
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
      6: { type: "open", title: "Open / hike", body: "Rest or easy bike/hike — maintains endurance, low impact.", sauna: "best" },
      0: { type: "open", title: "Open / rest", body: "Full rest. Easy bike commute alone maintains your aerobic base.", sauna: "best" },
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

const SAUNA_MEANING = {
  best: { label: "Sauna: ideal today", color: "#6a8d3f", note: "Rest/cardio day — pure recovery, nothing to blunt." },
  ideal: { label: "Sauna: great pairing", color: "#6a8d3f", note: "Low-fatigue day. On mobility days, sauna BEFORE stretching deepens range." },
  good: { label: "Sauna: good after", color: "#2e6e8e", note: "Heat complements endurance adaptation." },
  gap: { label: "Sauna: leave a gap", color: "#c9962e", note: "Fine, but not right after — wait a few hours / evening." },
  avoid: { label: "Sauna: not right after", color: "#c9962e", note: "Heat may blunt the strength signal. Sauna later that evening instead." },
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TYPE_LABEL = { main: "Main session", short: "Short session", open: "Open day" };

// ---------- helpers ----------
function blockForWeek(week) {
  return BLOCKS.find((b) => week >= b.weeks[0] && week <= b.weeks[1]) || BLOCKS[0];
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// deload: lighten a main session's prescription, leave skill/open mostly alone
function applyDeload(session) {
  if (session.type === "open") return session;
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

const LIFTS = ["Pull-ups (reps)", "HSPU (reps)", "Push-ups (reps)", "Run interval (count)", "Squat load (kg)", "Split depth (cm to floor)"];

// ============================================================================
// MAIN
// ============================================================================
export default function TrainingApp() {
  const [week, setWeek] = useState(1);
  const [view, setView] = useState("today");
  const [logs, setLogs] = useState([]);
  const [saunas, setSaunas] = useState([]);          // [{date, minutes, context, note}]
  const [rides, setRides] = useState([]);            // [{date, km, effort, note}]
  const [done, setDone] = useState({});              // { "W3-1": true }  week+dayKey
  const [deloads, setDeloads] = useState({});        // { "3": true } week -> deload on
  const [swaps, setSwaps] = useState({});            // { week: { dayKey: srcDayKey } } per-week session overrides
  const [bonusLog, setBonusLog] = useState([]);      // [{date, id, title, kind, minutes}] completed bonus sessions
  const [hsTier, setHsTier] = useState(0);            // handstand routine tier index (0=Foundation)
  const [hsBonusLevel, setHsBonusLevel] = useState(0); // bonus handstand progression level
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const safeGet = async (k, def) => {
        try { const v = await Store.get(k); return v != null ? JSON.parse(v) : def; }
        catch (e) { return def; }
      };
      setWeek(await safeGet("currentWeek", 1));
      setLogs(await safeGet("logs", []));
      setSaunas(await safeGet("saunas", []));
      setRides(await safeGet("rides", []));
      setDone(await safeGet("done", {}));
      setDeloads(await safeGet("deloads", {}));
      setSwaps(await safeGet("swaps", {}));
      setBonusLog(await safeGet("bonusLog", []));
      setHsTier(await safeGet("hsTier", 0));
      setHsBonusLevel(await safeGet("hsBonusLevel", 0));
      setLoaded(true);
    })();
  }, []);

  const save = async (k, v) => { try { await Store.set(k, JSON.stringify(v)); } catch (e) {} };
  const persistWeek = (w) => { setWeek(w); save("currentWeek", w); };
  const persistLogs = (v) => { setLogs(v); save("logs", v); };
  const persistSaunas = (v) => { setSaunas(v); save("saunas", v); };
  const persistRides = (v) => { setRides(v); save("rides", v); };
  const persistDone = (v) => { setDone(v); save("done", v); };
  const persistDeloads = (v) => { setDeloads(v); save("deloads", v); };
  const persistSwaps = (v) => { setSwaps(v); save("swaps", v); };
  const persistBonusLog = (v) => { setBonusLog(v); save("bonusLog", v); };
  const persistHsTier = (v) => { setHsTier(v); save("hsTier", v); };
  const persistHsBonusLevel = (v) => { setHsBonusLevel(v); save("hsBonusLevel", v); };

  const block = blockForWeek(week);
  const accent = block.accent;
  const isDeload = !!deloads[week];

  const toggleDeload = () => persistDeloads({ ...deloads, [week]: !isDeload });

  // ---- per-week session swaps ----
  const weekSwaps = swaps[week] || {};
  // which canonical dayKey's session actually sits on calendar day k this week
  const srcForDay = (k) => (weekSwaps[k] !== undefined ? weekSwaps[k] : k);
  // perform a swap between two calendar days for the current week (swaps their sources)
  const swapDays = (a, b) => {
    const cur = { ...(swaps[week] || {}) };
    const srcA = cur[a] !== undefined ? cur[a] : a;
    const srcB = cur[b] !== undefined ? cur[b] : b;
    cur[a] = srcB; cur[b] = srcA;
    // clean up identity mappings to keep the object tidy / detect "no override"
    Object.keys(cur).forEach((k) => { if (Number(cur[k]) === Number(k)) delete cur[k]; });
    const next = { ...swaps };
    if (Object.keys(cur).length === 0) delete next[week]; else next[week] = cur;
    persistSwaps(next);
  };
  const resetWeekSwaps = () => { const next = { ...swaps }; delete next[week]; persistSwaps(next); };
  const hasSwaps = Object.keys(weekSwaps).length > 0;

  // back-to-back hard-day check: two "main" sessions on consecutive calendar days
  const hardDayWarnings = (() => {
    const order = [1, 2, 3, 4, 5, 6, 0];
    const warns = [];
    for (let i = 0; i < order.length - 1; i++) {
      const d1 = order[i], d2 = order[i + 1];
      const s1 = block.days[srcForDay(d1)], s2 = block.days[srcForDay(d2)];
      if (s1?.type === "main" && s2?.type === "main") warns.push([d1, d2]);
    }
    return warns;
  })();

  const exportData = () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), currentWeek: week, logs, saunas, rides, done, deloads, swaps, bonusLog, hsTier, hsBonusLevel };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `training-data-${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importData = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (d.currentWeek != null) persistWeek(d.currentWeek);
        if (Array.isArray(d.logs)) persistLogs(d.logs);
        if (Array.isArray(d.saunas)) persistSaunas(d.saunas);
        if (Array.isArray(d.rides)) persistRides(d.rides);
        if (d.done && typeof d.done === "object") persistDone(d.done);
        if (d.deloads && typeof d.deloads === "object") persistDeloads(d.deloads);
        if (d.swaps && typeof d.swaps === "object") persistSwaps(d.swaps);
        if (Array.isArray(d.bonusLog)) persistBonusLog(d.bonusLog);
        if (typeof d.hsTier === "number") persistHsTier(d.hsTier);
        if (typeof d.hsBonusLevel === "number") persistHsBonusLevel(d.hsBonusLevel);
        alert("Data imported successfully.");
      } catch (err) {
        alert("Couldn't read that file — make sure it's a training-data export.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div style={S.shell}>
      <style>{CSS}</style>

      <header style={{ ...S.header, borderColor: accent }}>
        <div>
          <div style={S.kicker}>Concurrent Training · 24-week cycle</div>
          <h1 style={S.h1}>
            Week {week} <span style={{ color: accent }}>·</span>{" "}
            <span style={{ color: accent }}>{block.name} block</span>
            {isDeload && <span style={S.deloadBadge}>DELOAD</span>}
          </h1>
        </div>
        <WeekStepper week={week} setWeek={persistWeek} accent={accent} />
      </header>

      <BlockBar week={week} />

      <div style={S.deloadRow}>
        <span style={S.deloadLabel}>Deload week</span>
        <button onClick={toggleDeload}
          style={{ ...S.toggle, background: isDeload ? accent : "#ddd6c8" }}>
          <span style={{ ...S.toggleKnob, transform: isDeload ? "translateX(20px)" : "translateX(0)" }} />
        </button>
        <span style={S.muted2}>{isDeload ? "On — volume cut, recover." : "Off"}</span>
      </div>

      <nav style={S.nav}>
        {[["today", "Today"], ["week", "Week"], ["bonus", "Bonus"], ["progress", "Progress"], ["bike", "Bike"], ["sauna", "Sauna"], ["coach", "Coach"]].map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            style={{ ...S.navBtn, ...(view === k ? { background: accent, color: "#fff", borderColor: accent } : {}) }}>
            {label}
          </button>
        ))}
      </nav>

      {!loaded ? <div style={S.muted}>Loading…</div>
        : view === "today" ? <TodayView week={week} accent={accent} isDeload={isDeload} done={done} setDone={persistDone} hsTier={hsTier} setHsTier={persistHsTier} srcForDay={srcForDay} />
        : view === "week" ? <WeekView week={week} accent={accent} isDeload={isDeload} done={done} setDone={persistDone} hsTier={hsTier} setHsTier={persistHsTier} srcForDay={srcForDay} swapDays={swapDays} resetWeekSwaps={resetWeekSwaps} hasSwaps={hasSwaps} hardDayWarnings={hardDayWarnings} block={block} />
        : view === "progress" ? <ProgressView logs={logs} setLogs={persistLogs} accent={accent} />
        : view === "bonus" ? <BonusView bonusLog={bonusLog} setBonusLog={persistBonusLog} accent={accent} hsLevel={hsBonusLevel} setHsLevel={persistHsBonusLevel} />
        : view === "bike" ? <RideView rides={rides} setRides={persistRides} accent={accent} />
        : view === "sauna" ? <SaunaView saunas={saunas} setSaunas={persistSaunas} accent={accent} />
        : <CoachView week={week} block={block} logs={logs} saunas={saunas} rides={rides} bonusLog={bonusLog} isDeload={isDeload} accent={accent} />}

      <div style={S.dataRow}>
        <button onClick={exportData} style={S.dataBtn}>↓ Export data</button>
        <label style={S.dataBtn}>
          ↑ Import data
          <input type="file" accept="application/json,.json" onChange={importData} style={{ display: "none" }} />
        </label>
      </div>
      <footer style={S.footer}>Export saves a JSON file you can keep on your phone or Drive · Sauna 2–4×/week, best on rest/cardio/short days.</footer>
    </div>
  );
}

function WeekStepper({ week, setWeek, accent }) {
  return (
    <div style={S.stepper}>
      <button style={S.stepBtn} onClick={() => setWeek(Math.max(1, week - 1))}>−</button>
      <span style={{ ...S.stepNum, color: accent }}>W{week}</span>
      <button style={S.stepBtn} onClick={() => setWeek(Math.min(24, week + 1))}>+</button>
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

function TodayView({ week, accent, isDeload, done, setDone, hsTier, setHsTier, srcForDay }) {
  const block = blockForWeek(week);
  const td = new Date().getDay();
  const tm = (td + 1) % 7;
  const get = (k) => { const s = block.days[srcForDay(k)]; return isDeload ? applyDeload(s) : s; };
  const swapped = (k) => srcForDay(k) !== k;
  return (
    <div style={S.body}>
      <SessionCard label={swapped(td) ? "TODAY · swapped" : "TODAY"} dayKey={td} week={week} session={get(td)} accent={accent} big done={done} setDone={setDone} hsTier={hsTier} setHsTier={setHsTier} />
      <SessionCard label={swapped(tm) ? "TOMORROW · swapped" : "TOMORROW"} dayKey={tm} week={week} session={get(tm)} accent={accent} done={done} setDone={setDone} hsTier={hsTier} setHsTier={setHsTier} />
      <div style={{ ...S.tagBox, borderColor: accent }}>
        <strong style={{ color: accent }}>{block.name} block.</strong> {block.tag}
      </div>
    </div>
  );
}

function WeekView({ week, accent, isDeload, done, setDone, hsTier, setHsTier, srcForDay, swapDays, resetWeekSwaps, hasSwaps, hardDayWarnings, block }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const get = (k) => { const s = block.days[srcForDay(k)]; return isDeload ? applyDeload(s) : s; };
  const completed = order.filter((k) => done[`W${week}-${k}`]).length;
  const [swapMode, setSwapMode] = useState(null); // calendar dayKey awaiting a target, or null

  const onSwapClick = (k) => {
    if (swapMode === null) { setSwapMode(k); return; }
    if (swapMode === k) { setSwapMode(null); return; }   // tapped same card → cancel
    swapDays(swapMode, k);
    setSwapMode(null);
  };

  return (
    <div style={S.body}>
      <div style={{ ...S.tagBox, borderColor: accent, marginBottom: 2 }}>
        <strong style={{ color: accent }}>{completed}/7 logged this week.</strong> Tap a card to mark done · ⇄ to swap days.
      </div>

      {hardDayWarnings.length > 0 && (
        <div style={S.warnBox}>
          ⚠️ Two main sessions back-to-back: {hardDayWarnings.map(([a, b]) => `${DAY_NAMES[a]}→${DAY_NAMES[b]}`).join(", ")}.
          Fine occasionally, but you'll have no easy buffer between them — consider keeping one hard and easing the other, or sliding a rest/skill day between.
        </div>
      )}

      {hasSwaps && (
        <div style={S.swapBanner}>
          <span>This week has swapped days (overlay on the plan).</span>
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
        return (
          <div key={k} style={{
            outline: isPicking ? `2px solid ${accent}` : isTarget ? `2px dashed ${accent}88` : "none",
            borderRadius: 14, transition: "outline 0.15s" }}>
            <SessionCard label={swapped ? `${DAY_NAMES[k].toUpperCase()} · swapped` : DAY_NAMES[k].toUpperCase()}
              dayKey={k} week={week} session={get(k)} accent={accent}
              done={done} setDone={setDone} hsTier={hsTier} setHsTier={setHsTier} compact
              swapControl={
                <button onClick={() => onSwapClick(k)}
                  style={{ ...S.swapBtn, color: isPicking ? "#fff" : isTarget ? "#fff" : accent,
                    background: isPicking ? "#c9962e" : isTarget ? accent : "#fff", borderColor: accent + "66" }}>
                  {isPicking ? "✕ cancel" : isTarget ? `⇄ swap with ${DAY_NAMES[swapMode]}` : "⇄ swap day"}
                </button>
              } />
          </div>
        );
      })}
    </div>
  );
}

function DrillTimer({ seconds, perSide, accent }) {
  const [remaining, setRemaining] = useState(seconds);
  const [running, setRunning] = useState(false);
  const [side, setSide] = useState(1); // for perSide drills: 1 then 2
  const intervalRef = useRef(null);
  useWakeLock(running);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) {
            clearInterval(intervalRef.current);
            finish();
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    }
    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line
  }, [running]);

  const beep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 660; o.type = "sine";
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      o.start(); o.stop(ctx.currentTime + 0.62);
    } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(250); } catch (e) {}
  };

  const finish = () => {
    setRunning(false);
    beep();
    if (perSide && side === 1) {
      setSide(2);
      setRemaining(seconds);
    }
  };

  const toggle = () => {
    if (remaining === 0) { setRemaining(seconds); setSide(1); setRunning(true); }
    else setRunning(!running);
  };
  const reset = () => { setRunning(false); setRemaining(seconds); setSide(1); };

  const mm = String(Math.floor(remaining / 60)).padStart(1, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  const pct = (remaining / seconds) * 100;

  return (
    <div style={S.timerWrap}>
      <button onClick={toggle} style={{ ...S.timerBtn, background: running ? "#c9962e" : accent }}>
        {remaining === 0 ? "↻" : running ? "❚❚" : "▶"}
      </button>
      <div style={S.timerBody}>
        <div style={S.timerTime}>
          {mm}:{ss}
          {perSide && <span style={S.timerSide}>side {side}/2</span>}
        </div>
        <div style={S.timerTrack}>
          <div style={{ width: `${pct}%`, height: "100%", background: accent, borderRadius: 3, transition: "width 1s linear" }} />
        </div>
      </div>
      {(running || remaining !== seconds) && <button onClick={reset} style={S.timerReset}>reset</button>}
    </div>
  );
}

// Looping work/rest interval timer with distinct audio cues per phase.
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

function SessionCard({ label, dayKey, week, session, accent, big, compact, done, setDone, hsTier, setHsTier, swapControl }) {
  const sa = SAUNA_MEANING[session.sauna];
  const id = `W${week}-${dayKey}`;
  const isDone = !!done[id];
  const toggle = () => setDone({ ...done, [id]: !isDone });
  const [expanded, setExpanded] = useState(false);
  const hasDetail = session.exercises || session.routine;
  const showDetail = !compact || expanded;
  return (
    <div style={{ ...S.card, ...(big ? S.cardBig : {}), ...(compact ? { padding: 14 } : {}),
      borderLeft: `5px solid ${accent}`, opacity: isDone ? 0.62 : 1 }}>
      <div style={S.cardTop}>
        <span style={{ ...S.cardLabel, color: accent }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={S.typePill}>{TYPE_LABEL[session.type]}</span>
          <button onClick={toggle} title="Mark done"
            style={{ ...S.check, background: isDone ? accent : "#fff", borderColor: isDone ? accent : "#d8d2c5",
              color: isDone ? "#fff" : "transparent" }}>✓</button>
        </div>
      </div>
      <h2 style={{ ...S.cardTitle, fontSize: big ? 26 : compact ? 17 : 20,
        textDecoration: isDone ? "line-through" : "none" }}>{session.title}</h2>
      <p style={{ ...S.cardBody, fontSize: compact ? 13 : 14.5, marginBottom: compact ? 8 : 12 }}>{session.body}</p>
      {compact && hasDetail && (
        <button onClick={() => setExpanded(!expanded)}
          style={{ ...S.routineToggle, color: accent, borderColor: accent + "44", marginBottom: expanded ? 4 : 0 }}>
          {expanded ? "▾ Hide details" : "▸ Show full session"}
        </button>
      )}
      {!compact && (
        <div style={{ ...S.saunaChip, background: sa.color + "1a", color: sa.color, borderColor: sa.color + "55" }}>
          🔥 {sa.label} — <span style={{ opacity: 0.85 }}>{sa.note}</span>
        </div>
      )}
      {showDetail && session.exercises && (
        <ExerciseList exercises={session.exercises} accent={accent} deload={session.deload} defaultOpen={compact && expanded} />
      )}
      {showDetail && session.routine && (
        <div style={{ marginTop: 12 }}>
          {session.routine.tiered
            ? <TieredRoutine routine={session.routine} accent={accent} hsTier={hsTier} setHsTier={setHsTier} defaultOpen={compact && expanded} />
            : <ArrayRoutine routine={session.routine} accent={accent} defaultOpen={compact && expanded} />}
        </div>
      )}
      {swapControl && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          {swapControl}
        </div>
      )}
    </div>
  );
}

// Renders a main session's structured exercises with holds (DrillTimer) and intervals (IntervalTimer).
function ExerciseList({ exercises, accent, deload, defaultOpen }) {
  const [show, setShow] = useState(!!defaultOpen);
  const timed = exercises.filter((e) => e.seconds || e.interval).length;
  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={() => setShow(!show)}
        style={{ ...S.routineToggle, color: accent, borderColor: accent + "44" }}>
        {show ? "▾ Hide exercises" : "▸ Show exercises"} · {exercises.length} moves{timed ? ` · ${timed} timed` : ""}
      </button>
      {show && (
        <div style={{ marginTop: 10 }}>
          {deload && (
            <div style={S.tierBlurb}>
              Deload week: cut sets ~40–50% and stop well short of failure. Holds can stay full length — it's the volume you reduce, not the quality of each rep.
            </div>
          )}
          {exercises.map((it, ii) => (
            <div key={ii} style={S.routineItem}>
              <div style={S.routineItemTop}>
                <span style={S.routineName}>{it.name}</span>
                <span style={S.routineDose}>{it.dose}</span>
              </div>
              <div style={S.routineCue}>{it.cue}</div>
              {it.seconds && <DrillTimer seconds={it.seconds} perSide={it.perSide} accent={accent} />}
              {it.interval && <IntervalTimer config={deload ? { ...it.interval, rounds: Math.max(3, Math.round(it.interval.rounds * 0.6)) } : it.interval} accent={accent} />}
            </div>
          ))}
        </div>
      )}
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

function ProgressView({ logs, setLogs, accent }) {
  const [lift, setLift] = useState(LIFTS[0]);
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
      <div style={S.card}>
        <h2 style={S.cardTitle}>Log a number</h2>
        <div style={S.formRow}>
          <select value={lift} onChange={(e) => setLift(e.target.value)} style={S.select}>
            {LIFTS.map((l) => <option key={l}>{l}</option>)}
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
function RideView({ rides, setRides, accent }) {
  const [km, setKm] = useState("");
  const [effort, setEffort] = useState("Easy");
  const [note, setNote] = useState("");
  const EFFORTS = ["Easy", "Moderate", "Hard"];
  const add = () => {
    const d = parseFloat(km); if (isNaN(d)) return;
    setRides([...rides, { date: todayKey(), km: d, effort, note: note.trim() }]);
    setKm(""); setNote("");
  };
  const removeAt = (i) => setRides(rides.filter((_, idx) => idx !== i));

  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const week = rides.filter((r) => r.date >= weekAgo);
  const weekKm = week.reduce((s, r) => s + r.km, 0);
  const hardCount = week.filter((r) => r.effort === "Hard").length;
  const recent = [...rides].reverse().slice(0, 10);

  // simple "load" read: 2 easy rides = great; 2+ hard = watch recovery
  const loadNote = hardCount >= 2
    ? "Two+ hard rides this week — that's real leg load. Keep intervals well clear and watch for heavy legs."
    : week.length >= 2
    ? "Nicely distributed aerobic work. Easy back-to-back rides recover well."
    : week.length === 1
    ? "One ride banked. A second easy ride this week is fine — keeps your base building."
    : "No rides logged this week yet.";

  return (
    <div style={S.body}>
      <div style={{ ...S.card, borderLeft: `5px solid ${accent}` }}>
        <div style={S.cardTop}>
          <h2 style={S.cardTitle}>This week</h2>
          <span style={{ fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 700, color: accent }}>
            {weekKm}<span style={{ fontSize: 14, color: "#9a958c" }}> km</span>
          </span>
        </div>
        <p style={S.muted}>{week.length} ride{week.length === 1 ? "" : "s"}{hardCount ? ` · ${hardCount} hard` : ""}. {loadNote}</p>
      </div>
      <div style={S.card}>
        <h2 style={S.cardTitle}>Log a ride</h2>
        <div style={S.formRow}>
          <input type="number" placeholder="km" value={km} onChange={(e) => setKm(e.target.value)} style={S.input} />
          <select value={effort} onChange={(e) => setEffort(e.target.value)} style={S.select}>
            {EFFORTS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <input placeholder="note (optional) — e.g. commute, headwind" value={note}
          onChange={(e) => setNote(e.target.value)} style={{ ...S.input, width: "100%", marginTop: 8 }} />
        <button onClick={add} style={{ ...S.primaryBtn, background: accent, marginTop: 10 }}>Log ride</button>
        {effort === "Hard" &&
          <p style={{ ...S.muted2, marginTop: 8, color: "#c9962e" }}>A hard ride counts like an interval session for your legs — don't stack it next to one.</p>}
        {effort === "Easy" &&
          <p style={{ ...S.muted2, marginTop: 8, color: "#6a8d3f" }}>Easy rides are your aerobic base — highly recoverable, safe to repeat.</p>}
      </div>
      <div style={S.card}>
        <h2 style={S.cardTitle}>Recent rides</h2>
        {recent.length === 0 ? <p style={S.muted}>No rides logged yet.</p> :
          recent.map((r, i) => (
            <div key={i} style={S.logRow}>
              <span style={{ fontWeight: 600 }}>{r.km} km</span>
              <span style={S.logLift}>{r.effort}</span>
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

function CoachView({ week, block, logs, saunas, rides, bonusLog, isDeload, accent }) {
  // Day-aware bonus suggestion: pick the most fitting side-quest for today's context.
  const bonusSuggestion = (() => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const td = new Date().getDay();
    const todaySession = block.days[td];
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
    { role: "assistant", text: `Hi! You're in week ${week} (${block.name} block${isDeload ? ", DELOAD" : ""}). ${bonusSuggestion} Ask me to adjust today's session, plan around soreness, sauna timing, or anything else.` },
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
    const rideSummary = wkRides.length ? `${wkRides.length} this week, ${wkRides.reduce((s,r)=>s+r.km,0)}km (${wkRides.filter(r=>r.effort==="Hard").length} hard)` : "none this week";
    const wkBonus = (bonusLog || []).filter((b) => b.date >= weekAgo);
    const bonusSummary = wkBonus.length ? `${wkBonus.filter(b=>b.kind==="skill").length} skill + ${wkBonus.filter(b=>b.kind==="mobility").length} mobility this week` : "none this week";
    const system = `You are a concise S&C coach in a training app.
PROGRAM: 24-week concurrent, 8-week blocks — Endurance(w1-8), Strength(w9-16), Flexibility(w17-24). One priority/block, others maintain (~1/3 vol). Weekly: Mon/Wed/Fri main ~45min, Tue/Thu short skill+mobility, Sat/Sun open. Bodyweight-first; intermediate athlete (8-10 HSPU, 12 pull-ups, full lotus, endurance weak). Has pull-up bar, sauna, work gym, 32km bike commute; plans rings+kettlebell.
RECOVERY/SAUNA: best on rest/cardio/short days; not right after heavy strength (blunts hypertrophy signal); before stretching deepens range. ~48h between HARD same-tissue sessions; sub-maximal skill/mobility can be daily.
STATE: week ${week}, ${block.name} block${isDeload ? ", DELOAD WEEK (cut volume ~40-50%, reps in reserve)" : ""}. Logs: ${logSummary}. Sauna: ${saunaSummary}. Bike: ${rideSummary}. Bonus: ${bonusSummary}.
BONUS: optional short skill+mobility side-quests (no extra strength by design — it competes with the block priority). Encourage handstand-skill frequency and daily mobility; these are what the plan under-serves. Don't push extra strength load in the Endurance block. Today's fitting bonus: ${bonusSuggestion}
STYLE: practical, <120 words unless asked. Concrete adjustments. Flag recovery conflicts. Don't invent data. Not medical advice; caution with pain.`;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system,
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
      <p style={S.muted}>The coach knows your week, deload state, logs and sauna history.</p>
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
  shell: { fontFamily: FONT_BODY, background: PAPER, minHeight: "100vh", maxWidth: 720, margin: "0 auto", padding: "22px 18px 60px", color: "#2a261f" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "3px solid", paddingBottom: 14, marginBottom: 14, gap: 12 },
  kicker: { fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#9a958c", fontWeight: 600 },
  h1: { fontFamily: FONT_DISPLAY, fontSize: 28, fontWeight: 600, margin: "4px 0 0", lineHeight: 1.1, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 },
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
  nav: { display: "flex", gap: 6, marginBottom: 18 },
  navBtn: { flex: 1, padding: "9px 4px", borderRadius: 10, border: "1px solid #e2dcd0", background: "#fff", fontFamily: FONT_BODY, fontSize: 12.5, fontWeight: 600, cursor: "pointer", color: "#6b665d", transition: "all .15s" },
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
  formRow: { display: "flex", gap: 8 },
  select: { flex: 2, padding: "10px 12px", borderRadius: 9, border: "1px solid #e2dcd0", fontFamily: FONT_BODY, fontSize: 14, background: "#fff" },
  input: { flex: 1, padding: "10px 12px", borderRadius: 9, border: "1px solid #e2dcd0", fontFamily: FONT_BODY, fontSize: 14 },
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
  muted2: { color: "#9a958c", fontSize: 12 },
  footer: { marginTop: 14, textAlign: "center", fontSize: 11.5, color: "#b5afa2", lineHeight: 1.5 },
  dataRow: { display: "flex", gap: 8, justifyContent: "center", marginTop: 24 },
  dataBtn: { fontSize: 12.5, fontWeight: 600, fontFamily: FONT_BODY, color: "#6b665d", background: "#fff", border: "1px solid #e2dcd0", borderRadius: 9, padding: "9px 16px", cursor: "pointer", textAlign: "center" },
};
