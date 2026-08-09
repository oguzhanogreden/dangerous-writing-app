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
      await sqlite.execute({
        sql: "INSERT INTO writing_sessions (user_id, username, text, saved_at) VALUES (?, ?, ?, ?)",
        args: [user.user.id, user.user.username ?? null, text, Date.now()],
      });
      return Response.json({ saved: true, user: user.user.username ?? user.user.id });
    } catch (err) {
      return Response.json({ saved: false, reason: String(err) }, { status: 500 });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const user = await getOAuthUserData(req);
    if (!user?.user?.id) return Response.json({ saved: false, sessions: [] });
    const res = await sqlite.execute({
      sql: "SELECT text, saved_at FROM writing_sessions WHERE user_id = ? ORDER BY saved_at DESC LIMIT 5",
      args: [user.user.id],
    });
    const rows = res.rows as Array<{ text: string; saved_at: number }>;
    return Response.json({
      saved: true,
      sessions: rows.map((r) => ({ text: r.text, savedAt: r.saved_at })),
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

  switch (url.pathname) {
    case "/style.css":
      return serveFile("/style.css", import.meta.url);
    case "/client.js":
      return serveFile("/client.js", import.meta.url);
    case "/":
    case "/index.html":
      return serveFile("/index.html", import.meta.url);
    default:
      return new Response("Not found", { status: 404 });
  }
}

export default oauthMiddleware(handler);
