import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { promises as fs, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { splitMessage } from "./discord";
import * as db from "./vault";
import { rollDice } from "./dice";
import { checkUrl } from "./nivel20";
import { checkAttachment } from "./pdf";
import { runTurn, advance, resolveRoll, askOoc, maybeCompact, importSheet, quotaReport, type GameEnv, type SheetSource } from "./game";
import { initQuota } from "./quota";
import { statsSummary } from "./stats";
import { stateLine } from "./changes";
import { warmUp, ollamaModel } from "./ollama";

try {
  process.loadEnvFile();
} catch {
  // Sin .env: se usan las variables de entorno del sistema.
}

const env: GameEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_LIGHT_MODEL: process.env.GEMINI_LIGHT_MODEL,
  GEMINI_THINKING: process.env.GEMINI_THINKING,
  GEMINI_LIMITS: process.env.GEMINI_LIMITS,
  OLLAMA_URL: process.env.OLLAMA_URL,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL,
  OLLAMA_FALLBACK: process.env.OLLAMA_FALLBACK,
};

const NO_MENTIONS = { parse: [] };

function reply(i: ChatInputCommandInteraction, content: string, ephemeral = false) {
  return i.reply({ content: content.slice(0, 2000), flags: ephemeral ? MessageFlags.Ephemeral : undefined, allowedMentions: NO_MENTIONS });
}

interface Out {
  text: string;
  rolls?: db.RollRequest[];
}

/** Botones para las tiradas que pidió el árbitro (Discord permite hasta 5 por fila). */
function rollButtons(rolls: db.RollRequest[]) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let k = 0; k < rolls.length && rows.length < 5; k += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        rolls.slice(k, k + 5).map((r) =>
          new ButtonBuilder()
            .setCustomId(`tirar:${r.id}`)
            .setStyle(ButtonStyle.Primary)
            .setLabel(`🎲 ${r.character}: ${r.tipo} (${r.dados})`.slice(0, 80)),
        ),
      ),
    );
  }
  return rows;
}

function rollsMessage(rolls: db.RollRequest[]): string {
  const lines = rolls.map((r) => `• **${r.character}** — ${r.tipo}${r.motivo ? ` (${r.motivo})` : ""}`);
  return `⚖️ **Hace falta tirar:**\n${lines.join("\n")}\n-# Cada uno toca su botón (o usa /tirar). El DM narra cuando estén todas.`;
}

/** Envía el resultado: el primer trozo edita el "pensando...", el resto van como mensajes nuevos; los botones van al final. */
async function send(i: ChatInputCommandInteraction | ButtonInteraction, out: Out, mode: "edit" | "followUp") {
  const [first, ...rest] = splitMessage(out.text);
  const chunks = [first, ...rest];
  for (let k = 0; k < chunks.length; k++) {
    const last = k === chunks.length - 1;
    const payload = { content: chunks[k], allowedMentions: NO_MENTIONS, components: last && out.rolls?.length ? rollButtons(out.rolls) : [] };
    if (k === 0 && mode === "edit") await i.editReply(payload);
    else await i.followUp(payload);
  }
}

/** Responde "pensando..." de inmediato (Discord exige respuesta en 3 s) y publica el resultado cuando esté listo. */
async function deferAndRun(i: ChatInputCommandInteraction, work: () => Promise<string | Out>, after?: () => Promise<void>) {
  await i.deferReply();
  let out: Out;
  try {
    const r = await work();
    out = typeof r === "string" ? { text: r } : r;
  } catch (e) {
    console.error(e);
    out = { text: `⚠️ El DM tuvo un problema: ${(e as Error).message}\nSus acciones siguen guardadas; prueben \`/narrar\`.` };
  }
  await send(i, out, "edit").catch((e) => console.error("No se pudo publicar en Discord", e));
  if (after) await after().catch((e) => console.error("compactación", e));
}

/** El árbitro decide si hacen falta tiradas; si no, el DM narra. */
async function advanceTurn(ch: string, header: string): Promise<Out> {
  const r = await advance(env, ch);
  if (r.kind === "rolls") return { text: `${header}\n\n${rollsMessage(r.rolls)}`, rolls: r.rolls };
  return { text: `${header}\n\n${r.text}` };
}

/** Si todos los jugadores ya actuaron, pasa al árbitro; si no, avisa a quién se espera. */
async function registerAndMaybeNarrate(i: ChatInputCommandInteraction, ch: string, userId: string, line: string, header: string) {
  await db.addPending(ch, userId, line);
  const [players, pending, rolls] = await Promise.all([db.getPlayers(ch), db.getPending(ch), db.getRollRequests(ch)]);
  if (rolls.length) {
    return reply(i, `${header}\n-# Esperando las tiradas de: ${rolls.map((r) => r.character).join(", ")} · o usen /narrar`);
  }
  const acted = new Set(pending.map((p) => p.user_id));
  const waiting = players.filter((p) => !acted.has(p.user_id));
  if (waiting.length > 0) {
    return reply(i, `${header}\n-# Esperando a: ${waiting.map((p) => p.character).join(", ")} · o usen /narrar`);
  }
  return deferAndRun(
    i,
    () => advanceTurn(ch, header),
    () => maybeCompact(env, ch),
  );
}

/** Botón 🎲 de una tirada pedida por el árbitro. Cuando se hace la última, el DM narra. */
async function handleRollButton(i: ButtonInteraction) {
  const ch = i.channelId;
  const id = Number(i.customId.split(":")[1]);
  const req = (await db.getRollRequests(ch)).find((r) => r.id === id);
  if (!req) return i.reply({ content: "Esa tirada ya no está pendiente.", flags: MessageFlags.Ephemeral });
  if (req.user_id !== i.user.id) return i.reply({ content: `Esa tirada es de **${req.character}**.`, flags: MessageFlags.Ephemeral });

  const out = await resolveRoll(ch, i.user.id, { rollId: id });
  if (!out) return i.reply({ content: "Esa tirada ya se hizo.", flags: MessageFlags.Ephemeral });
  await i.update({ content: `${i.message.content}\n${out.display}`.slice(0, 2000), components: rollButtons(out.remaining), allowedMentions: NO_MENTIONS });
  if (out.remaining.length) return;

  if (i.channel && "sendTyping" in i.channel) await i.channel.sendTyping().catch(() => {});
  let text: string;
  try {
    text = await runTurn(env, ch);
  } catch (e) {
    console.error(e);
    text = `⚠️ El DM tuvo un problema: ${(e as Error).message}\nLas tiradas quedaron guardadas; prueben \`/narrar\`.`;
  }
  await send(i, { text }, "followUp").catch((e) => console.error("No se pudo publicar en Discord", e));
  await maybeCompact(env, ch).catch((e) => console.error("compactación", e));
}

async function handleCommand(i: ChatInputCommandInteraction) {
  const ch = i.channelId;
  const userId = i.user.id;
  db.rememberChannel(ch, i.channel && "name" in i.channel ? (i.channel.name ?? undefined) : undefined);
  const o = i.options;

  switch (i.commandName) {
    case "unirse": {
      const character = o.getString("personaje", true).trim().slice(0, 60);
      const description = (o.getString("descripcion") ?? "").trim().slice(0, 500);
      await db.upsertPlayer(ch, userId, character, description);
      return reply(i, `🛡️ <@${userId}> juega como **${character}**${description ? ` — ${description}` : ""}.`);
    }

    case "importar": {
      let source: SheetSource;
      const file = o.getAttachment("archivo");
      const link = o.getString("enlace");
      try {
        if (file) {
          source = { kind: "pdf", attachment: checkAttachment({ url: file.url, filename: file.name, size: file.size, content_type: file.contentType ?? undefined }) };
        } else if (link) {
          checkUrl(link);
          source = { kind: "link", link };
        } else {
          return reply(i, "📥 Adjuntá el **PDF** de tu ficha en `archivo` (o pegá un enlace de Nivel20 en `enlace`).", true);
        }
      } catch (e) {
        return reply(i, `📥 ${(e as Error).message}`, true);
      }
      return deferAndRun(i, async () => {
        try {
          const r = await importSheet(env, ch, userId, source);
          const from = source.kind === "pdf" ? "un PDF" : "Nivel20";
          const lines: string[] = [];
          if (r.verified) lines.push(`🔍 ${r.verified} números leídos directamente de la ficha, sin IA.`);
          if (r.corrected.length) lines.push(`🔧 Corregí ${r.corrected.length} que la IA había leído mal:\n${r.corrected.map((c) => `• ${c}`).join("\n")}`);
          if (!r.stats) lines.push("⚠️ No pude leer las estadísticas exactas: el bot no va a poder calcular tus bonificadores. Revisá la ficha con /ficha.");
          else if (r.warnings.length) lines.push(`⚠️ **Revisá estos números** (si están mal, corregilos en la nota de tu personaje en Obsidian):\n${r.warnings.map((w) => `• ${w}`).join("\n")}`);
          else lines.push("✅ Todos los bonificadores cuadran con tus características y tu competencia.");
          const check = `\n${lines.join("\n")}`;
          return `📥 <@${userId}> importó a **${r.character}** desde ${from} — ${r.description}${check}\n-# Mirá todos los números que va a usar el bot con /ficha. Si tu personaje cambia, volvé a usar /importar.`;
        } catch (e) {
          return `📥 No pude importar la ficha: ${(e as Error).message}`;
        }
      });
    }

    case "ficha": {
      const targetId = o.getUser("jugador")?.id ?? userId;
      const player = await db.getPlayer(ch, targetId);
      if (!player) return reply(i, targetId === userId ? "No tenés personaje en este canal. Usá `/importar` o `/unirse`." : "Ese jugador no tiene personaje en este canal.", true);
      if (!player.sheet) {
        return reply(i, `**${player.character}**${player.description ? ` — ${player.description}` : ""}\n-# Sin ficha importada. Usá \`/importar\` y adjuntá el PDF de tu ficha.`, true);
      }
      const source = player.sheet_url ? `\n-# Fuente: ${player.sheet_url.startsWith("http") ? `<${player.sheet_url}>` : player.sheet_url}` : "";
      const numbers = player.stats
        ? `\n**Números que usa el bot para tus tiradas:**\n\`\`\`\n${statsSummary(player.stats)}\n\`\`\``
        : "\n⚠️ Sin estadísticas exactas: el bot busca los bonificadores en el texto de la ficha.";
      const state = stateLine(player.state, player.stats?.hp_max);
      const head = `📜 **${player.character}**${player.description ? ` — ${player.description}` : ""}${state ? `\n**En la campaña:** ${state}` : ""}${numbers}`;
      const room = 2000 - head.length - source.length - 12;
      const sheet = room > 100 ? `\n\`\`\`\n${player.sheet.length > room ? player.sheet.slice(0, room - 1) + "…" : player.sheet}\n\`\`\`` : "";
      return reply(i, `${head}${sheet}${source}`, true);
    }

    case "salir": {
      const player = await db.getPlayer(ch, userId);
      if (!player) return reply(i, "No estás en la campaña de este canal.", true);
      await db.removePlayer(ch, userId);
      return reply(i, `👋 **${player.character}** deja la mesa.`);
    }

    case "campaña": {
      const setting = o.getString("ambientacion", true).trim().slice(0, 500);
      const tone = (o.getString("tono") ?? "aventura de fantasía clásica").trim().slice(0, 200);
      await db.resetCampaign(ch, setting, tone);
      return deferAndRun(i, async () => {
        const narration = await runTurn(
          env,
          ch,
          "Comienza la campaña. Presentá brevemente el mundo y la escena inicial, involucrando a cada personaje, y preguntá qué hace cada uno.",
        );
        return `🎲 **Nueva campaña** — ${setting} · *${tone}*\n\n${narration}`;
      });
    }

    case "accion": {
      if (!(await db.getCampaign(ch))) return reply(i, "No hay campaña en este canal. Empiecen con `/campaña`.", true);
      const player = await db.getPlayer(ch, userId);
      if (!player) return reply(i, "Primero traé tu personaje con `/importar` (PDF de tu ficha) o `/unirse`.", true);
      const text = o.getString("texto", true).trim().slice(0, 1000);
      return registerAndMaybeNarrate(i, ch, userId, `${player.character}: ${text}`, `📝 **${player.character}**: ${text}`);
    }

    case "tirar": {
      const dice = o.getString("dados", true);
      let result;
      try {
        result = rollDice(dice);
      } catch (e) {
        return reply(i, `🎲 ${(e as Error).message}. Ejemplos: \`1d20+5\`, \`2d20kh1\` (ventaja), \`2d20kl1\` (desventaja), \`8d6\`.`, true);
      }
      const player = await db.getPlayer(ch, userId);
      const who = player ? `**${player.character}**` : `<@${userId}>`;
      const header = `🎲 ${who} tira \`${dice}\`: ${result.detail} = **${result.total}**${result.note ? ` ${result.note}` : ""}`;

      const camp = await db.getCampaign(ch);
      if (!camp || !player) return reply(i, header);

      // Si el árbitro le había pedido una tirada a este jugador, este resultado la resuelve.
      if ((await db.getRollRequests(ch)).some((r) => r.user_id === userId)) {
        const out = await resolveRoll(ch, userId, { manual: result, expr: dice });
        if (out && !out.remaining.length) {
          return deferAndRun(
            i,
            async () => `${out.display}\n\n${await runTurn(env, ch)}`,
            () => maybeCompact(env, ch),
          );
        }
        if (out) return reply(i, `${out.display}\n-# Esperando las tiradas de: ${out.remaining.map((r) => r.character).join(", ")}`);
      }
      const line = `${player.character} tira ${dice}: ${result.detail.replace(/~~/g, "")} = ${result.total}${result.note ? ` (${result.note})` : ""}`;
      return registerAndMaybeNarrate(i, ch, userId, line, header);
    }

    case "narrar":
      return deferAndRun(
        i,
        () => runTurn(env, ch),
        () => maybeCompact(env, ch),
      );

    case "ooc": {
      const player = await db.getPlayer(ch, userId);
      const question = o.getString("pregunta", true).trim().slice(0, 1000);
      const who = player?.character ?? "Un jugador";
      return deferAndRun(i, async () => `💬 **${who}** (fuera de personaje): ${question}\n\n${await askOoc(env, ch, who, question)}`);
    }

    case "cuota":
      return reply(i, quotaReport(env), true);

    case "estado": {
      const camp = await db.getCampaign(ch);
      if (!camp) return reply(i, "No hay campaña en este canal. Empiecen con `/campaña`.", true);
      const [players, pending, rolls] = await Promise.all([db.getPlayers(ch), db.getPending(ch), db.getRollRequests(ch)]);
      const lines = [
        `📜 **${camp.setting}** · *${camp.tone}*`,
        `**Personajes:** ${players.length ? players.map((p) => p.character).join(", ") : "nadie todavía"}`,
        `**Acciones pendientes:** ${pending.length ? "\n" + pending.map((p) => `• ${p.content}`).join("\n") : "ninguna"}`,
      ];
      if (rolls.length) lines.push(`**Tiradas por hacer:** ${rolls.map((r) => `${r.character} (${r.tipo})`).join(", ")}`);
      if (camp.summary) lines.push(`**Resumen:**\n${camp.summary}`);
      return reply(i, lines.join("\n"), true);
    }

    default:
      return reply(i, "Comando desconocido.", true);
  }
}

/**
 * Dos copias del bot a la vez reciben los mismos comandos y escriben en la misma bóveda: la que responde primero gana
 * y la otra puede duplicar acciones. Por eso el bot deja su número de proceso en la bóveda y no arranca si ya hay otro.
 */
async function singleInstance(folder: string) {
  const lock = path.join(folder, ".bot.pid");
  const other = Number(await fs.readFile(lock, "utf8").catch(() => ""));
  if (other && other !== process.pid) {
    let alive = false;
    try {
      process.kill(other, 0);
      alive = true;
    } catch {
      // el proceso ya no existe: el archivo quedó de una vez que el bot se cerró mal
    }
    if (alive) throw new Error(`Ya hay otra copia del bot corriendo (proceso ${other}). Cerrala primero (Ctrl+C en su terminal, o: kill ${other}).`);
  }
  await fs.writeFile(lock, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch {
      // ya no estaba
    }
  };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      console.log("👋 DM bot cerrado");
      process.exit(0);
    });
  }
}

async function main() {
  const { DISCORD_TOKEN, OBSIDIAN_VAULT, OBSIDIAN_FOLDER } = process.env;
  if (!DISCORD_TOKEN) throw new Error("Falta DISCORD_TOKEN en .env");
  if (!OBSIDIAN_VAULT) throw new Error("Falta OBSIDIAN_VAULT en .env (la carpeta de tu bóveda de Obsidian)");
  if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY en .env");

  const folder = await db.initVault(OBSIDIAN_VAULT, OBSIDIAN_FOLDER || "DnD");
  await singleInstance(folder);
  await initQuota(folder);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (c) => console.log(`🎲 DM bot conectado como ${c.user.tag} · campañas en ${folder}`));
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand() && !(i.isButton() && i.customId.startsWith("tirar:"))) return;
    try {
      if (i.isButton()) await handleRollButton(i);
      else await handleCommand(i);
    } catch (e) {
      console.error(e);
      const content = `⚠️ Error: ${(e as Error).message}`.slice(0, 2000);
      if (i.deferred || i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      else await i.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  warmUp(env).then((ok) =>
    console.log(ok ? `🧠 Árbitro local listo (${ollamaModel(env)})` : `⚠️ Ollama no responde: el árbitro usará Gemini liviano. Arrancalo con: systemctl --user start ollama`),
  );
  await client.login(DISCORD_TOKEN);
}

main().catch((e) => {
  console.error(`❌ ${(e as Error).message}`);
  process.exit(1);
});
