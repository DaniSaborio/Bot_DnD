// Cliente de IA del DM. Todo es gratis:
//   - Google Gemini (GEMINI_API_KEY de https://aistudio.google.com/apikey, en un proyecto SIN facturación:
//     Google nunca cobra, al acabarse la cuota responde 429).
//   - Ollama (modelo local) como último respaldo cuando se acaba la cuota de Gemini.
//
// Cada tarea usa su propia cadena de modelos, para que la cuota del mejor modelo se gaste solo en narrar:
//   "narrar"  → GEMINI_MODEL       (por defecto 3.8 Flash, luego los Flash-Lite)
//   "liviano" → GEMINI_LIGHT_MODEL (resúmenes, /ooc, /importar, árbitro de respaldo)
import { callOllama, ollamaModel, type OllamaEnv } from "./ollama";
import { recordRequest, recordLimited, isCoolingDown } from "./quota";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AIEnv extends OllamaEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_LIGHT_MODEL?: string;
  GEMINI_THINKING?: string;
  /** "false" para no usar Ollama como respaldo cuando se acaba Gemini. */
  OLLAMA_FALLBACK?: string;
}

export type Task = "narrar" | "liviano";

// Todos tienen capa gratuita, cada uno con su propia cuota.
export const DEFAULT_MODELS: Record<Task, string> = {
  narrar: "gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite",
  liviano: "gemini-3.5-flash-lite,gemini-3.1-flash-lite",
};

// D&D tiene combates, monstruos y villanos: bloqueamos solo lo claramente dañino.
const SAFETY_SETTINGS = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"].map(
  (category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }),
);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

// Tiempo máximo por modelo: si uno se cuelga, se prueba el siguiente sin hacer esperar de más a los jugadores.
const TIMEOUT_MS = 40_000;

/** Error que permite pasar al respaldo local (sin cuota o sin conexión con Gemini). */
class FallbackError extends Error {}

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
export function modelList(env: AIEnv, task: Task): string[] {
  const raw = task === "narrar" ? env.GEMINI_MODEL : env.GEMINI_LIGHT_MODEL;
  const list = (raw || DEFAULT_MODELS[task]).split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS[task].split(",");
}

export async function callAI(
  env: AIEnv,
  task: Task,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  opts: { json?: boolean } = {},
): Promise<string> {
  try {
    return await callGemini(env, task, system, messages, maxTokens, opts);
  } catch (e) {
    if (!(e instanceof FallbackError) || env.OLLAMA_FALLBACK === "false") throw e;
    console.warn(`${e.message} → uso el modelo local ${ollamaModel(env)}`);
    try {
      recordRequest(`ollama:${ollamaModel(env)}`);
      return await callOllama(env, system, messages, maxTokens, { temperature: opts.json ? 0.2 : 0.8, ...(opts.json ? { schema: "json" as const } : {}) });
    } catch (local) {
      throw new Error(`${e.message} El respaldo local tampoco respondió: ${(local as Error).message}.`);
    }
  }
}

async function callGemini(env: AIEnv, task: Task, system: string, messages: ChatMessage[], maxTokens: number, opts: { json?: boolean }): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new FallbackError("Falta GEMINI_API_KEY en .env.");
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

  const models = modelList(env, task);
  // Los modelos que se quedaron sin cuota hace menos de un minuto se saltean (salvo que no quede ninguno).
  const order = models.filter((m) => !isCoolingDown(m));
  let res: Response | undefined;
  let model = "";
  // Por qué falló el último modelo, para elegir el mensaje si fallan todos.
  let failure: "cuota" | "saturado" | "lento" | "red" | "" = "";

  const send = () =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY!, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  for (model of order.length ? order : models) {
    res = undefined;
    try {
      res = await send();
      // 503 = Google saturado: suele pasar en segundos, así que un reintento corto antes de bajar a un modelo peor.
      if (res.status === 503) {
        console.warn(`Gemini ${model}: saturado, reintento en 2 s`);
        await new Promise((r) => setTimeout(r, 2000));
        res = await send();
      }
    } catch (e) {
      const timeout = (e as Error).name === "TimeoutError";
      failure = timeout ? "lento" : "red";
      console.warn(`Gemini ${model}: ${timeout ? `no respondió en ${TIMEOUT_MS / 1000} s` : "error de conexión"}, probando el siguiente modelo`);
      continue;
    }
    if (res.status === 429) {
      recordLimited(model);
      failure = "cuota";
      console.warn(`Gemini ${model}: sin cuota, probando el siguiente modelo`);
      continue;
    }
    if (res.status >= 500) {
      failure = "saturado";
      console.warn(`Gemini ${model}: no disponible (${res.status}), probando el siguiente modelo`);
      continue;
    }
    // 404 = el modelo no está disponible para esta key. Probamos el siguiente.
    if (res.status === 404) {
      console.warn(`Gemini ${model}: no existe para esta key, probando el siguiente modelo`);
      continue;
    }
    recordRequest(model);
    failure = "";
    break;
  }

  if (failure || !res) {
    const why = {
      cuota: "Se acabó la cuota gratuita de Gemini.",
      saturado: "Gemini está saturado en este momento.",
      lento: "Gemini está tardando demasiado en responder.",
      red: "No pude conectarme con Gemini (¿sin internet?).",
      "": "Ningún modelo de Gemini está disponible para esta key.",
    }[failure];
    throw new FallbackError(why);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (res.status === 400 && /API key/i.test(text)) throw new Error("La GEMINI_API_KEY no es válida.");
    if (res.status === 404) throw new FallbackError("Ningún modelo de Gemini está disponible para esta key.");
    throw new Error(`Gemini respondió ${res.status}: ${text}`);
  }

  const data = (await res.json()) as GeminiResponse;
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
