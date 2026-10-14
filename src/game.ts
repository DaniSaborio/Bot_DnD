import * as db from "./vault";
import { callAI, modelList, type AIEnv } from "./ai";
import { arbitrate } from "./arbiter";
import { rollDice, type RollResult } from "./dice";
import { ollamaModel } from "./ollama";
import { usage, nextReset, parseLimits } from "./quota";
import { dmSystemPrompt, oocSystemPrompt, SUMMARY_SYSTEM, SHEET_SYSTEM } from "./prompts";
import { fetchNivel20Sheet } from "./nivel20";
import { fetchPdfText, type DiscordAttachment } from "./pdf";
import { statsFromImport, type Stats } from "./stats";
import { extractChanges, describeChanges } from "./changes";
import { extractNpcs, describeNpcs, npcContext } from "./npcs";
import { mergeStats } from "./sheetparse";

export interface GameEnv extends AIEnv {
  /** Límites diarios de la cuenta, como se ven en AI Studio: "gemini-3.8-flash=250,gemini-3.5-flash-lite=1000". */
  GEMINI_LIMITS?: string;
}

// Largo máximo de la narración según lo que pasó en el turno: lo trivial y los fallos comunes, cortos.
const LENGTH = {
  breve: { tokens: 300, hint: "breve: 1 a 3 oraciones, sin descripciones de relleno" },
  media: { tokens: 550, hint: "media: 1 o 2 párrafos cortos" },
  larga: { tokens: 900, hint: "larga: hasta 3 párrafos cortos, es un momento importante" },
} as const;

/** Decide cuánto texto merece el turno mirando las tiradas resueltas, sin gastar IA. */
export function turnLength(lines: string[], instruction?: string): keyof typeof LENGTH {
  if (instruction) return "larga";
  const text = lines.join("\n");
  if (/¡crítico!|20 natural|1 natural/.test(text)) return "larga";
  const rolls = lines.filter((l) => / vs CD \d+ → /.test(l));
  if (rolls.some((l) => / tira (Ataque|Conjuro)/.test(l)) || lines.some((l) => / lanza .+(\(nivel|\(truco)/.test(l))) return "media"; // combate o conjuros
  if (rolls.some((l) => /→ éxito/.test(l))) return "media";
  return "breve"; // sin tiradas (acciones triviales) o solo fallos comunes
}
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
    const [pending, rolls, players, history, npcs] = await Promise.all([db.getPending(ch), db.getRollRequests(ch), db.getPlayers(ch), db.getMessages(ch), db.getNpcs(ch)]);

    const lines = pending.map((p) => p.content);
    for (const r of rolls) lines.push(`(${r.character} no llegó a tirar ${r.tipo}.)`);
    if (!lines.length && !instruction) lines.push("(Los jugadores no declaran acciones nuevas. Continuá la escena.)");
    if (instruction) lines.push(`[Indicación para el DM: ${instruction}]`);
    const length = LENGTH[turnLength(lines, instruction)];
    const userBlock = lines.join("\n");

    const raw = await callAI(
      env,
      "narrar",
      dmSystemPrompt(camp, players, npcContext(npcs, [...history.slice(-4).map((m) => m.content), userBlock].join("\n"))),
      [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: `${userBlock}\n[Extensión: ${length.hint}]` }],
      length.tokens,
    );

    // Los bloques [cambios] y [npcs] no se publican: se escriben en las notas de Obsidian.
    const { text: narration, notes } = await record(ch, raw, players);
    const maxId = pending.length ? pending[pending.length - 1].id : 0;
    await db.commitTurn(ch, userBlock, narration, maxId);
    return notes ? `${narration}\n${notes}` : narration;
  } finally {
    await db.unlock(ch);
  }
}

/** Saca los bloques [cambios] y [npcs] de una respuesta, los guarda y devuelve el texto limpio y lo que se anotó. */
async function record(ch: string, raw: string, players: db.Player[]): Promise<{ text: string; notes: string }> {
  const items = extractChanges(raw, players.map((p) => p.character));
  const people = extractNpcs(items.text);
  const applied = items.changes.length ? await db.applyChanges(ch, items.changes) : [];
  const npcResults = people.updates.length ? await db.applyNpcUpdates(ch, people.updates) : [];
  const lines = [];
  if (applied.length) lines.push(`-# 📝 Anotado en la hoja: ${describeChanges(applied)}`);
  const npcLine = describeNpcs(npcResults);
  if (npcLine) lines.push(`-# 👥 ${npcLine}`);
  return { text: people.text, notes: lines.join("\n") };
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
  if (req.conjuro && req.conjuro.tipo !== "ataque") {
    const out = await resolveSpell(ch, userId, req, "rollId" in by ? null : by.manual);
    return { display: out, remaining: picked.remaining };
  }
  const expr = "rollId" in by ? req.dados : by.expr;
  const roll = "rollId" in by ? rollDice(req.dados) : by.manual;

  // Los ataques de conjuro funcionan como un ataque: 20 natural siempre pega (crítico) y 1 natural siempre falla.
  const isAttack = /^ataque/i.test(req.tipo) || req.conjuro?.tipo === "ataque";
  const nat20 = roll.note?.startsWith("¡20");
  const nat1 = roll.note?.startsWith("1 natural");
  const success = isAttack && nat20 ? true : isAttack && nat1 ? false : roll.total >= req.cd;
  const crit = isAttack && nat20;

  let damage: RollResult | null = null;
  if (isAttack && success && req.dano) damage = rollDice(crit ? doubleDice(req.dano) : req.dano);

  const verdict = success ? "éxito" : "fallo";
  const plain =
    `${req.character} tira ${req.tipo} ${expr}: ${roll.detail.replace(/~~/g, "")} = ${roll.total} vs CD ${req.cd} → ${verdict}` +
    (crit ? " (¡crítico!)" : roll.note ? ` (${roll.note.replace(/\.+$/, "")})` : "") +
    (damage ? `, daño ${damage.total}` : "") +
    (req.motivo ? ` [${req.motivo}]` : "");
  await db.addPending(ch, userId, plain);

  const display =
    `🎲 **${req.character}** tira ${req.tipo} \`${expr}\`: ${roll.detail} = **${roll.total}**${roll.note ? ` ${roll.note}` : ""} vs CD ${req.cd} → ` +
    (success ? "✅ éxito" : "❌ fallo") +
    (crit ? " **¡CRÍTICO!**" : "") +
    (damage ? ` · 💥 daño **${damage.total}** (${damage.detail})` : "") +
    ("rollId" in by && req.fuente ? `\n-# ${req.fuente}` : "");
  return { display, remaining: picked.remaining };
}

/**
 * Conjuros que no son de ataque. En los de salvación tira el OBJETIVO (el bot, con el bonificador que estimó el
 * árbitro) contra la CD del lanzador; en los de efecto se tiran solo los dados del efecto.
 */
async function resolveSpell(ch: string, userId: string, req: db.RollRequest, manual: RollResult | null): Promise<string> {
  const spell = req.conjuro!;
  const name = req.tipo.replace(/^Conjuro: /, "");
  const level = spell.nivel ? ` (nivel ${spell.nivel})` : " (truco)";
  const source = req.fuente ? `\n-# ${req.fuente}` : "";

  if (spell.tipo === "efecto") {
    // Con /tirar el jugador puede tirar él mismo los dados del efecto.
    const roll = manual ?? rollDice(req.dados);
    const what = spell.curacion ? "HP curados" : (spell.efecto ?? "");
    await db.addPending(ch, userId, `${req.character} lanza ${name}${level}: ${req.dados} = ${roll.total}${what ? ` ${what}` : ""}${req.motivo ? ` [${req.motivo}]` : ""}`);
    return `✨ **${req.character}** lanza **${name}**${level}: \`${req.dados}\` ${roll.detail} = **${roll.total}**${what ? ` ${what}` : ""}${source}`;
  }

  // Salvación: tira el objetivo.
  const save = rollDice(req.dados);
  const resisted = save.total >= req.cd;
  const ab = (spell.salvacion ?? "sab").toUpperCase();
  let damage: RollResult | null = null;
  let damageText = "";
  if (req.dano) {
    damage = rollDice(req.dano);
    if (!resisted) damageText = `${damage.total} de daño`;
    else if (spell.mitad) damageText = `${Math.floor(damage.total / 2)} de daño (la mitad)`;
  }
  const outcome = resisted ? (damageText ? "resiste en parte" : "resiste: el conjuro no le hace efecto") : `falla: ${damageText || spell.efecto || "el conjuro le hace efecto"}`;
  await db.addPending(
    ch,
    userId,
    `${req.character} lanza ${name}${level}: el objetivo tira salvación de ${ab} ${req.dados}: ${save.detail.replace(/~~/g, "")} = ${save.total} vs CD ${req.cd} → ${resisted ? "éxito del objetivo" : "fallo del objetivo"}` +
      `${damageText ? `, ${damageText}` : ""}${!resisted && spell.efecto ? ` (${spell.efecto})` : ""}${req.motivo ? ` [${req.motivo}]` : ""}`,
  );
  return (
    `✨ **${req.character}** lanza **${name}**${level}: el objetivo tira salvación de ${ab} \`${req.dados}\` ${save.detail} = **${save.total}** vs tu CD ${req.cd} → ` +
    (resisted ? `🛡️ ${outcome}` : `✅ ${outcome}`) +
    (damage ? ` · 💥 ${damage.detail} = ${damage.total}` : "") +
    source
  );
}

/** Pregunta fuera de personaje: usa el contexto pero no se guarda en la historia. */
export async function askOoc(env: GameEnv, ch: string, character: string, question: string): Promise<string> {
  const camp = await db.getCampaign(ch);
  if (!camp) return "No hay campaña en este canal. Empiecen una con `/campaña`.";
  const [players, history, npcs] = await Promise.all([db.getPlayers(ch), db.getMessages(ch), db.getNpcs(ch)]);
  const recent = history.slice(-4).map((m) => ({ role: m.role, content: m.content }));
  const context = npcContext(npcs, [...recent.map((m) => m.content), question].join("\n"), 15);
  const raw = await callAI(env, "liviano", oocSystemPrompt(camp, players, context), [...recent, { role: "user", content: `[Fuera de personaje] ${character} pregunta: ${question}` }], 600);
  // Si el jugador pidió anotar algo que pasó en la partida, se escribe en su hoja (o en la nota del PNJ).
  const { text, notes } = await record(ch, raw, players);
  return notes ? `${text}\n${notes}` : text;
}

export interface ImportedSheet {
  character: string;
  description: string;
  sheet: string;
  url: string;
  stats: Stats | null;
  /** Números que no cuadran o faltan: el jugador debería revisarlos en Obsidian. */
  warnings: string[];
  /** Números que la IA leyó mal y el lector en código corrigió. */
  corrected: string[];
  /** Cuántos números se leyeron directamente del texto, sin IA. */
  verified: number;
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

  // Los números que el código puede leer directamente del texto mandan; la IA solo completa lo que falte.
  const { merged, corrected, verified } = mergeStats(text, data.estadisticas);
  const { stats, warnings } = statsFromImport(merged, Number(data.nivel) || undefined);
  await db.savePlayerSheet(ch, userId, character, description, sheet, origin, stats);
  return { character, description, sheet, url: origin, stats, warnings, corrected, verified };
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
