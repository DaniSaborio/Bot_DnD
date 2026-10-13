import { Client, Events, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { splitMessage } from "./discord";
import * as db from "./vault";
import { rollDice } from "./dice";
import { checkUrl } from "./nivel20";
import { checkAttachment } from "./pdf";
import { runTurn, askOoc, maybeCompact, importSheet, type GameEnv, type SheetSource } from "./game";

try {
  process.loadEnvFile();
} catch {
  // Sin .env: se usan las variables de entorno del sistema.
}

const env: GameEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_THINKING: process.env.GEMINI_THINKING,
};

const NO_MENTIONS = { parse: [] };

function reply(i: ChatInputCommandInteraction, content: string, ephemeral = false) {
  return i.reply({ content: content.slice(0, 2000), flags: ephemeral ? MessageFlags.Ephemeral : undefined, allowedMentions: NO_MENTIONS });
}

/** Responde "pensando..." de inmediato (Discord exige respuesta en 3 s) y publica el resultado cuando esté listo. */
async function deferAndRun(i: ChatInputCommandInteraction, work: () => Promise<string>, after?: () => Promise<void>) {
  await i.deferReply();
  let text: string;
  try {
    text = await work();
  } catch (e) {
    console.error(e);
    text = `⚠️ El DM tuvo un problema: ${(e as Error).message}\nSus acciones siguen guardadas; prueben \`/narrar\`.`;
  }
  const [first, ...rest] = splitMessage(text);
  try {
    await i.editReply({ content: first, allowedMentions: NO_MENTIONS });
    for (const chunk of rest) await i.followUp({ content: chunk, allowedMentions: NO_MENTIONS });
  } catch (e) {
    console.error("No se pudo publicar en Discord", e);
  }
  if (after) await after().catch((e) => console.error("compactación", e));
}

/** Si todos los jugadores ya actuaron, dispara la narración; si no, avisa a quién se espera. */
async function registerAndMaybeNarrate(i: ChatInputCommandInteraction, ch: string, userId: string, line: string, header: string) {
  await db.addPending(ch, userId, line);
  const [players, pending] = await Promise.all([db.getPlayers(ch), db.getPending(ch)]);
  const acted = new Set(pending.map((p) => p.user_id));
  const waiting = players.filter((p) => !acted.has(p.user_id));

  if (waiting.length > 0) {
    return reply(i, `${header}\n-# Esperando a: ${waiting.map((p) => p.character).join(", ")} · o usen /narrar`);
  }
  return deferAndRun(
    i,
    async () => `${header}\n\n${await runTurn(env, ch)}`,
    () => maybeCompact(env, ch),
  );
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
          return `📥 <@${userId}> importó a **${r.character}** desde ${from} — ${r.description}\n-# El DM ya usa su ficha. Si tu personaje cambia, volvé a usar /importar. Ver la ficha: /ficha`;
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
      return reply(i, `📜 **${player.character}**${player.description ? ` — ${player.description}` : ""}\n\`\`\`\n${player.sheet.slice(0, 1700)}\n\`\`\`${source}`, true);
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

    case "estado": {
      const camp = await db.getCampaign(ch);
      if (!camp) return reply(i, "No hay campaña en este canal. Empiecen con `/campaña`.", true);
      const [players, pending] = await Promise.all([db.getPlayers(ch), db.getPending(ch)]);
      const lines = [
        `📜 **${camp.setting}** · *${camp.tone}*`,
        `**Personajes:** ${players.length ? players.map((p) => p.character).join(", ") : "nadie todavía"}`,
        `**Acciones pendientes:** ${pending.length ? "\n" + pending.map((p) => `• ${p.content}`).join("\n") : "ninguna"}`,
      ];
      if (camp.summary) lines.push(`**Resumen:**\n${camp.summary}`);
      return reply(i, lines.join("\n"), true);
    }

    default:
      return reply(i, "Comando desconocido.", true);
  }
}

async function main() {
  const { DISCORD_TOKEN, OBSIDIAN_VAULT, OBSIDIAN_FOLDER } = process.env;
  if (!DISCORD_TOKEN) throw new Error("Falta DISCORD_TOKEN en .env");
  if (!OBSIDIAN_VAULT) throw new Error("Falta OBSIDIAN_VAULT en .env (la carpeta de tu bóveda de Obsidian)");
  if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY en .env");

  const folder = await db.initVault(OBSIDIAN_VAULT, OBSIDIAN_FOLDER || "DnD");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (c) => console.log(`🎲 DM bot conectado como ${c.user.tag} · campañas en ${folder}`));
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand()) return;
    try {
      await handleCommand(i);
    } catch (e) {
      console.error(e);
      const content = `⚠️ Error: ${(e as Error).message}`.slice(0, 2000);
      if (i.deferred || i.replied) await i.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      else await i.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  await client.login(DISCORD_TOKEN);
}

main().catch((e) => {
  console.error(`❌ ${(e as Error).message}`);
  process.exit(1);
});
