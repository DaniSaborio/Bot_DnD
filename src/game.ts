import * as db from "./db";
import { callAI, type AIEnv } from "./ai";
import { dmSystemPrompt, oocSystemPrompt, SUMMARY_SYSTEM, SHEET_SYSTEM } from "./prompts";
import { fetchNivel20Sheet } from "./nivel20";
import { fetchPdfText, type DiscordAttachment } from "./pdf";

export interface GameEnv extends AIEnv {
  DB: D1Database;
}

const NARRATION_TOKENS = 900;
const COMPACT_AFTER = 30; // mensajes guardados antes de resumir
const COMPACT_CHUNK = 20; // cuántos de los más viejos se resumen

/** Toma las acciones pendientes, le pide la narración a la IA y guarda el turno. */
export async function runTurn(env: GameEnv, ch: string, instruction?: string): Promise<string> {
  const camp = await db.getCampaign(env.DB, ch);
  if (!camp) return "No hay campaña en este canal. Empiecen una con `/campaña`.";
  if (!(await db.tryLock(env.DB, ch))) return "⏳ El DM ya está narrando; esperen un momento.";

  try {
    const [pending, players, history] = await Promise.all([db.getPending(env.DB, ch), db.getPlayers(env.DB, ch), db.getMessages(env.DB, ch)]);

    const lines = pending.map((p) => p.content);
    if (!lines.length && !instruction) lines.push("(Los jugadores no declaran acciones nuevas. Continuá la escena.)");
    if (instruction) lines.push(`[Indicación para el DM: ${instruction}]`);
    const userBlock = lines.join("\n");

    const narration = await callAI(
      env,
      dmSystemPrompt(camp, players),
      [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: userBlock }],
      NARRATION_TOKENS,
    );

    const maxId = pending.length ? pending[pending.length - 1].id : 0;
    await db.commitTurn(env.DB, ch, userBlock, narration, maxId);
    return narration;
  } finally {
    await db.unlock(env.DB, ch);
  }
}

/** Pregunta fuera de personaje: usa el contexto pero no se guarda en la historia. */
export async function askOoc(env: GameEnv, ch: string, character: string, question: string): Promise<string> {
  const camp = await db.getCampaign(env.DB, ch);
  if (!camp) return "No hay campaña en este canal. Empiecen una con `/campaña`.";
  const [players, history] = await Promise.all([db.getPlayers(env.DB, ch), db.getMessages(env.DB, ch)]);
  const recent = history.slice(-6).map((m) => ({ role: m.role, content: m.content }));
  return callAI(env, oocSystemPrompt(camp, players), [...recent, { role: "user", content: `[Fuera de personaje] ${character} pregunta: ${question}` }], 600);
}

export interface ImportedSheet {
  character: string;
  description: string;
  sheet: string;
  url: string;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No pude interpretar la ficha");
  return JSON.parse(text.slice(start, end + 1));
}

export type SheetSource = { kind: "link"; link: string } | { kind: "pdf"; attachment: DiscordAttachment };

/** Lee una ficha (PDF adjunto o enlace de Nivel20), la resume con la IA y la guarda como el personaje del jugador. */
export async function importSheet(env: GameEnv, ch: string, userId: string, source: SheetSource): Promise<ImportedSheet> {
  let text: string;
  let origin: string;
  if (source.kind === "pdf") {
    text = await fetchPdfText(source.attachment);
    origin = `PDF: ${source.attachment.filename}`;
  } else {
    const page = await fetchNivel20Sheet(source.link);
    text = page.text;
    origin = page.url;
  }

  const raw = await callAI(env, SHEET_SYSTEM, [{ role: "user", content: `<ficha>\n${text}\n</ficha>` }], 1200, { json: true });

  let data: Record<string, unknown>;
  try {
    data = parseJsonObject(raw);
  } catch {
    throw new Error("No pude interpretar la ficha; probá de nuevo");
  }
  if (typeof data.error === "string") throw new Error(`Eso no parece una ficha: ${data.error}`);

  const character = String(data.nombre ?? "").trim().slice(0, 60);
  const description = String(data.resumen ?? "").trim().slice(0, 300);
  const sheet = String(data.ficha ?? "").trim().slice(0, 2000);
  if (!character || !sheet) throw new Error("La ficha llegó incompleta; revisá que sea la ficha de tu personaje");

  await db.savePlayerSheet(env.DB, ch, userId, character, description, sheet, origin);
  return { character, description, sheet, url: origin };
}

/** Cuando la historia crece, resume los mensajes más viejos en el resumen de la campaña. */
export async function maybeCompact(env: GameEnv, ch: string): Promise<void> {
  const history = await db.getMessages(env.DB, ch);
  if (history.length <= COMPACT_AFTER) return;
  if (!(await db.tryLock(env.DB, ch))) return;

  try {
    const old = history.slice(0, COMPACT_CHUNK);
    // Cortar después de una narración para que lo que queda empiece con un turno de jugadores.
    while (old.length && old[old.length - 1].role !== "assistant") old.pop();
    if (!old.length) return;

    const camp = await db.getCampaign(env.DB, ch);
    if (!camp) return;
    const transcript = old.map((m) => `${m.role === "user" ? "JUGADORES" : "DM"}: ${m.content}`).join("\n\n");
    const summary = await callAI(
      env,
      SUMMARY_SYSTEM,
      [{ role: "user", content: `RESUMEN PREVIO:\n${camp.summary || "(vacío)"}\n\nEVENTOS NUEVOS:\n${transcript}` }],
      1200,
    );
    await db.applyCompaction(env.DB, ch, summary, old[old.length - 1].id);
  } finally {
    await db.unlock(env.DB, ch);
  }
}
