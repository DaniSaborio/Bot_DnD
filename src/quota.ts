// Cuenta los pedidos del día a cada modelo, para /cuota. La cuota diaria de Gemini se reinicia a la medianoche del Pacífico.
import { promises as fs } from "node:fs";
import path from "node:path";

interface Day {
  day: string;
  requests: Record<string, number>;
  limited: Record<string, number>; // modelo → cuántas veces respondió "sin cuota" hoy
}

const RESET_TZ = "America/Los_Angeles";
const COOLDOWN_MS = 60_000;

let file = "";
let state: Day = { day: "", requests: {}, limited: {} };
const lastLimited = new Map<string, number>();

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: RESET_TZ }).format(new Date());
}

function current(): Day {
  const day = today();
  if (state.day !== day) state = { day, requests: {}, limited: {} };
  return state;
}

export async function initQuota(dir: string) {
  file = path.join(dir, ".cuota.json");
  try {
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as Day;
    if (saved.day === today()) state = { day: saved.day, requests: saved.requests ?? {}, limited: saved.limited ?? {} };
  } catch {
    // primera vez o archivo dañado: se empieza de cero
  }
}

function save() {
  if (file) fs.writeFile(file, JSON.stringify(state, null, 2)).catch((e) => console.error("No pude guardar la cuota", e));
}

export function recordRequest(model: string) {
  const d = current();
  d.requests[model] = (d.requests[model] ?? 0) + 1;
  save();
}

/** El modelo respondió 429: lo salteamos un minuto para no perder tiempo en cada pedido. */
export function recordLimited(model: string) {
  const d = current();
  d.limited[model] = (d.limited[model] ?? 0) + 1;
  lastLimited.set(model, Date.now());
  save();
}

export function isCoolingDown(model: string): boolean {
  return Date.now() - (lastLimited.get(model) ?? 0) < COOLDOWN_MS;
}

export function usage(): Day {
  return current();
}

/** Hora local en la que se reinicia la cuota diaria (medianoche en California). */
export function nextReset(): Date {
  const now = new Date();
  const wall = new Date(now.toLocaleString("en-US", { timeZone: RESET_TZ }));
  const midnight = new Date(wall);
  midnight.setHours(24, 0, 0, 0);
  return new Date(now.getTime() + (midnight.getTime() - wall.getTime()));
}

/** GEMINI_LIMITS="gemini-3.8-flash=250,gemini-3.5-flash-lite=1000" → límites diarios que ve el usuario en AI Studio. */
export function parseLimits(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw ?? "").split(",")) {
    const [model, n] = part.split("=").map((s) => s.trim());
    if (model && Number(n) > 0) out[model] = Number(n);
  }
  return out;
}
