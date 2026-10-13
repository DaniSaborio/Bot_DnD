// Cliente de IA del DM: API de Google Gemini (necesita GEMINI_API_KEY, gratis en https://aistudio.google.com/apikey).
// Con una key de un proyecto sin facturación Google nunca cobra: al acabarse la cuota responde 429.
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_THINKING?: string;
}

// Todos tienen capa gratuita, cada uno con su propia cuota.
const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite";

// D&D tiene combates, monstruos y villanos: bloqueamos solo lo claramente dañino.
const SAFETY_SETTINGS = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map(
  (category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }),
);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** La API exige alternar user/model y empezar con user. */
function normalize(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else out.push({ ...m });
  }
  if (out.length && out[0].role === "assistant") out.unshift({ role: "user", content: "(Continuación de la campaña.)" });
  return out;
}

/** Lista de modelos a probar en orden: si a uno se le acaba la cuota gratuita, se pasa al siguiente. */
function modelList(env: AIEnv): string[] {
  const list = (env.GEMINI_MODEL || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS.split(",");
}

export async function callAI(env: AIEnv, system: string, messages: ChatMessage[], maxTokens: number, opts: { json?: boolean } = {}): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY en .env");
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: normalize(messages).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: {
      // El razonamiento interno cuenta dentro de maxOutputTokens: damos margen extra.
      maxOutputTokens: maxTokens * 3,
      temperature: opts.json ? 0.2 : 0.9,
      thinkingConfig: { thinkingLevel: env.GEMINI_THINKING || "low" },
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
    safetySettings: SAFETY_SETTINGS,
  });

  let res: Response | undefined;
  let model = "";
  for (model of modelList(env)) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body,
    });
    // 429 = se acabó la cuota de este modelo; 404 = el modelo no está disponible para esta key. Probamos el siguiente.
    if (res.status !== 429 && res.status !== 404) break;
    console.warn(`Gemini ${model}: ${res.status === 429 ? "sin cuota" : "no disponible"}, probando el siguiente modelo`);
  }

  if (!res!.ok) {
    const text = (await res!.text()).slice(0, 300);
    if (res!.status === 429) throw new Error("Se acabó la cuota gratuita de Gemini en todos los modelos. Esperen un minuto (o hasta mañana si es el límite diario, se reinicia a la 01:00 de Costa Rica) y prueben /narrar.");
    if (res!.status === 400 && /API key/i.test(text)) throw new Error("La GEMINI_API_KEY no es válida.");
    throw new Error(`Gemini respondió ${res!.status}: ${text}`);
  }

  const data = (await res!.json()) as GeminiResponse;
  const u = data.usageMetadata;
  if (u) console.log(`Gemini ${model}: ${u.promptTokenCount ?? 0} tokens de entrada, ${(u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)} de salida`);
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini bloqueó el mensaje (${data.promptFeedback.blockReason}); reformulen la acción.`);
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  if (!text) {
    const reason = candidate?.finishReason;
    if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT") throw new Error("Gemini bloqueó la respuesta por sus filtros de seguridad; reformulen la acción.");
    if (reason === "MAX_TOKENS") throw new Error("La IA se quedó sin tokens antes de responder; prueben /narrar.");
    throw new Error("La IA devolvió una respuesta vacía; prueben /narrar");
  }
  return text;
}
