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

async function verifyDiscordSignature(env, signature, timestamp, body) {
  try {
    const PUBLIC_KEY = env.DISCORD_PUBLIC_KEY;
    if (!PUBLIC_KEY) return false;
    
    const hexToUint8 = (hex) => {
      const arr = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        arr[i / 2] = parseInt(hex.substr(i, 2), 16);
      }
      return arr;
    };
    
    const keyData = hexToUint8(PUBLIC_KEY);
    const sigData = hexToUint8(signature);
    const message = new TextEncoder().encode(timestamp + body);
    
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    
    return await crypto.subtle.verify("Ed25519", key, sigData, message);
  } catch(e) {
    console.error("verify error:", e.message);
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("San is alive");
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Discord interactions - verify signature first
    const sig = request.headers.get("x-signature-ed25519");
    const ts = request.headers.get("x-signature-timestamp");
    
    if (sig && ts) {
      try {
        const rawBody = await request.text();
        const i = JSON.parse(rawBody);
        if (i.type === 1) return new Response(JSON.stringify({ type: 1 }), { headers: { "Content-Type": "application/json" } });
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
          return new Response(JSON.stringify({ type: 5 }), { headers: { "Content-Type": "application/json" } });
        }
      } catch(e) { console.error("discord err:", e.message); }
      return new Response("ok");
    }

    // Dedicated Discord interaction endpoint
    const url = new URL(request.url);
    if (url.pathname === "/discord" && request.method === "POST") {
      try {
        const i = await request.json();
        if (i.type === 1) {
          return new Response(JSON.stringify({ type: 1 }), { headers: { "Content-Type": "application/json" } });
        }
        if (i.type === 2 && i.data?.name === "ask") {
          const q = i.data.options?.[0]?.value || "";
          ctx.waitUntil((async () => {
            const sp = await getPrompt(env);
            const reply = await ai(env, sp, q);
            const clean = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 1900);
            await fetch("https://discord.com/api/v10/webhooks/" + env.DISCORD_APP_ID + "/" + i.token, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: clean })
            });
          })().catch(console.error));
          return new Response(JSON.stringify({ type: 5 }), { headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ type: 1 }), { headers: { "Content-Type": "application/json" } });
      } catch(e) {
        console.error("discord:", e.message);
      }
      return new Response("ok");
    }

    // Telegram
    try {
      const update = await request.json();
      const msg = update.message || update.edited_message;
      if (!msg || !msg.text) return new Response(JSON.stringify({ status: "no_text" }), { headers: { "Content-Type": "application/json" } });

      const text = msg.text;
      const chatType = msg.chat.type;
      const botUsername = env.BOT_USERNAME || "Shippun_sanbot";
      const mentioned = text.includes("@" + botUsername);

      // Groups: only respond when tagged or replying
      if (chatType !== "private" && !mentioned && !msg.reply_to_message) {
        return new Response(JSON.stringify({ status: "ignored_group" }), { headers: { "Content-Type": "application/json" } });
      }

      let query = text;
      if (chatType !== "private") {
        query = text.replace(new RegExp("@" + botUsername, "g"), "").trim();
        if (!query && msg.reply_to_message?.text) {
          query = msg.reply_to_message.text;
        }
      }

      if (!query) return new Response(JSON.stringify({ status: "no_query" }), { headers: { "Content-Type": "application/json" } });

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
        return new Response(JSON.stringify({ status: "learned" }), { headers: { "Content-Type": "application/json" } });
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

      return new Response(JSON.stringify({ status: "replied" }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      console.error("telegram handler error:", err.message);
      return new Response(JSON.stringify({ error: err.message }, { status: 200 }), { headers: { "Content-Type": "application/json" } });
    }
  }
};
