import { serveFile } from "https://esm.town/v/std/utils/index.ts";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import {
  getOAuthUserData,
  oauthMiddleware,
} from "https://esm.town/v/std/oauth/middleware.ts";

// GreenPT is OpenAI-compatible: POST /v1/chat/completions with a Bearer key.
const GREENPT_BASE_URL = "https://api.greenpt.ai/v1";
const GREENPT_MODEL = "gemma4"; // GreenPT's recommended default chat model

// Finished writing sessions. Only saved when the visitor is signed in to
// val.town (the browser always keeps its own copy in localStorage first).
await sqlite.execute(`CREATE TABLE IF NOT EXISTS writing_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  username TEXT,
  text TEXT NOT NULL,
  saved_at INTEGER NOT NULL
)`);
await sqlite.execute(
  `CREATE INDEX IF NOT EXISTS idx_writing_sessions_user
   ON writing_sessions (user_id, saved_at DESC)`,
);

// Ask GreenPT to continue the writer's text in their voice, briefly.
async function continueText(text: string): Promise<string> {
  const apiKey = Deno.env.get("GREENPT_API_KEY");
  if (!apiKey) throw new Error("GREENPT_API_KEY is not set");

  const snippet = text.slice(-1500); // only send the tail for context
  const res = await fetch(`${GREENPT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GREENPT_MODEL,
      temperature: 0.9,
      max_tokens: 60,
      reasoning_effort: "none", // we want a fast continuation, not visible thinking
      messages: [
        {
          role: "system",
          content:
            "You are an AI that hijacks a piece of in-progress writing the moment its " +
            "human author stops typing. Continue their text from exactly where it left " +
            "off, matching their tone, topic, and language. Write 1-2 short sentences " +
            "only. Do not repeat what is already there, do not add quotation marks, " +
            "labels, or commentary — output only the continuation, starting with a " +
            "leading space if the text does not already end with whitespace.",
        },
        {
          role: "user",
          content: snippet || "Begin a short piece of reflective writing.",
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GreenPT ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

// The /debug page can only report what the server knows (auth, saved-session
// count, whether GreenPT is configured). Live in-memory client state — the
// global `Task` from client.js — only exists on the / page during an active
// session, so the embedded script here reads localStorage instead, which is
// what actually persists across reloads.
function renderDebugPage(server: Record<string, unknown>): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Debug — Dangerous Writing</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #1c1916; color: #ece6dd; padding: 1.5rem; font-size: 14px; line-height: 1.5; max-width: 40rem; margin: 0 auto; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  h2 { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; color: #a89f90; text-transform: uppercase; letter-spacing: 0.05em; }
  pre { background: #2b2722; padding: 0.85rem 1rem; border-radius: 8px; overflow-x: auto; margin: 0; white-space: pre-wrap; word-break: break-word; }
  .note { color: #a89f90; font-size: 0.85rem; margin-top: 0.5rem; }
  a { color: #b1a6ef; }
  button { font: inherit; background: #7b6ed0; color: #fff; border: none; border-radius: 6px; padding: 0.5rem 0.9rem; cursor: pointer; }
  button:hover { opacity: 0.85; }
  button:active { transform: translateY(1px); }
  #resetMsg { color: #96ba9a; margin-left: 0.75rem; }
  /* Same fixed-bottom countdown-bar paradigm as the app's silence/grace
     meter (style.css .gracebar) — driven by the same shared component
     (countdown-bar.js), just themed for this page and fed refresh time
     instead of silence time. */
  .refresh-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0.75rem 1.5rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
    background: linear-gradient(to top, #1c1916 55%, transparent);
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  .refresh-bar.visible { opacity: 1; }
  .refresh-label {
    display: block;
    max-width: 40rem;
    margin: 0 auto;
    padding-bottom: 0.35rem;
    text-align: right;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    color: #a89f90;
  }
  .refresh-track { max-width: 40rem; margin: 0 auto; height: 3px; background: #2b2722; }
  .refresh-fill { height: 100%; width: 100%; background: #7b6ed0; transition: width 0.2s linear; }
</style>
</head>
<body>
<h1>Dangerous Writing — Debug</h1>

<h2>Server</h2>
<pre id="server">${JSON.stringify(server, null, 2)}</pre>

<h2>Client (persisted)</h2>
<pre id="client">loading…</pre>
<p class="note">
  <button id="resetBtn" type="button">Reset local state</button>
  <span id="resetMsg"></span>
</p>
<p class="note">Clears this browser's settings, session stage, and last-draft
  backup (the three <code>dangerous-writing:*</code> keys above) — not
  writing already backed up to your Val Town account.</p>

<h2>Client (live)</h2>
<pre>Open the / page's own devtools console during an active session and run
window.Task to inspect it in real time — it's in-memory only, so it can't
be shown from this separate page.</pre>

<p class="note"><a href="/" target="_top">Back to the app</a> — the Server section now refreshes itself; see the bar at the bottom of the screen.</p>

<div id="refreshBar" class="refresh-bar" aria-hidden="true">
  <span id="refreshLabel" class="refresh-label"></span>
  <div class="refresh-track"><div id="refreshFill" class="refresh-fill"></div></div>
</div>

<script src="/countdown-bar.js"></script>
<script>
  const CLIENT_KEYS = [
    "dangerous-writing:settings",
    "dangerous-writing:task",
    "dangerous-writing:last",
  ];

  function safeParse(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return { error: String(e) };
    }
  }

  function renderClientState() {
    const settings = safeParse("dangerous-writing:settings");
    const task = safeParse("dangerous-writing:task");
    const lastRaw = safeParse("dangerous-writing:last");
    const lastDraft = lastRaw
      ? {
          length: typeof lastRaw.text === "string" ? lastRaw.text.length : 0,
          savedAt: lastRaw.savedAt ? new Date(lastRaw.savedAt).toISOString() : null,
        }
      : null;
    document.getElementById("client").textContent = JSON.stringify(
      { settings, task, lastDraft },
      null,
      2,
    );
  }
  renderClientState();

  document.getElementById("resetBtn").addEventListener("click", () => {
    for (const key of CLIENT_KEYS) localStorage.removeItem(key);
    renderClientState();
    const msg = document.getElementById("resetMsg");
    msg.textContent = "Cleared.";
    setTimeout(() => { msg.textContent = ""; }, 2000);
  });

  // ---- auto-refresh: same countdown-bar component the app's silence meter
  // uses (see countdown-bar.js), fed refresh time instead of silence time.
  const REFRESH_MS = 10000;
  let refreshDeadline = performance.now() + REFRESH_MS;

  const refreshCountdown = createCountdownBar({
    container: document.getElementById("refreshBar"),
    fill: document.getElementById("refreshFill"),
    label: document.getElementById("refreshLabel"),
    formatLabel: (left) => "Refreshing in " + (left / 1000).toFixed(1) + "s",
  });

  async function refreshServerState() {
    try {
      const res = await fetch(location.pathname, {
        headers: { Accept: "application/json" },
      });
      const data = await res.json();
      document.getElementById("server").textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      // offline / server hiccup — leave the stale data up, try again next cycle
    }
    renderClientState();
    refreshDeadline = performance.now() + REFRESH_MS;
  }

  function tick() {
    const left = refreshDeadline - performance.now();
    refreshCountdown.update(left, REFRESH_MS);
    if (left <= 0) refreshServerState();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
</script>
</body>
</html>`;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/api/save") {
    const user = await getOAuthUserData(req);
    if (!user?.user?.id) {
      return Response.json({ saved: false, reason: "not signed in" });
    }
    try {
      const { text } = await req.json();
      if (typeof text !== "string" || !text.trim()) {
        return Response.json({ saved: false, reason: "no text" });
      }
      // "Keep going" re-saves the same piece as a growing superset on every
      // run. If the new text starts with the latest saved row, it is a
      // continuation of that session, so fold it into that row instead of
      // stacking near-identical snapshots in the Previous entries panel.
      const latest = await sqlite.execute({
        sql: "SELECT id, text FROM writing_sessions WHERE user_id = ? ORDER BY saved_at DESC LIMIT 1",
        args: [user.user.id],
      });
      const last = latest.rows[0] as unknown as { id: number; text: string } | undefined;
      if (last && typeof last.text === "string" && text.startsWith(last.text)) {
        await sqlite.execute({
          sql: "UPDATE writing_sessions SET text = ?, saved_at = ? WHERE id = ?",
          args: [text, Date.now(), last.id],
        });
      } else {
        await sqlite.execute({
          sql: "INSERT INTO writing_sessions (user_id, username, text, saved_at) VALUES (?, ?, ?, ?)",
          args: [user.user.id, user.user.username ?? null, text, Date.now()],
        });
      }
      return Response.json({ saved: true, user: user.user.username ?? user.user.id });
    } catch (err) {
      return Response.json({ saved: false, reason: String(err) }, { status: 500 });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const user = await getOAuthUserData(req);
    if (!user?.user?.id) return Response.json({ saved: false, sessions: [] });
    const res = await sqlite.execute({
      sql: "SELECT id, text, saved_at FROM writing_sessions WHERE user_id = ? ORDER BY saved_at DESC LIMIT 5",
      args: [user.user.id],
    });
    const rows = res.rows as Array<{ id: number; text: string; saved_at: number }>;
    return Response.json({
      saved: true,
      sessions: rows.map((r) => ({ id: r.id, text: r.text, savedAt: r.saved_at })),
    });
  }

  if (req.method === "POST" && url.pathname === "/ai/continue") {
    try {
      const { text } = await req.json();
      const continuation = await continueText(typeof text === "string" ? text : "");
      return Response.json({ continuation });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = await getOAuthUserData(req);
    if (!user?.user?.id) {
      return Response.json({ signedIn: false });
    }
    return Response.json({
      signedIn: true,
      username: user.user.username ?? null,
    });
  }

  if (req.method === "GET" && url.pathname === "/debug") {
    const server = await getDebugServerState(req);
    // The page's own auto-refresh bar (see renderDebugPage) re-fetches this
    // same route with an Accept: application/json header instead of
    // reloading, so it can update just the Server block in place.
    if (req.headers.get("accept")?.includes("application/json")) {
      return Response.json(server);
    }
    return new Response(renderDebugPage(server), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  switch (url.pathname) {
    case "/style.css":
      return serveFile("/style.css", import.meta.url);
    case "/client.js":
      return serveFile("/client.js", import.meta.url);
    case "/countdown-bar.js":
      return serveFile("/countdown-bar.js", import.meta.url);
    case "/":
    case "/index.html":
      return serveFile("/index.html", import.meta.url);
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function getDebugServerState(req: Request) {
  const user = await getOAuthUserData(req);
  const signedIn = !!user?.user?.id;
  let sessionCount = 0;
  let latestSavedAt: number | null = null;
  if (signedIn) {
    const res = await sqlite.execute({
      sql:
        "SELECT COUNT(*) as count, MAX(saved_at) as latest FROM writing_sessions WHERE user_id = ?",
      args: [user!.user.id],
    });
    const row = res.rows[0] as unknown as
      | { count: number; latest: number | null }
      | undefined;
    sessionCount = row?.count ?? 0;
    latestSavedAt = row?.latest ?? null;
  }
  return {
    signedIn,
    username: user?.user?.username ?? null,
    sessionCount,
    latestSavedAt: latestSavedAt ? new Date(latestSavedAt).toISOString() : null,
    greenptConfigured: !!Deno.env.get("GREENPT_API_KEY"),
    serverTime: new Date().toISOString(),
  };
}

export default oauthMiddleware(handler);
