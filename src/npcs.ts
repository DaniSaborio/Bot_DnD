// Personajes no jugadores (PNJ). El narrador los anota en un bloque [npcs]...[/npcs] al final de su narración; el bot
// lo saca antes de publicar y guarda una nota por PNJ en Obsidian. Los que acompañan al grupo siempre van en el contexto
// del narrador, así no se olvidan; del resto, solo los que se mencionan en los turnos recientes.
import { norm } from "./stats";

export interface Npc {
  nombre: string;
  acompana: boolean;
  rol: string;
  descripcion: string;
  actitud: string;
  estado: string;
  lugar: string;
  /** Registro de apariciones: "13/10/26 — se une como guía". */
  notas: string[];
}

export interface NpcUpdate {
  nombre: string;
  acompana?: boolean;
  rol?: string;
  descripcion?: string;
  actitud?: string;
  estado?: string;
  lugar?: string;
  nota?: string;
}

const BLOCK = /\[npcs?\]([\s\S]*?)(?:\[\/npcs?\]|$)/i;
const MAX_NOTES = 30;

const FIELDS: Record<string, keyof Omit<NpcUpdate, "nombre">> = {
  acompana: "acompana",
  acompaña: "acompana",
  "acompaña al grupo": "acompana",
  compañero: "acompana",
  rol: "rol",
  descripcion: "descripcion",
  descripción: "descripcion",
  actitud: "actitud",
  estado: "estado",
  lugar: "lugar",
  nota: "nota",
};

const yes = (v: string) => /^(si|sí|yes|true|se une|unido|acompaña)/i.test(v.trim());

/** Separa la narración del bloque [npcs]. */
export function extractNpcs(narration: string): { text: string; updates: NpcUpdate[] } {
  const m = BLOCK.exec(narration);
  if (!m) return { text: narration, updates: [] };
  const text = (narration.slice(0, m.index) + narration.slice(m.index + m[0].length)).trim();
  const updates: NpcUpdate[] = [];
  for (const line of m[1].split("\n")) {
    const parts = line
      .replace(/^\s*[-•*]\s*/, "")
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    const nombre = parts[0].replace(/\*+/g, "").replace(/:$/, "").trim().slice(0, 60);
    if (!nombre) continue;
    const u: NpcUpdate = { nombre };
    for (const part of parts.slice(1)) {
      const fm = /^([^:]+):\s*(.*)$/.exec(part);
      if (!fm) continue;
      const key = FIELDS[norm(fm[1])] ?? FIELDS[fm[1].trim().toLowerCase()];
      const value = fm[2].trim().slice(0, 200);
      if (!key || !value) continue;
      if (key === "acompana") u.acompana = yes(value);
      else u[key] = value;
    }
    if (Object.keys(u).length > 1) updates.push(u);
  }
  return { text, updates };
}

export function applyNpcUpdate(npc: Npc | null, u: NpcUpdate, when: string): Npc {
  const n: Npc = npc
    ? { ...npc, notas: [...npc.notas] }
    : { nombre: u.nombre, acompana: false, rol: "", descripcion: "", actitud: "", estado: "vivo", lugar: "", notas: [] };
  const joined = u.acompana != null && u.acompana !== n.acompana;
  if (joined) n.acompana = u.acompana!;
  for (const k of ["rol", "descripcion", "actitud", "estado", "lugar"] as const) if (u[k]) n[k] = u[k]!;
  if (u.estado && /muert|fallec/i.test(u.estado)) n.acompana = false;
  // Una sola línea por turno en el registro: la nota del narrador, o una automática si no dejó ninguna.
  const auto = joined ? (n.acompana ? "se une al grupo" : "deja el grupo") : !npc ? "aparece por primera vez" : "";
  const entry = u.nota ?? auto;
  if (entry) n.notas.push(`${when} — ${entry}`);
  n.notas = n.notas.slice(-MAX_NOTES);
  return n;
}

/** Para Discord: "👥 Greta se une al grupo · nuevo PNJ: Maese Torvald". */
export function describeNpcs(updates: { before: Npc | null; after: Npc }[]): string {
  const parts: string[] = [];
  for (const { before, after } of updates) {
    if (!before) parts.push(after.acompana ? `${after.nombre} se une al grupo` : `nuevo PNJ: ${after.nombre}`);
    else if (before.acompana !== after.acompana) parts.push(`${after.nombre} ${after.acompana ? "se une al grupo" : "deja el grupo"}`);
    else if (before.estado !== after.estado) parts.push(`${after.nombre}: ${after.estado}`);
  }
  return parts.join(" · ");
}

function line(n: Npc): string {
  const bits = [n.rol, n.descripcion, n.actitud && `actitud ${n.actitud}`, n.estado && n.estado !== "vivo" ? n.estado : "", n.lugar && `en ${n.lugar}`].filter(Boolean);
  return `- ${n.nombre}${bits.length ? `: ${bits.join(" · ")}` : ""}`;
}

// Títulos y palabras que no identifican a nadie: "el Barón de Oakhaven" se reconoce por "Oakhaven", no por "barón".
const TITLES = new Set(["maese", "senor", "senora", "don", "dona", "sir", "lady", "lord", "baron", "baronesa", "conde", "condesa", "duque", "duquesa", "rey", "reina", "principe", "princesa", "capitan", "sargento", "padre", "madre", "hermano", "hermana", "anciano", "anciana", "viejo", "vieja", "del", "los", "las", "the"]);

function nameWords(name: string): string[] {
  return norm(name)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !TITLES.has(w))
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/** Contexto de PNJ para el narrador: compañeros siempre; el resto, si se nombran en el texto reciente. */
export function npcContext(npcs: Npc[], recentText: string, maxOthers = 8): string {
  const companions = npcs.filter((n) => n.acompana);
  const recent = norm(recentText);
  const mentioned = npcs.filter((n) => !n.acompana && nameWords(n.nombre).some((w) => new RegExp(`\\b${w}\\b`).test(recent))).slice(0, maxOthers);
  const parts: string[] = [];
  if (companions.length) parts.push(`PNJ QUE ACOMPAÑAN AL GRUPO (están presentes, tenelos en cuenta en cada escena):\n${companions.map(line).join("\n")}`);
  if (mentioned.length) parts.push(`PNJ CONOCIDOS QUE APARECEN EN LA ESCENA RECIENTE:\n${mentioned.map(line).join("\n")}`);
  return parts.join("\n\n");
}
