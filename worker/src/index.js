const TELEGRAM_API = "https://api.telegram.org/bot";
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.6-27b"
];

// System prompt is fetched from repo and cached
let cachedPrompt = null;

async function getSystemPrompt(env) {
  if (cachedPrompt) return cachedPrompt;
  try {
    const resp = await fetch(env.SYSTEM_PROMPT_URL);
    if (!resp.ok) throw new Error("fetch failed");
    const text = await resp.text();
    cachedPrompt = text;
    return text;
  } catch {
    return "You are San, bot for Sanin community. Sharp-witted, helpful, has attitude.";
  }
}

function extractQuery(update, botUsername) {
  const message = update.message || update.edited_message;
  if (!message || !message.text) return null;

  const chatType = message.chat.type;
  const text = message.text;
  const mentioned = text.includes("@" + botUsername);

  if (chatType === "private") return { query: text, userId: message.from.id, displayName: message.from.first_name };

  // Groups: only act when mentioned or replying to someone
  if (!mentioned && !message.reply_to_message) return null;

  const userText = text.replace(new RegExp("@" + botUsername, "g"), "").trim();

  if (userText && message.reply_to_message?.text) {
    return {
      query: "Previous message for context: " + message.reply_to_message.text +
             "\n\nMy actual question: " + userText,
      userId: message.from.id,
      displayName: message.from.first_name,
      replyTo: message.chat.id
    };
  }
  if (userText) {
    return { query: userText, userId: message.from.id, displayName: message.from.first_name, replyTo: message.chat.id };
  }
  if (message.reply_to_message?.text) {
    return { query: message.reply_to_message.text, userId: message.from.id, displayName: message.from.first_name, replyTo: message.chat.id };
  }

  return null;
}

async function getUserHistory(env, userId) {
  const key = "history_" + userId;
  const data = await env.USER_MEMORY.get(key);
  return data ? JSON.parse(data) : [];
}

async function saveUserHistory(env, userId, name, messages) {
  await env.USER_MEMORY.put(
    "user_" + userId,
    JSON.stringify({ name, updated: Date.now() })
  );
  await env.USER_MEMORY.put(
    "history_" + userId,
    JSON.stringify(messages.slice(-20))
  );
}

async function tryModel(apiKey, model, messages) {
  const resp = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0.8 })
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

async function webSearch(query) {
  try {
    const resp = await fetch(
      "https://api.duckduckgo.com/?q=" + encodeURIComponent(query) + "&format=json&no_html=1",
      { headers: { "User-Agent": "SanBot/1.0" } }
    );
    const data = await resp.json();
    if (data.AbstractText) return data.AbstractText;
    if (data.Answer) return data.Answer;
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      return data.RelatedTopics.slice(0, 3).map(t => t.Text).join("\n");
    }
    return null;
  } catch {
    return null;
  }
}

async function callAI(env, systemPrompt, profile, history, query) {
  const contextParts = [
    { role: "system", content: systemPrompt },
    { role: "system", content: "[You are talking to: " + (profile ? profile.name : "someone") + "]" }
  ];

  if (profile && profile.notes) {
    contextParts.push({ role: "system", content: "[Personality notes: " + profile.notes + "]" });
  }

  const messages = [
    ...contextParts,
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: query }
  ];

  // Search the web for additional context
  let searchContext = "";
  try {
    const searchResult = await webSearch(query);
    if (searchResult) {
      searchContext = "\n\n[Web search result: " + searchResult + "]";
      messages[messages.length - 1].content = query + searchContext;
    }
  } catch {}

  // Groq models in priority order
  for (const model of GROQ_MODELS) {
    try {
      const reply = await tryModel(env.GROQ_API_KEY, model, messages);
      if (reply) return reply;
    } catch {}
  }

  // Fallback to Cloudflare Workers AI
  if (env.AI) {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: messages.map(m => ({ role: m.role === "system" ? "system" : m.role, content: m.content }))
    });
    if (result && result.response) return result.response;
  }

  throw new Error("All AI providers exhausted");
}

async function sendTelegramMessage(token, chatId, text) {
  await fetch(TELEGRAM_API + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("San is alive", { status: 200 });
    }

    try {
      const update = await request.json();
      const botInfo = await fetch(TELEGRAM_API + env.TELEGRAM_BOT_TOKEN + "/getMe");
      const botData = await botInfo.json();
      const botUsername = botData.result.username;

      const extracted = extractQuery(update, botUsername);
      if (!extracted) return new Response("ignored", { status: 200 });

      const systemPrompt = await getSystemPrompt(env);
      const history = await getUserHistory(env, extracted.userId);

      let profile = null;
      try {
        const profileRaw = await env.USER_MEMORY.get("user_" + extracted.userId);
        if (profileRaw) profile = JSON.parse(profileRaw);
      } catch {}

      const reply = await callAI(env, systemPrompt, profile, history, extracted.query);

      history.push({ role: "user", content: extracted.query });
      history.push({ role: "assistant", content: reply });

      ctx.waitUntil(saveUserHistory(env, extracted.userId, extracted.displayName, history));

      const cleanReply = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      const chatId = extracted.replyTo || update.message?.chat?.id;
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, cleanReply);

      return new Response("ok", { status: 200 });
    } catch (err) {
      console.error("Worker error:", err.message);
      return new Response("error: " + err.message, { status: 500 });
    }
  }
};
