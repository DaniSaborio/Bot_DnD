// Cliente de Ollama (modelo local, gratis y sin límite). Se usa como árbitro de tiradas y como narrador de respaldo.
import type { ChatMessage } from "./ai";

export interface OllamaEnv {
  OLLAMA_URL?: string;
  OLLAMA_MODEL?: string;
}

export const DEFAULT_OLLAMA_MODEL = "gemma4:e4b";
// El contexto se fija en 8K para que el modelo y su memoria entren en una placa de video de 4 GB.
const NUM_CTX = 8192;
const MAX_PROMPT_CHARS = (NUM_CTX - 1500) * 3.5;

export function ollamaModel(env: OllamaEnv): string {
  return env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
}

/** Deja afuera los mensajes más viejos si no entran en el contexto del modelo local. */
function fit(system: string, messages: ChatMessage[]): ChatMessage[] {
  let budget = MAX_PROMPT_CHARS - system.length;
  const out: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    budget -= messages[i].content.length;
    if (budget < 0 && out.length) break;
    out.unshift(messages[i]);
  }
  return out;
}

export async function callOllama(
  env: OllamaEnv,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
  opts: { schema?: object | "json"; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const url = (env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${url}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
      body: JSON.stringify({
        model: ollamaModel(env),
        stream: false,
        think: false,
        keep_alive: -1, // el modelo queda cargado en la placa de video: no se pierden segundos cargándolo
        ...(opts.schema ? { format: opts.schema } : {}),
        options: { temperature: opts.temperature ?? 0.8, num_ctx: NUM_CTX, num_predict: maxTokens },
        messages: [{ role: "system", content: system }, ...fit(system, messages)],
      }),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError") throw new Error("Ollama tardó demasiado en responder");
    throw new Error("Ollama no está corriendo (ollama serve)");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: { content?: string } };
  if (!res.ok || data.error) throw new Error(`Ollama: ${data.error ?? res.status}`);
  const text = (data.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text) throw new Error("Ollama devolvió una respuesta vacía");
  return text;
}

/** Carga el modelo en la placa de video al arrancar el bot, así la primera tirada no espera la carga. */
export async function warmUp(env: OllamaEnv): Promise<boolean> {
  const url = (env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model: ollamaModel(env), keep_alive: -1 }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
