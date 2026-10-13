import * as db from "./vault";
import { callAI, modelList, type AIEnv } from "./ai";
import { arbitrate } from "./arbiter";
import { rollDice, type RollResult } from "./dice";
import { ollamaModel } from "./ollama";
import { usage, nextReset, parseLimits } from "./quota";
import { dmSystemPrompt, oocSystemPrompt, SUMMARY_SYSTEM, SHEET_SYSTEM } from "./prompts";
import { fetchNivel20Sheet } from "./nivel20";
import { fetchPdfText, type DiscordAttachment } from "./pdf";

export interface GameEnv extends AIEnv {
  /** Límites diarios de la cuenta, como se ven en AI Studio: "gemini-3.8-flash=250,gemini-3.5-flash-lite=1000". */
  GEMINI_LIMITS?: string;
}

const NARRATION_TOKENS = 900;
// El narrador recibe el resumen + los mensajes todavía no resumidos. Cuando pasan de COMPACT_AFTER,
// se resumen todos menos los últimos KEEP_RECENT: así cada pedido queda chico aunque la campaña dure meses.
const COMPACT_AFTER = 16;
const KEEP_RECENT = 6;
const NARRATIONS_PER_HOUR = 35; // ritmo típico con 2 jugadores, para estimar horas de juego en /cuota

/** Toma las acciones pendientes (con sus tiradas ya resueltas), le pide la narración a la IA y guarda el turno. */
export async function runTurn(env: GameEnv, ch: string, instruction?: string): Promise<string> {
  const camp = await db.getCampaign(ch);
  if (!camp) return "No hay campaña en este canal. Empiecen una con `/campaña`.";
  if (!(await db.tryLock(ch))) return "⏳ El DM ya está narrando; esperen un momento.";

  try {
    const [pending, rolls, players, history] = await Promise.all([db.getPending(ch), db.getRollRequests(ch), db.getPlayers(ch), db.getMessages(ch)]);

    const lines = pending.map((p) => p.content);
    for (const r of rolls) lines.push(`(${r.character} no llegó a tirar ${r.tipo}.)`);
    if (!lines.length && !instruction) lines.push("(Los jugadores no declaran acciones nuevas. Continuá la escena.)");
    if (instruction) lines.push(`[Indicación para el DM: ${instruction}]`);
    const userBlock = lines.join("\n");

    const narration = await callAI(
      env,
      "narrar",
      dmSystemPrompt(camp, players),
      [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: userBlock }],
      NARRATION_TOKENS,
    );

    const maxId = pending.length ? pending[pending.length - 1].id : 0;
    await db.commitTurn(ch, userBlock, narration, maxId);
    return narration;
  } finally {
    await db.unlock(ch);
  }
}

export type Advance = { kind: "text"; text: string } | { kind: "rolls"; rolls: db.RollRequest[] };

/** Todos actuaron: el árbitro decide si hacen falta tiradas. Si no, se narra directamente. */
export async function advance(env: GameEnv, ch: string): Promise<Advance> {
  if (!(await db.getCampaign(ch))) return { kind: "text", text: "No hay campaña en este canal. Empiecen una con `/campaña`." };
  if (!(await db.tryLock(ch))) return { kind: "text", text: "⏳ El DM ya está narrando; esperen un momento." };
  try {
    const [pending, players, history] = await Promise.all([db.getPending(ch), db.getPlayers(ch), db.getMessages(ch)]);
    const lastNarration = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";
    let rolls: Awaited<ReturnType<typeof arbitrate>> = [];
    try {
      rolls = await arbitrate(env, players, lastNarration, pending.map((p) => p.content));
    } catch (e) {
      console.warn("El árbitro falló; narro sin pedir tiradas:", (e as Error).message);
    }
    if (rolls.length) return { kind: "rolls", rolls: await db.setRollRequests(ch, rolls) };
  } finally {
    await db.unlock(ch);
  }
  return { kind: "text", text: await runTurn(env, ch) };
}

export interface RollOutcome {
  /** Para mostrar en Discord. */
  display: string;
  remaining: db.RollRequest[];
}

const doubleDice = (expr: string) => expr.replace(/(\d*)d(\d+)/gi, (_, n, sides) => `${(Number(n) || 1) * 2}d${sides}`);

/**
 * Resuelve una tirada que pidió el árbitro: con el botón (tira el bot) o con /tirar (se usa ese resultado).
 * Compara con la CD, tira el daño si es un ataque que pega, y la deja como acción para el narrador.
 */
export async function resolveRoll(ch: string, userId: string, by: { rollId: number } | { manual: RollResult; expr: string }): Promise<RollOutcome | null> {
  const picked = await db.takeRollRequest(ch, (r) => r.user_id === userId && ("rollId" in by ? r.id === by.rollId : true));
  if (!picked) return null;
  const req = picked.taken;
  const expr = "rollId" in by ? req.dados : by.expr;
  const roll = "rollId" in by ? rollDice(req.dados) : by.manual;

  const isAttack = /^ataque/i.test(req.tipo);
  const nat20 = roll.note?.startsWith("¡20");
  const nat1 = roll.note?.startsWith("1 natural");
  const success = isAttack && nat20 ? true : isAttack && nat1 ? false : roll.total >= req.cd;
  const crit = isAttack && nat20;

  let damage: RollResult | null = null;
  if (isAttack && success && req.dano) damage = rollDice(crit ? doubleDice(req.dano) : req.dano);

  const verdict = success ? "éxito" : "fallo";
  const plain =
    `${req.character} tira ${req.tipo} ${expr}: ${roll.detail.replace(/~~/g, "")} = ${roll.total} vs CD ${req.cd} → ${verdict}` +
    (crit ? " (¡crítico!)" : "") +
    (damage ? `, daño ${damage.total}` : "") +
    (req.motivo ? ` [${req.motivo}]` : "");
  await db.addPending(ch, userId, plain);

  const display =
    `🎲 **${req.character}** tira ${req.tipo} \`${expr}\`: ${roll.detail} = **${roll.total}**${roll.note ? ` ${roll.note}` : ""} vs CD ${req.cd} → ` +
    (success ? "✅ éxito" : "❌ fallo") +
    (crit ? " **¡CRÍTICO!**" : "") +
    (damage ? ` · 💥 daño **${damage.total}** (${damage.detail})` : "");
  return { display, remaining: picked.remaining };
}

/** Pregunta fuera de personaje: usa el contexto pero no se guarda en la historia. */
export async function askOoc(env: GameEnv, ch: string, character: string, question: string): Promise<string> {
  const camp = await db.getCampaign(ch);
  if (!camp) return "No hay campaña en este canal. Empiecen una con `/campaña`.";
  const [players, history] = await Promise.all([db.getPlayers(ch), db.getMessages(ch)]);
  const recent = history.slice(-4).map((m) => ({ role: m.role, content: m.content }));
  return callAI(env, "liviano", oocSystemPrompt(camp, players), [...recent, { role: "user", content: `[Fuera de personaje] ${character} pregunta: ${question}` }], 600);
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

  const raw = await callAI(env, "liviano", SHEET_SYSTEM, [{ role: "user", content: `<ficha>\n${text}\n</ficha>` }], 1200, { json: true });

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

  await db.savePlayerSheet(ch, userId, character, description, sheet, origin);
  return { character, description, sheet, url: origin };
}

/** Cuando la historia crece, resume los mensajes más viejos en el resumen de la campaña. */
export async function maybeCompact(env: GameEnv, ch: string): Promise<void> {
  const history = await db.getMessages(ch);
  if (history.length <= COMPACT_AFTER) return;
  if (!(await db.tryLock(ch))) return;

  try {
    const old = history.slice(0, history.length - KEEP_RECENT);
    // Cortar después de una narración para que lo que queda empiece con un turno de jugadores.
    while (old.length && old[old.length - 1].role !== "assistant") old.pop();
    if (!old.length) return;

    const camp = await db.getCampaign(ch);
    if (!camp) return;
    const transcript = old.map((m) => `${m.role === "user" ? "JUGADORES" : "DM"}: ${m.content}`).join("\n\n");
    const summary = await callAI(
      env,
      "liviano",
      SUMMARY_SYSTEM,
      [{ role: "user", content: `RESUMEN PREVIO:\n${camp.summary || "(vacío)"}\n\nEVENTOS NUEVOS:\n${transcript}` }],
      1200,
    );
    await db.applyCompaction(ch, summary, old[old.length - 1].id);
  } finally {
    await db.unlock(ch);
  }
}

function hours(n: number): string {
  const mins = Math.round((n / NARRATIONS_PER_HOUR) * 60);
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

/** /cuota: pedidos de hoy por modelo y, si se configuraron los límites de la cuenta, cuánto queda. */
export function quotaReport(env: GameEnv): string {
  const { requests, limited } = usage();
  const limits = parseLimits(env.GEMINI_LIMITS);
  const reset = nextReset().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });

  const describe = (model: string, estimate: boolean) => {
    const used = requests[model] ?? 0;
    const limit = limits[model];
    if (!limit) return `\`${model}\` ${used}`;
    const left = Math.max(0, limit - used);
    return `\`${model}\` ${used}/${limit}${estimate ? ` (quedan ${left} ≈ ${hours(left)} de juego)` : ""}`;
  };

  const narrators = modelList(env, "narrar");
  const lines = [
    `📊 **Uso de IA de hoy** · la cuota de Gemini se reinicia a las **${reset}**`,
    `**Narrador:** ${narrators.map((m, i) => describe(m, i === 0)).join(" → ")}`,
    `**Liviano** (resúmenes, /ooc, /importar): ${modelList(env, "liviano").map((m) => describe(m, false)).join(" · ")}`,
    `**Local** (\`${ollamaModel(env)}\`, árbitro y respaldo): ${requests[`ollama:${ollamaModel(env)}`] ?? 0} pedidos · gratis y sin límite`,
  ];
  const exhausted = Object.entries(limited).filter(([, n]) => n > 0);
  if (exhausted.length) lines.push(`⚠️ Sin cuota en algún momento de hoy: ${exhausted.map(([m, n]) => `\`${m}\` (${n})`).join(", ")}`);
  if (!Object.keys(limits).length) lines.push("-# Para ver cuánto queda, poné los límites de tu cuenta (https://aistudio.google.com/rate-limit, columna RPD) en `GEMINI_LIMITS` del `.env`.");
  return lines.join("\n");
}
