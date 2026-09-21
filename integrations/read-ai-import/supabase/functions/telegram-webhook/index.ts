import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const MUNSIT_API_KEY = Deno.env.get("MUNSIT_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const DAILY_TASK_OWNER_ID = Deno.env.get("DAILY_TASK_OWNER_ID")!;
const ALLOWED_USER_IDS = (Deno.env.get("TELEGRAM_ALLOWED_USER_IDS") || "").split(",").map((s) => s.trim()).filter(Boolean);
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

type ExtractedItem = {
  destination: "daily" | "project";
  project_name?: string | null;
  kind?: "action" | "idea" | null;
  desc: string;
  owner?: string | null;
  due?: string | null;
  notes?: string | null;
};

async function extractItems(text: string, projectNames: string[]): Promise<ExtractedItem[]> {
  const prompt = `أنت مساعد ذكي شخصي لإدارة مهام ومشاريع بالعربي (لهجة أردنية أو عراقية غالباً، كتابة أو تفريغ صوتي). حلل الرسالة بعمق وافهم القصد الحقيقي — لا تكتفِ بنسخ الكلام، ميّز كل نقطة عمل أو فكرة مستقلة فيها وتجاهل السلام والحشو والكلام الجانبي.

معلومات تساعدك:
- تاريخ اليوم: ${todayStr()} وهو يوم ${dayName()}
- المشاريع الموجودة حالياً بالنظام: ${projectNames.length ? projectNames.join("، ") : "لا يوجد أي مشروع بعد"}

لكل نقطة عمل أو فكرة مستقلة حدد:
1. "destination": اكتب "project" فقط إذا ذكر المستخدم صراحة اسم أحد المشاريع أعلاه، أو كان مضمون الكلام واضح جداً إنه يخص أحدها تحديداً (مو مجرد تخمين). غير هيك اكتب "daily" (تعتبر مهمة شخصية عادية).
2. إذا كانت destination="project": حدد "project_name" (لازم يطابق اسم من القائمة أعلاه بالضبط)، و"kind": اكتب "action" إذا كانت خطوة عمل واضحة إلها مسؤول أو التزام أو قرار متخذ، أو "idea" إذا كانت مجرد اقتراح أو فكرة لسا مو محسومة ومحتاجة نقاش.
3. "desc": وصف مختصر وواضح ومفهوم للنقطة (لا تنسخ الكلام حرفياً لو كان ركيك، أعد صياغته بوضوح)
4. "owner": اسم الشخص المسؤول عن هاي النقطة تحديداً إذا انذكر، وإلا ""
5. "due": حوّل أي موعد نسبي (الخميس، بكرا، الأسبوع الجاي...) لتاريخ فعلي بصيغة YYYY-MM-DD بناءً على تاريخ اليوم أعلاه، أو null إذا ما في موعد واضح
6. "notes": أي تفاصيل أو سياق إضافي مهم تستحق الحفظ بس مش جزء من الوصف الأساسي، وإلا ""

أرجع JSON فقط بدون أي كلام إضافي وبدون markdown، بهاد الشكل بالضبط:
{"items":[
  {"destination":"daily","desc":"...","owner":"","due":null,"notes":""},
  {"destination":"project","project_name":"شعبة ب","kind":"action","desc":"...","owner":"","due":null,"notes":""}
]}

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
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const raw = (data.content || []).map((i: { text?: string }) => i.text || "").join("");
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed.items) ? parsed.items : [];
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

  // Only allowlisted Telegram user ids may use the bot (it writes to the owner's tasks/projects and spends API credits).
  // With no allowlist configured the bot stays locked and only tells the sender their own id, so the owner can add it.
  const senderId = String(message.from?.id ?? "");
  if (ALLOWED_USER_IDS.length === 0) {
    await sendTelegramMessage(chatId, `🔒 البوت مقفل. معرّفك: ${senderId} — أعطيه لصاحب النظام حتى يفعّل الوصول.`);
    return Response.json({ ok: true });
  }
  if (!ALLOWED_USER_IDS.includes(senderId)) return Response.json({ ok: true });

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

  const { data: projectRows } = await supabaseAdmin.from("projects").select("id, name");
  const projects = projectRows || [];

  const items = await extractItems(text, projects.map((p: { name: string }) => p.name));
  if (items.length === 0) {
    await sendTelegramMessage(chatId, "⚠️ ما قدرت ألاقي نقطة واضحة بالرسالة");
    return Response.json({ ok: true });
  }

  const dailyRows: { description: string; due_date: string | null; notes: string; owner_id: string; is_done: boolean }[] = [];
  const projectRowsToInsert: { project_id: string; kind: string; description: string; owner_name: string; due_date: string | null; notes: string; is_done: boolean }[] = [];
  const summaryLines: string[] = [];

  for (const it of items) {
    const desc = it.desc || "بند";
    let matchedProject = null as { id: string; name: string } | null;
    if (it.destination === "project" && it.project_name) {
      matchedProject = projects.find((p: { id: string; name: string }) =>
        p.name === it.project_name || p.name.includes(it.project_name!) || it.project_name!.includes(p.name)
      ) || null;
    }

    if (matchedProject) {
      const kind = it.kind === "idea" ? "idea" : "action";
      projectRowsToInsert.push({
        project_id: matchedProject.id,
        kind,
        description: desc,
        owner_name: it.owner || "",
        due_date: it.due || null,
        notes: it.notes || "",
        is_done: false,
      });
      summaryLines.push(`• [${matchedProject.name} — ${kind === "idea" ? "فكرة" : "أكشن بوينت"}] ${desc}${it.due ? " — " + it.due : ""}`);
    } else {
      dailyRows.push({
        owner_id: DAILY_TASK_OWNER_ID,
        description: desc,
        due_date: it.due || null,
        notes: it.notes || "",
        is_done: false,
      });
      summaryLines.push(`• [مهمة يومية] ${desc}${it.due ? " — " + it.due : ""}`);
    }
  }

  if (dailyRows.length) {
    const { error } = await supabaseAdmin.from("daily_tasks").insert(dailyRows);
    if (error) { await sendTelegramMessage(chatId, "⚠️ صار خطأ بإضافة المهام اليومية"); return Response.json({ ok: true }); }
  }
  if (projectRowsToInsert.length) {
    const { error } = await supabaseAdmin.from("project_items").insert(projectRowsToInsert);
    if (error) { await sendTelegramMessage(chatId, "⚠️ صار خطأ بإضافة بنود المشروع"); return Response.json({ ok: true }); }
  }

  await sendTelegramMessage(chatId, `✅ ضفت ${items.length}:\n${summaryLines.join("\n")}`);
  return Response.json({ ok: true });
});
