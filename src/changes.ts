// Cambios en los personajes durante la partida (objetos, dinero, HP, condiciones). El narrador los anota al final de su
// narración en un bloque [cambios]...[/cambios]; el bot lo saca antes de publicar y los escribe en la nota del personaje.
import { norm } from "./stats";

export const COINS = ["ppt", "po", "pe", "pp", "pc"] as const;
export type Coin = (typeof COINS)[number];

export type Op =
  | { kind: "item"; add: boolean; name: string }
  | { kind: "money"; coin: Coin; amount: number }
  | { kind: "hp"; delta: number }
  | { kind: "condition"; add: boolean; name: string };

export interface Change {
  character: string;
  ops: Op[];
}

/** Estado del personaje en la campaña (propiedades de su nota). */
export interface CampaignState {
  hp_actual?: number;
  inventario: string[];
  /** Objetos de la ficha original que se perdieron o se gastaron. */
  perdidos: string[];
  condiciones: string[];
  dinero: Partial<Record<Coin, number>>;
}

export const emptyState = (): CampaignState => ({ inventario: [], perdidos: [], condiciones: [], dinero: {} });

const BLOCK = /\[cambios\]([\s\S]*?)(?:\[\/cambios\]|$)/i;

function parseOp(raw: string): Op | null {
  const t = raw.trim().replace(/\s+/g, " ");
  let m: RegExpExecArray | null;
  if ((m = /^([+-])\s*(?:objeto|obj|item)s?\s*:?\s+(.+)$/i.exec(t))) return { kind: "item", add: m[1] === "+", name: cleanName(m[2]) };
  if ((m = /^([+-])\s*(ppt|po|pe|pp|pc)\s*:?\s*(\d+)$/i.exec(t)) || (m = /^([+-])\s*(\d+)\s*(ppt|po|pe|pp|pc)$/i.exec(t))) {
    const [coin, n] = /\d/.test(m[2]) ? [m[3], m[2]] : [m[2], m[3]];
    return { kind: "money", coin: coin.toLowerCase() as Coin, amount: (m[1] === "-" ? -1 : 1) * parseInt(n, 10) };
  }
  if ((m = /^(?:hp|pg|puntos de golpe)\s*:?\s*([+-])\s*(\d+)$/i.exec(t))) return { kind: "hp", delta: (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10) };
  if ((m = /^([+-])\s*condici[oó]n(?:es)?\s*:?\s+(.+)$/i.exec(t))) return { kind: "condition", add: m[1] === "+", name: cleanName(m[2]).toLowerCase() };
  return null;
}

const cleanName = (s: string) =>
  s
    .replace(/^["'«“]|["'»”]$/g, "")
    .replace(/\s*\.$/, "")
    .trim()
    .slice(0, 80);

/** Separa la narración (para publicar) del bloque de cambios (para la ficha). */
export function extractChanges(narration: string, characters: string[]): { text: string; changes: Change[] } {
  const m = BLOCK.exec(narration);
  if (!m) return { text: narration.trim(), changes: [] };
  const text = (narration.slice(0, m.index) + narration.slice(m.index + m[0].length)).trim();
  const changes: Change[] = [];
  for (const line of m[1].split("\n")) {
    const lm = /^\s*[-•*]?\s*\**([^:|*]+?)\**\s*:\s*(.+)$/.exec(line);
    if (!lm) continue;
    const who = norm(lm[1]);
    const character = characters.find((c) => norm(c) === who) ?? characters.find((c) => who && (norm(c).startsWith(who) || who.startsWith(norm(c))));
    if (!character) continue;
    const ops = lm[2]
      .split(/\s*[|;]\s*/)
      .map(parseOp)
      .filter((o): o is Op => o != null && (o.kind !== "item" || o.name.length > 0));
    if (!ops.length) continue;
    const existing = changes.find((c) => c.character === character);
    if (existing) existing.ops.push(...ops);
    else changes.push({ character, ops });
  }
  return { text, changes };
}

/** Aplica los cambios al estado del personaje. hpMax limita la curación. */
export function applyOps(state: CampaignState, ops: Op[], hpMax?: number): CampaignState {
  const s: CampaignState = { ...state, inventario: [...state.inventario], perdidos: [...state.perdidos], condiciones: [...state.condiciones], dinero: { ...state.dinero } };
  for (const op of ops) {
    if (op.kind === "item") {
      const i = s.inventario.findIndex((x) => norm(x) === norm(op.name));
      if (op.add) {
        const j = s.perdidos.findIndex((x) => norm(x) === norm(op.name));
        if (j >= 0) s.perdidos.splice(j, 1); // recuperó algo que había perdido
        else s.inventario.push(op.name);
      } else if (i >= 0) s.inventario.splice(i, 1);
      else if (!s.perdidos.some((x) => norm(x) === norm(op.name))) s.perdidos.push(op.name);
    } else if (op.kind === "money") {
      s.dinero = op.amount >= 0 ? { ...s.dinero, [op.coin]: (s.dinero[op.coin] ?? 0) + op.amount } : pay(s.dinero, op.coin, -op.amount);
    } else if (op.kind === "hp") {
      const current = s.hp_actual ?? hpMax;
      if (current == null) continue; // sin HP conocidos no se inventa un número
      let v = current + op.delta;
      if (hpMax != null) v = Math.min(hpMax, v);
      s.hp_actual = Math.max(0, v);
    } else {
      const i = s.condiciones.findIndex((x) => norm(x) === norm(op.name));
      if (op.add && i < 0) s.condiciones.push(op.name);
      if (!op.add && i >= 0) s.condiciones.splice(i, 1);
    }
  }
  return s;
}

// Valor de cada moneda en piezas de cobre.
const VALUE: Record<Coin, number> = { pc: 1, pp: 10, pe: 50, po: 100, ppt: 1000 };
const BY_VALUE: Coin[] = ["pc", "pp", "pe", "po", "ppt"];

/**
 * Paga una cantidad de una moneda. Si no alcanza, cambia una moneda más grande (como en la mesa: pagás con oro y te
 * dan el vuelto en esa moneda). Si no alcanza ni con todo, queda en 0: no se puede gastar lo que no se tiene.
 */
export function pay(purse: Partial<Record<Coin, number>>, coin: Coin, amount: number): Partial<Record<Coin, number>> {
  const p: Partial<Record<Coin, number>> = { ...purse };
  const total = BY_VALUE.reduce((sum, c) => sum + (p[c] ?? 0) * VALUE[c], 0);
  if (total < amount * VALUE[coin]) {
    for (const c of BY_VALUE) if (p[c] != null) p[c] = 0;
    p[coin] = 0;
    return p;
  }
  let need = amount;
  while ((p[coin] ?? 0) < need) {
    // La moneda más chica que sea más grande que esta y que tengamos
    const bigger = BY_VALUE.find((c) => VALUE[c] > VALUE[coin] && (p[c] ?? 0) > 0);
    if (!bigger) {
      // Solo quedan monedas más chicas: se pagan con ellas
      const rest = need * VALUE[coin] - (p[coin] ?? 0) * VALUE[coin];
      p[coin] = 0;
      need = 0;
      let left = rest;
      for (const c of [...BY_VALUE].reverse().filter((c) => VALUE[c] < VALUE[coin])) {
        const use = Math.min(p[c] ?? 0, Math.floor(left / VALUE[c]));
        if (use) p[c] = (p[c] ?? 0) - use;
        left -= use * VALUE[c];
      }
      break;
    }
    p[bigger] = (p[bigger] ?? 0) - 1;
    p[coin] = (p[coin] ?? 0) + VALUE[bigger] / VALUE[coin];
  }
  if (need) p[coin] = (p[coin] ?? 0) - need;
  return p;
}

const signedAmount = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** Para mostrar en Discord: "Kael: +Amuleto de plata, HP -9 · Lyra: +25 po". */
export function describeChanges(changes: Change[]): string {
  return changes
    .map((c) => {
      const parts = c.ops.map((o) => {
        if (o.kind === "item") return `${o.add ? "+" : "−"}${o.name}`;
        if (o.kind === "money") return `${signedAmount(o.amount)} ${o.coin}`;
        if (o.kind === "hp") return `HP ${signedAmount(o.delta)}`;
        return `${o.add ? "+" : "−"}${o.name}`;
      });
      return `${c.character}: ${parts.join(", ")}`;
    })
    .join(" · ");
}

/** Estado → propiedades de la nota (solo lo que tiene valor). */
export function stateToProps(s: CampaignState): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (s.hp_actual != null) p.hp_actual = s.hp_actual;
  p.inventario = s.inventario;
  if (s.perdidos.length) p.objetos_perdidos = s.perdidos;
  p.condiciones = s.condiciones;
  for (const c of COINS) if (s.dinero[c] != null) p[c] = s.dinero[c];
  return p;
}

export const STATE_PROPS = ["hp_actual", "inventario", "objetos_perdidos", "condiciones", ...COINS];

export function stateFromProps(meta: Record<string, unknown>): CampaignState {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const dinero: Partial<Record<Coin, number>> = {};
  for (const c of COINS) {
    const n = num(meta[c]);
    if (n != null) dinero[c] = n;
  }
  return { hp_actual: num(meta.hp_actual), inventario: list(meta.inventario), perdidos: list(meta.objetos_perdidos), condiciones: list(meta.condiciones), dinero };
}

/** Una línea para que el narrador sepa cómo está el personaje ahora. */
export function stateLine(s: CampaignState, hpMax?: number): string {
  const parts: string[] = [];
  if (s.hp_actual != null || hpMax != null) parts.push(`HP ${s.hp_actual ?? hpMax}${hpMax != null ? `/${hpMax}` : ""}`);
  if (s.condiciones.length) parts.push(`condiciones: ${s.condiciones.join(", ")}`);
  if (s.inventario.length) parts.push(`lleva además: ${s.inventario.join(", ")}`);
  if (s.perdidos.length) parts.push(`ya no tiene: ${s.perdidos.join(", ")}`);
  const money = COINS.filter((c) => s.dinero[c] != null).map((c) => `${s.dinero[c]} ${c}`);
  if (money.length) parts.push(`dinero: ${money.join(", ")}`);
  return parts.join(" · ");
}

/** Dinero escrito en la ficha ("15 po, 3 pp"), para arrancar la cuenta la primera vez que cambia. */
export function moneyFromSheet(sheet: string): Partial<Record<Coin, number>> {
  const out: Partial<Record<Coin, number>> = {};
  for (const m of norm(sheet).matchAll(/(\d+)\s*(ppt|po|pe|pp|pc)\b/g)) {
    const coin = m[2] as Coin;
    if (out[coin] == null) out[coin] = parseInt(m[1], 10);
  }
  return out;
}
