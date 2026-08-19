import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req, _ctx) => {
    if (req.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }

    // لازم مستخدم حقيقي مسجّل دخول — مو بس المفتاح العام — حتى ما حدا يستنزف رصيد Claude/Munsit مجاناً
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { user } } = await authClient.auth.getUser(jwt);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

    const { text, teamNames, todayStr, dayNameStr } = await req.json();
    if (!text || !Array.isArray(teamNames)) {
      return Response.json({ error: "missing text or teamNames" }, { status: 400 });
    }

    const prompt = `أنت مساعد داخل تطبيق إدارة اجتماعات. المستخدم أعطاك نصاً بالعربي (لهجة أردنية أو عراقية غالباً): إما نقاط مكتوبة، أو تفريغ صوتي كامل لاجتماع فيه نقاش وكلام جانبي. مهمتك: (1) تكتب ملخص قصير وواضح للاجتماع، و(2) تستخرج نقاط العمل (action points) فقط وتحولها لمهام منفصلة، وتتجاهل السلام والنقاش الجانبي.

معلومات تساعدك:
- تاريخ اليوم: ${todayStr} وهو يوم ${dayNameStr}
- أسماء أعضاء الفريق المسجّلين بالنظام (للاستئناس فقط، مو حصراً): ${teamNames.join("، ")}
- أنواع المهام المسموحة: "متابعة" أو "تنفيذ" فقط

قواعد:
1. كل نقطة عمل مستقلة = مهمة منفصلة
2. المسؤول (owner) هو دايماً الاسم يلي انذكر فعلياً بالنص لهاي المهمة تحديداً — حتى لو هاد الشخص مش من أسماء الفريق المسجّلين (ممكن يكون شخص برا النظام). اكتب الاسم متل ما انذكر بالضبط. لا تحاول تطابقه قسراً مع قائمة الفريق. إذا ما انذكر أي اسم لهاي المهمة تحديداً، خلّي owner فاضي ""
3. حوّل أي موعد نسبي (الخميس، بكرا...) لتاريخ فعلي YYYY-MM-DD بناءً على تاريخ اليوم. إذا ما في موعد خليه null
4. النوع: متابعة موضوع/تذكير = "متابعة"، شغل ينعمل = "تنفيذ"
5. الملخص يكون 2-4 جمل، بالعربي، يلخص محتوى الاجتماع فقط

أرجع JSON فقط بدون أي كلام إضافي وبدون markdown، بهاد الشكل بالضبط:
{"summary":"...","tasks":[{"type":"تنفيذ","desc":"...","owner":"الاسم يلي انذكر بالنص","due":"2026-08-06","notes":""}]}

ملاحظات الاجتماع:
"""${text}"""`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
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

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return Response.json({ error: "anthropic_error", detail: errText }, { status: 502 });
    }

    const data = await anthropicRes.json();
    const raw = (data.content || []).map((i: { text?: string }) => i.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(clean);
      return Response.json(parsed);
    } catch {
      return Response.json({ error: "parse_error", raw: clean }, { status: 502 });
    }
  }),
};
