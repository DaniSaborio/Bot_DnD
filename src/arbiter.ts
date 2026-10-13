// Árbitro de reglas: decide qué tiradas hacen falta antes de narrar. Corre en el modelo local (Ollama), gratis y sin
// cuota; si Ollama no responde, usa el modelo liviano de Gemini. Solo ve las fichas y la escena actual, no la historia.
// El modelo solo elige QUÉ se tira (habilidad, salvación, ataque) y la CD: el bonificador lo calcula el código con las
// estadísticas de la ficha, así una IA nunca puede equivocarse de número.
import { callAI, type AIEnv } from "./ai";
import { callOllama, ollamaModel } from "./ollama";
import { recordRequest } from "./quota";
import { ARBITER_SYSTEM } from "./prompts";
import { ABILITIES, SKILLS, SKILL_NAMES, bonusFor, checkLabel, d20, mod, norm, signed, type Ability, type Bonus, type Check } from "./stats";
import type { Player, RollRequest } from "./vault";

const CATEGORIES = ["habilidad", "salvacion", "caracteristica", "ataque", "iniciativa"] as const;
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
          },
          required: ["personaje", "categoria", "habilidad", "caracteristica", "arma", "cd", "ventaja", "motivo"],
        },
      },
    },
    required: ["tiradas"],
  };
}

const MAX_SCENE_CHARS = 1500;

export async function arbitrate(env: AIEnv, players: Player[], lastNarration: string, actions: string[]): Promise<Omit<RollRequest, "id">[]> {
  if (!players.length || !actions.length) return [];
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
    const schemaHint = `\n\nFormato: {"tiradas": [{"personaje": "", "categoria": "habilidad", "habilidad": "Atletismo", "caracteristica": "", "arma": "", "cd": 15, "ventaja": "normal", "motivo": ""}]}`;
    raw = await callAI(env, "liviano", ARBITER_SYSTEM + schemaHint, messages, 400, { json: true });
  }
  return validate(raw, players);
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

function validate(raw: string, players: Player[]): Omit<RollRequest, "id">[] {
  let data: { tiradas?: unknown };
  try {
    data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    console.warn("El árbitro devolvió algo que no es JSON:", raw.slice(0, 200));
    return [];
  }
  const out: Omit<RollRequest, "id">[] = [];
  for (const t of Array.isArray(data.tiradas) ? data.tiradas : []) {
    if (!t || typeof t !== "object") continue;
    const name = norm(String(t.personaje ?? ""));
    const player = players.find((p) => norm(p.character) === name) ?? players.find((p) => name && (norm(p.character).startsWith(name) || name.startsWith(norm(p.character))));
    if (!player || out.some((r) => r.user_id === player.user_id)) continue;
    const check = toCheck(t);
    if (!check) continue;

    const bonus = bonusForPlayer(player, check);
    const ventaja = t.ventaja === "ventaja" || t.ventaja === "desventaja" ? t.ventaja : "normal";
    out.push({
      user_id: player.user_id,
      character: player.character,
      tipo: checkLabel(check, bonus.arma),
      dados: d20(bonus.value, ventaja),
      cd: Math.min(30, Math.max(5, Math.round(Number(t.cd) || 15))),
      dano: check.categoria === "ataque" ? (bonus.dano ?? "") : "",
      motivo: String(t.motivo ?? "").trim().slice(0, 120),
      fuente: `${bonus.source}${ventaja !== "normal" ? ` · con ${ventaja}` : ""}`,
    });
  }
  return out;
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
