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
}

const PLAYER_COLS = "user_id, character, description, sheet, sheet_url";
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

const LOCK_MS = 60_000;

export async function getCampaign(db: D1Database, ch: string): Promise<Campaign | null> {
  return db.prepare("SELECT channel_id, setting, tone, summary FROM campaigns WHERE channel_id = ?").bind(ch).first<Campaign>();
}

export async function resetCampaign(db: D1Database, ch: string, setting: string, tone: string): Promise<void> {
  await db.batch([
    db
      .prepare("INSERT OR REPLACE INTO campaigns (channel_id, setting, tone, summary, lock_until, created_at) VALUES (?, ?, ?, '', NULL, ?)")
      .bind(ch, setting, tone, Date.now()),
    db.prepare("DELETE FROM messages WHERE channel_id = ?").bind(ch),
    db.prepare("DELETE FROM pending WHERE channel_id = ?").bind(ch),
  ]);
}

/** /unirse: cambia nombre y descripción pero conserva la ficha importada si existe. */
export async function upsertPlayer(db: D1Database, ch: string, userId: string, character: string, description: string) {
  await db
    .prepare(
      `INSERT INTO players (channel_id, user_id, character, description) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel_id, user_id) DO UPDATE SET character = excluded.character,
         description = CASE WHEN excluded.description = '' THEN players.description ELSE excluded.description END`,
    )
    .bind(ch, userId, character, description)
    .run();
}

/** /importar: crea o actualiza el personaje con la ficha de Nivel20. */
export async function savePlayerSheet(db: D1Database, ch: string, userId: string, character: string, description: string, sheet: string, url: string) {
  await db
    .prepare(
      `INSERT INTO players (channel_id, user_id, character, description, sheet, sheet_url) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel_id, user_id) DO UPDATE SET character = excluded.character, description = excluded.description,
         sheet = excluded.sheet, sheet_url = excluded.sheet_url`,
    )
    .bind(ch, userId, character, description, sheet, url)
    .run();
}

export async function removePlayer(db: D1Database, ch: string, userId: string) {
  await db.prepare("DELETE FROM players WHERE channel_id = ? AND user_id = ?").bind(ch, userId).run();
}

export async function getPlayers(db: D1Database, ch: string): Promise<Player[]> {
  const r = await db.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE channel_id = ? ORDER BY character`).bind(ch).all<Player>();
  return r.results;
}

export async function getPlayer(db: D1Database, ch: string, userId: string): Promise<Player | null> {
  return db.prepare(`SELECT ${PLAYER_COLS} FROM players WHERE channel_id = ? AND user_id = ?`).bind(ch, userId).first<Player>();
}

export async function addPending(db: D1Database, ch: string, userId: string, content: string) {
  await db.prepare("INSERT INTO pending (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)").bind(ch, userId, content, Date.now()).run();
}

export async function getPending(db: D1Database, ch: string): Promise<Pending[]> {
  const r = await db.prepare("SELECT id, user_id, content FROM pending WHERE channel_id = ? ORDER BY id").bind(ch).all<Pending>();
  return r.results;
}

export async function getMessages(db: D1Database, ch: string): Promise<Message[]> {
  const r = await db.prepare("SELECT id, role, content FROM messages WHERE channel_id = ? ORDER BY id").bind(ch).all<Message>();
  return r.results;
}

/** Guarda el turno (acciones + narración) y borra solo las acciones que entraron en este turno. */
export async function commitTurn(db: D1Database, ch: string, userBlock: string, narration: string, maxPendingId: number) {
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO messages (channel_id, role, content, created_at) VALUES (?, 'user', ?, ?)").bind(ch, userBlock, now),
    db.prepare("INSERT INTO messages (channel_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").bind(ch, narration, now),
    db.prepare("DELETE FROM pending WHERE channel_id = ? AND id <= ?").bind(ch, maxPendingId),
  ]);
}

export async function applyCompaction(db: D1Database, ch: string, summary: string, upToId: number) {
  await db.batch([
    db.prepare("UPDATE campaigns SET summary = ? WHERE channel_id = ?").bind(summary, ch),
    db.prepare("DELETE FROM messages WHERE channel_id = ? AND id <= ?").bind(ch, upToId),
  ]);
}

/** Candado simple para que dos acciones simultáneas no generen dos narraciones. */
export async function tryLock(db: D1Database, ch: string): Promise<boolean> {
  const now = Date.now();
  const r = await db
    .prepare("UPDATE campaigns SET lock_until = ? WHERE channel_id = ? AND (lock_until IS NULL OR lock_until < ?)")
    .bind(now + LOCK_MS, ch, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function unlock(db: D1Database, ch: string) {
  await db.prepare("UPDATE campaigns SET lock_until = NULL WHERE channel_id = ?").bind(ch).run();
}
