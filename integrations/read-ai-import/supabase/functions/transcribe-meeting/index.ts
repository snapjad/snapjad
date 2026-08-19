import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MUNSIT_API_KEY = Deno.env.get("MUNSIT_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  // لازم مستخدم حقيقي مسجّل دخول — مو بس المفتاح العام — حتى ما حدا يستنزف رصيد Munsit المدفوع
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user } } = await authClient.auth.getUser(jwt);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const incomingForm = await req.formData();
  const file = incomingForm.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "missing file" }, { status: 400 });
  }

  const outgoingForm = new FormData();
  outgoingForm.append("file", file, file.name || "recording.m4a");
  outgoingForm.append("model", "munsit");

  const munsitRes = await fetch("https://api.munsit.com/api/v1/minutes-of-meeting/transcribe", {
    method: "POST",
    headers: { "x-api-key": MUNSIT_API_KEY },
    body: outgoingForm,
  });

  if (!munsitRes.ok) {
    const errText = await munsitRes.text();
    return Response.json({ error: "munsit_error", detail: errText }, { status: 502 });
  }

  const result = await munsitRes.json();
  const data = result.data || {};

  return Response.json({
    transcript: data.originalTranscript || data.transcription || "",
    summary: data.summary || "",
    duration: data.duration || null,
  });
});
