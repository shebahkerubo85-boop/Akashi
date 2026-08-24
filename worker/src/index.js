const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const TELEGRAM = "https://api.telegram.org/bot";

let cachedPrompt = null;

async function getPrompt(env) {
  if (cachedPrompt) return cachedPrompt;
  const r = await fetch(env.SYSTEM_PROMPT_URL);
  cachedPrompt = await r.text();
  return cachedPrompt;
}

async function ai(env, sysPrompt, query) {
  const models = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
  for (const m of models) {
    try {
      const r = await fetch(GROQ_API, {
        method: "POST",
        headers: { Authorization: "Bearer " + env.GROQ_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: query }
        ], max_tokens: 1024, temperature: 0.8 })
      });
      if (!r.ok) continue;
      const d = await r.json();
      let txt = d.choices?.[0]?.message?.content || "";
      txt = txt.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (txt) return txt;
    } catch(e) { console.error(m, e.message); }
  }
  // Cloudflare AI fallback
  if (env.AI) {
    const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "system", content: sysPrompt }, { role: "user", content: query }]
    });
    if (r?.response) return r.response;
  }
  throw new Error("all models failed");
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("San is alive");
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Discord interactions have x-signature-ed25519 header
    if (request.headers.get("x-signature-ed25519")) {
      try {
        const i = await request.json();
        if (i.type === 1) return Response.json({ type: 1 });
        if (i.type === 2 && i.data?.name === "ask") {
          const q = i.data.options?.[0]?.value || "";
          ctx.waitUntil((async () => {
            const sp = await getPrompt(env);
            const reply = await ai(env, sp, q);
            await fetch("https://discord.com/api/v10/webhooks/" + env.DISCORD_APP_ID + "/" + i.token, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: reply.slice(0, 1900) })
            });
          })().catch(console.error));
          return Response.json({ type: 5 });
        }
      } catch(e) { console.error("discord err:", e.message); }
      return new Response("ok");
    }

    // Telegram
    try {
      const update = await request.json();
      const msg = update.message || update.edited_message;
      if (!msg || !msg.text) return Response.json({ status: "no_text" });

      const text = msg.text;
      const chatType = msg.chat.type;
      const botUsername = env.BOT_USERNAME || "Shippun_sanbot";
      const mentioned = text.includes("@" + botUsername);

      // Groups: only respond when tagged or replying
      if (chatType !== "private" && !mentioned && !msg.reply_to_message) {
        return Response.json({ status: "ignored_group" });
      }

      let query = text;
      if (chatType !== "private") {
        query = text.replace(new RegExp("@" + botUsername, "g"), "").trim();
        if (!query && msg.reply_to_message?.text) {
          query = msg.reply_to_message.text;
        }
      }

      if (!query) return Response.json({ status: "no_query" });

      // /learn command
      if (query.startsWith("/learn")) {
        const knowledge = query.replace("/learn", "").trim();
        if (knowledge) {
          let learned = [];
          try {
            const raw = await env.USER_MEMORY.get("learned_knowledge");
            if (raw) learned = JSON.parse(raw);
          } catch {}
          learned.push({ t: Date.now(), c: knowledge });
          await env.USER_MEMORY.put("learned_knowledge", JSON.stringify(learned));
        }
        await fetch(TELEGRAM + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: msg.chat.id, text: knowledge ? "Noted." : "Usage: /learn <text>" })
        });
        return Response.json({ status: "learned" });
      }

      // Load knowledge + history
      let learnedText = "";
      try {
        const raw = await env.USER_MEMORY.get("learned_knowledge");
        if (raw) {
          learnedText = JSON.parse(raw).map(k => k.c).join("\n");
        }
      } catch {}

      const sysPrompt = await getPrompt(env);
      const fullSys = sysPrompt + (learnedText ? "\n\nAdditional knowledge:\n" + learnedText : "");

      // Get AI reply
      const reply = await ai(env, fullSys, query);

      // Send to Telegram
      const sendUrl = TELEGRAM + env.TELEGRAM_BOT_TOKEN + "/sendMessage";
      const sendResp = await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: msg.chat.id, text: reply })
      });

      if (!sendResp.ok) {
        const errBody = await sendResp.text();
        console.error("Telegram send failed:", errBody);
      }

      return Response.json({ status: "replied" });
    } catch (err) {
      console.error("telegram handler error:", err.message);
      return Response.json({ error: err.message }, { status: 200 });
    }
  }
};
