// Guarda las campañas como notas Markdown en una bóveda local de Obsidian (reemplaza a la base de datos).
//
// <bóveda>/<OBSIDIAN_FOLDER>/<nombre del canal> (<id del canal>)/
//   Campaña.md          ambientación, tono y resumen (el resumen se puede editar a mano)
//   Historial.md        todos los turnos: acciones de los jugadores y narraciones del DM
//   Pendientes.md       acciones declaradas que el DM todavía no narró
//   Personajes/<nombre>.md   un archivo por personaje, con su ficha (editable a mano)
//   Archivo/            campañas anteriores del canal, al empezar una nueva con /campaña
//
// Todo se lee del disco en cada operación, así que los cambios hechos en Obsidian se respetan de inmediato.
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { statsFromProps, statsToProps, norm, type Stats } from "./stats";
import { applyOps, emptyState, moneyFromSheet, stateFromProps, stateToProps, COINS, type CampaignState, type Change } from "./changes";

export interface Campaign {
  channel_id: string;
  setting: string;
  tone: string;
  summary: string;
}
export interface Player {
  user_id: string;
  character: string;
  description: string;
  sheet: string;
  sheet_url: string;
  /** Números exactos de la ficha (propiedades de la nota). null si no hay ficha importada o le faltan datos. */
  stats: Stats | null;
  /** Lo que cambió en la campaña: objetos, dinero, HP actuales, condiciones. */
  state: CampaignState;
}
export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
}
export interface Pending {
  id: number;
  user_id: string;
  content: string;
}
export interface RollRequest {
  id: number;
  user_id: string;
  character: string;
  tipo: string;
  dados: string;
  cd: number;
  dano: string;
  motivo: string;
  /** De dónde sale el bonificador, para mostrarlo en la tirada. */
  fuente?: string;
}

const CAMPAIGN_FILE = "Campaña.md";
const HISTORY_FILE = "Historial.md";
const PENDING_FILE = "Pendientes.md";
const PLAYERS_DIR = "Personajes";
const ARCHIVE_DIR = "Archivo";
const SUMMARY_HEADING = "## Resumen";
const SHEET_HEADING = "## Ficha";
const CAMPAIGN_HEADING = "## En la campaña";

const MSG_MARK = /^<!-- msg (\d+) (user|assistant) -->$/gm;
const PENDING_LINE = /^- \[.\] (.*?) <!-- pend (\d+) (\S+) -->$/;
const ROLL_LINE = /<!-- tirada (\{.*\}) -->$/;

let root = "";

/** Configura la carpeta de la bóveda donde se guardan las campañas. */
export async function initVault(vault: string, folder: string): Promise<string> {
  const stat = await fs.stat(vault).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`No encuentro la bóveda de Obsidian en "${vault}" (revisá OBSIDIAN_VAULT en .env)`);
  root = path.join(vault, folder);
  await fs.mkdir(root, { recursive: true });
  return root;
}

// ---------- utilidades de archivos ----------

const channelNames = new Map<string, string>();

/** Recuerda el nombre del canal para nombrar su carpeta la primera vez que se crea. */
export function rememberChannel(ch: string, name: string | undefined) {
  if (name) channelNames.set(ch, name);
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "sin nombre";
}

async function findChannelDir(ch: string): Promise<string | null> {
  const suffix = `(${ch})`;
  const entries = await fs.readdir(root, { withFileTypes: true });
  const hit = entries.find((e) => e.isDirectory() && e.name.endsWith(suffix));
  return hit ? path.join(root, hit.name) : null;
}

async function channelDir(ch: string): Promise<string> {
  const found = await findChannelDir(ch);
  if (found) return found;
  const dir = path.join(root, `${safeName(channelNames.get(ch) ?? "canal")} (${ch})`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Escribe en un temporal y renombra, para que Obsidian nunca vea un archivo a medio escribir. */
async function writeFile(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

function parseNote(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: unknown;
  try {
    meta = YAML.parse(m[1]);
  } catch {
    meta = {};
  }
  return { meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}, body: text.slice(m[0].length) };
}

function renderNote(meta: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(meta)}---\n${body.replace(/^\n+/, "")}`;
}

/** Texto debajo de un encabezado "## ..." hasta el próximo encabezado del mismo nivel. */
function section(body: string, heading: string): string {
  const start = body.indexOf(heading + "\n");
  if (start < 0) return "";
  const rest = body.slice(start + heading.length + 1);
  const next = rest.search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

const str = (v: unknown) => (v == null ? "" : String(v));

// Las escrituras de un mismo canal van en fila, para que dos comandos simultáneos no se pisen.
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(ch: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(ch) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(ch, next.catch(() => {}));
  return next;
}

function stamp(): string {
  return new Date().toLocaleString("es", { dateStyle: "short", timeStyle: "short" });
}

// ---------- campaña ----------

async function readCampaignNote(ch: string) {
  const dir = await findChannelDir(ch);
  if (!dir) return null;
  const text = await readFile(path.join(dir, CAMPAIGN_FILE));
  if (text == null) return null;
  return { dir, ...parseNote(text) };
}

function campaignBody(setting: string, tone: string, summary: string): string {
  return `# ${setting}\n\n*${tone}*\n\nDiario de la partida: [Historial](<./${HISTORY_FILE}>)\n\n${SUMMARY_HEADING}\n\n${summary || "(La campaña recién empieza.)"}\n`;
}

export async function getCampaign(ch: string): Promise<Campaign | null> {
  const note = await readCampaignNote(ch);
  if (!note) return null;
  const summary = section(note.body, SUMMARY_HEADING);
  return {
    channel_id: ch,
    setting: str(note.meta.ambientacion),
    tone: str(note.meta.tono),
    summary: summary === "(La campaña recién empieza.)" ? "" : summary,
  };
}

/** /campaña: archiva la campaña anterior del canal (si había) y empieza una nueva. Los personajes se conservan. */
export function resetCampaign(ch: string, setting: string, tone: string): Promise<void> {
  return serialize(ch, async () => {
    const dir = await channelDir(ch);
    const old = await readFile(path.join(dir, CAMPAIGN_FILE));
    if (old != null) {
      const prefix = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
      const archive = path.join(dir, ARCHIVE_DIR);
      await fs.mkdir(archive, { recursive: true });
      await fs.rename(path.join(dir, CAMPAIGN_FILE), path.join(archive, `${prefix} - ${CAMPAIGN_FILE}`));
      await fs.rename(path.join(dir, HISTORY_FILE), path.join(archive, `${prefix} - ${HISTORY_FILE}`)).catch(() => {});
    }
    await fs.rm(path.join(dir, PENDING_FILE), { force: true });
    const meta = { canal: channelNames.get(ch) ?? "", channel_id: ch, ambientacion: setting, tono: tone, creada: new Date().toISOString(), compactado_hasta: 0 };
    await writeFile(path.join(dir, CAMPAIGN_FILE), renderNote(meta, campaignBody(setting, tone, "")));
    await writeFile(path.join(dir, HISTORY_FILE), `# Historial — ${setting}\n\n`);
  });
}

// ---------- personajes ----------

async function readPlayerFiles(ch: string): Promise<{ file: string; player: Player; meta: Record<string, unknown> }[]> {
  const dir = await findChannelDir(ch);
  if (!dir) return [];
  const pdir = path.join(dir, PLAYERS_DIR);
  const names = await fs.readdir(pdir).catch(() => [] as string[]);
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    const file = path.join(pdir, name);
    const text = await readFile(file);
    if (text == null) continue;
    const { meta, body } = parseNote(text);
    if (!meta.user_id) continue;
    out.push({
      file,
      meta,
      player: {
        user_id: str(meta.user_id),
        character: str(meta.personaje) || name.replace(/\.md$/, ""),
        description: str(meta.descripcion),
        sheet: section(body, SHEET_HEADING),
        sheet_url: str(meta.fuente),
        stats: statsFromProps(meta),
        state: stateFromProps(meta),
      },
    });
  }
  return out;
}

function campaignSection(p: Player): string {
  const s = p.state;
  const hpMax = p.stats?.hp_max;
  const money = COINS.filter((c) => s.dinero[c] != null).map((c) => `${s.dinero[c]} ${c}`);
  const lines = [
    hpMax != null || s.hp_actual != null ? `- **HP:** ${s.hp_actual ?? hpMax}${hpMax != null ? ` / ${hpMax}` : ""}` : "",
    money.length ? `- **Dinero:** ${money.join(", ")}` : "",
    s.condiciones.length ? `- **Condiciones:** ${s.condiciones.join(", ")}` : "",
    s.inventario.length ? `- **Objetos conseguidos:**\n${s.inventario.map((x) => `  - ${x}`).join("\n")}` : "",
    s.perdidos.length ? `- **Ya no tiene:** ${s.perdidos.join(", ")}` : "",
  ].filter(Boolean);
  if (!lines.length) return "";
  return `${CAMPAIGN_HEADING}\n\n*Se actualiza sola durante la partida. Para corregir algo, editá las propiedades de arriba (\`inventario\`, \`hp_actual\`, \`po\`…).*\n\n${lines.join("\n")}\n\n`;
}

function playerBody(p: Player): string {
  const desc = p.description ? `> ${p.description}\n\n` : "";
  return `# ${p.character}\n\n${desc}${campaignSection(p)}${SHEET_HEADING}\n\n${p.sheet || "(Sin ficha importada. Usá /importar o escribila acá.)"}\n`;
}

async function writePlayer(ch: string, p: Player, previousFile?: string) {
  const dir = await channelDir(ch);
  const file = path.join(dir, PLAYERS_DIR, `${safeName(p.character)}.md`);
  const meta = {
    user_id: p.user_id,
    personaje: p.character,
    descripcion: p.description,
    fuente: p.sheet_url,
    ...(p.stats ? statsToProps(p.stats) : {}),
    ...stateToProps(p.state),
  };
  await writeFile(file, renderNote(meta, playerBody(p)));
  if (previousFile && previousFile !== file) await fs.rm(previousFile, { force: true });
}

export async function getPlayers(ch: string): Promise<Player[]> {
  const list = (await readPlayerFiles(ch)).map((f) => f.player);
  return list.map((p) => (p.sheet.startsWith("(Sin ficha importada") ? { ...p, sheet: "" } : p)).sort((a, b) => a.character.localeCompare(b.character));
}

export async function getPlayer(ch: string, userId: string): Promise<Player | null> {
  return (await getPlayers(ch)).find((p) => p.user_id === userId) ?? null;
}

/** /unirse: cambia nombre y descripción pero conserva la ficha importada si existe. */
export function upsertPlayer(ch: string, userId: string, character: string, description: string): Promise<void> {
  return serialize(ch, async () => {
    const existing = (await readPlayerFiles(ch)).find((f) => f.player.user_id === userId);
    const base: Player = existing?.player ?? { user_id: userId, character, description: "", sheet: "", sheet_url: "", stats: null, state: emptyState() };
    if (base.sheet.startsWith("(Sin ficha importada")) base.sheet = "";
    await writePlayer(ch, { ...base, character, description: description || base.description }, existing?.file);
  });
}

/** /importar: crea o actualiza el personaje con la ficha leída. Lo conseguido en la campaña se conserva. */
export function savePlayerSheet(ch: string, userId: string, character: string, description: string, sheet: string, url: string, stats: Stats | null = null): Promise<void> {
  return serialize(ch, async () => {
    const existing = (await readPlayerFiles(ch)).find((f) => f.player.user_id === userId);
    await writePlayer(ch, { user_id: userId, character, description, sheet, sheet_url: url, stats, state: existing?.player.state ?? emptyState() }, existing?.file);
  });
}

/** Escribe en la nota de cada personaje lo que cambió en el turno. Devuelve los cambios que sí se aplicaron. */
export function applyChanges(ch: string, changes: Change[]): Promise<Change[]> {
  return serialize(ch, async () => {
    const files = await readPlayerFiles(ch);
    const applied: Change[] = [];
    for (const change of changes) {
      const f = files.find((x) => norm(x.player.character) === norm(change.character));
      if (!f) continue;
      const p = f.player;
      let state = p.state;
      // La primera vez que cambia el dinero, la cuenta arranca desde lo que dice la ficha.
      if (change.ops.some((o) => o.kind === "money") && !COINS.some((c) => state.dinero[c] != null)) {
        state = { ...state, dinero: moneyFromSheet(p.sheet) };
      }
      state = applyOps(state, change.ops, p.stats?.hp_max);
      const sheet = p.sheet.startsWith("(Sin ficha importada") ? "" : p.sheet;
      await writePlayer(ch, { ...p, sheet, state }, f.file);
      applied.push(change);
    }
    return applied;
  });
}

export function removePlayer(ch: string, userId: string): Promise<void> {
  return serialize(ch, async () => {
    const existing = (await readPlayerFiles(ch)).find((f) => f.player.user_id === userId);
    if (existing) await fs.rm(existing.file, { force: true });
  });
}

// ---------- acciones pendientes y tiradas pedidas por el árbitro ----------

interface PendingState {
  actions: Pending[];
  rolls: RollRequest[];
}

async function readPendingState(ch: string): Promise<PendingState> {
  const dir = await findChannelDir(ch);
  const state: PendingState = { actions: [], rolls: [] };
  if (!dir) return state;
  const text = (await readFile(path.join(dir, PENDING_FILE))) ?? "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = PENDING_LINE.exec(line);
    if (m) {
      state.actions.push({ id: Number(m[2]), user_id: m[3], content: m[1] });
      continue;
    }
    const r = ROLL_LINE.exec(line);
    if (r) {
      try {
        state.rolls.push(JSON.parse(r[1]) as RollRequest);
      } catch {
        // línea editada a mano y rota: se ignora
      }
    }
  }
  state.actions.sort((x, y) => x.id - y.id);
  return state;
}

async function writePendingState(ch: string, state: PendingState) {
  const dir = await channelDir(ch);
  const actions = state.actions.map((p) => `- [ ] ${p.content} <!-- pend ${p.id} ${p.user_id} -->`);
  // El JSON va dentro de un comentario (invisible en Obsidian); "--" no puede aparecer adentro.
  const rolls = state.rolls.map((r) => `- [ ] 🎲 ${r.character}: ${r.tipo} (${r.dados}) — ${r.motivo} <!-- tirada ${JSON.stringify(r).replace(/--/g, "- -")} -->`);
  const rollsBlock = rolls.length ? `\n\n## Tiradas que pidió el árbitro\n\n${rolls.join("\n")}` : "";
  await writeFile(
    path.join(dir, PENDING_FILE),
    `# Acciones pendientes\n\nEl DM las narra cuando todos actuaron (y tiraron lo que pidió el árbitro) o alguien usa /narrar.\n\n${actions.join("\n")}${rollsBlock}\n`,
  );
}

export function addPending(ch: string, userId: string, content: string): Promise<void> {
  return serialize(ch, async () => {
    const state = await readPendingState(ch);
    const id = state.actions.reduce((max, p) => Math.max(max, p.id), 0) + 1;
    state.actions.push({ id, user_id: userId, content: content.replace(/\s*\n\s*/g, " ") });
    await writePendingState(ch, state);
  });
}

export async function getPending(ch: string): Promise<Pending[]> {
  return (await readPendingState(ch)).actions;
}

export async function getRollRequests(ch: string): Promise<RollRequest[]> {
  return (await readPendingState(ch)).rolls;
}

/** Guarda las tiradas que pidió el árbitro (reemplaza las anteriores) y les asigna un id. */
export function setRollRequests(ch: string, rolls: Omit<RollRequest, "id">[]): Promise<RollRequest[]> {
  return serialize(ch, async () => {
    const state = await readPendingState(ch);
    const base = Date.now() % 1_000_000_000;
    state.rolls = rolls.map((r, i) => ({ ...r, id: base + i }));
    await writePendingState(ch, state);
    return state.rolls;
  });
}

/** Saca una tirada pedida (al tirarla). Devuelve null si ya no estaba, por ejemplo por un doble clic. */
export function takeRollRequest(ch: string, match: (r: RollRequest) => boolean): Promise<{ taken: RollRequest; remaining: RollRequest[] } | null> {
  return serialize(ch, async () => {
    const state = await readPendingState(ch);
    const taken = state.rolls.find(match);
    if (!taken) return null;
    state.rolls = state.rolls.filter((r) => r !== taken);
    await writePendingState(ch, state);
    return { taken, remaining: state.rolls };
  });
}

// ---------- historial ----------

async function readHistory(ch: string): Promise<Message[]> {
  const dir = await findChannelDir(ch);
  if (!dir) return [];
  const text = (await readFile(path.join(dir, HISTORY_FILE))) ?? "";
  const marks = [...text.matchAll(MSG_MARK)];
  return marks.map((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
    const content = text
      .slice(start, end)
      .replace(/^\s*\*\*[^\n]*\*\*[^\n]*\n/, "") // encabezado visible ("**📜 DM** · fecha")
      .replace(/\n+---\s*$/, "") // separador entre turnos
      .trim();
    return { id: Number(m[1]), role: m[2] as Message["role"], content };
  });
}

/** Mensajes que todavía no se resumieron (los anteriores siguen en Historial.md para leerlos en Obsidian). */
export async function getMessages(ch: string): Promise<Message[]> {
  const note = await readCampaignNote(ch);
  const upTo = Number(note?.meta.compactado_hasta ?? 0) || 0;
  return (await readHistory(ch)).filter((m) => m.id > upTo);
}

/** Guarda el turno (acciones + narración) y borra solo las acciones que entraron en este turno. */
export function commitTurn(ch: string, userBlock: string, narration: string, maxPendingId: number): Promise<void> {
  return serialize(ch, async () => {
    const dir = await channelDir(ch);
    const file = path.join(dir, HISTORY_FILE);
    const history = await readHistory(ch);
    const id = history.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    const when = stamp();
    const entry =
      `\n<!-- msg ${id} user -->\n**🎲 Jugadores** · ${when}\n\n${userBlock.trim()}\n` +
      `\n<!-- msg ${id + 1} assistant -->\n**📜 DM** · ${when}\n\n${narration.trim()}\n\n---\n`;
    const current = (await readFile(file)) ?? "# Historial\n\n";
    await writeFile(file, current.replace(/\n*$/, "\n") + entry);
    // Las tiradas pedidas que nadie hizo se descartan: la narración ya avanzó.
    const state = await readPendingState(ch);
    await writePendingState(ch, { actions: state.actions.filter((p) => p.id > maxPendingId), rolls: [] });
  });
}

/** Actualiza el resumen y marca hasta qué mensaje ya está resumido (el historial completo no se borra). */
export function applyCompaction(ch: string, summary: string, upToId: number): Promise<void> {
  return serialize(ch, async () => {
    const note = await readCampaignNote(ch);
    if (!note) return;
    const meta = { ...note.meta, compactado_hasta: upToId };
    const setting = str(note.meta.ambientacion);
    const tone = str(note.meta.tono);
    await writeFile(path.join(note.dir, CAMPAIGN_FILE), renderNote(meta, campaignBody(setting, tone, summary.trim())));
  });
}

// ---------- candado ----------

const LOCK_MS = 120_000;
const locks = new Map<string, number>();

/** Candado en memoria para que dos acciones simultáneas no generen dos narraciones. */
export async function tryLock(ch: string): Promise<boolean> {
  const now = Date.now();
  if ((locks.get(ch) ?? 0) > now) return false;
  locks.set(ch, now + LOCK_MS);
  return true;
}

export async function unlock(ch: string) {
  locks.delete(ch);
}
