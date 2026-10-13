// Cliente de IA del DM: API de Google Gemini (necesita GEMINI_API_KEY, gratis en https://aistudio.google.com/apikey).
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_THINKING?: string;
}

const DEFAULT_MODEL = "gemini-3.8-flash";

// D&D tiene combates, monstruos y villanos: bloqueamos solo lo claramente dañino.
const SAFETY_SETTINGS = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map(
  (category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }),
);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
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

export async function callAI(env: AIEnv, system: string, messages: ChatMessage[], maxTokens: number, opts: { json?: boolean } = {}): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY: wrangler secret put GEMINI_API_KEY");
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
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
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 429) throw new Error("Se alcanzó el límite de uso de Gemini. Esperen un minuto (o hasta mañana si es el límite diario) y prueben /narrar.");
    if (res.status === 400 && /API key/i.test(body)) throw new Error("La GEMINI_API_KEY no es válida.");
    throw new Error(`Gemini respondió ${res.status}: ${body}`);
  }

  const data = (await res.json()) as GeminiResponse;
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
