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
const aiMode = document.getElementById("aiMode");
const demoBtn = document.getElementById("demoBtn");
const copyBtn = document.getElementById("copyBtn");
const restoreBtn = document.getElementById("restoreBtn");
const entriesBtn = document.getElementById("entriesBtn");
const entriesPanel = document.getElementById("entriesPanel");
const entriesList = document.getElementById("entriesList");
const authStatus = document.getElementById("authStatus");
const authBtn = document.getElementById("authBtn");

// Aggressive preset so first-timers feel the pressure instantly: a tiny goal,
// almost no grace period, and a snap countdown.
const DEMO_CONFIG = {
  goalSeconds: 30, // total run is only 30 seconds
  graceSeconds: 2, // you get barely 2 seconds of silence
};

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

const DECAY_CHARS_PER_SEC = 12;
const AI_TYPE_MS = 24; // ms per character when the AI types

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

function cancelCountdown() {
  if (countTimer !== null) {
    clearTimeout(countTimer);
    countTimer = null;
  }
  counting = false;
  countdownEl.hidden = true;
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
function start(opts = {}) {
  if (counting || running) return;
  const demo = !!opts.demo;

  if (demo) {
    goalMs = DEMO_CONFIG.goalSeconds * 1000;
    inactivityMs = DEMO_CONFIG.graceSeconds * 1000;
    aiMode.checked = true; // the demo always showcases AI takeover
  } else {
    goalMs = parseFloat(minutes.value) * 60 * 1000;
    inactivityMs = parseFloat(seconds.value) * 1000;
  }
  resetAiState();

  // Seed the editor with text to lose, but keep it locked during the countdown.
  editor.value = SEED_TEXT;
  autosize();
  editor.style.setProperty("--fade", "0");
  editor.disabled = true;
  copyBtn.hidden = true;
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
  progress.style.width = "0%";
  progress.style.background = "var(--ink)";
  setStatus(
    demo
      ? `Demo: ${DEMO_CONFIG.goalSeconds}s to survive, ${DEMO_CONFIG.graceSeconds}s grace. Brutal.`
      : "",
    demo ? "danger" : "",
  );

  runCountdown(demo);
}

// Abort a run or countdown early, leaving whatever text survived.
function stop() {
  const wasCounting = counting;
  cancelCountdown();
  stopAi();
  running = false;
  cancelAnimationFrame(rafId);
  setBody("warning", false);
  setBody("decaying", false);
  editor.style.setProperty("--fade", "0");
  lockEditor();

  setPhase("Stopped");
  if (wasCounting) {
    // Only the seed text was on screen; nothing of yours to save.
    setStatus("Cancelled before the clock started.");
    copyBtn.hidden = true;
  } else {
    saveAndAnnounce(
      editor.value,
      "Stopped early — what survived is saved to this browser.",
    );
  }

  startBtn.textContent = "Begin again";
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
        beginRun();
      }, holdMs);
    }
  }
  tick();
}

function beginRun() {
  running = true;
  startTime = performance.now();
  lastTyped = startTime;
  lastFrame = 0;
  decayAcc = 0;

  editor.disabled = false;
  unlockEditor();
  // Put the caret at the end of the seed text and focus.
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);

  setPhase("Writing");
  setStatus("");

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function finish(won) {
  running = false;
  cancelAnimationFrame(rafId);
  stopAi();
  setBody("warning", false);
  setBody("decaying", false);
  editor.style.setProperty("--fade", "0");
  lockEditor();

  const blank = !editor.value.trim();
  if (aiMode.checked) {
    const total = aiChars + humanChars;
    const pct = total > 0 ? Math.round((aiChars / total) * 100) : 0;
    progress.style.width = "100%";
    if (pct >= 50) {
      progress.style.background = "var(--ai)";
      setPhase("Outwritten");
      saveAndAnnounce(
        editor.value,
        `The machine wrote ${pct}% of this. It's mostly not yours.`,
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
    setPhase("Gone");
    setStatus(blank ? "The page is blank." : "The page is blank again.", "danger");
    copyBtn.hidden = true;
  }

  startBtn.disabled = false;
  startBtn.textContent = "Begin again";
  minutes.disabled = false;
  seconds.disabled = false;
  aiMode.disabled = false;
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
    if (aiMode.checked) {
      // AI TAKEOVER: the machine writes instead of erasing.
      setBody("warning", false);
      setBody("decaying", false);
      setBody("aiwriting", true);
      editor.style.setProperty("--fade", "0");
      progress.style.background = "var(--ai)";
      setPhase("AI is writing…");
      setStatus("Type to wrestle the pen back.", "danger");
      triggerAiTakeover();
    } else {
      // ERASE: decay characters from the end.
      setBody("warning", true);
      setBody("decaying", true);
      progress.style.background = "var(--danger)";
      setPhase("Decaying");
      editor.style.setProperty("--fade", "0");

      decayAcc += (DECAY_CHARS_PER_SEC * dt) / 1000;
      const toRemove = Math.floor(decayAcc);
      if (toRemove > 0) {
        decayAcc -= toRemove;
        editor.value = editor.value.slice(0, Math.max(0, editor.value.length - toRemove));
        autosize(); // shrink the box back down as the words dissolve
        updateCounter();
      }
      setStatus("Keep typing — your words are vanishing.", "danger");

      if (editor.value.length === 0) {
        finish(false);
        return;
      }
    }
  } else {
    decayAcc = 0;
    setBody("decaying", false);
    setBody("aiwriting", false);
    // Warning ramp begins WARN_MS before the deadline; fade grows 0 -> 1 across it.
    const WARN_MS = Math.min(1500, inactivityMs * 0.6);
    const warnStart = inactivityMs - WARN_MS;
    const warn = idle >= warnStart;
    setBody("warning", warn);
    progress.style.background = "var(--ink)";
    if (warn) {
      if (aiMode.checked) {
        editor.style.setProperty("--fade", "0");
        setPhase("Hold on…");
        setStatus("Stop now and the machine takes over.", "danger");
      } else {
        const fade = Math.min(1, (idle - warnStart) / WARN_MS);
        editor.style.setProperty("--fade", fade.toFixed(3));
        setPhase("Hold on…");
        setStatus("Your words are dissolving.", "danger");
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
  editor.value = text;
  editor.disabled = false;
  lockEditor();
  setPhase("Restored");
  setStatus("Your last writing is back on the page.", "win");
  copyBtn.hidden = false;
  autosize();
  updateCounter();
  scrollTo(0, document.body.scrollHeight);
}

restoreBtn.addEventListener("click", () => {
  const local = readLocalDraft();
  if (local && local.text.trim()) restoreTextToEditor(local.text);
});

copyBtn.addEventListener("click", copyText);

// On load, offer to restore the most recent writing.
maybeShowRestore();
