// Árbitro de reglas: decide qué tiradas hacen falta antes de narrar. Corre en el modelo local (Ollama), gratis y sin
// cuota; si Ollama no responde, usa el modelo liviano de Gemini. Solo ve las fichas y la escena actual, no la historia.
import { callAI, type AIEnv } from "./ai";
import { callOllama, ollamaModel } from "./ollama";
import { recordRequest } from "./quota";
import { rollDice } from "./dice";
import { ARBITER_SYSTEM } from "./prompts";
import type { Player, RollRequest } from "./vault";

const SCHEMA = {
  type: "object",
  properties: {
    tiradas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          personaje: { type: "string" },
          tipo: { type: "string" },
          dados: { type: "string" },
          cd: { type: "integer" },
          dano: { type: "string" },
          motivo: { type: "string" },
        },
        required: ["personaje", "tipo", "dados", "cd", "dano", "motivo"],
      },
    },
  },
  required: ["tiradas"],
};

const MAX_SCENE_CHARS = 1500;

export async function arbitrate(env: AIEnv, players: Player[], lastNarration: string, actions: string[]): Promise<Omit<RollRequest, "id">[]> {
  if (!players.length || !actions.length) return [];
  const sheets = players
    .map((p) => `- ${p.character}${p.description ? `: ${p.description}` : ""}${p.sheet ? `\n${p.sheet.replace(/^/gm, "  ")}` : ""}`)
    .join("\n");
  const scene = lastNarration.length > MAX_SCENE_CHARS ? "…" + lastNarration.slice(-MAX_SCENE_CHARS) : lastNarration;
  const prompt = `PERSONAJES:\n${sheets}\n\nESCENA ACTUAL:\n${scene || "(Comienzo de la escena.)"}\n\nACCIONES DECLARADAS:\n${actions.join("\n")}`;
  const messages = [{ role: "user" as const, content: prompt }];

  let raw: string;
  try {
    recordRequest(`ollama:${ollamaModel(env)}`);
    raw = await callOllama(env, ARBITER_SYSTEM, messages, 400, { schema: SCHEMA, temperature: 0.2, timeoutMs: 45_000 });
  } catch (e) {
    console.warn(`Árbitro local: ${(e as Error).message} → uso Gemini`);
    const schemaHint = `\n\nFormato: {"tiradas": [{"personaje": "", "tipo": "", "dados": "", "cd": 15, "dano": "", "motivo": ""}]}`;
    raw = await callAI(env, "liviano", ARBITER_SYSTEM + schemaHint, messages, 400, { json: true });
  }
  return validate(raw, players);
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
    const name = norm(String(t?.personaje ?? ""));
    const player = players.find((p) => norm(p.character) === name) ?? players.find((p) => name && (norm(p.character).startsWith(name) || name.startsWith(norm(p.character))));
    if (!player || out.some((r) => r.user_id === player.user_id)) continue;

    const tipo = String(t.tipo ?? "").trim().slice(0, 60);
    let dados = String(t.dados ?? "").replace(/\s+/g, "");
    if (!tipo || !isValidDice(dados)) continue;
    const bonus = sheetBonus(player.sheet, tipo);
    if (bonus != null) dados = withBonus(dados, bonus);

    const cd = Math.min(30, Math.max(5, Math.round(Number(t.cd) || 15)));
    const isAttack = /^ataque/i.test(tipo);
    const dano = isAttack && isValidDice(String(t.dano ?? "").replace(/\s+/g, "")) ? String(t.dano).replace(/\s+/g, "") : "";
    out.push({ user_id: player.user_id, character: player.character, tipo, dados, cd, dano, motivo: String(t.motivo ?? "").trim().slice(0, 120) });
  }
  return out;
}

function isValidDice(expr: string): boolean {
  if (!/d\d/i.test(expr)) return false;
  try {
    rollDice(expr);
    return true;
  } catch {
    return false;
  }
}

// ---------- bonificadores desde la ficha ----------
// El modelo chico a veces se equivoca de número: si la ficha tiene el bonificador escrito, manda la ficha.

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ABILITIES = ["fue", "des", "con", "int", "sab", "car"];
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
