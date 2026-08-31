// Dangerous writing — client logic
const minutes = document.getElementById("minutes");
const seconds = document.getElementById("seconds");
const minutesOut = document.getElementById("minutesOut");
const secondsOut = document.getElementById("secondsOut");
const startBtn = document.getElementById("startBtn");
const timerEl = document.getElementById("timer");
const phaseEl = document.getElementById("phase");
const editor = document.getElementById("editor");
const statusEl = document.getElementById("status");
const wordsEl = document.getElementById("words");
const progress = document.getElementById("progressInner");
const countdownEl = document.getElementById("countdown");
const countNum = document.getElementById("countNum");
const demoIntro = document.getElementById("demoIntro");
const demoIntroText = document.getElementById("demoIntroText");
const demoIntroGo = document.getElementById("demoIntroGo");
const aiMode = document.getElementById("aiMode");
const demoBtn = document.getElementById("demoBtn");
const copyBtn = document.getElementById("copyBtn");
const continueBtn = document.getElementById("continueBtn");
const restoreBtn = document.getElementById("restoreBtn");
const entriesBtn = document.getElementById("entriesBtn");
const entriesPanel = document.getElementById("entriesPanel");
const entriesList = document.getElementById("entriesList");
const graceBar = document.getElementById("graceBar");
const graceFill = document.getElementById("graceFill");
const graceLabel = document.getElementById("graceLabel");
const authStatus = document.getElementById("authStatus");
const authBtn = document.getElementById("authBtn");

// ---- Task: global session-lifecycle state ----
// One global object, inspectable as `Task` in devtools, tracking which stage
// of a writing session we're in.

/**
 * @typedef {"LAND" | "COUNTDOWN" | "WRITE" | "DONE" | "FIRST_DEMO"} Stage
 * LAND = idle/ready. COUNTDOWN = "3,2,1,Write!". WRITE = the clock is
 * running. DONE = finished, stopped early, or a past draft was restored.
 * FIRST_DEMO = the demo preset was started — replaces COUNTDOWN for the
 * "Start demo" flow specifically, so a demo run is distinguishable from an
 * ordinary one from the moment it begins.
 */

/**
 * Leaf names nested inside "stage" — closed, kebab-case, joined onto their
 * parent with "/" (see Section below). Both members drive identical CSS
 * today via the `^=` prefix rules in style.css; add a matching CSS rule
 * the day either needs its own layout, without inventing a second Record
 * or a second setter alongside STAGE_LAYOUT/setStage.
 * - "demo" — FIRST_DEMO's own identity, set via setStage()/STAGE_LAYOUT
 *   like any other Stage-driven Section.
 * - "ai-takeover" — the machine has taken the pen during WRITE. Unlike
 *   "demo" this doesn't correspond to a Stage of its own (Task.stage stays
 *   "WRITE" throughout); it's set directly from loop() the same way the
 *   LAND-stage interaction listeners below call setActiveSection() without
 *   going through setStage().
 * @typedef {"demo" | "ai-takeover"} StageSub
 */

/**
 * Which section of the mobile zoom layout is enlarged — see
 * setActiveSection() below and the [data-active] rules in style.css.
 * "begin" is the standalone Begin/Stop control (#beginBox), a first-class
 * box alongside "stage" and "controls" — not nested inside either.
 * Hierarchical values are kebab-case path segments joined with "/"; a
 * child's path always starts with its parent's name (e.g. "stage/demo"
 * starts with "stage"), so CSS matches "this section or any of its
 * children" with one prefix selector (main[data-active^="stage"]) instead
 * of enumerating every leaf.
 * @typedef {"begin" | "stage" | "controls" | "entries" | `stage/${StageSub}`} Section
 */

/**
 * The layout each stage forces into view, so a new stage can't be added
 * without also deciding what it does to the screen. `null` means the stage
 * doesn't override. LAND defaults to "begin" — the writer's one job on
 * landing is to see and press Begin — but LAND is still the only stage that
 * lets interaction move away from it (touching a slider or the entries list
 * still switches the active section; see the listeners below).
 * @type {Record<Stage, Section | null>}
 */
const STAGE_LAYOUT = {
  LAND: "begin",
  COUNTDOWN: "stage",
  WRITE: "stage",
  DONE: "stage",
  FIRST_DEMO: "stage/demo", // same box as COUNTDOWN (^= prefix match), own identity
};

const TASK_KEY = "dangerous-writing:task";

// `var` (not const) so this is both a plain script-global `Task` identifier
// tsc/JSDoc can resolve, and — since it's a top-level var in a classic
// script — a `window.Task` property, inspectable in devtools.
/** @type {{ stage: Stage }} */
var Task = { stage: "LAND" };

function persistTask() {
  try {
    localStorage.setItem(TASK_KEY, JSON.stringify({ stage: Task.stage }));
  } catch {
    // storage unavailable — Task still drives the UI for this page view
  }
}

function restoreTask() {
  try {
    const raw = localStorage.getItem(TASK_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // COUNTDOWN/WRITE have no live timer to resume after a reload, so only
    // the two static stages carry across page loads.
    if (parsed && (parsed.stage === "LAND" || parsed.stage === "DONE")) {
      Task.stage = parsed.stage;
    }
  } catch {
    // corrupt value — LAND (the default) is already in place
  }
}
restoreTask();

/**
 * Moves the Task to a new stage, persists it, and applies that stage's
 * layout via STAGE_LAYOUT — the one place Stage and Section are wired
 * together.
 * @param {Stage} stage
 */
function setStage(stage) {
  Task.stage = stage;
  persistTask();
  const section = STAGE_LAYOUT[stage];
  if (section) setActiveSection(section);
}

// Aggressive preset so first-timers feel the pressure instantly: a tiny goal,
// almost no grace period, and a snap countdown.
const DEMO_CONFIG = {
  goalSeconds: 30, // total run is only 30 seconds
  graceSeconds: 2, // you get barely 2 seconds of silence
};

// How long the demo intro overlay stays up before auto-starting — long
// enough to read the two-sentence explanation once.
const DEMO_INTRO_MS = 4500;

const SEED_TEXT =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Keep this text " +
  "alive by writing — the moment you stop, it begins to dissolve. Replace it " +
  "with your own words, or simply keep adding to it. Whatever you do, do not stop.";

let running = false;
let counting = false;
let countTimer = null;
let startTime = 0;
let lastTyped = 0;
let goalMs = 0;
let inactivityMs = 0;
let rafId = null;
let decayAcc = 0;
let lastFrame = 0;

// AI takeover state
let aiActive = false; // AI is currently producing/typing text
let aiBusy = false; // a /ai/continue request is in flight
let aiTypeTimer = null; // interval id for the char-by-char typing
let aiChars = 0; // total characters the AI has authored this run
let humanChars = 0; // characters the human authored this run (best-effort)

const DECAY_CHARS_PER_SEC = 12; // floor: a short run always burns out to blank
// Extra decay proportional to text length, so a long carry-over still stands a
// real stake to idling instead of taking minutes to dissolve. Combined with the
// floor above it decays ~5% of whatever is on screen per second, giving a
// continued run a comparable *share* of loss to a fresh one over the same idle.
const DECAY_FRACTION_PER_SEC = 0.05;
const AI_TYPE_MS = 24; // ms per character when the AI types
// The grace meter stays hidden until this share of the silence budget is spent,
// so it doesn't flicker at full while the writer is mid-sentence.
const GRACE_REVEAL = 0.25;

// ---- live readouts for the sliders ----
function fmtMinutes(v) {
  v = parseFloat(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function syncReadouts() {
  minutesOut.innerHTML = `${fmtMinutes(minutes.value)}<span class="unit">min</span>`;
  secondsOut.innerHTML = `${seconds.value}<span class="unit">sec</span>`;
}
minutes.addEventListener("input", syncReadouts);
seconds.addEventListener("input", syncReadouts);
syncReadouts();

// ---- settings persistence (browser only) ----
// The three settings — write-for minutes, grace seconds, and the AI takeover
// toggle — are remembered in localStorage so a returning visitor keeps their
// preferred setup. No server round-trip needed.
const SETTINGS_KEY = "dangerous-writing:settings";

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && typeof s.minutes === "number") minutes.value = String(s.minutes);
    if (s && typeof s.seconds === "number") seconds.value = String(s.seconds);
    if (s && typeof s.aiMode === "boolean") aiMode.checked = s.aiMode;
    syncReadouts();
  } catch {
    // storage unavailable — fall back to defaults
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        minutes: parseFloat(minutes.value),
        seconds: parseFloat(seconds.value),
        aiMode: aiMode.checked,
      }),
    );
  } catch {
    // storage unavailable (private mode / quota) — settings just won't persist
  }
}

minutes.addEventListener("input", saveSettings);
seconds.addEventListener("input", saveSettings);
aiMode.addEventListener("change", saveSettings);
loadSettings();

// ---- helpers ----
function fmtClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
function setBody(cls, on) {
  document.body.classList.toggle(cls, on);
}
function countWords(text) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
function updateCounter() {
  const n = countWords(editor.value);
  const total = aiChars + humanChars;
  if (aiMode.checked && total > 0) {
    const pct = Math.round((aiChars / total) * 100);
    wordsEl.textContent = `${n} ${n === 1 ? "word" : "words"} · ${pct}% AI`;
  } else {
    wordsEl.textContent = `${n} ${n === 1 ? "word" : "words"}`;
  }
}

// Grow the editor with its content up to the CSS cap (max-height); past that,
// the box stays put and the text scrolls inside it instead.
function autosize() {
  editor.style.height = "auto";
  const maxH = parseFloat(getComputedStyle(editor).maxHeight) || 0;
  editor.style.height = (maxH ? Math.min(editor.scrollHeight, maxH) : editor.scrollHeight) + "px";
}

window.addEventListener("resize", autosize);

function setPhase(text) {
  phaseEl.textContent = text;
}
function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

const entryTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
function formatSessionTime(ms) {
  return ms ? entryTimeFormatter.format(new Date(ms)) : "";
}
function snippet(text, max = 90) {
  const t = (text || "").trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

// Drive the fixed grace meter: how much silence is left before decay or the
// AI takeover. See countdown-bar.js — the /debug page's auto-refresh
// indicator uses the same component.
const graceCountdown = createCountdownBar({
  container: graceBar,
  fill: graceFill,
  label: graceLabel,
  formatLabel: (left) => (left / 1000).toFixed(1) + "s of silence left",
  revealFraction: GRACE_REVEAL,
});

// Pass null to retire it (no run in progress).
function setGrace(remainingMs) {
  graceCountdown.update(remainingMs, inactivityMs);
}

// Same fixed bottom bar, a second consumer: while the demo intro overlay is
// up (before WRITE starts, so graceCountdown above is idle), it reads as a
// "starting in..." timer instead of a silence budget.
const introCountdown = createCountdownBar({
  container: graceBar,
  fill: graceFill,
  label: graceLabel,
  formatLabel: (left) => "Demo starting in " + (left / 1000).toFixed(1) + "s — or tap Go",
});

// "Keep going" is only worth offering when there is writing to carry forward —
// not on an empty page, and not on untouched seed text (cancelled countdown).
function syncContinueBtn() {
  const text = editor.value;
  continueBtn.hidden = !text.trim() || text === SEED_TEXT;
}

function cancelCountdown() {
  if (countTimer !== null) {
    clearTimeout(countTimer);
    countTimer = null;
  }
  counting = false;
  countdownEl.hidden = true;
  demoIntro.hidden = true;
  cancelDemoIntroCountdown();
}

// The demo intro overlay auto-advances once it's had time to be read;
// tapping Go does the same thing early. Either way this is the one path in.
let demoIntroRafId = null;

function beginDemoCountdown() {
  cancelDemoIntroCountdown();
  demoIntro.hidden = true;
  runCountdown(true);
}

function cancelDemoIntroCountdown() {
  if (demoIntroRafId !== null) {
    cancelAnimationFrame(demoIntroRafId);
    demoIntroRafId = null;
  }
  introCountdown.hide();
}

function startDemoIntroCountdown() {
  const deadline = performance.now() + DEMO_INTRO_MS;
  function tick(now) {
    const left = deadline - now;
    if (left <= 0) {
      demoIntroRafId = null;
      beginDemoCountdown();
      return;
    }
    introCountdown.update(left, DEMO_INTRO_MS);
    demoIntroRafId = requestAnimationFrame(tick);
  }
  demoIntroRafId = requestAnimationFrame(tick);
}

// Stop any in-progress AI typing and hand control back to the writer.
function stopAi() {
  if (aiTypeTimer !== null) {
    clearInterval(aiTypeTimer);
    aiTypeTimer = null;
  }
  aiActive = false;
  setBody("aiwriting", false);
}

function resetAiState() {
  stopAi();
  aiBusy = false;
  aiChars = 0;
  humanChars = 0;
}

// ---- persistence & copy ----
// Finished writing goes to localStorage first; if the visitor is signed in to
// val.town it is also backed up to this val's sqlite via /api/save.
const SAVE_KEY = "dangerous-writing:last";

function lockEditor() {
  // Read-only (not disabled) so the text stays selectable and copyable.
  editor.readOnly = true;
}
function unlockEditor() {
  editor.readOnly = false;
}

function readLocalDraft() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.text === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// base/cls are the final status message from the caller; on server success we
// append a note that it was backed up to val.town.
function saveAndAnnounce(text, base, cls = "") {
  setStatus(base, cls);
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  copyBtn.hidden = false;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ text, savedAt: Date.now() }));
  } catch {
    // storage unavailable (private mode / quota) — server sync may still work
  }
  fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
    .then((r) => r.json().catch(() => ({})))
    .then((data) => {
      if (data && data.saved) {
        setStatus(base + " · Backed up to your Val Town account.", cls);
        loadPreviousEntries(); // refresh the panel so this session shows up immediately
      }
    })
    .catch(() => {
      // offline / server hiccup — the browser copy is enough
    });
}

function flashCopy() {
  const original = copyBtn.textContent;
  copyBtn.textContent = "Copied!";
  setTimeout(() => {
    copyBtn.textContent = original;
  }, 1400);
}

async function copyText() {
  const text = editor.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flashCopy();
    return;
  } catch {
    // clipboard API blocked — fall back to manual selection
  }
  editor.focus();
  editor.select();
  try {
    document.execCommand("copy");
    flashCopy();
  } catch {
    // text is at least selected for a manual copy
  }
}

// ---- sign in / sign out ----
// Signing in with Val Town enables the server-side backup of finished writing.
let signedIn = false;
let username = null;

async function refreshAuth() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    signedIn = !!data.signedIn;
    username = data.username || null;
  } catch {
    signedIn = false;
    username = null;
  }
  renderAuth();
  maybeShowRestore(); // re-sync restore/entries UI on every auth transition
}

function renderAuth() {
  if (signedIn) {
    authStatus.textContent = username
      ? `Signed in as @${username} — writing is backed up to Val Town.`
      : "Signed in — writing is backed up to Val Town.";
    authBtn.textContent = "Sign out";
  } else {
    authStatus.textContent = "Your writing is saved to this browser only.";
    authBtn.textContent = "Sign in to back up to Val Town";
  }
  authBtn.hidden = false;
}

function signIn() {
  // Open the Val Town login in a popup. On success the callback page posts a
  // same-origin message and closes, and we refresh our sign-in state below.
  const popup = window.open("/auth/login", "valTownOAuth", "width=600,height=700");
  if (!popup) {
    // Popup blocked — fall back to a full-page redirect through the OAuth flow.
    window.location.href = "/auth/login";
    return;
  }
  authStatus.textContent = "Waiting for Val Town…";
}

function signOut() {
  fetch("/auth/logout", { method: "POST" })
    .then(() => refreshAuth())
    .catch(() => refreshAuth());
}

// The OAuth callback (in the popup) posts this message back to us after login.
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data && event.data.type === "std_oauth_success") {
    refreshAuth();
  }
});

authBtn.addEventListener("click", () => {
  if (signedIn) signOut();
  else signIn();
});

// Signed-in users browse their synced history via the "Previous entries"
// panel; anonymous visitors keep the single-draft localStorage restore.
function expandEntries() {
  entriesPanel.hidden = false;
  entriesBtn.setAttribute("aria-expanded", "true");
}
function collapseEntries() {
  entriesPanel.hidden = true;
  entriesBtn.setAttribute("aria-expanded", "false");
}
entriesBtn.addEventListener("click", () => {
  if (entriesBtn.getAttribute("aria-expanded") === "true") collapseEntries();
  else expandEntries();
});

let previousEntries = [];

async function loadPreviousEntries() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    if (data && data.saved && data.sessions && data.sessions.length) {
      previousEntries = data.sessions;
      renderEntries(previousEntries);
      entriesBtn.hidden = false;
    } else {
      entriesBtn.hidden = true;
      collapseEntries();
    }
  } catch {
    entriesBtn.hidden = true;
    collapseEntries();
  }
}

function renderEntries(sessions) {
  entriesList.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "entries-item";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "entries-item-btn";
    btn.dataset.id = String(s.id);

    const time = document.createElement("span");
    time.className = "entries-item-time";
    time.textContent = `${formatSessionTime(s.savedAt)} · ${countWords(s.text)} words`;

    const preview = document.createElement("span");
    preview.className = "entries-item-preview";
    preview.textContent = snippet(s.text);

    btn.append(time, preview);
    li.appendChild(btn);
    entriesList.appendChild(li);
  }
}

entriesList.addEventListener("click", (e) => {
  const btn = e.target.closest(".entries-item-btn");
  if (!btn) return;
  const entry = previousEntries.find((s) => s.id === Number(btn.dataset.id));
  if (!entry) return;
  restoreTextToEditor(entry.text);
  collapseEntries();
});

async function maybeShowRestore() {
  if (signedIn) {
    restoreBtn.hidden = true;
    await loadPreviousEntries();
    return;
  }
  entriesBtn.hidden = true;
  collapseEntries();
  const local = readLocalDraft();
  if (local && local.text.trim()) restoreBtn.hidden = false;
}

refreshAuth();

// ---- game flow ----
// Pressing Begin seeds the lorem ipsum, then runs an instructive countdown.
// The clock only starts once the countdown reaches "Write!".
// `opts.demo` runs the aggressive preset with a snap countdown.
// `opts.continueText` carries text from a finished run into the new one, so a
// writer can pick up where they left off instead of starting from the seed.
function start(opts = {}) {
  if (counting || running) return;
  const demo = !!opts.demo;
  setStage(demo ? "FIRST_DEMO" : "COUNTDOWN");

  if (demo) {
    goalMs = DEMO_CONFIG.goalSeconds * 1000;
    inactivityMs = DEMO_CONFIG.graceSeconds * 1000;
    aiMode.checked = true; // the demo always showcases AI takeover
  } else {
    goalMs = parseFloat(minutes.value) * 60 * 1000;
    inactivityMs = parseFloat(seconds.value) * 1000;
  }
  // A continuation is scored as a fresh run: the % AI readout starts over even
  // though the carried text may already contain the machine's words.
  resetAiState();

  // Seed the editor with text to lose — either the carried-over writing or the
  // lorem ipsum — but keep it locked during the countdown.
  editor.value = opts.continueText || SEED_TEXT;
  autosize();
  editor.style.setProperty("--fade", "0");
  editor.disabled = true;
  copyBtn.hidden = true;
  continueBtn.hidden = true;
  collapseEntries();
  updateCounter();

  // Begin doubles as a Stop control once a run/countdown is active.
  startBtn.textContent = "Stop";
  demoBtn.disabled = true;
  minutes.disabled = true;
  seconds.disabled = true;
  aiMode.disabled = true;

  setBody("warning", false);
  setBody("decaying", false);
  setBody("aiwriting", false);
  // Hide the surrounding chrome before the countdown runs, so the writer is
  // already looking at just the stage by the time "Write!" appears.
  setBody("focus-mode", true);
  setGrace(null); // no silence budget until the clock actually starts
  progress.style.width = "0%";
  progress.style.background = "var(--ink)";
  setStatus("");

  if (demo) {
    // First stage of the demo intro: explain the aggressive preset and wait
    // for the writer to opt in, rather than snapping straight into the
    // countdown. `counting` is set here (not just inside runCountdown()) so
    // every existing guard — stop(), the re-entry checks on start()/demoBtn/
    // continueBtn/restoreBtn — already treats "waiting on Go" the same as
    // "counting down": nothing of the writer's is on screen yet to lose.
    counting = true;
    demoIntroText.textContent =
      `This is the demo: ${DEMO_CONFIG.goalSeconds} seconds to write, only ` +
      `${DEMO_CONFIG.graceSeconds} seconds of quiet before the machine takes the pen.`;
    demoIntro.hidden = false;
    startDemoIntroCountdown();
  } else {
    runCountdown(demo);
  }
}

demoIntroGo.addEventListener("click", beginDemoCountdown);

// Abort a run or countdown early, leaving whatever text survived.
function stop() {
  const wasCounting = counting;
  cancelCountdown();
  stopAi();
  running = false;
  cancelAnimationFrame(rafId);
  setBody("warning", false);
  setBody("decaying", false);
  setBody("focus-mode", false);
  setGrace(null);
  editor.style.setProperty("--fade", "0");
  lockEditor();

  setPhase("Stopped");
  if (wasCounting) {
    // Only the seed text was on screen; nothing of yours to save, so there's
    // no session to show — back to the landing stage.
    setStage("LAND");
    setStatus("Cancelled before the clock started.");
    copyBtn.hidden = true;
  } else {
    setStage("DONE");
    saveAndAnnounce(
      editor.value,
      "Stopped early — what survived is saved to this browser.",
    );
  }

  startBtn.textContent = "Begin again";
  syncContinueBtn();
  demoBtn.disabled = false;
  minutes.disabled = false;
  seconds.disabled = false;
  aiMode.disabled = false;
}

function runCountdown(demo = false) {
  counting = true;
  // Demo gets a snap countdown so the pressure lands immediately.
  const steps = demo ? ["Write!"] : ["3", "2", "1", "Write!"];
  const stepMs = demo ? 250 : 800;
  const holdMs = demo ? 250 : 550;
  let i = 0;

  countdownEl.hidden = false;

  function tick() {
    const label = steps[i];
    const isGo = label === "Write!";
    setPhase(isGo ? "Go!" : "Get ready…");
    // Re-trigger the pop animation by replacing the node's content + class.
    countNum.className = isGo ? "go" : "";
    countNum.textContent = label;
    countNum.style.animation = "none";
    void countNum.offsetWidth; // reflow so the animation restarts
    countNum.style.animation = "";

    i++;
    if (i < steps.length) {
      countTimer = setTimeout(tick, isGo ? 0 : stepMs);
    } else {
      // Hold "Write!" briefly, then launch.
      countTimer = setTimeout(() => {
        countdownEl.hidden = true;
        counting = false;
        beginRun(demo);
      }, holdMs);
    }
  }
  tick();
}

function beginRun(demo = false) {
  running = true;
  setStage("WRITE");
  startTime = performance.now();
  lastTyped = startTime;
  lastFrame = 0;
  decayAcc = 0;

  editor.disabled = false;
  unlockEditor();
  // Put the caret at the end of the text and focus. Carried-over writing can
  // overflow the box, so scroll the tail into view too.
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  editor.scrollTop = editor.scrollHeight;

  setPhase("Writing");
  // Say the silence budget out loud once, the way the demo does. It clears on
  // the first keystroke so it doesn't linger over the writing.
  if (demo) {
    setStatus("");
  } else {
    const secs = Math.round(inactivityMs / 1000);
    setStatus(
      `${secs} ${secs === 1 ? "second" : "seconds"} of quiet allowed — then ` +
        (aiMode.checked ? "the machine continues for you." : "your words start to drift."),
    );
  }

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function finish(won) {
  running = false;
  setStage("DONE");
  cancelAnimationFrame(rafId);
  stopAi();
  setBody("warning", false);
  setBody("decaying", false);
  setBody("focus-mode", false);
  setGrace(null);
  editor.style.setProperty("--fade", "0");
  lockEditor();

  const blank = !editor.value.trim();
  if (aiMode.checked) {
    const total = aiChars + humanChars;
    const pct = total > 0 ? Math.round((aiChars / total) * 100) : 0;
    progress.style.width = "100%";
    if (pct >= 50) {
      progress.style.background = "var(--ai)";
      setPhase("Shared");
      saveAndAnnounce(
        editor.value,
        `The machine wrote ${pct}% of this one. Want to take it back?`,
        "danger",
      );
    } else {
      progress.style.background = "var(--good)";
      setPhase("Survived");
      saveAndAnnounce(
        editor.value,
        `You kept the pen — only ${pct}% is the machine's.`,
        "win",
      );
    }
  } else if (won) {
    progress.style.width = "100%";
    progress.style.background = "var(--good)";
    setPhase("Survived");
    saveAndAnnounce(editor.value, "Your words are safe.", "win");
  } else {
    progress.style.width = "0%";
    setPhase("Done");
    setStatus(blank ? "The page is empty — that's okay." : "The page is empty again — start when you're ready.", "danger");
    copyBtn.hidden = true;
  }

  startBtn.disabled = false;
  startBtn.textContent = "Begin again";
  syncContinueBtn(); // offer to carry the surviving text into a fresh run
  minutes.disabled = false;
  seconds.disabled = false;
  aiMode.disabled = false;
  demoBtn.disabled = false;
}

// Ask the server for a continuation, then type it into the editor.
function triggerAiTakeover() {
  if (aiBusy || aiActive) return;
  aiBusy = true;
  aiActive = true;

  fetch("/ai/continue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: editor.value }),
  })
    .then((r) => r.json())
    .then((data) => {
      aiBusy = false;
      // The writer may have resumed (or the run ended) while we waited.
      if (!running || !aiActive) return;
      let text = (data && data.continuation) || "";
      if (!text) {
        aiActive = false;
        return;
      }
      // Ensure a separating space so words don't fuse together.
      if (editor.value.length && !/\s$/.test(editor.value) && !/^\s/.test(text)) {
        text = " " + text;
      }
      typeAiText(text);
    })
    .catch(() => {
      aiBusy = false;
      aiActive = false;
      setStatus("The machine faltered. Keep writing.", "danger");
    });
}

// Type AI text character-by-character; bail out the moment the writer types.
function typeAiText(text) {
  let i = 0;
  if (aiTypeTimer !== null) clearInterval(aiTypeTimer);
  aiTypeTimer = setInterval(() => {
    if (!running || !aiActive) {
      stopAi();
      return;
    }
    editor.value += text[i];
    aiChars++;
    i++;
    editor.setSelectionRange(editor.value.length, editor.value.length);
    autosize();
    editor.scrollTop = editor.scrollHeight; // keep the tail in view as it overflows
    updateCounter();
    if (i >= text.length) {
      clearInterval(aiTypeTimer);
      aiTypeTimer = null;
      aiActive = false; // wait for the next idle period to strike again
    }
  }, AI_TYPE_MS);
}

function loop(now) {
  if (!running) return;
  if (!lastFrame) lastFrame = now;
  const dt = now - lastFrame;
  lastFrame = now;

  const elapsed = now - startTime;
  const idle = now - lastTyped;

  timerEl.textContent = fmtClock(goalMs - elapsed);
  progress.style.width = Math.min(100, (elapsed / goalMs) * 100) + "%";

  if (elapsed >= goalMs) {
    finish(true);
    return;
  }

  if (idle >= inactivityMs) {
    setGrace(0); // budget spent — the meter sits empty rather than disappearing
    if (aiMode.checked) {
      // AI TAKEOVER: the machine writes instead of erasing.
      setBody("warning", false);
      setBody("decaying", false);
      setBody("aiwriting", true);
      setActiveSection("stage/ai-takeover");
      editor.style.setProperty("--fade", "0");
      progress.style.background = "var(--ai)";
      setPhase("Passing the pen");
      setStatus("Start typing to take it back.", "danger");
      triggerAiTakeover();
    } else {
      // ERASE: decay characters from the end.
      setBody("warning", true);
      setBody("decaying", true);
      progress.style.background = "var(--danger)";
      setPhase("Fading");
      editor.style.setProperty("--fade", "0");

      const decayRate = Math.max(
        DECAY_CHARS_PER_SEC,
        editor.value.length * DECAY_FRACTION_PER_SEC,
      );
      decayAcc += (decayRate * dt) / 1000;
      const toRemove = Math.floor(decayAcc);
      if (toRemove > 0) {
        decayAcc -= toRemove;
        editor.value = editor.value.slice(0, Math.max(0, editor.value.length - toRemove));
        autosize(); // shrink the box back down as the words dissolve
        updateCounter();
      }
      setStatus("Keep going — the words are drifting away.", "danger");

      if (editor.value.length === 0) {
        finish(false);
        return;
      }
    }
  } else {
    setGrace(inactivityMs - idle);
    decayAcc = 0;
    setBody("decaying", false);
    setBody("aiwriting", false);
    setActiveSection("stage");
    // Warning ramp begins WARN_MS before the deadline; fade grows 0 -> 1 across it.
    const WARN_MS = Math.min(1500, inactivityMs * 0.6);
    const warnStart = inactivityMs - WARN_MS;
    const warn = idle >= warnStart;
    setBody("warning", warn);
    progress.style.background = "var(--ink)";
    if (warn) {
      if (aiMode.checked) {
        editor.style.setProperty("--fade", "0");
        setPhase("Breathe…");
        setStatus("Pause and the machine continues for you.", "danger");
      } else {
        const fade = Math.min(1, (idle - warnStart) / WARN_MS);
        editor.style.setProperty("--fade", fade.toFixed(3));
        setPhase("Breathe…");
        setStatus("Your words are beginning to drift.", "danger");
      }
    } else {
      editor.style.setProperty("--fade", "0");
      setPhase("Writing");
      if (statusEl.classList.contains("danger")) setStatus("");
    }
  }

  rafId = requestAnimationFrame(loop);
}

editor.addEventListener("input", (e) => {
  if (!running) {
    updateCounter();
    return;
  }
  // If this input came from the human (not the AI typer), reclaim control.
  if (!aiActive || aiTypeTimer === null) {
    lastTyped = performance.now();
    if (e.inputType) humanChars++;
    // Retire the opening "N seconds of silence allowed" line — the meter takes
    // over from here. Warnings (.danger) are the loop's to clear, not ours.
    if (statusEl.textContent && !statusEl.classList.contains("danger")) setStatus("");
  }
  if (aiActive) {
    // The writer interrupted the machine — hand the pen back immediately.
    stopAi();
    lastTyped = performance.now();
  }
  autosize(); // track the box as you type
  updateCounter();
});

startBtn.addEventListener("click", () => {
  if (running || counting) stop();
  else start();
});

demoBtn.addEventListener("click", () => {
  // Demo always starts a fresh aggressive run; ignore if one is already going.
  if (running || counting) return;
  start({ demo: true });
});

// ---- restore / copy interactions ----
// Loads a past draft into the editor so you can re-read (or copy) it. Guarded
// against an active run/countdown so a stray click can't clobber it.
function restoreTextToEditor(text) {
  if (running || counting) return;
  if (!text) return;
  setStage("DONE");
  editor.value = text;
  editor.disabled = false;
  lockEditor();
  setPhase("Restored");
  setStatus("Your last writing is back on the page.", "win");
  copyBtn.hidden = false;
  continueBtn.hidden = false; // a restored entry can be picked back up too
  autosize();
  updateCounter();
  scrollTo(0, document.body.scrollHeight);
}

// "Keep going" starts a fresh timed run with whatever is on the page right now —
// a finished session, an early stop, or a restored entry — instead of the seed.
continueBtn.addEventListener("click", () => {
  if (running || counting) return;
  const text = editor.value;
  if (!text.trim()) return;
  start({ continueText: text });
});

restoreBtn.addEventListener("click", () => {
  const local = readLocalDraft();
  if (local && local.text.trim()) restoreTextToEditor(local.text);
});

copyBtn.addEventListener("click", copyText);

// On load, offer to restore the most recent writing.
maybeShowRestore();

// ---- mobile zoom layout: track active section ----
// Which section is enlarged on a narrow viewport. During COUNTDOWN/WRITE/DONE
// this is locked to "stage" by setStage() + STAGE_LAYOUT above; during LAND
// it follows whatever the writer last touched.
/**
 * @param {Section} section
 */
function setActiveSection(section) {
  const main = document.querySelector("main");
  if (main) main.setAttribute("data-active", section);
}

// Editor interactions
editor.addEventListener("focus", () => setActiveSection("stage"));

// Control interactions
minutes.addEventListener("input", () => setActiveSection("controls"));
seconds.addEventListener("input", () => setActiveSection("controls"));
aiMode.addEventListener("change", () => setActiveSection("controls"));

// Entries panel: hook into existing toggle
entriesBtn.addEventListener("click", () => {
  if (entriesBtn.getAttribute("aria-expanded") === "true") {
    setActiveSection("entries");
  }
});

// Apply the restored (or default) Task stage to the layout on load, via
// STAGE_LAYOUT: LAND shows the big Begin button, DONE shows whatever was
// last written.
setStage(Task.stage);
