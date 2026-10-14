// Estadísticas de un personaje como datos, para que los bonificadores de las tiradas los calcule el código y nunca la IA.
// Se guardan como propiedades de la nota del personaje en Obsidian, así se pueden revisar y corregir a mano.

export type Ability = "fue" | "des" | "con" | "int" | "sab" | "car";
export const ABILITIES: Ability[] = ["fue", "des", "con", "int", "sab", "car"];
export const ABILITY_LABEL: Record<Ability, string> = { fue: "FUE", des: "DES", con: "CON", int: "INT", sab: "SAB", car: "CAR" };

export const SKILLS: Record<string, Ability> = {
  Acrobacias: "des",
  Arcanos: "int",
  Atletismo: "fue",
  Engaño: "car",
  Historia: "int",
  Interpretación: "car",
  Intimidación: "car",
  Investigación: "int",
  "Juego de manos": "des",
  Medicina: "sab",
  Naturaleza: "int",
  Percepción: "sab",
  Perspicacia: "sab",
  Persuasión: "car",
  Religión: "int",
  Sigilo: "des",
  Supervivencia: "sab",
  "Trato con animales": "sab",
};
export const SKILL_NAMES = Object.keys(SKILLS);

export interface Attack {
  nombre: string;
  bono: number;
  dano: string;
}

export interface Stats {
  competencia: number;
  scores: Record<Ability, number>;
  /** Totales escritos en la ficha. Lo que no está se calcula (modificador, sin competencia). */
  salvaciones: Partial<Record<Ability, number>>;
  habilidades: Record<string, number>;
  ataques: Attack[];
  iniciativa?: number;
  ca?: number;
  hp_max?: number;
  /** CD de salvación y bonificador de ataque de conjuros, tal como están en la ficha. */
  conjuros?: { cd?: number; ataque?: number };
}

export const mod = (score: number) => Math.floor((score - 10) / 2);
export const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function int(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/\s/g, ""), 10);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function abilityKey(raw: string): Ability | undefined {
  const k = norm(raw).slice(0, 3);
  const alias: Record<string, Ability> = { fue: "fue", str: "fue", des: "des", dex: "des", con: "con", int: "int", sab: "sab", wis: "sab", car: "car", cha: "car" };
  return alias[k];
}

// Otras formas en que las fichas nombran las habilidades (verbos, traducciones viejas, inglés).
const SKILL_ALIASES: Record<string, string> = {
  enganar: "Engaño",
  engano: "Engaño",
  deception: "Engaño",
  interpretar: "Interpretación",
  actuacion: "Interpretación",
  performance: "Interpretación",
  intimidar: "Intimidación",
  intimidation: "Intimidación",
  investigar: "Investigación",
  investigation: "Investigación",
  percibir: "Percepción",
  perception: "Percepción",
  persuadir: "Persuasión",
  persuasion: "Persuasión",
  "conocimiento arcano": "Arcanos",
  arcana: "Arcanos",
  "manejo de animales": "Trato con animales",
  "trato animal": "Trato con animales",
  "animal handling": "Trato con animales",
  "juegos de manos": "Juego de manos",
  "sleight of hand": "Juego de manos",
  athletics: "Atletismo",
  acrobatics: "Acrobacias",
  stealth: "Sigilo",
  insight: "Perspicacia",
  medicine: "Medicina",
  nature: "Naturaleza",
  religion: "Religión",
  history: "Historia",
  survival: "Supervivencia",
};

export function skillKey(raw: string): string | undefined {
  const n = norm(raw);
  return SKILL_NAMES.find((s) => norm(s) === n) ?? SKILL_ALIASES[n] ?? SKILL_NAMES.find((s) => n.startsWith(norm(s))) ?? Object.entries(SKILL_ALIASES).find(([a]) => n.startsWith(a))?.[1];
}

/** "Atletismo +5" / "Espada larga +5 · 1d8+3" → nombre, número y resto. */
function parseEntry(line: string): { name: string; value: number; rest: string } | null {
  const m = /^(.+?)\s*([+-]\s?\d+)\s*(?:[·,|;]\s*(.*))?$/.exec(String(line).trim());
  if (!m) return null;
  return { name: m[1].replace(/[:\s]+$/, "").trim(), value: parseInt(m[2].replace(/\s/g, ""), 10), rest: (m[3] ?? "").trim() };
}

const DICE_RE = /\d*d\d+(?:\s*[+-]\s*\d+)?/i;

// ---------- propiedades de Obsidian ----------

/** Estadísticas → propiedades planas, fáciles de editar en Obsidian. */
export function statsToProps(s: Stats): Record<string, unknown> {
  const props: Record<string, unknown> = { competencia: s.competencia };
  for (const a of ABILITIES) props[a] = s.scores[a];
  if (s.ca != null) props.ca = s.ca;
  if (s.hp_max != null) props.hp_max = s.hp_max;
  if (s.iniciativa != null) props.iniciativa = s.iniciativa;
  props.salvaciones = ABILITIES.filter((a) => s.salvaciones[a] != null).map((a) => `${ABILITY_LABEL[a]} ${signed(s.salvaciones[a]!)}`);
  props.habilidades = Object.entries(s.habilidades).map(([k, v]) => `${k} ${signed(v)}`);
  props.ataques = s.ataques.map((a) => `${a.nombre} ${signed(a.bono)}${a.dano ? ` · ${a.dano}` : ""}`);
  if (s.conjuros?.cd != null) props.cd_conjuros = s.conjuros.cd;
  if (s.conjuros?.ataque != null) props.ataque_conjuros = s.conjuros.ataque;
  return props;
}

export const STAT_PROPS = ["competencia", ...ABILITIES, "ca", "hp_max", "iniciativa", "salvaciones", "habilidades", "ataques", "cd_conjuros", "ataque_conjuros"];

/** Propiedades de la nota → estadísticas. Devuelve null si faltan las características (no hay con qué calcular). */
export function statsFromProps(meta: Record<string, unknown>): Stats | null {
  const scores = {} as Record<Ability, number>;
  for (const a of ABILITIES) {
    const v = int(meta[a]);
    if (v == null || v < 1 || v > 30) return null;
    scores[a] = v;
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
  const salvaciones: Partial<Record<Ability, number>> = {};
  for (const e of list(meta.salvaciones).map(parseEntry)) {
    const k = e && abilityKey(e.name);
    if (e && k) salvaciones[k] = e.value;
  }
  const habilidades: Record<string, number> = {};
  for (const e of list(meta.habilidades).map(parseEntry)) {
    const k = e && skillKey(e.name);
    if (e && k) habilidades[k] = e.value;
  }
  const ataques: Attack[] = [];
  for (const e of list(meta.ataques).map(parseEntry)) {
    if (e) ataques.push({ nombre: e.name, bono: e.value, dano: (DICE_RE.exec(e.rest)?.[0] ?? "").replace(/\s+/g, "") });
  }
  return {
    competencia: int(meta.competencia) ?? 2,
    scores,
    salvaciones,
    habilidades,
    ataques,
    iniciativa: int(meta.iniciativa),
    ca: int(meta.ca),
    hp_max: int(meta.hp_max),
    ...(int(meta.cd_conjuros) != null || int(meta.ataque_conjuros) != null ? { conjuros: { cd: int(meta.cd_conjuros), ataque: int(meta.ataque_conjuros) } } : {}),
  };
}

// ---------- lo que devuelve la IA al importar ----------

/**
 * Normaliza las estadísticas que extrajo la IA de la ficha. Los modificadores se recalculan desde las puntuaciones
 * (nunca se usan los de la IA) y se avisa si un total de la ficha no cuadra con modificador + competencia.
 */
export function statsFromImport(raw: unknown, nivel?: number): { stats: Stats | null; warnings: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const car = (r.caracteristicas ?? {}) as Record<string, unknown>;
  const scores = {} as Record<Ability, number>;
  for (const [k, v] of Object.entries(car)) {
    const a = abilityKey(k);
    const n = int(v);
    if (a && n != null && n >= 1 && n <= 30) scores[a] = n;
  }
  const missing = ABILITIES.filter((a) => scores[a] == null);
  if (missing.length) {
    return { stats: null, warnings: [`No encontré las puntuaciones de ${missing.map((a) => ABILITY_LABEL[a]).join(", ")}: sin eso no puedo calcular bonificadores.`] };
  }

  const fromLevel = nivel ? 2 + Math.floor((Math.min(20, Math.max(1, nivel)) - 1) / 4) : undefined;
  const competencia = int(r.competencia) ?? fromLevel ?? 2;
  const warnings: string[] = [];
  if (int(r.competencia) == null) warnings.push(`La ficha no dice el bonificador de competencia: uso ${signed(competencia)}${fromLevel ? " (por nivel)" : ""}.`);

  const salvaciones: Partial<Record<Ability, number>> = {};
  for (const [k, v] of Object.entries((r.salvaciones ?? {}) as Record<string, unknown>)) {
    const a = abilityKey(k);
    const n = int(v);
    if (!a || n == null) continue;
    salvaciones[a] = n;
    const m = mod(scores[a]);
    if (n !== m && n !== m + competencia) warnings.push(`Salvación de ${ABILITY_LABEL[a]} ${signed(n)} no cuadra con ${ABILITY_LABEL[a]} ${signed(m)} y competencia ${signed(competencia)}.`);
  }

  const habilidades: Record<string, number> = {};
  for (const [k, v] of Object.entries((r.habilidades ?? {}) as Record<string, unknown>)) {
    const s = skillKey(k);
    const n = int(v);
    if (!s || n == null) continue;
    habilidades[s] = n;
    const m = mod(scores[SKILLS[s]]);
    if (![m, m + competencia, m + 2 * competencia, m + Math.floor(competencia / 2)].includes(n)) {
      warnings.push(`${s} ${signed(n)} no cuadra con ${ABILITY_LABEL[SKILLS[s]]} ${signed(m)} y competencia ${signed(competencia)}.`);
    }
  }

  const ataques: Attack[] = [];
  for (const a of Array.isArray(r.ataques) ? r.ataques : []) {
    const nombre = String(a?.nombre ?? "").trim().slice(0, 40);
    const bono = int(a?.bono);
    if (!nombre || bono == null) continue;
    const dano = (DICE_RE.exec(String(a?.dano ?? ""))?.[0] ?? "").replace(/\s+/g, "");
    ataques.push({ nombre, bono, dano });
    const options = [mod(scores.fue), mod(scores.des), mod(scores.int), mod(scores.sab), mod(scores.car)].map((m) => m + competencia);
    if (!options.includes(bono)) warnings.push(`El ataque con ${nombre} ${signed(bono)} no cuadra con tus modificadores + competencia (¿arma mágica?).`);
  }

  return {
    stats: {
      competencia,
      scores,
      salvaciones,
      habilidades,
      ataques,
      iniciativa: int(r.iniciativa),
      ca: int(r.ca),
      hp_max: int(r.hp_max),
      ...(int(r.cd_conjuros) != null || int(r.ataque_conjuros) != null ? { conjuros: { cd: int(r.cd_conjuros), ataque: int(r.ataque_conjuros) } } : {}),
    },
    warnings,
  };
}

// ---------- bonificador de una tirada ----------

export type Check =
  | { categoria: "habilidad"; habilidad: string }
  | { categoria: "salvacion" | "caracteristica"; caracteristica: Ability }
  | { categoria: "ataque"; arma: string }
  | { categoria: "iniciativa" };

export interface Bonus {
  value: number;
  /** De dónde sale el número, para mostrarlo en la tirada. */
  source: string;
  dano?: string;
  /** Nombre del arma tal como figura en la ficha. */
  arma?: string;
}

export function checkLabel(c: Check, arma?: string): string {
  switch (c.categoria) {
    case "habilidad":
      return c.habilidad;
    case "salvacion":
      return `Salvación de ${ABILITY_LABEL[c.caracteristica]}`;
    case "caracteristica":
      return `Prueba de ${ABILITY_LABEL[c.caracteristica]}`;
    case "ataque":
      return `Ataque con ${arma ?? c.arma}`;
    case "iniciativa":
      return "Iniciativa";
  }
}

function findAttack(s: Stats, arma: string): Attack | undefined {
  const n = norm(arma);
  if (!n) return s.ataques.length === 1 ? s.ataques[0] : undefined;
  return (
    s.ataques.find((a) => norm(a.nombre) === n) ??
    s.ataques.find((a) => norm(a.nombre).includes(n) || n.includes(norm(a.nombre))) ??
    s.ataques.find((a) => norm(a.nombre).split(" ")[0] === n.split(" ")[0])
  );
}

/** Calcula el bonificador exacto de una tirada a partir de las estadísticas. Nunca adivina: si no sabe, lo dice. */
export function bonusFor(s: Stats, c: Check): Bonus {
  const m = (a: Ability) => mod(s.scores[a]);
  const L = ABILITY_LABEL;
  switch (c.categoria) {
    case "habilidad": {
      const ab = SKILLS[c.habilidad];
      if (s.habilidades[c.habilidad] != null) return { value: s.habilidades[c.habilidad], source: `${c.habilidad} ${signed(s.habilidades[c.habilidad])} según tu ficha` };
      return { value: m(ab), source: `${L[ab]} ${signed(m(ab))}, sin competencia` };
    }
    case "salvacion": {
      const a = c.caracteristica;
      if (s.salvaciones[a] != null) return { value: s.salvaciones[a]!, source: `salvación de ${L[a]} ${signed(s.salvaciones[a]!)} según tu ficha` };
      return { value: m(a), source: `${L[a]} ${signed(m(a))}, sin competencia` };
    }
    case "caracteristica":
      return { value: m(c.caracteristica), source: `${L[c.caracteristica]} ${signed(m(c.caracteristica))}` };
    case "iniciativa":
      return s.iniciativa != null ? { value: s.iniciativa, source: `iniciativa ${signed(s.iniciativa)} según tu ficha` } : { value: m("des"), source: `DES ${signed(m("des"))}` };
    case "ataque": {
      const atk = findAttack(s, c.arma);
      if (atk) return { value: atk.bono, source: `${atk.nombre} ${signed(atk.bono)} según tu ficha`, dano: atk.dano, arma: atk.nombre };
      const v = m("fue") + s.competencia;
      return { value: v, source: `⚠️ «${c.arma || "esa arma"}» no está en tu ficha: FUE ${signed(m("fue"))} + competencia ${signed(s.competencia)}` };
    }
  }
}

/** Expresión de dados con ventaja/desventaja y el bonificador. */
export function d20(bonus: number, ventaja: "normal" | "ventaja" | "desventaja"): string {
  const base = ventaja === "ventaja" ? "2d20kh1" : ventaja === "desventaja" ? "2d20kl1" : "1d20";
  return bonus === 0 ? base : `${base}${signed(bonus)}`;
}

/** Resumen legible para /ficha: todos los números que va a usar el bot. */
export function statsSummary(s: Stats): string {
  const L = ABILITY_LABEL;
  const lines = [
    ABILITIES.map((a) => `${L[a]} ${s.scores[a]} (${signed(mod(s.scores[a]))})`).join(" · "),
    `Competencia ${signed(s.competencia)}${s.ca != null ? ` · CA ${s.ca}` : ""}${s.hp_max != null ? ` · HP ${s.hp_max}` : ""} · Iniciativa ${signed(s.iniciativa ?? mod(s.scores.des))}`,
    `Salvaciones: ${ABILITIES.map((a) => `${L[a]} ${signed(s.salvaciones[a] ?? mod(s.scores[a]))}`).join(" ")}`,
    `Habilidades: ${SKILL_NAMES.map((k) => `${k} ${signed(s.habilidades[k] ?? mod(s.scores[SKILLS[k]]))}`).join(", ")}`,
    `Ataques: ${s.ataques.length ? s.ataques.map((a) => `${a.nombre} ${signed(a.bono)}${a.dano ? ` (${a.dano})` : ""}`).join(", ") : "ninguno en la ficha"}`,
  ];
  return lines.join("\n");
}
