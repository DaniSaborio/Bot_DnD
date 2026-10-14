// Lector de fichas en código: saca los números exactos del texto del PDF sin IA, para que ningún modelo pueda correr
// un número de lugar. Lo que se lee acá manda sobre lo que extrajo la IA; la IA solo completa lo que el código no encontró.
import { ABILITIES, SKILLS, SKILL_NAMES, mod, norm, type Ability } from "./stats";

/** Mismo formato que devuelve la IA en "estadisticas", para poder combinarlos. */
export interface RawStats {
  caracteristicas: Partial<Record<Ability, number>>;
  competencia?: number;
  ca?: number;
  hp_max?: number;
  iniciativa?: number;
  cd_conjuros?: number;
  ataque_conjuros?: number;
  salvaciones: Partial<Record<Ability, number>>;
  habilidades: Record<string, number>;
  ataques: { nombre: string; bono: number; dano: string }[];
}

const ABILITY_WORDS: Record<Ability, string[]> = {
  fue: ["fuerza", "strength"],
  des: ["destreza", "dexterity"],
  con: ["constitucion", "constitution"],
  int: ["inteligencia", "intelligence"],
  sab: ["sabiduria", "wisdom"],
  car: ["carisma", "charisma"],
};

const SKILL_WORDS: Record<string, string[]> = {
  Acrobacias: ["acrobacias", "acrobatics"],
  Arcanos: ["arcanos", "arcana", "conocimiento arcano"],
  Atletismo: ["atletismo", "athletics"],
  Engaño: ["engano", "enganar", "deception"],
  Historia: ["historia", "history"],
  Interpretación: ["interpretacion", "interpretar", "performance"],
  Intimidación: ["intimidacion", "intimidar", "intimidation"],
  Investigación: ["investigacion", "investigation"],
  "Juego de manos": ["juego de manos", "sleight of hand"],
  Medicina: ["medicina", "medicine"],
  Naturaleza: ["naturaleza", "nature"],
  Percepción: ["percepcion", "perception"],
  Perspicacia: ["perspicacia", "insight"],
  Persuasión: ["persuasion"],
  Religión: ["religion"],
  Sigilo: ["sigilo", "stealth"],
  Supervivencia: ["supervivencia", "survival"],
  "Trato con animales": ["trato con animales", "animal handling"],
};

// Campos de la hoja oficial rellenable (también la que exporta D&D Beyond), comparados sin espacios ni mayúsculas.
const FIELD_ABILITY: Record<string, Ability> = { str: "fue", dex: "des", con: "con", int: "int", wis: "sab", cha: "car" };
const FIELD_SAVE: Record<string, Ability> = { ststrength: "fue", stdexterity: "des", stconstitution: "con", stintelligence: "int", stwisdom: "sab", stcharisma: "car" };
const FIELD_SKILL: Record<string, string> = {
  acrobatics: "Acrobacias",
  animal: "Trato con animales",
  animalhandling: "Trato con animales",
  arcana: "Arcanos",
  athletics: "Atletismo",
  deception: "Engaño",
  history: "Historia",
  insight: "Perspicacia",
  intimidation: "Intimidación",
  investigation: "Investigación",
  medicine: "Medicina",
  nature: "Naturaleza",
  perception: "Percepción",
  performance: "Interpretación",
  persuasion: "Persuasión",
  religion: "Religión",
  sleightofhand: "Juego de manos",
  stealth: "Sigilo",
  survival: "Supervivencia",
};

const signedInt = (s: string) => parseInt(s.replace(/\s/g, ""), 10);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function empty(): RawStats {
  return { caracteristicas: {}, salvaciones: {}, habilidades: {}, ataques: [] };
}

// ---------- campos de formulario ----------

function fromFormFields(text: string): RawStats {
  const out = empty();
  const start = text.indexOf("CAMPOS DEL FORMULARIO:");
  if (start < 0) return out;
  const weapons: Record<string, { nombre?: string; bono?: number; dano?: string }> = {};
  for (const line of text.slice(start).split("\n").slice(1)) {
    const m = /^(.+?)(?: \(.*\))?: (.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/[^a-z0-9]/g, "");
    const value = m[2].trim();
    const num = /^[+-]?\s?\d+$/.test(value) ? signedInt(value) : undefined;

    if (key in FIELD_ABILITY && num != null && num >= 1 && num <= 30) out.caracteristicas[FIELD_ABILITY[key]] = num;
    else if (key in FIELD_SAVE && num != null) out.salvaciones[FIELD_SAVE[key]] = num;
    else if (key in FIELD_SKILL && num != null) out.habilidades[FIELD_SKILL[key]] = num;
    else if (key === "profbonus" && num != null) out.competencia = num;
    else if (key === "ac" && num != null) out.ca = num;
    else if (key === "hpmax" && num != null) out.hp_max = num;
    else if (key === "initiative" && num != null) out.iniciativa = num;
    else if (key === "spellsavedc" && num != null) out.cd_conjuros = num;
    else if (key === "spellatkbonus" && num != null) out.ataque_conjuros = num;
    else {
      // Wpn Name / Wpn1 AtkBonus / Wpn1 Damage, Wpn Name 2 / Wpn2 AtkBonus ...
      const w = /^wpn(?:name)?(\d?)(atkbonus|damage|name)?(\d?)$/.exec(key);
      if (w) {
        const slot = w[1] || w[3] || "1";
        const field = w[2] ?? (key.startsWith("wpnname") ? "name" : "");
        const entry = (weapons[slot] ??= {});
        if (field === "name") entry.nombre = value;
        if (field === "atkbonus" && num != null) entry.bono = num;
        if (field === "damage") entry.dano = /\d*d\d+(?:\s*[+-]\s*\d+)?/i.exec(value)?.[0].replace(/\s+/g, "");
      }
    }
  }
  for (const w of Object.values(weapons)) if (w.nombre && w.bono != null) out.ataques.push({ nombre: w.nombre, bono: w.bono, dano: w.dano ?? "" });
  return out;
}

// ---------- texto suelto ----------

/** Puntuación de característica: número SIN signo (1-30) cerca del nombre; si tiene el modificador al lado, tiene que cuadrar. */
function abilityScores(t: string): Partial<Record<Ability, number>> {
  const out: Partial<Record<Ability, number>> = {};
  for (const a of ABILITIES) {
    const words = [...ABILITY_WORDS[a], a];
    for (const w of words) {
      const re = new RegExp(`\\b${esc(w)}\\b[^\\d+\\-\\n]{0,12}(?<![+-]\\s?)(\\d{1,2})(?!\\d)(?:\\s*\\(?\\s*([+-]\\s?\\d{1,2})\\s*\\)?)?`, "g");
      for (const m of t.matchAll(re)) {
        const score = parseInt(m[1], 10);
        if (score < 1 || score > 30) continue;
        if (m[2] != null && signedInt(m[2]) !== mod(score)) continue;
        // "con", "fue", "des"... también son palabras comunes: abreviadas solo valen con el modificador al lado.
        if (w === a && m[2] == null) continue;
        out[a] = score;
        break;
      }
      if (out[a] != null) break;
    }
  }
  return out;
}

/**
 * Bonificadores de una lista de nombres (habilidades o salvaciones). Cada ficha pone el número antes o después del
 * nombre: se prueban las dos lecturas y se queda la que cuadra con características + competencia en más casos.
 */
function signedList<K extends string>(
  section: string,
  words: Record<K, string[]>,
  expected: (k: K, v: number) => boolean,
): Partial<Record<K, number>> {
  const read = (after: boolean) => {
    const out: Partial<Record<K, number>> = {};
    for (const k of Object.keys(words) as K[]) {
      for (const w of words[k]) {
        const re = after
          ? new RegExp(`\\b${esc(w)}\\b[^\\d+\\-\\n]{0,6}([+-]\\s?\\d{1,2})(?!\\d)`)
          : new RegExp(`(?<![\\d])([+-]\\s?\\d{1,2})[^\\d+\\-\\n]{0,6}\\b${esc(w)}\\b`);
        const m = re.exec(section);
        if (m) {
          out[k] = signedInt(m[1]);
          break;
        }
      }
    }
    return out;
  };
  const score = (r: Partial<Record<K, number>>) => (Object.entries(r) as [K, number][]).filter(([k, v]) => expected(k, v)).length;
  const after = read(true);
  const before = read(false);
  const sa = score(after);
  const sb = score(before);
  if (sa === sb && sa === 0) return {};
  // Solo se confía en una lectura si cuadra claramente mejor que la otra (o es la única que encontró algo).
  if (sa > sb) return after;
  if (sb > sa) return before;
  return JSON.stringify(after) === JSON.stringify(before) ? after : {};
}

/** Recorta el texto desde un encabezado hasta el siguiente encabezado conocido. */
function sectionOf(t: string, headers: string[], enders: string[]): string {
  const start = headers.map((h) => t.search(new RegExp(`\\b${h}`))).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start == null) return "";
  const rest = t.slice(start);
  const end = enders.map((h) => rest.slice(10).search(new RegExp(`\\b${h}`))).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return end == null ? rest : rest.slice(0, end + 10);
}

function fromText(text: string): RawStats {
  const t = norm(text.split("CAMPOS DEL FORMULARIO:")[0]).replace(/[−–]/g, "-");
  const out = empty();
  out.caracteristicas = abilityScores(t);

  const num = (re: RegExp) => {
    const m = re.exec(t);
    return m ? signedInt(m[1]) : undefined;
  };
  out.competencia = num(/(?:bonificador (?:por|de) competencia|proficiency bonus|competencia)[^\d+\-\n]{0,6}\+?\s?(\d)\b/);
  out.ca = num(/(?:clase de armadura|armor class|\bca\b)[^\d\n]{0,6}(\d{1,2})\b/);
  out.hp_max = num(/(?:puntos de golpe maximos|hit point maximum|hp max(?:imo)?|pg max(?:imos)?)[^\d\n]{0,8}(\d{1,3})\b/);
  out.iniciativa = num(/(?:iniciativa|initiative)[^\d+\-\n]{0,6}([+-]\s?\d{1,2})\b/);
  out.cd_conjuros = num(/(?:cd de (?:salvacion de )?(?:los )?conjuros|cd de conjuros|spell save dc|conjuros?\s*\(?\s*cd)[^\d\n]{0,6}(\d{1,2})\b/);
  out.ataque_conjuros = num(/(?:(?:bonificador de )?ataque de (?:los )?conjuros|spell attack(?: bonus)?|conjuros?\s*\(?[^)\n]{0,12}?(?:atq|ataque))[^\d+\-\n]{0,6}([+-]\s?\d{1,2})\b/);

  const scores = out.caracteristicas;
  const prof = out.competencia;
  if (ABILITIES.every((a) => scores[a] != null) && prof != null) {
    const m = (a: Ability) => mod(scores[a]!);
    const skillsSection = sectionOf(t, ["habilidades", "skills"], ["ataques", "attacks", "competencias e idiomas", "rasgos", "features", "equipo", "equipment", "salvacion", "saving throws"]) || t;
    out.habilidades = signedList(skillsSection, SKILL_WORDS as Record<string, string[]>, (k, v) =>
      [m(SKILLS[k]), m(SKILLS[k]) + prof, m(SKILLS[k]) + 2 * prof, m(SKILLS[k]) + Math.floor(prof / 2)].includes(v),
    ) as Record<string, number>;
    const savesSection = sectionOf(t, ["tiradas de salvacion", "salvaciones", "saving throws"], ["habilidades", "skills", "ataques", "attacks", "rasgos", "features"]);
    // En la sección de salvaciones las abreviaturas (FUE +5) son seguras.
    const saveWords = Object.fromEntries(ABILITIES.map((a) => [a, [...ABILITY_WORDS[a], a, { fue: "str", des: "dex", con: "con", int: "int", sab: "wis", car: "cha" }[a]]])) as Record<Ability, string[]>;
    if (savesSection) out.salvaciones = signedList(savesSection, saveWords, (a, v) => v === m(a) || v === m(a) + prof);
  }
  return out;
}

export function parseSheet(text: string): RawStats {
  const form = fromFormFields(text);
  const loose = fromText(text);
  // Los campos de formulario son exactos; el texto suelto completa lo que falte.
  return {
    caracteristicas: { ...loose.caracteristicas, ...form.caracteristicas },
    competencia: form.competencia ?? loose.competencia,
    ca: form.ca ?? loose.ca,
    hp_max: form.hp_max ?? loose.hp_max,
    iniciativa: form.iniciativa ?? loose.iniciativa,
    cd_conjuros: form.cd_conjuros ?? loose.cd_conjuros,
    ataque_conjuros: form.ataque_conjuros ?? loose.ataque_conjuros,
    salvaciones: { ...loose.salvaciones, ...form.salvaciones },
    habilidades: { ...loose.habilidades, ...form.habilidades },
    ataques: form.ataques,
  };
}

/** Corrige con el texto el bonificador de cada ataque que leyó la IA ("Martillo de guerra +4"). */
function verifyAttacks(text: string, ataques: RawStats["ataques"]): RawStats["ataques"] {
  const t = norm(text).replace(/[−–]/g, "-");
  return ataques.map((a) => {
    const m = new RegExp(`${esc(norm(a.nombre))}[^\\d+\\-\\n]{0,6}([+-]\\s?\\d{1,2})(?!\\d)`).exec(t);
    return m ? { ...a, bono: signedInt(m[1]) } : a;
  });
}

/**
 * Combina lo que leyó el código (manda) con lo que leyó la IA (completa). Devuelve el resultado en el formato de
 * "estadisticas" y la lista de diferencias encontradas, para avisarle al jugador.
 */
export function mergeStats(text: string, ai: unknown): { merged: RawStats; corrected: string[]; verified: number } {
  const a = (ai && typeof ai === "object" ? ai : {}) as Partial<RawStats> & Record<string, any>;
  const code = parseSheet(text);
  const corrected: string[] = [];
  let verified = 0;

  const pick = <T extends number | undefined>(label: string, fromCode: T, fromAi: unknown): number | undefined => {
    const aiNum = typeof fromAi === "number" ? fromAi : fromAi != null && /^[+-]?\d+$/.test(String(fromAi).trim()) ? signedInt(String(fromAi)) : undefined;
    if (fromCode == null) return aiNum;
    verified++;
    if (aiNum != null && aiNum !== fromCode) corrected.push(`${label}: la IA leyó ${aiNum}, en la ficha dice ${fromCode}`);
    return fromCode;
  };
  const keyed = <K extends string>(obj: unknown, keyOf: (k: string) => K | undefined) => {
    const out: Partial<Record<K, unknown>> = {};
    for (const [k, v] of Object.entries((obj ?? {}) as Record<string, unknown>)) {
      const key = keyOf(k);
      if (key) out[key] = v;
    }
    return out;
  };
  const abilityOf = (k: string) => ABILITIES.find((x) => norm(k).startsWith(x) || ABILITY_WORDS[x].some((w) => norm(k) === w));
  const skillOf = (k: string) => SKILL_NAMES.find((s) => norm(s) === norm(k) || SKILL_WORDS[s].includes(norm(k)));

  const aiScores = keyed<Ability>(a.caracteristicas, abilityOf);
  const aiSaves = keyed<Ability>(a.salvaciones, abilityOf);
  const aiSkills = keyed<string>(a.habilidades, skillOf);

  const merged = empty();
  for (const x of ABILITIES) {
    const v = pick(x.toUpperCase(), code.caracteristicas[x], aiScores[x]);
    if (v != null) merged.caracteristicas[x] = v;
    const s = pick(`Salvación de ${x.toUpperCase()}`, code.salvaciones[x], aiSaves[x]);
    if (s != null) merged.salvaciones[x] = s;
  }
  for (const k of SKILL_NAMES) {
    const v = pick(k, code.habilidades[k], aiSkills[k]);
    if (v != null) merged.habilidades[k] = v;
  }
  merged.competencia = pick("Competencia", code.competencia, a.competencia);
  merged.ca = pick("CA", code.ca, a.ca);
  merged.hp_max = pick("HP máximos", code.hp_max, a.hp_max);
  merged.iniciativa = pick("Iniciativa", code.iniciativa, a.iniciativa);
  merged.cd_conjuros = pick("CD de conjuros", code.cd_conjuros, a.cd_conjuros);
  merged.ataque_conjuros = pick("Ataque de conjuros", code.ataque_conjuros, a.ataque_conjuros);

  const aiAttacks = (Array.isArray(a.ataques) ? a.ataques : []) as RawStats["ataques"];
  const attacks = code.ataques.length ? code.ataques : verifyAttacks(text, aiAttacks);
  for (const atk of attacks) {
    const before = aiAttacks.find((x) => norm(String(x?.nombre ?? "")) === norm(atk.nombre));
    if (before && Number(before.bono) !== atk.bono) corrected.push(`Ataque con ${atk.nombre}: la IA leyó ${before.bono}, en la ficha dice ${atk.bono}`);
  }
  merged.ataques = attacks;
  return { merged, corrected, verified };
}
