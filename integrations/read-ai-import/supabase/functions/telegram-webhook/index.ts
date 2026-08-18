import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const MUNSIT_API_KEY = Deno.env.get("MUNSIT_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const DAILY_TASK_OWNER_ID = Deno.env.get("DAILY_TASK_OWNER_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const todayStr = () => new Date().toISOString().slice(0, 10);
const DAYS = ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
const dayName = () => DAYS[new Date().getDay()];

async function sendTelegramMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function transcribeVoice(fileId: string): Promise<string | null> {
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) return null;

  const audioRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  const audioBlob = await audioRes.blob();

  const form = new FormData();
  form.append("file", audioBlob, "voice.ogg");
  form.append("model", "munsit");

  const munsitRes = await fetch("https://api.munsit.com/api/v1/minutes-of-meeting/transcribe", {
    method: "POST",
    headers: { "x-api-key": MUNSIT_API_KEY },
    body: form,
  });
  if (!munsitRes.ok) return null;
  const result = await munsitRes.json();
  return result?.data?.originalTranscript || result?.data?.transcription || null;
}

async function extractTasks(text: string) {
  const prompt = `أنت مساعد شخصي لإدارة مهام يومية. المستخدم بعتلك رسالة (كتابة أو تفريغ صوتي) بالعربي، لهجة أردنية أو عراقية غالباً. استخرج منها مهمة أو أكتر (action points فقط، تجاهل أي كلام جانبي أو سلام).

معلومات:
- تاريخ اليوم: ${todayStr()} وهو يوم ${dayName()}

قواعد:
1. كل نقطة عمل مستقلة = مهمة منفصلة
2. حوّل أي موعد نسبي (الخميس، بكرا...) لتاريخ فعلي YYYY-MM-DD. إذا ما في موعد واضح خليه null
3. الوصف يكون مختصر وواضح

أرجع JSON فقط بدون أي كلام إضافي وبدون markdown، بهاد الشكل بالضبط:
{"tasks":[{"desc":"...","due":"2026-08-06","notes":""}]}

الرسالة:
"""${text}"""`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const raw = (data.content || []).map((i: { text?: string }) => i.text || "").join("");
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
  if (secretHeader !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const update = await req.json();
  const message = update.message;
  if (!message) return Response.json({ ok: true });

  const chatId = message.chat.id;
  let text: string | null = null;

  if (message.voice) {
    await sendTelegramMessage(chatId, "⏳ عم أفرّغ الصوت...");
    text = await transcribeVoice(message.voice.file_id);
    if (!text) {
      await sendTelegramMessage(chatId, "⚠️ ما قدرت أفرّغ الصوت، جرب مرة ثانية");
      return Response.json({ ok: true });
    }
  } else if (message.text) {
    text = message.text;
  } else {
    return Response.json({ ok: true });
  }

  const tasks = await extractTasks(text);
  if (tasks.length === 0) {
    await sendTelegramMessage(chatId, "⚠️ ما قدرت ألاقي مهمة واضحة بالرسالة");
    return Response.json({ ok: true });
  }

  const rows = tasks.map((t: { desc?: string; due?: string; notes?: string }) => ({
    owner_id: DAILY_TASK_OWNER_ID,
    description: t.desc || "مهمة",
    due_date: t.due || null,
    notes: t.notes || "",
    is_done: false,
  }));

  const { error } = await supabaseAdmin.from("daily_tasks").insert(rows);
  if (error) {
    await sendTelegramMessage(chatId, "⚠️ صار خطأ بالإضافة لقاعدة البيانات");
    return Response.json({ ok: true });
  }

  const summary = rows.map((r: { description: string; due_date: string | null }) =>
    `• ${r.description}${r.due_date ? " — " + r.due_date : ""}`
  ).join("\n");
  await sendTelegramMessage(chatId, `✅ ضفت ${rows.length} مهمة:\n${summary}`);

  return Response.json({ ok: true });
});
