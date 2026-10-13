// Registra los comandos slash en Discord.
// Uso: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... [DISCORD_GUILD_ID=...] node scripts/register-commands.mjs
// Con DISCORD_GUILD_ID los comandos aparecen al instante en ese servidor; sin él son globales (pueden tardar en aparecer).

const STRING = 3;
const USER = 6;
const ATTACHMENT = 11;
const commands = [
  {
    name: "unirse",
    description: "Unirte a la campaña de este canal con tu personaje",
    options: [
      { type: STRING, name: "personaje", description: "Nombre del personaje", required: true },
      { type: STRING, name: "descripcion", description: "Raza, clase, nivel, rasgos, HP…", required: false },
    ],
  },
  {
    name: "importar",
    description: "Traer tu personaje desde el PDF de tu ficha (o un enlace de Nivel20)",
    options: [
      { type: ATTACHMENT, name: "archivo", description: "PDF de la ficha (Nivel20 → Imprimir en PDF, D&D Beyond, hoja oficial)", required: false },
      { type: STRING, name: "enlace", description: "Alternativa: enlace de Compartir de Nivel20", required: false },
    ],
  },
  {
    name: "ficha",
    description: "Ver la ficha de tu personaje (o la de otro jugador)",
    options: [{ type: USER, name: "jugador", description: "Jugador cuya ficha querés ver", required: false }],
  },
  { name: "salir", description: "Sacar a tu personaje de la campaña" },
  {
    name: "campaña",
    description: "Empezar una campaña nueva en este canal (borra la anterior)",
    options: [
      { type: STRING, name: "ambientacion", description: "Mundo o premisa de la aventura", required: true },
      { type: STRING, name: "tono", description: "épico, oscuro, humor, terror…", required: false },
    ],
  },
  {
    name: "accion",
    description: "Declarar lo que hace o dice tu personaje",
    options: [{ type: STRING, name: "texto", description: "Qué hacés", required: true }],
  },
  {
    name: "tirar",
    description: "Tirar dados: 1d20+5, 2d20kh1 (ventaja), 2d20kl1 (desventaja), 8d6",
    options: [{ type: STRING, name: "dados", description: "Expresión de dados", required: true }],
  },
  { name: "narrar", description: "Que el DM continúe sin esperar a todos" },
  {
    name: "ooc",
    description: "Pregunta fuera de personaje (reglas, aclaraciones)",
    options: [{ type: STRING, name: "pregunta", description: "Tu pregunta", required: true }],
  },
  { name: "estado", description: "Ver personajes, acciones pendientes y resumen de la campaña" },
];

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN) {
  console.error("Faltan DISCORD_APP_ID y/o DISCORD_BOT_TOKEN");
  process.exit(1);
}

const url = DISCORD_GUILD_ID
  ? `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${DISCORD_GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: { "content-type": "application/json", authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error("Error", res.status, await res.text());
  process.exit(1);
}
console.log(`✅ ${commands.length} comandos registrados ${DISCORD_GUILD_ID ? "en el servidor" : "globalmente"}`);
