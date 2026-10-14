// Árbitro de reglas: decide qué tiradas hacen falta antes de narrar. Corre en el modelo local (Ollama), gratis y sin
// cuota; si Ollama no responde, usa el modelo liviano de Gemini. Solo ve las fichas y la escena actual, no la historia.
// El modelo solo elige QUÉ se tira (habilidad, salvación, ataque) y la CD: el bonificador lo calcula el código con las
// estadísticas de la ficha, así una IA nunca puede equivocarse de número.
import { callAI, type AIEnv } from "./ai";
import { callOllama, ollamaModel } from "./ollama";
import { recordRequest } from "./quota";
import { ARBITER_SYSTEM, ENEMY_SYSTEM } from "./prompts";
import { rollDice } from "./dice";
import { casterNumbers, findSpell, spellDice, SPELLS, type SpellInfo, type SpellKind } from "./spells";
import { ABILITIES, SKILLS, SKILL_NAMES, bonusFor, checkLabel, d20, mod, norm, signed, type Ability, type Bonus, type Check } from "./stats";
import type { Player, RollRequest } from "./vault";

const CATEGORIES = ["habilidad", "salvacion", "caracteristica", "ataque", "iniciativa", "conjuro"] as const;
const ABILITY_ENUM = ["", "FUE", "DES", "CON", "INT", "SAB", "CAR"];

/** El formato de respuesta es cerrado: el modelo solo puede elegir de estas listas, nunca escribir números de dados. */
function schemaFor(players: Player[]) {
  return {
    type: "object",
    properties: {
      tiradas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            personaje: { type: "string", enum: players.map((p) => p.character) },
            categoria: { type: "string", enum: CATEGORIES },
            habilidad: { type: "string", enum: ["", ...SKILL_NAMES] },
            caracteristica: { type: "string", enum: ABILITY_ENUM },
            arma: { type: "string" },
            cd: { type: "integer" },
            ventaja: { type: "string", enum: ["normal", "ventaja", "desventaja"] },
            motivo: { type: "string" },
            conjuro: { type: "string" },
            nivel_espacio: { type: "integer" },
            tipo_conjuro: { type: "string", enum: ["", "ataque", "salvacion", "efecto"] },
            salvacion_conjuro: { type: "string", enum: ABILITY_ENUM },
            dados_conjuro: { type: "string" },
            bono_salvacion_objetivo: { type: "integer" },
            objetivo_indefenso: { type: "boolean" },
          },
          required: ["personaje", "categoria", "habilidad", "caracteristica", "arma", "cd", "ventaja", "motivo", "conjuro", "nivel_espacio", "tipo_conjuro", "salvacion_conjuro", "dados_conjuro", "bono_salvacion_objetivo", "objetivo_indefenso"],
        },
      },
      en_combate: { type: "boolean" },
    },
    required: ["en_combate", "tiradas"],
  };
}

const MAX_SCENE_CHARS = 1500;

export interface Arbitration {
  rolls: Omit<RollRequest, "id">[];
  /** Hay enemigos peleando: después de las tiradas de los jugadores, atacan ellos. */
  combat: boolean;
}

export async function arbitrate(env: AIEnv, players: Player[], lastNarration: string, actions: string[]): Promise<Arbitration> {
  if (!players.length || !actions.length) return { rolls: [], combat: false };
  const sheets = players.map(brief).join("\n");
  const scene = lastNarration.length > MAX_SCENE_CHARS ? "…" + lastNarration.slice(-MAX_SCENE_CHARS) : lastNarration;
  const prompt = `PERSONAJES:\n${sheets}\n\nESCENA ACTUAL:\n${scene || "(Comienzo de la escena.)"}\n\nACCIONES DECLARADAS:\n${actions.join("\n")}`;
  const messages = [{ role: "user" as const, content: prompt }];

  let raw: string;
  try {
    recordRequest(`ollama:${ollamaModel(env)}`);
    raw = await callOllama(env, ARBITER_SYSTEM, messages, 400, { schema: schemaFor(players), temperature: 0.2, timeoutMs: 45_000 });
  } catch (e) {
    console.warn(`Árbitro local: ${(e as Error).message} → uso Gemini`);
    const schemaHint = `\n\nFormato: {"en_combate": false, "tiradas": [{"personaje": "", "categoria": "habilidad", "habilidad": "Atletismo", "caracteristica": "", "arma": "", "cd": 15, "ventaja": "normal", "motivo": "", "conjuro": "", "nivel_espacio": 0, "tipo_conjuro": "", "salvacion_conjuro": "", "dados_conjuro": "", "bono_salvacion_objetivo": 0, "objetivo_indefenso": false}]}`;
    raw = await callAI(env, "liviano", ARBITER_SYSTEM + schemaHint, messages, 400, { json: true });
  }
  const result = validate(raw, players, actions);
  ensureRolls(result.rolls, players, actions, scene);
  if (result.rolls.some((r) => /^(Ataque|Conjuro)/.test(r.tipo))) result.combat = true;
  return result;
}

/**
 * Lo que el árbitro necesita saber de cada personaje, en pocas líneas. No van números: los pone el código, así que
 * mandarlos solo gastaría tokens. Con estadísticas: armas, competencias y rasgos; sin ellas, la ficha en texto.
 */
export function brief(p: Player): string {
  const head = `- ${p.character}${p.description ? ` — ${p.description}` : ""}`;
  if (!p.stats) return p.sheet ? `${head}\n${p.sheet.replace(/^/gm, "  ")}` : head;
  const s = p.stats;
  const lines = [head];
  if (s.ataques.length) lines.push(`  Armas: ${s.ataques.map((a) => a.nombre).join(", ")}`);
  const proficient = Object.keys(s.habilidades).filter((k) => s.habilidades[k] > mod(s.scores[SKILLS[k]]));
  if (proficient.length) lines.push(`  Competente en: ${proficient.join(", ")}`);
  if (p.state.inventario.length) lines.push(`  Consiguió en la campaña: ${p.state.inventario.join(", ")}`);
  if (p.state.condiciones.length) lines.push(`  Condiciones: ${p.state.condiciones.join(", ")}`);
  // Rasgos, conjuros y equipo ayudan a decidir (ej. herramientas de ladrón); las líneas de números no hacen falta.
  const extras = p.sheet
    .split("\n")
    .filter((l) => /rasgo|dote|conjuro|truco|equipo|herramienta|competencia con|idioma|subclase|clase/i.test(l) && !/\b(HP|CA)\b|\(\s*[+-]\d+\s*\)/.test(l))
    .map((l) => l.trim())
    .slice(0, 6);
  for (const l of extras) lines.push(`  ${l.replace(/^[-•]\s*/, "")}`);
  return lines.join("\n");
}

/** Lo que pidió el modelo → una tirada concreta, con el bonificador calculado por el código. */
function toCheck(t: Record<string, unknown>): Check | null {
  const cat = String(t.categoria ?? "");
  const ab = norm(String(t.caracteristica ?? "")).slice(0, 3) as Ability;
  if (cat === "habilidad") {
    const h = SKILL_NAMES.find((s) => norm(s) === norm(String(t.habilidad ?? "")));
    return h ? { categoria: "habilidad", habilidad: h } : null;
  }
  if (cat === "salvacion" || cat === "caracteristica") return ABILITIES.includes(ab) ? { categoria: cat, caracteristica: ab } : null;
  if (cat === "ataque") return { categoria: "ataque", arma: String(t.arma ?? "").trim().slice(0, 40) };
  if (cat === "iniciativa") return { categoria: "iniciativa" };
  return null;
}

function bonusForPlayer(player: Player, check: Check): Bonus {
  if (player.stats) return bonusFor(player.stats, check);
  // Ficha vieja o editada sin propiedades: buscamos el número escrito en el texto; si no está, no se inventa.
  const label = checkLabel(check);
  const fromText = player.sheet ? sheetBonus(player.sheet, label) : null;
  if (fromText != null) return { value: fromText, source: `${label} ${signed(fromText)} según el texto de tu ficha` };
  return { value: 0, source: player.sheet ? `⚠️ no encontré el bonificador de ${label} en tu ficha: tirá con /tirar y tu número` : "⚠️ sin ficha importada: tirá con /tirar y tu número" };
}

/**
 * Un conjuro se resuelve según su tipo (ataque, salvación del objetivo o dados de efecto). Si está en la tabla del
 * Manual del Jugador, los dados y la salvación salen de ahí; si no, de lo que indicó el árbitro. La CD y el ataque
 * del lanzador siempre los calcula el código.
 */
function spellRequest(player: Player, t: Record<string, any>): Omit<RollRequest, "id"> | null {
  const name = String(t.conjuro ?? "").trim().slice(0, 60);
  if (!name) return null;
  const known = findSpell(name);
  const caster = casterNumbers(player.stats, player.sheet, player.description);
  const tipo: SpellKind | undefined = known?.tipo ?? (["ataque", "salvacion", "efecto"].includes(t.tipo_conjuro) ? t.tipo_conjuro : undefined);
  if (!tipo) return null;

  const nivelBase = known?.nivel ?? Math.max(0, Math.min(9, Number(t.nivel_espacio) || 1));
  const slot = nivelBase === 0 ? 0 : Math.max(nivelBase, Math.min(9, Number(t.nivel_espacio) || nivelBase));
  const castMod = caster?.caracteristica && player.stats ? mod(player.stats.scores[caster.caracteristica]) : 0;
  const info: SpellInfo = known ?? {
    nombre: name,
    nivel: nivelBase,
    tipo,
    salvacion: norm(String(t.salvacion_conjuro ?? "")).slice(0, 3) as Ability,
    dados: /^\d*d\d+([+-]\d+)?$/i.test(String(t.dados_conjuro ?? "").replace(/\s+/g, "")) ? String(t.dados_conjuro).replace(/\s+/g, "") : "",
    mitad: false,
    alias: [],
  };
  const dice = spellDice(info, slot, caster?.nivel ?? 1, castMod);
  const ventaja = t.ventaja === "ventaja" || t.ventaja === "desventaja" ? t.ventaja : "normal";

  // ¿Lo tiene en su ficha? Si la ficha lista conjuros y este no está, se avisa (no se bloquea: puede ser un pergamino).
  const sheetSpells = norm(player.sheet.split("\n").filter((l) => /conjuro|truco|hechizo/i.test(l)).join(" "));
  const listed = !sheetSpells || [info.nombre, ...info.alias].some((a) => sheetSpells.includes(norm(a)));
  const notes = [
    !caster ? "⚠️ no encontré tu CD ni tu ataque de conjuros en la ficha" : `CD ${caster.cd} · ataque ${signed(caster.ataque)} (${caster.source})`,
    known ? "" : "⚠️ conjuro fuera de la tabla del bot: tipo y dados según el árbitro",
    listed ? "" : `⚠️ ${info.nombre} no figura en tu ficha`,
    slot > nivelBase ? `lanzado con espacio de nivel ${slot}` : "",
  ].filter(Boolean);

  const base = {
    user_id: player.user_id,
    character: player.character,
    tipo: `Conjuro: ${info.nombre}`,
    motivo: String(t.motivo ?? "").trim().slice(0, 120),
    fuente: notes.join(" · "),
  };
  if (tipo === "ataque") {
    return { ...base, dados: d20(caster?.ataque ?? 0, ventaja), cd: Math.min(30, Math.max(5, Math.round(Number(t.cd) || 12))), dano: dice, conjuro: { tipo, nivel: slot } };
  }
  if (tipo === "salvacion") {
    const ab = info.salvacion && ABILITIES.includes(info.salvacion) ? info.salvacion : "sab";
    const targetBonus = Math.max(-5, Math.min(15, Math.round(Number(t.bono_salvacion_objetivo) || 0)));
    return {
      ...base,
      dados: d20(targetBonus, "normal"),
      cd: caster?.cd ?? 10,
      dano: dice,
      conjuro: { tipo, nivel: slot, salvacion: ab, mitad: !!info.mitad, efecto: info.efecto },
    };
  }
  return { ...base, dados: dice || "0", cd: 0, dano: "", conjuro: { tipo, nivel: slot, curacion: !!info.curacion, efecto: info.efecto } };
}

const alreadyRolled = (p: Player, actions: string[]) => actions.some((a) => a.startsWith(`${p.character} tira `) || a.startsWith(`${p.character} lanza `));

function validate(raw: string, players: Player[], actions: string[] = []): Arbitration {
  let data: { tiradas?: unknown; en_combate?: unknown };
  try {
    data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    console.warn("El árbitro devolvió algo que no es JSON:", raw.slice(0, 200));
    return { rolls: [], combat: false };
  }
  const out: Omit<RollRequest, "id">[] = [];
  for (const t of Array.isArray(data.tiradas) ? data.tiradas : []) {
    if (!t || typeof t !== "object") continue;
    const name = norm(String(t.personaje ?? ""));
    const player = players.find((p) => norm(p.character) === name) ?? players.find((p) => name && (norm(p.character).startsWith(name) || name.startsWith(norm(p.character))));
    if (!player || out.some((r) => r.user_id === player.user_id)) continue;
    if (alreadyRolled(player, actions)) continue;
    // Si la acción nombra un conjuro conocido ("le lanzo Burla dañina"), se resuelve como ese conjuro aunque el
    // modelo lo haya clasificado como otra cosa (pasó: pidió "Ataque con Estoque" para Burla dañina).
    const named = mentionedSpell(player, actions);
    if (named && (t.categoria !== "conjuro" || !findSpell(String(t.conjuro ?? "")))) {
      const r = spellRequest(player, { ...t, conjuro: named.nombre, nivel_espacio: Number(t.nivel_espacio) || named.nivel });
      if (r) out.push(r);
      continue;
    }
    if (t.categoria === "conjuro") {
      const spell = spellRequest(player, t);
      if (spell) out.push(spell);
      continue;
    }
    const check = toCheck(t);
    if (!check) continue;

    const bonus = bonusForPlayer(player, check);
    // Contra un objetivo dormido, inconsciente o paralizado: ventaja, y si pega cuerpo a cuerpo es crítico.
    const helpless = check.categoria === "ataque" && t.objetivo_indefenso === true;
    const ventaja = helpless ? "ventaja" : t.ventaja === "ventaja" || t.ventaja === "desventaja" ? t.ventaja : "normal";
    const meleeCrit = helpless && !RANGED.test(norm(bonus.arma ?? check.arma));
    out.push({
      user_id: player.user_id,
      character: player.character,
      tipo: checkLabel(check, bonus.arma),
      dados: d20(bonus.value, ventaja),
      cd: Math.min(30, Math.max(5, Math.round(Number(t.cd) || 15))),
      dano: check.categoria === "ataque" ? (bonus.dano ?? "") : "",
      motivo: String(t.motivo ?? "").trim().slice(0, 120),
      fuente: `${bonus.source}${ventaja !== "normal" ? ` · con ${ventaja}` : ""}${meleeCrit ? " · objetivo indefenso: si pega, es crítico" : ""}`,
      ...(meleeCrit ? { critico_auto: true } : {}),
    });
  }
  return { rolls: out, combat: data.en_combate === true };
}

const RANGED = /arco|ballesta|honda|dardo|jabalina|cerbatana|red\b|bow|crossbow|sling/;
const ATTACK_VERB = /\b(ataco|ataca|atacamos|golpeo|golpea|apunalo|apunala|acuchillo|corto|clavo|hiero|disparo|dispara|tiro una flecha|lanzo (?:mi|una|un) (?:daga|hacha|lanza|jabalina)|le doy (?:un|con)|ensarto|decapito|remato)\b/;
const HELPLESS = /dormid|inconscient|paralizad|indefens|atad[oa]s?\b|desmayad/;

/** Conjuro conocido que el jugador dice lanzar en su acción ("lanzo Dormir", "uso el conjuro sueño"). */
function mentionedSpell(player: Player, actions: string[]): SpellInfo | undefined {
  const text = actions
    .filter((a) => a.startsWith(`${player.character}:`))
    .map((a) => norm(a.slice(player.character.length + 1)))
    .join(" ");
  if (!/\b(lanzo|lanza|uso|usa|conjuro|invoco|canto|toco|hago|le tiro|le echo)\b/.test(text)) return undefined;
  return SPELLS.find((sp) => [sp.nombre, ...sp.alias].some((a) => new RegExp(`\\b${norm(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)));
}

/**
 * Red de seguridad: todo ataque y todo conjuro con tirada se tiran, aunque el modelo chico no los haya pedido
 * (por ejemplo, rematar a una criatura dormida igual lleva tirada de ataque, con ventaja).
 */
function ensureRolls(out: Omit<RollRequest, "id">[], players: Player[], actions: string[], scene: string) {
  const ac = Number(/\bCA\s*(\d{1,2})\b/.exec(scene)?.[1]) || 12;
  for (const player of players) {
    if (out.some((r) => r.user_id === player.user_id)) continue;
    // Ya tiró este turno ("Kael tira …" / "Kael lanza …"): no se le pide otra.
    if (actions.some((a) => a.startsWith(`${player.character} tira `) || a.startsWith(`${player.character} lanza `))) continue;
    const mine = actions.filter((a) => a.startsWith(`${player.character}:`)).map((a) => norm(a.slice(player.character.length + 1)));
    const text = mine.join(" ");
    if (!text) continue;
    const helpless = HELPLESS.test(norm(scene)) || HELPLESS.test(text);

    const spell = mentionedSpell(player, actions);
    if (spell) {
      const r = spellRequest(player, { conjuro: spell.nombre, nivel_espacio: spell.nivel, cd: ac, bono_salvacion_objetivo: 1, ventaja: helpless && spell.tipo === "ataque" ? "ventaja" : "normal", motivo: "" });
      if (r) out.push({ ...r, fuente: `${r.fuente} · ⚠️ el árbitro no la pidió: el bot la agregó` });
      continue;
    }
    if (!ATTACK_VERB.test(text) || !player.stats?.ataques.length) continue;
    const atk = player.stats.ataques.find((a) => text.includes(norm(a.nombre).split(" ")[0])) ?? player.stats.ataques[0];
    const melee = !RANGED.test(norm(atk.nombre));
    out.push({
      user_id: player.user_id,
      character: player.character,
      tipo: `Ataque con ${atk.nombre}`,
      dados: d20(atk.bono, helpless ? "ventaja" : "normal"),
      cd: ac,
      dano: atk.dano,
      motivo: "",
      fuente: `${atk.nombre} ${signed(atk.bono)} según tu ficha · ⚠️ el árbitro no la pidió: todo ataque lleva tirada (CA estimada ${ac})${helpless ? " · objetivo indefenso: con ventaja" + (melee ? ", y si pega es crítico" : "") : ""}`,
      ...(helpless && melee ? { critico_auto: true } : {}),
    });
  }
}

// ---------- bonificadores desde la ficha ----------
// Respaldo para fichas sin estadísticas en las propiedades: se busca el número escrito en el texto de la ficha.

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SKILL_ABILITY: Record<string, string> = {
  atletismo: "fue",
  acrobacias: "des",
  "juego de manos": "des",
  sigilo: "des",
  arcanos: "int",
  historia: "int",
  investigacion: "int",
  naturaleza: "int",
  religion: "int",
  "trato con animales": "sab",
  perspicacia: "sab",
  medicina: "sab",
  percepcion: "sab",
  supervivencia: "sab",
  engano: "car",
  intimidacion: "car",
  interpretacion: "car",
  persuasion: "car",
};

function firstNumber(text: string, re: RegExp): number | null {
  const m = re.exec(text);
  return m ? parseInt(m[1].replace(/\s/g, ""), 10) : null;
}

/** "FUE 16 (+3)" → 3 */
function abilityMod(sheet: string, ab: string): number | null {
  return firstNumber(sheet, new RegExp(`\\b${ab}\\w*\\s+\\d+\\s*\\(\\s*([+-]\\s?\\d+)\\s*\\)`));
}

export function sheetBonus(rawSheet: string, rawTipo: string): number | null {
  if (!rawSheet) return null;
  const sheet = norm(rawSheet);
  const tipo = norm(rawTipo);

  const attack = /^ataque (?:con|de) (?:(?:el|la|los|las|un|una|mi|su) )?(.+)$/.exec(tipo);
  if (attack) return firstNumber(sheet, new RegExp(`${esc(attack[1])}\\s*:?\\s*\\(?([+-]\\s?\\d+)`));

  const save = /^(?:tirada de )?salvacion(?:es)?(?: de)? (fue|des|con|int|sab|car)/.exec(tipo);
  if (save) {
    const line = sheet.split("\n").find((l) => l.includes("salvacion"));
    const own = line ? firstNumber(line, new RegExp(`\\b${save[1]}\\w*\\s*:?\\s*([+-]\\s?\\d+)`)) : null;
    return own ?? abilityMod(sheet, save[1]);
  }

  const skill = tipo.replace(/^(?:prueba|tirada) de /, "");
  const listed = firstNumber(sheet, new RegExp(`\\b${esc(skill)}\\s*:?\\s*\\(?([+-]\\s?\\d+)`));
  if (listed != null) return listed;
  const ab = SKILL_ABILITY[skill] ?? ABILITIES.find((a) => skill.startsWith(a));
  return ab ? abilityMod(sheet, ab) : null;
}

/** "1d20+3" + bonificador 5 → "1d20+5" (respeta ventaja/desventaja). */
export function withBonus(dados: string, bonus: number): string {
  const m = /^(\d*d20(?:k[hl]1)?)([+-]\d+)?$/i.exec(dados);
  if (!m) return dados;
  return bonus === 0 ? m[1] : `${m[1]}${bonus > 0 ? "+" : ""}${bonus}`;
}

// ---------- turno de los enemigos ----------

export interface EnemyAttack {
  /** Para el narrador. */
  plain: string;
  /** Para Discord. */
  display: string;
  target: string;
  damage: number;
}

const enemySchema = (players: Player[]) => ({
  type: "object",
  properties: {
    ataques: {
      type: "array",
      items: {
        type: "object",
        properties: {
          atacante: { type: "string" },
          objetivo: { type: "string", enum: players.map((p) => p.character) },
          arma: { type: "string" },
          bono: { type: "integer" },
          dano: { type: "string" },
          ventaja: { type: "string", enum: ["normal", "ventaja", "desventaja"] },
        },
        required: ["atacante", "objetivo", "arma", "bono", "dano", "ventaja"],
      },
    },
  },
  required: ["ataques"],
});

/** CA del personaje: la de las estadísticas o la escrita en la ficha. */
function armorClass(p: Player): number | null {
  return p.stats?.ca ?? (Number(/\bCA\s*:?\s*(\d{1,2})\b/.exec(p.sheet)?.[1]) || null);
}

/**
 * En combate, después de que los jugadores actúan: qué enemigos que siguen en pie atacan a quién. El modelo local solo
 * decide eso y estima el bonificador y el daño de cada enemigo (los números de los monstruos son cosa del DM); las
 * tiradas las hace el código contra la CA real de cada personaje.
 */
export async function enemyTurn(env: AIEnv, players: Player[], scene: string, turn: string[]): Promise<EnemyAttack[]> {
  if (!players.length) return [];
  const sheets = players.map((p) => `- ${p.character}${p.description ? ` — ${p.description}` : ""}${armorClass(p) ? ` (CA ${armorClass(p)})` : ""}`).join("\n");
  const prompt = `PERSONAJES JUGADORES:\n${sheets}\n\nESCENA ANTERIOR:\n${scene.slice(-MAX_SCENE_CHARS) || "(combate)"}\n\nLO QUE HICIERON LOS JUGADORES ESTE TURNO (ya resuelto):\n${turn.join("\n") || "(nada)"}`;
  let raw: string;
  try {
    recordRequest(`ollama:${ollamaModel(env)}`);
    raw = await callOllama(env, ENEMY_SYSTEM, [{ role: "user", content: prompt }], 400, { schema: enemySchema(players), temperature: 0.2, timeoutMs: 45_000 });
  } catch (e) {
    console.warn(`Turno enemigo local: ${(e as Error).message} → uso Gemini`);
    raw = await callAI(env, "liviano", ENEMY_SYSTEM + `\n\nFormato: {"ataques": [{"atacante": "", "objetivo": "", "arma": "", "bono": 3, "dano": "1d6+1", "ventaja": "normal"}]}`, [{ role: "user", content: prompt }], 400, { json: true });
  }
  let data: { ataques?: unknown };
  try {
    data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return [];
  }
  const out: EnemyAttack[] = [];
  for (const a of (Array.isArray(data.ataques) ? data.ataques : []).slice(0, 8)) {
    const target = players.find((p) => norm(p.character) === norm(String(a?.objetivo ?? "")));
    const ac = target && armorClass(target);
    if (!target || !ac) continue;
    const who = String(a.atacante ?? "Un enemigo").trim().slice(0, 40) || "Un enemigo";
    const weapon = String(a.arma ?? "").trim().slice(0, 30);
    const bono = Math.max(0, Math.min(12, Math.round(Number(a.bono) || 3)));
    const ventaja = a.ventaja === "ventaja" || a.ventaja === "desventaja" ? a.ventaja : "normal";
    const expr = d20(bono, ventaja);
    const roll = rollDice(expr);
    const nat20 = roll.note?.startsWith("¡20");
    const nat1 = roll.note?.startsWith("1 natural");
    const hit = nat20 || (!nat1 && roll.total >= ac);
    let dano = String(a.dano ?? "").replace(/\s+/g, "");
    try {
      rollDice(dano);
    } catch {
      dano = "1d6";
    }
    const damage = hit ? rollDice(nat20 ? dano.replace(/(\d*)d(\d+)/gi, (_, n, sd) => `${(Number(n) || 1) * 2}d${sd}`) : dano) : null;
    const dmg = Math.max(0, damage?.total ?? 0);
    const verdict = hit ? `impacta${nat20 ? " (¡crítico!)" : ""}, ${dmg} de daño` : "falla";
    out.push({
      target: target.character,
      damage: dmg,
      plain: `${who} ataca a ${target.character}${weapon ? ` con ${weapon}` : ""} ${expr}: ${roll.detail.replace(/~~/g, "")} = ${roll.total} vs CA ${ac} → ${verdict}`,
      display: `⚔️ **${who}** ataca a **${target.character}**${weapon ? ` con ${weapon}` : ""}: \`${expr}\` ${roll.detail} = **${roll.total}** vs CA ${ac} → ${hit ? `💥 **${dmg}** de daño${nat20 ? " **¡CRÍTICO!**" : ""}` : "🛡️ falla"}`,
    });
  }
  return out;
}
