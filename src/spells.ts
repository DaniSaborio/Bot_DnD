// Conjuros: cómo se resuelve cada uno (D&D 5e, Manual del Jugador). No todos son 1d20:
//   ataque     → d20 + ataque de conjuro del lanzador contra la CA del objetivo (Rayo de fuego)
//   salvacion  → el OBJETIVO tira salvación contra la CD de conjuros del lanzador (Retener persona, Bola de fuego)
//   efecto     → se tiran los dados del efecto, sin d20 (Dormir, Proyectil mágico, Curar heridas)
// Los números del lanzador (CD y ataque) los calcula el código; esta tabla da los dados y la salvación de cada conjuro.
import { ABILITY_LABEL, mod, norm, signed, type Ability, type Stats } from "./stats";

export type SpellKind = "ataque" | "salvacion" | "efecto";

export interface SpellInfo {
  nombre: string;
  nivel: number; // 0 = truco
  tipo: SpellKind;
  salvacion?: Ability;
  /** Dados de daño o efecto al nivel base ("5d8", "3d4+3"). Vacío si el conjuro no hace daño (solo un efecto). */
  dados?: string;
  /** Dados extra por cada nivel de espacio por encima del base (o por nivel de personaje en los trucos). */
  escala?: string;
  /** Mitad de daño si el objetivo supera la salvación. */
  mitad?: boolean;
  /** Suma el modificador de la característica de lanzamiento (Curar heridas, Palabra de curación). */
  suma_mod?: boolean;
  curacion?: boolean;
  /** Qué representan los dados de efecto (Dormir: "puntos de golpe de criaturas que se duermen"). */
  efecto?: string;
  alias: string[];
}

const S = (nombre: string, nivel: number, tipo: SpellKind, extra: Partial<SpellInfo>, alias: string[] = []): SpellInfo => ({ nombre, nivel, tipo, ...extra, alias });

export const SPELLS: SpellInfo[] = [
  // Trucos
  S("Rayo de fuego", 0, "ataque", { dados: "1d10", escala: "1d10" }, ["fire bolt", "descarga de fuego"]),
  S("Rayo de escarcha", 0, "ataque", { dados: "1d8", escala: "1d8" }, ["ray of frost"]),
  S("Toque electrizante", 0, "ataque", { dados: "1d8", escala: "1d8" }, ["shocking grasp", "agarre electrizante"]),
  S("Descarga sobrenatural", 0, "ataque", { dados: "1d10", escala: "1d10" }, ["eldritch blast", "estallido sobrenatural", "explosion sobrenatural"]),
  S("Toque gélido", 0, "ataque", { dados: "1d8", escala: "1d8" }, ["chill touch", "toque helado"]),
  S("Producir llama", 0, "ataque", { dados: "1d8", escala: "1d8" }, ["produce flame"]),
  S("Látigo de espinas", 0, "ataque", { dados: "1d6", escala: "1d6" }, ["thorn whip"]),
  S("Llama sagrada", 0, "salvacion", { salvacion: "des", dados: "1d8", escala: "1d8" }, ["sacred flame"]),
  S("Burla dañina", 0, "salvacion", { salvacion: "sab", dados: "1d4", escala: "1d4" }, ["vicious mockery", "burla cruel", "burla maliciosa", "insulto despiadado"]),
  S("Rociada venenosa", 0, "salvacion", { salvacion: "con", dados: "1d12", escala: "1d12" }, ["poison spray", "rociada de veneno", "salpicadura venenosa"]),
  S("Salpicadura ácida", 0, "salvacion", { salvacion: "des", dados: "1d6", escala: "1d6" }, ["acid splash", "salpicadura de acido"]),
  // Nivel 1
  S("Proyectil mágico", 1, "efecto", { dados: "3d4+3", escala: "1d4+1", efecto: "de daño de fuerza (impacta siempre)" }, ["magic missile", "misil magico", "proyectiles magicos"]),
  S("Dormir", 1, "efecto", { dados: "5d8", escala: "2d8", efecto: "puntos de golpe de criaturas que se duermen (empezando por las de menos HP)" }, ["sleep", "sueno"]),
  S("Rociada de color", 1, "efecto", { dados: "6d10", escala: "2d10", efecto: "puntos de golpe de criaturas que quedan cegadas (empezando por las de menos HP)" }, ["color spray", "rocio de color"]),
  S("Curar heridas", 1, "efecto", { dados: "1d8", escala: "1d8", suma_mod: true, curacion: true }, ["cure wounds", "curar heridas leves"]),
  S("Palabra de curación", 1, "efecto", { dados: "1d4", escala: "1d4", suma_mod: true, curacion: true }, ["healing word", "palabra curativa", "palabra sanadora"]),
  S("Manos ardientes", 1, "salvacion", { salvacion: "des", dados: "3d6", escala: "1d6", mitad: true }, ["burning hands"]),
  S("Onda atronadora", 1, "salvacion", { salvacion: "con", dados: "2d8", escala: "1d8", mitad: true }, ["thunderwave", "ola atronadora", "onda de trueno"]),
  S("Susurros disonantes", 1, "salvacion", { salvacion: "sab", dados: "3d6", escala: "1d6", mitad: true }, ["dissonant whispers", "susurros discordantes", "disonancia susurrante"]),
  S("Risa horrible de Tasha", 1, "salvacion", { salvacion: "sab", efecto: "cae al suelo riendo, incapacitado" }, ["tasha's hideous laughter", "risa espantosa de tasha", "risa histerica de tasha", "risa horrible"]),
  S("Hechizar persona", 1, "salvacion", { salvacion: "sab", efecto: "queda hechizado" }, ["charm person", "encantar persona"]),
  S("Orden imperiosa", 1, "salvacion", { salvacion: "sab", efecto: "obedece la orden de una palabra" }, ["command", "orden", "mandato"]),
  S("Perdición", 1, "salvacion", { salvacion: "car", efecto: "resta 1d4 a sus ataques y salvaciones" }, ["bane"]),
  S("Fuego feérico", 1, "salvacion", { salvacion: "des", efecto: "queda iluminado: los ataques contra él tienen ventaja" }, ["faerie fire", "fuego feerico"]),
  S("Enmarañar", 1, "salvacion", { salvacion: "fue", efecto: "queda apresado" }, ["entangle", "enredar"]),
  S("Saeta guía", 1, "ataque", { dados: "4d6", escala: "1d6" }, ["guiding bolt", "rayo guia", "rayo guiador"]),
  S("Rayo de enfermedad", 1, "ataque", { dados: "2d8", escala: "1d8" }, ["ray of sickness", "rayo nauseabundo"]),
  S("Infligir heridas", 1, "ataque", { dados: "3d10", escala: "1d10" }, ["inflict wounds", "causar heridas", "infligir heridas leves"]),
  // Nivel 2
  S("Retener persona", 2, "salvacion", { salvacion: "sab", efecto: "queda paralizado" }, ["hold person", "inmovilizar persona", "paralizar persona"]),
  S("Sugestión", 2, "salvacion", { salvacion: "sab", efecto: "sigue la sugerencia" }, ["suggestion"]),
  S("Estallar", 2, "salvacion", { salvacion: "con", dados: "3d8", escala: "1d8", mitad: true }, ["shatter", "destrozar", "romper"]),
  S("Flecha ácida de Melf", 2, "ataque", { dados: "4d4", escala: "1d4" }, ["melf's acid arrow", "flecha acida"]),
  S("Arma espiritual", 2, "ataque", { dados: "1d8", suma_mod: true }, ["spiritual weapon"]),
  // Nivel 3
  S("Bola de fuego", 3, "salvacion", { salvacion: "des", dados: "8d6", escala: "1d6", mitad: true }, ["fireball"]),
  S("Relámpago", 3, "salvacion", { salvacion: "des", dados: "8d6", escala: "1d6", mitad: true }, ["lightning bolt", "rayo relampago"]),
  S("Espíritus guardianes", 3, "salvacion", { salvacion: "sab", dados: "3d8", escala: "1d8", mitad: true }, ["spirit guardians"]),
  S("Patrón hipnótico", 3, "salvacion", { salvacion: "sab", efecto: "queda hechizado e incapacitado" }, ["hypnotic pattern", "patron hipnotico", "imagen hipnotica"]),
  S("Miedo", 3, "salvacion", { salvacion: "sab", efecto: "queda asustado y huye" }, ["fear", "terror"]),
];

export function findSpell(name: string): SpellInfo | undefined {
  const n = norm(name).replace(/^(el|la|los|las) /, "");
  if (!n) return undefined;
  return (
    SPELLS.find((s) => norm(s.nombre) === n || s.alias.some((a) => norm(a) === n)) ??
    SPELLS.find((s) => [s.nombre, ...s.alias].some((a) => n.startsWith(norm(a)) || norm(a).startsWith(n)))
  );
}

// ---------- números del lanzador ----------

const CLASS_ABILITY: [RegExp, Ability][] = [
  [/bardo|bard/, "car"],
  [/brujo|warlock/, "car"],
  [/hechicero|sorcerer/, "car"],
  [/paladin/, "car"],
  [/clerigo|cleric/, "sab"],
  [/druida|druid/, "sab"],
  [/explorador|ranger/, "sab"],
  [/mago|wizard/, "int"],
  [/artifice|artificer/, "int"],
];

export interface Caster {
  cd: number;
  ataque: number;
  caracteristica?: Ability;
  /** Nivel de personaje (para escalar los trucos). */
  nivel: number;
  source: string;
}

/** CD y ataque de conjuros: lo escrito en la ficha manda; si no está, se calcula con la característica de la clase. */
export function casterNumbers(stats: Stats | null, sheet: string, description: string): Caster | null {
  const text = norm(`${description}\n${sheet}`);
  const nivel = Number(/(?:bardo|brujo|hechicero|paladin|clerigo|druida|explorador|mago|artifice|guerrero|picaro|barbaro|monje|nivel)\D{0,3}(\d{1,2})\b/.exec(text)?.[1] ?? 1);
  const cls = CLASS_ABILITY.find(([re]) => re.test(text));
  const ab = cls?.[1];

  const line = sheet.split("\n").find((l) => /conjuro|hechizo|spell/i.test(l)) ?? "";
  const cdWritten = /\bCD\s*:?\s*(\d{1,2})\b/i.exec(line)?.[1] ?? stats?.conjuros?.cd?.toString();
  const atkWritten = /(?:atq|ataque|attack)[^\d+\-]{0,12}([+-]\s?\d{1,2})/i.exec(line)?.[1] ?? (stats?.conjuros?.ataque != null ? signed(stats.conjuros.ataque) : undefined);
  if (cdWritten && atkWritten) {
    return { cd: Number(cdWritten), ataque: parseInt(atkWritten.replace(/\s/g, ""), 10), caracteristica: ab, nivel, source: "según tu ficha" };
  }
  if (!stats || !ab) return null;
  const m = mod(stats.scores[ab]);
  return {
    cd: cdWritten ? Number(cdWritten) : 8 + stats.competencia + m,
    ataque: atkWritten ? parseInt(atkWritten.replace(/\s/g, ""), 10) : stats.competencia + m,
    caracteristica: ab,
    nivel,
    source: `calculado: ${ABILITY_LABEL[ab]} ${signed(m)} + competencia ${signed(stats.competencia)}`,
  };
}

// ---------- dados según el nivel ----------

/** "3d4+3" + 2 veces "1d4+1" → "5d4+5". Suma dados del mismo tipo y los bonos fijos. */
export function addDice(base: string, extra: string, times: number): string {
  if (!extra || times <= 0) return base;
  const terms = new Map<number, number>();
  let flat = 0;
  const add = (expr: string, k: number) => {
    for (const m of expr.replace(/\s+/g, "").matchAll(/([+-]?)(\d*)d(\d+)|([+-]?)(\d+)(?!d)/gi)) {
      if (m[3]) terms.set(Number(m[3]), (terms.get(Number(m[3])) ?? 0) + (Number(m[2]) || 1) * k);
      else if (m[5]) flat += (m[4] === "-" ? -1 : 1) * Number(m[5]) * k;
    }
  };
  add(base, 1);
  add(extra, times);
  const dice = [...terms.entries()].map(([sides, n]) => `${n}d${sides}`).join("+");
  return flat ? `${dice}${flat > 0 ? "+" : ""}${flat}` : dice;
}

/** Dados del conjuro al nivel lanzado (o, para trucos, según el nivel del personaje). */
export function spellDice(spell: SpellInfo, slot: number, casterLevel: number, castMod: number): string {
  if (!spell.dados) return "";
  let times = 0;
  if (spell.nivel === 0) times = casterLevel >= 17 ? 3 : casterLevel >= 11 ? 2 : casterLevel >= 5 ? 1 : 0;
  else times = Math.max(0, slot - spell.nivel);
  let dice = addDice(spell.dados, spell.escala ?? "", times);
  if (spell.suma_mod && castMod) dice = `${dice}${castMod > 0 ? "+" : ""}${castMod}`;
  return dice;
}
