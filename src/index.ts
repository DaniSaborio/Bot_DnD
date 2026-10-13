import { verifyDiscordRequest, json, reply, postDeferred, InteractionType, ResponseType } from "./discord";
import * as db from "./db";
import { rollDice } from "./dice";
import { checkUrl } from "./nivel20";
import { checkAttachment, type DiscordAttachment } from "./pdf";
import { runTurn, askOoc, maybeCompact, importSheet, type GameEnv, type SheetSource } from "./game";

export interface Env extends GameEnv {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
}

type Interaction = {
  type: number;
  token: string;
  channel_id?: string;
  channel?: { id: string };
  member?: { user: { id: string } };
  user?: { id: string };
  data: {
    name: string;
    options?: { name: string; value: string }[];
    resolved?: { attachments?: Record<string, DiscordAttachment> };
  };
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") return new Response("🎲 DM bot activo", { status: 200 });

    const body = await req.text();
    if (!(await verifyDiscordRequest(req, body, env.DISCORD_PUBLIC_KEY))) {
      return new Response("Firma inválida", { status: 401 });
    }

    const interaction = JSON.parse(body) as Interaction;
    if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      try {
        return await handleCommand(interaction, env, ctx);
      } catch (e) {
        console.error(e);
        return reply(`⚠️ Error: ${(e as Error).message}`, true);
      }
    }
    return json({ error: "Tipo de interacción no soportado" }, 400);
  },
} satisfies ExportedHandler<Env>;

/** Responde "pensando..." de inmediato (Discord exige respuesta en 3 s) y publica el resultado cuando esté listo. */
function deferAndRun(ctx: ExecutionContext, env: Env, i: Interaction, work: () => Promise<string>, after?: () => Promise<void>): Response {
  ctx.waitUntil(
    (async () => {
      let text: string;
      try {
        text = await work();
      } catch (e) {
        console.error(e);
        text = `⚠️ El DM tuvo un problema: ${(e as Error).message}\nSus acciones siguen guardadas; prueben \`/narrar\`.`;
      }
      await postDeferred(env.DISCORD_APP_ID, i.token, text).catch((e) => console.error("No se pudo publicar en Discord", e));
      if (after) await after().catch((e) => console.error("compactación", e));
    })(),
  );
  return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE });
}

/** Si todos los jugadores ya actuaron, dispara la narración; si no, avisa a quién se espera. */
async function registerAndMaybeNarrate(i: Interaction, env: Env, ctx: ExecutionContext, ch: string, userId: string, line: string, header: string) {
  await db.addPending(env.DB, ch, userId, line);
  const [players, pending] = await Promise.all([db.getPlayers(env.DB, ch), db.getPending(env.DB, ch)]);
  const acted = new Set(pending.map((p) => p.user_id));
  const waiting = players.filter((p) => !acted.has(p.user_id));

  if (waiting.length > 0) {
    return reply(`${header}\n-# Esperando a: ${waiting.map((p) => p.character).join(", ")} · o usen /narrar`);
  }
  return deferAndRun(
    ctx,
    env,
    i,
    async () => `${header}\n\n${await runTurn(env, ch)}`,
    () => maybeCompact(env, ch),
  );
}

async function handleCommand(i: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ch = i.channel_id ?? i.channel?.id;
  const userId = i.member?.user.id ?? i.user?.id;
  if (!ch || !userId) return reply("No pude identificar el canal o el usuario.", true);
  const opts = Object.fromEntries((i.data.options ?? []).map((o) => [o.name, String(o.value)]));

  switch (i.data.name) {
    case "unirse": {
      const character = opts.personaje.trim().slice(0, 60);
      const description = (opts.descripcion ?? "").trim().slice(0, 500);
      await db.upsertPlayer(env.DB, ch, userId, character, description);
      return reply(`🛡️ <@${userId}> juega como **${character}**${description ? ` — ${description}` : ""}.`);
    }

    case "importar": {
      let source: SheetSource;
      try {
        if (opts.archivo) {
          source = { kind: "pdf", attachment: checkAttachment(i.data.resolved?.attachments?.[opts.archivo]) };
        } else if (opts.enlace) {
          checkUrl(opts.enlace);
          source = { kind: "link", link: opts.enlace };
        } else {
          return reply("📥 Adjuntá el **PDF** de tu ficha en `archivo` (o pegá un enlace de Nivel20 en `enlace`).", true);
        }
      } catch (e) {
        return reply(`📥 ${(e as Error).message}`, true);
      }
      return deferAndRun(ctx, env, i, async () => {
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
      const targetId = opts.jugador ?? userId;
      const player = await db.getPlayer(env.DB, ch, targetId);
      if (!player) return reply(targetId === userId ? "No tenés personaje en este canal. Usá `/importar` o `/unirse`." : "Ese jugador no tiene personaje en este canal.", true);
      if (!player.sheet) {
        return reply(`**${player.character}**${player.description ? ` — ${player.description}` : ""}\n-# Sin ficha importada. Usá \`/importar\` y adjuntá el PDF de tu ficha.`, true);
      }
      const source = player.sheet_url
        ? `\n-# Fuente: ${player.sheet_url.startsWith("http") ? `<${player.sheet_url}>` : player.sheet_url}`
        : "";
      return reply(`📜 **${player.character}**${player.description ? ` — ${player.description}` : ""}\n\`\`\`\n${player.sheet.slice(0, 1700)}\n\`\`\`${source}`, true);
    }

    case "salir": {
      const player = await db.getPlayer(env.DB, ch, userId);
      if (!player) return reply("No estás en la campaña de este canal.", true);
      await db.removePlayer(env.DB, ch, userId);
      return reply(`👋 **${player.character}** deja la mesa.`);
    }

    case "campaña": {
      const setting = opts.ambientacion.trim().slice(0, 500);
      const tone = (opts.tono ?? "aventura de fantasía clásica").trim().slice(0, 200);
      await db.resetCampaign(env.DB, ch, setting, tone);
      return deferAndRun(ctx, env, i, async () => {
        const narration = await runTurn(
          env,
          ch,
          "Comienza la campaña. Presentá brevemente el mundo y la escena inicial, involucrando a cada personaje, y preguntá qué hace cada uno.",
        );
        return `🎲 **Nueva campaña** — ${setting} · *${tone}*\n\n${narration}`;
      });
    }

    case "accion": {
      if (!(await db.getCampaign(env.DB, ch))) return reply("No hay campaña en este canal. Empiecen con `/campaña`.", true);
      const player = await db.getPlayer(env.DB, ch, userId);
      if (!player) return reply("Primero traé tu personaje con `/importar` (PDF de tu ficha) o `/unirse`.", true);
      const text = opts.texto.trim().slice(0, 1000);
      return registerAndMaybeNarrate(i, env, ctx, ch, userId, `${player.character}: ${text}`, `📝 **${player.character}**: ${text}`);
    }

    case "tirar": {
      let result;
      try {
        result = rollDice(opts.dados);
      } catch (e) {
        return reply(`🎲 ${(e as Error).message}. Ejemplos: \`1d20+5\`, \`2d20kh1\` (ventaja), \`2d20kl1\` (desventaja), \`8d6\`.`, true);
      }
      const player = await db.getPlayer(env.DB, ch, userId);
      const who = player ? `**${player.character}**` : `<@${userId}>`;
      const header = `🎲 ${who} tira \`${opts.dados}\`: ${result.detail} = **${result.total}**${result.note ? ` ${result.note}` : ""}`;

      const camp = await db.getCampaign(env.DB, ch);
      if (!camp || !player) return reply(header);
      const line = `${player.character} tira ${opts.dados}: ${result.detail.replace(/~~/g, "")} = ${result.total}${result.note ? ` (${result.note})` : ""}`;
      return registerAndMaybeNarrate(i, env, ctx, ch, userId, line, header);
    }

    case "narrar":
      return deferAndRun(
        ctx,
        env,
        i,
        () => runTurn(env, ch),
        () => maybeCompact(env, ch),
      );

    case "ooc": {
      const player = await db.getPlayer(env.DB, ch, userId);
      const question = opts.pregunta.trim().slice(0, 1000);
      const who = player?.character ?? "Un jugador";
      return deferAndRun(ctx, env, i, async () => `💬 **${who}** (fuera de personaje): ${question}\n\n${await askOoc(env, ch, who, question)}`);
    }

    case "estado": {
      const camp = await db.getCampaign(env.DB, ch);
      if (!camp) return reply("No hay campaña en este canal. Empiecen con `/campaña`.", true);
      const [players, pending] = await Promise.all([db.getPlayers(env.DB, ch), db.getPending(env.DB, ch)]);
      const lines = [
        `📜 **${camp.setting}** · *${camp.tone}*`,
        `**Personajes:** ${players.length ? players.map((p) => p.character).join(", ") : "nadie todavía"}`,
        `**Acciones pendientes:** ${pending.length ? "\n" + pending.map((p) => `• ${p.content}`).join("\n") : "ninguna"}`,
      ];
      if (camp.summary) lines.push(`**Resumen:**\n${camp.summary}`);
      return reply(lines.join("\n"), true);
    }

    default:
      return reply("Comando desconocido.", true);
  }
}
