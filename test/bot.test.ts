// Pruebas sin red: Gemini y Ollama se simulan. Uso: npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as db from "../src/vault";
import { runTurn, advance, resolveRoll, maybeCompact, quotaReport } from "../src/game";
import { callAI } from "../src/ai";
import { sheetBonus, withBonus } from "../src/arbiter";
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
let root = "";
let n = 0;
const newChannel = async () => {
  const ch = `${100 + ++n}`;
  db.rememberChannel(ch, `canal-${n}`);
  await db.savePlayerSheet(ch, "111", "Kael", "humano guerrero 3", KAEL, "PDF: kael.pdf");
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

test("bonificadores leídos de la ficha", () => {
  const cases: [string, number | null][] = [
    ["Atletismo", 5], ["Percepción", 3], ["Sigilo", 1], ["Persuasión", -1], ["Salvación de FUE", 5], ["Salvación de DES", 1],
    ["Ataque con espada larga", 5], ["Ataque con el arco largo", 3], ["Ataque con hacha", null],
  ];
  for (const [tipo, want] of cases) assert.equal(sheetBonus(KAEL, tipo), want, tipo);
  assert.equal(withBonus("1d20+3", 5), "1d20+5");
  assert.equal(withBonus("2d20kh1+1", 7), "2d20kh1+7");
  assert.equal(withBonus("1d20+2", 0), "1d20");
});

test("turno completo: el árbitro local pide tiradas, se resuelven y el narrador recibe el resultado", async () => {
  const ch = await newChannel();
  await db.addPending(ch, "111", "Kael: ataco al orco");
  await db.addPending(ch, "222", "Lyra: me escondo");
  arbiterReply = {
    tiradas: [
      { personaje: "Kael", tipo: "Ataque con espada larga", dados: "1d20+3", cd: 13, dano: "1d8+3", motivo: "golpear al orco" },
      { personaje: "lyra", tipo: "Sigilo", dados: "1d20+3", cd: 12, dano: "1d6", motivo: "esconderse" },
      { personaje: "Nadie", tipo: "Sigilo", dados: "1d20", cd: 10, dano: "", motivo: "" },
    ],
  };
  const before = calls.length;
  const adv = await advance(env, ch);
  assert.equal(adv.kind, "rolls");
  const rolls = adv.kind === "rolls" ? adv.rolls : [];
  assert.equal(rolls.length, 2, "se descarta el personaje que no existe");
  assert.equal(rolls[0].dados, "1d20+5", "el bonificador de ataque se corrige con la ficha");
  assert.equal(rolls[1].dano, "", "el daño solo se guarda para ataques");
  assert.deepEqual(
    calls.slice(before).map((c) => c.service),
    ["ollama"],
    "el árbitro no gasta Gemini",
  );

  assert.equal(await resolveRoll(ch, "222", { rollId: rolls[0].id }), null, "no se puede tirar la tirada de otro");
  const r1 = await resolveRoll(ch, "111", { rollId: rolls[0].id });
  assert.equal(r1?.remaining.length, 1);
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
  assert.match(turn, /Kael tira Ataque con espada larga 1d20\+5: .* vs CD 13 → (éxito|fallo)/);
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
