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

async function handleLearnCommand(env, message) {
  const text = message.text;
  if (!text.startsWith("/learn")) return false;
  if (!text.slice(6).trim()) return true;

  const userId = String(message.from.id);
  // Get existing knowledge
  let knowledge = [];
  try {
    const raw = await env.USER_MEMORY.get("learned_knowledge");
    if (raw) knowledge = JSON.parse(raw);
  } catch {}
  
  knowledge.push({
    added: Date.now(),
    by: message.from.first_name,
    content: text.slice(7).trim()
  });

  await env.USER_MEMORY.put("learned_knowledge", JSON.stringify(knowledge));
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, message.chat.id, "Noted. Filed away.");
  return true;
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
  let body = { model, messages, max_tokens: 1024, temperature: 0.8 };
  
  // For gpt-oss models, strip reasoning from output
  if (model.includes("gpt-oss")) {
    body.reasoning_effort = "low";
    body.reasoning_format = "parsed";
  }
  
  const resp = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) return null;
  
  // If content is empty but reasoning has text, use reasoning
  let result = msg.content || "";
  if (!result.trim() && msg.reasoning) {
    // Extract final answer from reasoning (usually last paragraph)
    const parts = msg.reasoning.split("\n\n");
    result = parts[parts.length - 1].trim();
  }
  
  return result.trim() ? result : null;
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
  let learned = "";
  try {
    const raw = await env.USER_MEMORY.get("learned_knowledge");
    if (raw) {
      const items = JSON.parse(raw);
      learned = items.map(k => k.content).join("\n");
    }
  } catch {}

  const contextParts = [
    { role: "system", content: systemPrompt },
    ...(learned ? [{ role: "system", content: "[Additional knowledge you have been taught:\n" + learned + "]" }] : []),
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

  // Only search web for anime-related queries
  const animeKeywords = ["anime","manga","episode","season","sanin","dantotsu","anilist",
    "myanimelist","extension","sub","dub","streaming","watch","player","subtitle",
    "fire tv","android tv","shield","apk","source","repo","crash","bug","install",
    "download","update","tracking","simkl","tmdb","cloudstream","exoplayer","pip",
    "otaku","waifu","shounen","isekai","release","airing"];
  const lowerQuery = query.toLowerCase();
  const isAnimeRelated = animeKeywords.some(k => lowerQuery.includes(k));

  let searchContext = "";
  if (isAnimeRelated) {
    try {
      const searchResult = await webSearch(query);
      if (searchResult) {
        searchContext = "\n\n[Web search result: " + searchResult + "]";
        messages[messages.length - 1].content = query + searchContext;
      }
    } catch {}
  }

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

async function handleDiscordInteraction(request, env) {
  const interaction = await request.json();

  // Ping/verification
  if (interaction.type === 1) {
    return new Response(JSON.stringify({ type: 1 }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  if (interaction.type !== 2) return new Response("ok", { status: 200 });

  const command = interaction.data.name;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const displayName = interaction.member?.user?.username || interaction.user?.username || "user";
  const channelId = interaction.channel_id;
  const token = interaction.token;

  async function respond(text) {
    await fetch("https://discord.com/api/v10/interactions/" + interaction.id + "/" + token + "/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 4, data: { content: text } })
    });
  }

  async function followUp(text) {
    await fetch("https://discord.com/api/v10/webhooks/" + env.DISCORD_APP_ID + "/" + token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text })
    });
  }

  try {
    if (command === "learn") {
      const knowledge = interaction.data.options?.[0]?.value || "";
      if (!knowledge) {
        await respond("What do you want me to learn?");
        return new Response("ok", { status: 200 });
      }
      let learned = [];
      try {
        const raw = await env.USER_MEMORY.get("learned_knowledge");
        if (raw) learned = JSON.parse(raw);
      } catch {}
      learned.push({ added: Date.now(), by: displayName, content: knowledge });
      await env.USER_MEMORY.put("learned_knowledge", JSON.stringify(learned));
      await respond("Noted. Filed away.");
      return new Response("ok", { status: 200 });
    }

    if (command === "ask") {
      const question = interaction.data.options?.[0]?.value || "";
      if (!question) {
        await respond("What do you want to ask?");
        return new Response("ok", { status: 200 });
      }

      // Acknowledge immediately (Discord requires response within 3s)
      await fetch("https://discord.com/api/v10/interactions/" + interaction.id + "/" + token + "/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 5 })
      });

      // Get system prompt and history
      const systemPrompt = await getSystemPrompt(env);
      let history = [];
      try {
        const raw = await env.USER_MEMORY.get("history_dc_" + userId);
        if (raw) history = JSON.parse(raw);
      } catch {}

      let profile = null;
      try {
        const raw = await env.USER_MEMORY.get("user_dc_" + userId);
        if (raw) profile = JSON.parse(raw);
      } catch {}

      const reply = await callAI(env, systemPrompt, profile, history, question);
      
      let cleanReply = reply
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .trim();
      // Discord message limit
      if (cleanReply.length > 1900) cleanReply = cleanReply.slice(0, 1897) + "...";

      history.push({ role: "user", content: question });
      history.push({ role: "assistant", content: cleanReply });

      ctx.waitUntil(env.USER_MEMORY.put(
        "history_dc_" + userId,
        JSON.stringify(history.slice(-20))
      ));

      await followUp(cleanReply);
      return new Response("ok", { status: 200 });
    }
  } catch (err) {
    console.error("Discord error:", err.message);
    try {
      await followUp("Something broke. Try again in a bit.");
    } catch {}
  }

  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("San is alive", { status: 200 });
    }

    // Check if this is a Discord interaction
    const userAgent = request.headers.get("user-agent") || "";
    const isDiscord = request.headers.get("x-signature-ed25519") !== null ||
                      request.headers.get("x-signature-timestamp") !== null;

    if (isDiscord && env.DISCORD_BOT_TOKEN) {
      return handleDiscordInteraction(request.clone(), env);
    }

    try {
      const update = await request.json();
      const botInfo = await fetch(TELEGRAM_API + env.TELEGRAM_BOT_TOKEN + "/getMe");
      const botData = await botInfo.json();
      const botUsername = botData.result.username;

      // Check for /learn command
      const msg = update.message || update.edited_message;
      if (msg && msg.text && msg.text.startsWith("/learn")) {
        ctx.waitUntil(handleLearnCommand(env, msg));
        return new Response("ok", { status: 200 });
      }

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

      let cleanReply = reply
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/^(?:\s*[\d]+\.\s*\*\*(?:Analyze|Check|Determine|Draft|Identify|Formulate|Refine)[^\n]*\n)+/gm, "")
        .replace(/^(?:Here.s a thinking process:?[\s\S]*?)(?=\n\n)/i, "")
        .replace(/^\s*(?:Okay|Let me|Alright|So the user)[^\n]*(?:\n|$)/gim, "")
        .trim();
      // If reply is very long and contains numbered analysis steps before actual answer, keep only last paragraph block
      if (cleanReply.length > 500 && (cleanReply.includes("Check Against") || cleanReply.includes("Draft Response") || cleanReply.includes("thinking process"))) {
        const paragraphs = cleanReply.split("\n\n");
        cleanReply = paragraphs[paragraphs.length - 1].trim();
      }
      const chatId = extracted.replyTo || update.message?.chat?.id;
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, cleanReply);

      return new Response("ok", { status: 200 });
    } catch (err) {
      console.error("Worker error:", err.message);
      try {
        const update = await request.clone().json();
        const chatId = update.message?.chat?.id;
        if (chatId) {
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Something broke on my end. Give me a minute.");
        }
      } catch {}
      return new Response("ok", { status: 200 });
    }
  }
};
