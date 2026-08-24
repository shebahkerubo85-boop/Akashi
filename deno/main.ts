const DISCORD_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") ?? "";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const SYSTEM_PROMPT_URL = "https://raw.githubusercontent.com/shebahkerubo85-boop/Akashi/main/system_prompt.md";

let systemPrompt: string | null = null;
let ws: WebSocket | null = null;
let connected = false;

async function getPrompt(): Promise<string> {
  if (systemPrompt) return systemPrompt;
  const r = await fetch(SYSTEM_PROMPT_URL);
  systemPrompt = await r.text();
  return systemPrompt;
}

async function callAI(query: string): Promise<string> {
  const prompt = await getPrompt();
  const models = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
  
  for (const model of models) {
    try {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: query }
        ],
        max_tokens: 1024,
        temperature: 0.8
      };
      
      if (model.includes("gpt-oss")) {
        body.reasoning_effort = "low";
      }

      const r = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      
      if (!r.ok) continue;
      const d = await r.json();
      let txt: string = d.choices?.[0]?.message?.content || "";
      txt = txt.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (txt) return txt;
    } catch { continue; }
  }
  return "I'm overloaded right now. Try again in a bit.";
}

async function sendMessage(channelId: string, text: string) {
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content: text.slice(0, 1900) })
  });
}

function connectGateway() {
  if (!DISCORD_TOKEN) {
    console.log("No DISCORD_BOT_TOKEN set. Skipping gateway.");
    return;
  }
  
  console.log("Connecting to Discord gateway...");
  
  const socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
  ws = socket;
  
  let heartbeatTimer: number | undefined;

  socket.onopen = () => console.log("Gateway connected");

  socket.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.op) {
      case 10:
        heartbeatTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: 1, d: data.d.heartbeat_interval ? null : null }));
          }
        }, data.d.heartbeat_interval);
        
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: DISCORD_TOKEN,
            intents: 32768 | 512,
            properties: { os: "linux", browser: "san", device: "san" }
          }
        }));
        break;

      case 11:
        // Heartbeat ACK
        break;

      case 0:
        if (data.t === "MESSAGE_CREATE") {
          const message = data.d;
          if (message.author?.bot) break;
          
          const text: string = message.content || "";
          const isDM: boolean = !message.guild_id;
          const mentioned: boolean = text.includes("<@");

          if (!isDM && !mentioned) break;

          const query: string = text.replace(/<@\d+>/g, "").trim();
          if (!query) break;

          try {
            const reply: string = await callAI(query);
            await sendMessage(message.channel_id, reply);
          } catch (e) {
            await sendMessage(message.channel_id, "Something broke. Give me a minute.");
          }
        }
        break;
    }
  };

  socket.onclose = () => {
    console.log("Gateway closed");
    connected = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    setTimeout(connectGateway, 5000);
  };

  socket.onerror = () => { connected = false; };
  socket.onopen = () => { connected = true; };
}

// Start gateway in background
connectGateway();

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "alive", discord_connected: connected }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response("San is running");
});
