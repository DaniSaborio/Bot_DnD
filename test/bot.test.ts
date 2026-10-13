// Pruebas sin red: Gemini y Ollama se simulan. Uso: npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as db from "../src/vault";
import { runTurn, advance, resolveRoll, maybeCompact, quotaReport } from "../src/game";
import { callAI } from "../src/ai";
import { sheetBonus, withBonus, brief } from "../src/arbiter";
import { statsFromImport, statsFromProps, statsToProps, bonusFor } from "../src/stats";
import { initQuota } from "../src/quota";

const KAEL = `HP máx 28 · CA 18 · Velocidad 30
FUE 16 (+3) DES 12 (+1) CON 14 (+2) INT 10 (+0) SAB 12 (+1) CAR 8 (-1)
Salvaciones: FUE +5, CON +4
Habilidades: Atletismo +5, Intimidación +1, Percepción +3
Ataques: Espada larga +5, 1d8+3 cortante; Arco largo +3, 1d8+1`;

// ---------- simulación de Gemini y Ollama ----------
const calls: { service: "gemini" | "ollama"; model: string; body: any }[] = [];
let geminiStatus = 200;
let arbiterReply: object = { tiradas: [] };
let narration = 0;

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.includes("googleapis")) {
    const model = url.split("/models/")[1].split(":")[0];
    calls.push({ service: "gemini", model, body });
    if (geminiStatus !== 200) return new Response("{}", { status: geminiStatus });
    const text = body.generationConfig.responseMimeType ? JSON.stringify(arbiterReply) : `Narración ${++narration}`;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  }
  calls.push({ service: "ollama", model: body.model, body });
  const text = body.format && body.format !== "json" ? JSON.stringify(arbiterReply) : `Narración local ${++narration}`;
  return new Response(JSON.stringify({ message: { content: text } }));
}) as typeof fetch;

const env = { GEMINI_API_KEY: "x", GEMINI_LIMITS: "gemini-3.8-flash=250" };
const KAEL_STATS = statsFromImport(
  {
    caracteristicas: { fue: 16, des: 12, con: 14, int: 10, sab: 12, car: 8 },
    competencia: 2,
    ca: 18,
    hp_max: 28,
    salvaciones: { fue: 5, con: 4 },
    habilidades: { Atletismo: 5, Intimidación: 1, Percepción: 3 },
    ataques: [{ nombre: "Espada larga", bono: 5, dano: "1d8+3" }],
  },
  3,
).stats;
let root = "";
let n = 0;
const newChannel = async () => {
  const ch = `${100 + ++n}`;
  db.rememberChannel(ch, `canal-${n}`);
  await db.savePlayerSheet(ch, "111", "Kael", "humano guerrero 3", KAEL, "PDF: kael.pdf", KAEL_STATS);
  await db.upsertPlayer(ch, "222", "Lyra", "elfa pícara");
  await db.resetCampaign(ch, "La cripta", "oscuro");
  return ch;
};

before(async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "dnd-vault-"));
  root = await db.initVault(vault, "DnD");
  await initQuota(root);
});

// ---------- bóveda ----------

test("acciones simultáneas no se pisan y quedan en una línea", async () => {
  const ch = await newChannel();
  await Promise.all([db.addPending(ch, "111", "Kael: ataca\ncon furia"), db.addPending(ch, "222", "Lyra: se esconde"), db.addPending(ch, "222", "Lyra: mira")]);
  const pending = await db.getPending(ch);
  assert.equal(pending.length, 3);
  assert.ok(pending.some((p) => p.content === "Kael: ataca con furia"));
});

test("un turno queda en Historial.md y vacía las pendientes", async () => {
  const ch = await newChannel();
  await db.addPending(ch, "111", "Kael: abre la puerta");
  geminiStatus = 200;
  const text = await runTurn(env, ch);
  assert.match(text, /^Narración/);
  const msgs = await db.getMessages(ch);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(msgs[1].content, text, "el separador --- no se cuela en el texto");
  assert.equal((await db.getPending(ch)).length, 0);
});

test("/unirse con otro nombre renombra la nota y conserva la ficha", async () => {
  const ch = await newChannel();
  await db.upsertPlayer(ch, "111", "Kael el Rojo", "");
  const p = await db.getPlayer(ch, "111");
  assert.equal(p?.character, "Kael el Rojo");
  assert.equal(p?.sheet, KAEL);
  assert.deepEqual(p?.stats, KAEL_STATS, "las estadísticas se conservan");
  const dir = (await fs.readdir(root)).find((d) => d.endsWith(`(${ch})`))!;
  assert.deepEqual((await fs.readdir(path.join(root, dir, "Personajes"))).sort(), ["Kael el Rojo.md", "Lyra.md"]);
});

test("la compactación resume lo viejo pero el historial completo se conserva", async () => {
  const ch = await newChannel();
  for (let i = 0; i < 10; i++) {
    await db.addPending(ch, "111", `Kael: paso ${i}`);
    await runTurn(env, ch);
  }
  await maybeCompact(env, ch);
  const left = await db.getMessages(ch);
  assert.ok(left.length <= 6 && left[0].role === "user", `quedan ${left.length}`);
  assert.match((await db.getCampaign(ch))!.summary, /Narración/);
  const dir = (await fs.readdir(root)).find((d) => d.endsWith(`(${ch})`))!;
  const hist = await fs.readFile(path.join(root, dir, "Historial.md"), "utf8");
  assert.equal(hist.match(/<!-- msg/g)?.length, 20);
  const summaryCall = calls[calls.length - 1];
  assert.equal(summaryCall.model, "gemini-3.5-flash-lite", "los resúmenes usan el modelo liviano");
});

test("/campaña archiva la anterior y conserva los personajes", async () => {
  const ch = await newChannel();
  await db.resetCampaign(ch, "Otra", "humor");
  const dir = (await fs.readdir(root)).find((d) => d.endsWith(`(${ch})`))!;
  assert.equal((await fs.readdir(path.join(root, dir, "Archivo"))).length, 2);
  assert.equal((await db.getPlayers(ch)).length, 2);
});

// ---------- árbitro y tiradas ----------

test("bonificadores calculados por el código, nunca por la IA", () => {
  const st = KAEL_STATS!;
  const cases: [Parameters<typeof bonusFor>[1], number][] = [
    [{ categoria: "habilidad", habilidad: "Atletismo" }, 5],
    [{ categoria: "habilidad", habilidad: "Sigilo" }, 1], // sin competencia: solo DES
    [{ categoria: "habilidad", habilidad: "Persuasión" }, -1],
    [{ categoria: "salvacion", caracteristica: "fue" }, 5],
    [{ categoria: "salvacion", caracteristica: "sab" }, 1],
    [{ categoria: "caracteristica", caracteristica: "con" }, 2],
    [{ categoria: "ataque", arma: "espada larga" }, 5],
    [{ categoria: "ataque", arma: "espada" }, 5],
    [{ categoria: "iniciativa" }, 1],
  ];
  for (const [check, want] of cases) assert.equal(bonusFor(st, check).value, want, JSON.stringify(check));
  const unknown = bonusFor(st, { categoria: "ataque", arma: "hacha" });
  assert.match(unknown.source, /no está en tu ficha/, "un arma que no está en la ficha se avisa");
});

test("al importar se recalculan los modificadores y se avisa lo que no cuadra", () => {
  const r = statsFromImport({
    caracteristicas: { fue: 16, des: 12, con: 14, int: 10, sab: 12, car: 8 },
    competencia: 2,
    salvaciones: { fue: 5 },
    habilidades: { Atletismo: 9, Sigilo: 1 },
    ataques: [{ nombre: "Espada larga +1", bono: 6, dano: "1d8+4" }],
  });
  assert.equal(r.warnings.length, 2, r.warnings.join(" | "));
  assert.ok(r.warnings.some((w) => w.startsWith("Atletismo +9")));
  assert.equal(statsFromImport({ caracteristicas: { fue: 16 } }).stats, null, "sin las 6 puntuaciones no hay estadísticas");
});

test("las estadísticas sobreviven como propiedades de Obsidian", () => {
  assert.deepEqual(statsFromProps(statsToProps(KAEL_STATS!)), KAEL_STATS);
  // Una corrección a mano en Obsidian se respeta
  const props = { ...statsToProps(KAEL_STATS!), habilidades: ["Atletismo +6", "Sigilo +3"] };
  assert.equal(bonusFor(statsFromProps(props)!, { categoria: "habilidad", habilidad: "Sigilo" }).value, 3);
});

test("respaldo para fichas sin estadísticas: el número escrito en el texto", () => {
  assert.equal(sheetBonus(KAEL, "Atletismo"), 5);
  assert.equal(sheetBonus(KAEL, "Ataque con el arco largo"), 3);
  assert.equal(sheetBonus(KAEL, "Ataque con hacha"), null);
  assert.equal(withBonus("1d20+3", 5), "1d20+5");
});

test("el árbitro recibe un resumen corto, sin números", async () => {
  const ch = await newChannel();
  const kael = (await db.getPlayer(ch, "111"))!;
  const text = brief(kael);
  assert.match(text, /Armas: Espada larga/);
  assert.match(text, /Competente en: Atletismo, Intimidación, Percepción/);
  assert.doesNotMatch(text, /[+-]\d/, "sin bonificadores");
  assert.ok(text.length < KAEL.length);
});

test("turno completo: el árbitro elige la tirada, el código pone el número, el narrador recibe el resultado", async () => {
  const ch = await newChannel();
  await db.addPending(ch, "111", "Kael: ataco al orco");
  await db.addPending(ch, "222", "Lyra: me escondo");
  arbiterReply = {
    tiradas: [
      { personaje: "Kael", categoria: "ataque", habilidad: "", caracteristica: "", arma: "espada larga", cd: 13, ventaja: "normal", motivo: "golpear al orco" },
      { personaje: "lyra", categoria: "habilidad", habilidad: "Sigilo", caracteristica: "", arma: "", cd: 12, ventaja: "desventaja", motivo: "esconderse" },
      { personaje: "Nadie", categoria: "habilidad", habilidad: "Sigilo", caracteristica: "", arma: "", cd: 10, ventaja: "normal", motivo: "" },
      { personaje: "Kael", categoria: "habilidad", habilidad: "Inventada", caracteristica: "", arma: "", cd: 10, ventaja: "normal", motivo: "" },
    ],
  };
  const before = calls.length;
  const adv = await advance(env, ch);
  assert.equal(adv.kind, "rolls");
  const rolls = adv.kind === "rolls" ? adv.rolls : [];
  assert.equal(rolls.length, 2, "se descartan personajes y habilidades que no existen");
  assert.equal(rolls[0].tipo, "Ataque con Espada larga");
  assert.equal(rolls[0].dados, "1d20+5");
  assert.equal(rolls[0].dano, "1d8+3", "el daño sale de la ficha");
  assert.equal(rolls[1].dados, "2d20kl1", "Lyra no tiene estadísticas ni número en su ficha: no se inventa");
  assert.match(rolls[1].fuente ?? "", /sin ficha importada/);
  assert.deepEqual(
    calls.slice(before).map((c) => c.service),
    ["ollama"],
    "el árbitro no gasta Gemini",
  );
  assert.ok(calls.at(-1)!.body.format.properties.tiradas.items.properties.personaje.enum.includes("Kael"), "formato cerrado");

  assert.equal(await resolveRoll(ch, "222", { rollId: rolls[0].id }), null, "no se puede tirar la tirada de otro");
  const r1 = await resolveRoll(ch, "111", { rollId: rolls[0].id });
  assert.equal(r1?.remaining.length, 1);
  assert.match(r1!.display, /Espada larga \+5 según tu ficha/, "se muestra de dónde sale el número");
  assert.equal(await resolveRoll(ch, "111", { rollId: rolls[0].id }), null, "doble clic no duplica");
  const r2 = await resolveRoll(ch, "222", { manual: { total: 4, detail: "1d20[1] + 3" }, expr: "1d20+3" });
  assert.match(r2!.display, /❌ fallo/);
  assert.equal(r2!.remaining.length, 0);

  await runTurn(env, ch);
  const narr = calls[calls.length - 1];
  assert.equal(narr.model, "gemini-3.8-flash");
  const system: string = narr.body.systemInstruction.parts[0].text;
  assert.ok(!system.includes("Habilidades:") && system.includes("CA 18"), "el narrador no ve la ficha completa, sí HP y CA");
  const turn: string = narr.body.contents.at(-1).parts[0].text;
  assert.match(turn, /Kael tira Ataque con Espada larga 1d20\+5: .* vs CD 13 → (éxito|fallo)/);
  assert.match(turn, /Lyra tira Sigilo 1d20\+3: .* = 4 vs CD 12 → fallo/);
  assert.equal((await db.getRollRequests(ch)).length, 0);
});

test("si el árbitro no pide tiradas, se narra directamente", async () => {
  const ch = await newChannel();
  await db.addPending(ch, "111", "Kael: pido una cerveza");
  arbiterReply = { tiradas: [] };
  const adv = await advance(env, ch);
  assert.equal(adv.kind, "text");
});

// ---------- cuota y respaldos ----------

test("sin cuota en un modelo se pasa al siguiente; sin cuota en ninguno narra el modelo local", async () => {
  const ch = await newChannel();
  geminiStatus = 429;
  const start = calls.length;
  const text = await runTurn(env, ch);
  assert.match(text, /^Narración local/);
  assert.deepEqual(
    calls.slice(start).map((c) => c.model),
    ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemma4:e4b"],
  );
  // Si todos están en espera por falta de cuota, se vuelve a probar desde el mejor: la cuota por minuto pudo liberarse
  geminiStatus = 200;
  const again = calls.length;
  assert.match(await callAI(env, "narrar", "s", [{ role: "user", content: "hola" }], 50), /^Narración/);
  assert.deepEqual(
    calls.slice(again).map((c) => c.model),
    ["gemini-3.8-flash"],
  );
});

test("/cuota muestra lo usado y lo que queda", () => {
  const report = quotaReport(env);
  assert.match(report, /`gemini-3\.8-flash` \d+\/250 \(quedan \d+/);
  assert.match(report, /gemma4:e4b/);
});

// ---------- lector de fichas en código ----------

const THORIN_PDF = `NOMBRE DEL PERSONAJE Thorin Escudo de Roble
CLASE Y NIVEL Clérigo 4 TRASFONDO Acólito RAZA Enano de las colinas
FUERZA 14 +2 DESTREZA 10 +0 CONSTITUCIÓN 16 +3
INTELIGENCIA 8 -1 SABIDURÍA 17 +3 CARISMA 12 +1
BONIFICADOR POR COMPETENCIA +2 CLASE DE ARMADURA 18 INICIATIVA +0 VELOCIDAD 25
PUNTOS DE GOLPE MÁXIMOS 35
TIRADAS DE SALVACIÓN ○ +2 Fuerza ○ +0 Destreza ○ +3 Constitución ○ -1 Inteligencia ● +5 Sabiduría ● +3 Carisma
HABILIDADES ○ +0 Acrobacias ○ -1 Arcanos ○ +2 Atletismo ○ +1 Engaño ○ -1 Historia ○ +1 Interpretación ○ +1 Intimidación ○ -1 Investigación ○ +0 Juego de manos ● +5 Medicina ○ -1 Naturaleza ○ +3 Percepción ● +5 Perspicacia ● +3 Persuasión ● +1 Religión ○ +0 Sigilo ○ +3 Supervivencia ○ +3 Trato con animales
ATAQUES Y CONJUROS Martillo de guerra +4 1d8+2 contundente  Ballesta ligera +2 1d8 perforante
RASGOS Resistencia enana, Canalizar divinidad`;

test("lector en código: el número va antes del nombre (la IA corría los números de lugar)", async () => {
  const { parseSheet, mergeStats } = await import("../src/sheetparse");
  const p = parseSheet(THORIN_PDF);
  assert.deepEqual(p.caracteristicas, { fue: 14, des: 10, con: 16, int: 8, sab: 17, car: 12 });
  assert.equal(p.competencia, 2);
  assert.equal(p.ca, 18);
  assert.equal(p.hp_max, 35);
  assert.deepEqual(p.salvaciones, { fue: 2, des: 0, con: 3, int: -1, sab: 5, car: 3 });
  assert.equal(Object.keys(p.habilidades).length, 18);
  assert.equal(p.habilidades["Medicina"], 5);
  assert.equal(p.habilidades["Juego de manos"], 0);
  assert.equal(p.habilidades["Religión"], 1);
  // Lo que la IA leyó corrido se corrige y se informa
  const ai = { caracteristicas: { fue: 14, des: 10, con: 16, int: 8, sab: 17, car: 12 }, competencia: 2, habilidades: { Medicina: 3, Religión: 3 }, ataques: [{ nombre: "Martillo de guerra", bono: 2, dano: "1d8+2" }] };
  const { merged, corrected } = mergeStats(THORIN_PDF, ai);
  assert.equal(merged.habilidades["Medicina"], 5);
  assert.equal(merged.ataques[0].bono, 4, "el bonificador del ataque se verifica con el texto");
  assert.ok(corrected.some((c) => c.startsWith("Medicina: la IA leyó 3")));
  assert.ok(corrected.some((c) => c.startsWith("Ataque con Martillo de guerra")));
});

test("lector en código: el número va después del nombre", async () => {
  const { parseSheet } = await import("../src/sheetparse");
  const p = parseSheet(`Kael, guerrero 3
Fuerza 16 (+3) Destreza 12 (+1) Constitución 14 (+2) Inteligencia 10 (+0) Sabiduría 12 (+1) Carisma 8 (-1)
Bonificador de competencia +2
Salvaciones: FUE +5, DES +1, CON +4, INT +0, SAB +1, CAR -1
Habilidades: Atletismo +5, Intimidación +1, Percepción +3`);
  assert.deepEqual(p.caracteristicas, { fue: 16, des: 12, con: 14, int: 10, sab: 12, car: 8 });
  assert.deepEqual(p.habilidades, { Atletismo: 5, Intimidación: 1, Percepción: 3 });
  assert.equal(p.salvaciones.fue, 5);
  assert.equal(p.salvaciones.car, -1);
});

test("lector en código: campos de la hoja oficial rellenable", async () => {
  const { parseSheet } = await import("../src/sheetparse");
  const p = parseSheet(`texto cualquiera

CAMPOS DEL FORMULARIO:
CharacterName: Lyra
STR: 8
DEX: 17
CON: 12
INT: 14
WIS: 10
CHA: 14
ProfBonus: +2
AC: 14
HPMax: 20
ST Dexterity: +5
Stealth: +7
SleightofHand: +5
Wpn Name: Daga
Wpn1 AtkBonus: +5
Wpn1 Damage: 1d4+3 perforante
Wpn Name 2: Ballesta ligera
Wpn2 AtkBonus: +5
Wpn2 Damage: 1d8+3`);
  assert.deepEqual(p.caracteristicas, { fue: 8, des: 17, con: 12, int: 14, sab: 10, car: 14 });
  assert.equal(p.habilidades["Sigilo"], 7);
  assert.equal(p.habilidades["Juego de manos"], 5);
  assert.equal(p.salvaciones.des, 5);
  assert.deepEqual(p.ataques, [
    { nombre: "Daga", bono: 5, dano: "1d4+3" },
    { nombre: "Ballesta ligera", bono: 5, dano: "1d8+3" },
  ]);
});

test("lector en código: sin datos claros no inventa nada", async () => {
  const { parseSheet } = await import("../src/sheetparse");
  const p = parseSheet("Mi personaje fue criado con 2 hermanos en una granja.");
  assert.deepEqual(p.caracteristicas, {});
  assert.deepEqual(p.habilidades, {});
});
