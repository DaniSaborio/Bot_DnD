# 🎲 DnD DM Bot

Bot de Discord que hace de Dungeon Master, **100% gratis**: **Google Gemini** narra la historia (capa gratuita) y un modelo local con **Ollama** hace de árbitro de reglas y decide las tiradas. Corre en tu propia computadora y guarda todo en tu **bóveda de Obsidian**: campañas, personajes, fichas e historial quedan como notas Markdown que podés leer y editar. Cada canal de Discord es una campaña independiente.

## Cómo se juega

| Comando | Qué hace |
|---|---|
| `/importar archivo` | Trae tu personaje desde el **PDF de tu ficha** (ver abajo). También acepta `enlace` de Nivel20 |
| `/unirse personaje descripcion` | Alternativa sin Nivel20: te une con nombre y descripción a mano (ej. `Kael` · `humano guerrero nv1, 12 HP`) |
| `/ficha [jugador]` | Ver tu ficha o la de otro jugador (solo la ves vos) |
| `/campaña ambientacion tono` | Empieza una campaña nueva y el DM narra la escena inicial. La anterior del canal se mueve a `Archivo/` en Obsidian |
| `/accion texto` | Declarás lo que hace tu personaje |
| `/tirar dados` | Tira dados a mano: `1d20+5`, `2d20kh1` (ventaja), `2d20kl1` (desventaja), `4d6kh3`, `8d6` |
| `/narrar` | El DM continúa sin esperar a todos |
| `/ooc pregunta` | Pregunta fuera de personaje (reglas, dudas); no afecta la historia |
| `/estado` | Ver personajes, acciones pendientes y el resumen (solo lo ves vos) |
| `/cuota` | Ver cuánta IA gratis se usó hoy, cuánto queda y a qué hora se recarga |
| `/salir` | Saca a tu personaje de la mesa |

**Turnos:**
1. Cada jugador declara lo que hace con `/accion`.
2. Cuando **todos** actuaron, el **árbitro** mira las fichas y la escena y decide si alguna acción necesita tirada (ej. *Kael: Atletismo, CD 15*). Si hace falta, aparece un botón **🎲** para cada uno, con el bonificador de su ficha.
3. Cada uno toca su botón: el bot tira, compara con la CD y, si es un ataque que pega, tira también el daño (doble en un 20 natural).
4. Con todos los resultados, el DM narra **una sola vez** lo que pasó.

Si el árbitro no pide tiradas, el DM narra directamente. Si alguien no tiene nada que hacer, o no quieren esperar una tirada, usen `/narrar`.

**Dados:** las tiradas son reales y el DM respeta el resultado. La CD se decide *antes* de tirar, así que no se puede acomodar. Si preferís tirar a mano, `/tirar` también resuelve la tirada que te pidió el árbitro.

**Memoria:** cuando la historia crece, el bot resume lo más viejo automáticamente (historia, estado de personajes, NPCs, misiones), así la campaña puede durar meses sin perder el hilo.

Orden recomendado para la primera sesión: los dos hacen `/importar` con su PDF, luego uno hace `/campaña`.

## Personajes desde un PDF

1. Exportá la ficha como PDF:
   - **Nivel20:** abrí la ficha → **Imprimir en PDF**.
   - **D&D Beyond:** ficha → *Export to PDF*.
   - **Hoja oficial de 5e rellenable:** llenala en la compu y guardala.
2. En el canal escribí `/importar`, elegí el campo **archivo** y adjuntá el PDF.

El bot lee el texto del PDF (y los campos, si es una hoja rellenable) y guarda dos cosas:
- **Los números exactos** (características, competencia, salvaciones, habilidades, ataques, CA, HP), que se usan para calcular cada tirada.
- **Una ficha compacta en texto** (rasgos, conjuros, equipo), para el contexto.

**Cómo se asegura de que los números estén bien:**
1. Un **lector en código, sin IA**, saca los números directamente del texto del PDF: lee los campos de la hoja rellenable por su nombre, o busca el número al lado de cada habilidad y se queda con la lectura que cuadra con tus características y tu competencia. La IA solo completa lo que el código no encuentra.
2. Si la IA leyó un número distinto, **manda lo que dice la ficha** y `/importar` te muestra qué corrigió.
3. Si algún número no cuadra con *característica + competencia* (por ejemplo, por un objeto mágico), `/importar` te lo marca para que lo revises.
4. Con `/ficha` ves **todos** los números que va a usar el bot, incluidos los que se calculan (por ejemplo, una habilidad sin competencia es solo el modificador).

**En las tiradas la IA nunca pone el número.** El árbitro solo elige *qué* se tira (por ejemplo, Sigilo) y la CD; el bonificador lo calcula el código con tu ficha, y en cada tirada se muestra de dónde salió (*Sigilo +1: DES +1, sin competencia*).

Cuando tu personaje cambie (subís de nivel, nuevo equipo), exportá el PDF otra vez y volvé a usar `/importar`. Con `/ficha` ves lo que leyó el bot. Si después usás `/unirse` para cambiar el nombre, la ficha se conserva.

**Requisitos del PDF:** tiene que ser generado por computadora, de hasta 10 MB. Una foto o un escaneo de una hoja en papel no tiene texto que el bot pueda leer.

**Alternativa con enlace:** `/importar enlace:<enlace de Compartir de Nivel20>` lee la ficha pública directamente. Depende de que Nivel20 permita el acceso; si falla, usá el PDF.

## Las campañas en Obsidian

Todo se guarda en `<tu bóveda>/DnD/` (la carpeta se cambia con `OBSIDIAN_FOLDER`), una carpeta por canal de Discord:

```
DnD/
└── campaña-brumas (123456789012345678)/
    ├── Campaña.md        ambientación, tono y resumen de lo ocurrido
    ├── Historial.md      todos los turnos: acciones de los jugadores y narraciones del DM
    ├── Pendientes.md     acciones declaradas y tiradas pedidas que el DM todavía no narró
    ├── Personajes/
    │   ├── Kael.md       ficha de cada personaje
    │   └── Lyra.md
    └── Archivo/          campañas anteriores de este canal
```

**Podés editar en Obsidian** y el bot usa los cambios en el siguiente turno, sin reiniciarlo:
- **Números de la ficha** (`Personajes/*.md`, en las propiedades de arriba): `fue`, `des`… (puntuaciones), `competencia`, `ca`, `hp_max`, y las listas `salvaciones`, `habilidades` y `ataques` (ej. `Sigilo +7`, `Daga +5 · 1d4+3`). Son los que usa el bot para cada tirada: si algo está mal, corregilo ahí.
- **Ficha en texto** (`Personajes/*.md`, debajo de `## Ficha`): rasgos, conjuros, equipo. Agregá un objeto mágico o lo que quieras.
- **Lo que pasa en la campaña** (`Personajes/*.md`, propiedades `inventario`, `hp_actual`, `po`/`pp`/`pc`…, `condiciones`, `objetos_perdidos`): se actualiza **solo** durante la partida. Cuando tu personaje agarra, compra o recibe un objeto, gasta o gana dinero, recibe daño o curación, o queda envenenado, el DM lo anota y el bot lo escribe en tu nota (también se ve en la sección `## En la campaña`). En Discord aparece una línea `📝 Anotado en la hoja: …` para que sepas qué se guardó. Si algo quedó mal, corregí la propiedad a mano. Volver a hacer `/importar` (por ejemplo al subir de nivel) conserva todo esto.
- **Resumen** (`Campaña.md`): lo que esté debajo de `## Resumen` es la memoria del DM. Podés agregar notas propias (NPCs, secretos, ganchos de trama).
- **Historial**: se puede leer y releer como el diario de la partida. Si lo editás, no borres las marcas `<!-- msg N ... -->` (en modo lectura no se ven); son las que usa el bot para separar los turnos.

No cambies el `(número)` al final del nombre de la carpeta: es el ID del canal y así la encuentra el bot. El resto del nombre sí lo podés cambiar. Tampoco edites el bloque `---` de arriba de cada nota (las propiedades), salvo que sepas lo que hacés.

Cuando el historial crece, el bot resume lo más viejo en `Campaña.md` y le manda a la IA solo el resumen más los turnos recientes, pero **el `Historial.md` completo se conserva**.

## Instalación (≈20 min)

Requisitos:
- **Node.js 20.12 o superior** (en Arch/Garuda: `sudo pacman -S nodejs npm`; en Windows/macOS: https://nodejs.org, versión LTS).
- **Ollama** para el árbitro local (en Arch/Garuda con placa NVIDIA: `sudo pacman -S ollama-cuda`; en otros sistemas: https://ollama.com/download). Funciona bien con una placa de 4 GB. Si no lo instalás, el árbitro usa el modelo liviano de Gemini, que también es gratis pero gasta cuota.
- **Obsidian** con una bóveda creada.
- Una cuenta de Discord y un servidor donde seas dueño o admin.
- Una API key de Gemini: entrá a https://aistudio.google.com/apikey con tu cuenta de Google → **Create API key**. **No actives la facturación** ("Set up billing") en ese proyecto: así Google nunca puede cobrarte, y cuando se acaba la cuota gratuita el bot simplemente avisa y espera.

> El bot corre en tu computadora: **solo responde mientras esté prendida y con el bot corriendo**. Para tenerlo siempre activo, ver [Dejarlo corriendo siempre](#dejarlo-corriendo-siempre-linux).

### 1. Crear la app en Discord
En https://discord.com/developers/applications → **New Application**. Vas a necesitar:

| Dato | Dónde está | ¿Secreto? |
|---|---|---|
| **Application ID** (solo números) | General Information | No |
| **Token** | Bot → Reset Token (se muestra una sola vez) | **Sí** |

> ⚠️ El **token** controla el bot: no lo pegues en chats, capturas ni lo subas a GitHub (el `.env` ya está en `.gitignore`). Si se filtra, Bot → **Reset Token**.

No hace falta configurar *Interactions Endpoint URL*: el bot se conecta solo a Discord. Si la tenías puesta de la versión anterior, **borrala** y guardá; si no, Discord le manda los comandos a la URL vieja en vez de a tu bot.

### 2. Invitar el bot a tu servidor
Portal → **OAuth2** → **URL Generator** → en *Scopes* marcá **`applications.commands`** y **`bot`** (no hace falta ningún permiso) → abrí la URL generada abajo y elegí tu servidor.

### 3. Configurar
Desde la carpeta del proyecto:
```bash
npm install
cp .env.example .env
```
Abrí `.env` y completá:

| Variable | Qué poner |
|---|---|
| `DISCORD_TOKEN` | El token del bot |
| `DISCORD_APP_ID` | El Application ID |
| `DISCORD_GUILD_ID` | El ID de tu servidor: en Discord, *Configuración → Avanzado → Modo desarrollador*; después clic derecho en el ícono del servidor → **Copiar ID del servidor** |
| `GEMINI_API_KEY` | Tu API key de Gemini |
| `OBSIDIAN_VAULT` | La ruta completa a tu bóveda, ej. `/home/sabo/Documentos/Obsidian/MiBoveda` o `C:\Users\Dani\Documents\MiBoveda` |

Para encontrar la ruta de la bóveda en Obsidian: menú de bóvedas (abajo a la izquierda) → **Administrar bóvedas** → clic derecho → *Mostrar en el explorador*.

### 4. Preparar el árbitro local (Ollama)
```bash
ollama pull gemma4:e4b
```
Para que Ollama arranque solo al iniciar sesión, con las optimizaciones para placas de video chicas, creá `~/.config/systemd/user/ollama.service`:
```ini
[Unit]
Description=Ollama (árbitro local del DM bot)
After=network-online.target

[Service]
ExecStart=/usr/bin/ollama serve
Environment=OLLAMA_FLASH_ATTENTION=1
Environment=OLLAMA_KV_CACHE_TYPE=q8_0
Environment=OLLAMA_CONTEXT_LENGTH=8192
Environment=OLLAMA_KEEP_ALIVE=-1
Restart=on-failure

[Install]
WantedBy=default.target
```
```bash
systemctl --user daemon-reload
systemctl --user enable --now ollama
```
Si además está activo el servicio del sistema (`sudo systemctl status ollama`), desactivalo con `sudo systemctl disable --now ollama`, porque los dos usan el mismo puerto.

**Por qué `gemma4:e4b`:** en una RTX 3050 de 4 GB fue el más rápido (~3 s por decisión) y el que mejor eligió las tiradas, comparado con `qwen3.5:4b` y `gemma3:4b`. Para probar otro, cambiá `OLLAMA_MODEL` en `.env`.

### 5. Registrar los comandos
```bash
npm run register
```
Tiene que responder `✅ 11 comandos registrados en el servidor`. Solo hace falta la primera vez (o si cambian los comandos).

### 6. Arrancar
```bash
npm start
```
Tiene que decir `🎲 DM bot conectado como ... · campañas en ...` y `🧠 Árbitro local listo (gemma4:e4b)`. Dejá esa terminal abierta mientras jueguen. En Discord, creá un canal tipo `#campaña-brumas`, escribí `/` y deberían aparecer los comandos.

### Dejarlo corriendo siempre (Linux)
Con un servicio de usuario de systemd arranca solo al iniciar sesión y se reinicia si falla. Creá `~/.config/systemd/user/dnd-dm-bot.service` (cambiá las rutas):
```ini
[Unit]
Description=DnD DM Bot
After=network-online.target

[Service]
WorkingDirectory=/home/sabo/Projects/dnd-dm-bot
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```
```bash
systemctl --user daemon-reload
systemctl --user enable --now dnd-dm-bot
journalctl --user -u dnd-dm-bot -f      # ver los logs
```

### ¿Venías de la versión en Cloudflare?
Las campañas guardadas en D1 no se migran solas. Pasos: en el portal de Discord **borrá la Interactions Endpoint URL**, seguí los pasos 3 a 5, y volvé a hacer `/importar` y `/campaña`. Si querés, podés borrar el Worker y la base: `npx wrangler delete dnd-dm-bot` y `npx wrangler d1 delete dnd-dm`.

## Solución de problemas

| Síntoma | Causa y solución |
|---|---|
| `No encuentro la bóveda de Obsidian` | Revisá `OBSIDIAN_VAULT` en `.env`: tiene que ser la ruta completa a la carpeta de la bóveda. |
| `An invalid token was provided` | `DISCORD_TOKEN` incorrecto o reseteado: generá uno nuevo en Bot → Reset Token. |
| Los comandos aparecen pero dicen *"La aplicación no respondió"* | El bot no está corriendo (`npm start`), o quedó puesta la Interactions Endpoint URL vieja en el portal de Discord: borrala. |
| `npm run register` → `403 Missing Access (50001)` | El bot no está en ese servidor o el `DISCORD_GUILD_ID` es de otro servidor. Invitalo (paso 2) y verificá el ID. |
| Los comandos no aparecen | Registralos con `DISCORD_GUILD_ID` puesto. Probá también reiniciar Discord (Ctrl+R). |
| `process.loadEnvFile is not a function` | Node es muy viejo: instalá la versión 20.12 o superior. |
| "Se acabó la cuota gratuita de Gemini" | Se usó la cuota de los tres modelos. Si Ollama está corriendo, el modelo local sigue narrando (más lento y algo peor). Si fue la cuota por minuto, esperen un minuto; si fue la diaria, se reinicia a medianoche hora del Pacífico (01:00 en Costa Rica; 02:00 de noviembre a marzo). `/cuota` muestra la hora exacta. |
| `⚠️ Ollama no responde` al arrancar | Ollama no está corriendo: `systemctl --user start ollama`. Mientras tanto el árbitro usa Gemini liviano. |
| El árbitro pide tiradas raras | Es un modelo chico: puede equivocarse de habilidad (el bonificador sí se corrige con la ficha). Usen `/narrar` para seguir sin tirar. |
| "Gemini bloqueó la respuesta" | Los filtros de seguridad de Google frenaron la escena. Reformulen la acción o pidan al DM que siga con `/narrar`. |
| `/importar` dice que el PDF no tiene texto | Es una foto o un escaneo. Exportá la ficha como PDF desde Nivel20, D&D Beyond o la hoja rellenable. |
| `/importar` con enlace falla | La ficha debe ser visible con el enlace de **Compartir** de Nivel20; si igual falla, usá el PDF. `/unirse` funciona sin ficha. |

## Configuración

Todo en `.env` (reiniciá el bot después de cambiarlo):
- **Narrador:** `GEMINI_MODEL`, una lista separada por comas. El bot usa el primero y, si se le acaba la cuota gratuita, pasa al siguiente (cada modelo tiene su propia cuota). Por defecto: `gemini-3.8-flash` (narra mejor), luego `gemini-3.5-flash-lite` y `gemini-3.1-flash-lite`. Si se acaban todos, narra Ollama (se desactiva con `OLLAMA_FALLBACK=false`).
- **Tareas livianas:** `GEMINI_LIGHT_MODEL` (resúmenes, `/ooc`, `/importar`), para que no gasten la cuota del narrador.
- **Árbitro:** `OLLAMA_MODEL` (por defecto `gemma4:e4b`).
- **Límites de tu cuenta:** `GEMINI_LIMITS`, con los RPD de https://aistudio.google.com/rate-limit, para que `/cuota` diga cuántas horas de juego quedan.
- **Razonamiento:** `GEMINI_THINKING` (`low`, `medium`, `high`). Más alto puede mejorar combates complejos, pero tarda más y gasta más cuota.
- **Carpeta en la bóveda:** `OBSIDIAN_FOLDER` (por defecto `DnD`).

En el código:
- **Personalidad del DM:** `src/prompts.ts`.
- **Largo de la memoria:** `COMPACT_AFTER` y `KEEP_RECENT` en `src/game.ts`.
- **Prompt del árbitro:** `ARBITER_SYSTEM` en `src/prompts.ts`.
- **Filtros de seguridad:** `SAFETY_SETTINGS` en `src/ai.ts` (por defecto solo bloquea contenido claramente dañino, para permitir combates y villanos).

## Cómo funciona

```
Discord ◀──(gateway)──▶ bot en tu PC (Node + discord.js) ──▶ bóveda de Obsidian (notas .md)
                              │
          acciones ──▶ árbitro local (Ollama) ──▶ botones 🎲 ──▶ tiradas reales
                              │
                              └──▶ Gemini (narrador) ──▶ narración ──▶ Discord
```

Cada IA ve solo lo que necesita:
- **Árbitro (Ollama):** las fichas completas, la última escena y las acciones nuevas. No gasta nada de Gemini.
- **Narrador (Gemini):** el resumen, los turnos recientes, el nombre, HP y CA de cada personaje, y los resultados de las tiradas. Sin las fichas completas, el pedido es más chico.

- Discord exige respuesta en 3 s, así que el bot responde "pensando…" y publica la narración cuando Gemini termina.
- Las notas se leen del disco en cada comando, así que lo que edites en Obsidian se usa enseguida.
- Un candado evita que dos acciones simultáneas generen dos narraciones, y las escrituras de un mismo canal van en fila.
- Si la API falla, las acciones quedan en `Pendientes.md` y basta con `/narrar`.

## ¿Cuánto podemos jugar gratis?

- Cada **narración** es un pedido al narrador (`gemini-3.8-flash`). Con 2 jugadores son unas **35 por hora**.
- Los **resúmenes** automáticos (uno cada ~5 turnos), `/ooc` e `/importar` usan el modelo liviano, que tiene su propia cuota.
- El **árbitro** corre en tu compu: no gasta nada. `/accion` y las tiradas tampoco.

Horas de juego con el mejor narrador ≈ RPD de `gemini-3.8-flash` ÷ 35. Por ejemplo, con 250 pedidos por día son unas 7 horas. Después sigue narrando con los modelos *lite* y, si se acaban todos, con Ollama, así que la partida no se corta.

`/cuota` muestra lo usado hoy y, si ponés tus límites en `GEMINI_LIMITS`, cuánto queda.

## Límites conocidos

- El bot solo funciona mientras tu computadora esté prendida y el bot corriendo.
- Corré **una sola copia** del bot a la vez sobre la misma bóveda.
- Si sincronizás la bóveda entre dispositivos (Obsidian Sync, Syncthing, Drive), evitá editar las notas de una campaña en otro dispositivo mientras se está jugando: puede generar conflictos de sincronización.
- Los comandos son por canal: si cambian de canal, es otra campaña.

## Desarrollo
```bash
npm run dev         # reinicia el bot al guardar cambios
npm test            # pruebas (sin red: Gemini y Ollama se simulan)
npm run typecheck
```
