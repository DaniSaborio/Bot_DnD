# 🎲 DnD DM Bot

Bot de Discord que hace de Dungeon Master usando la API de **Google Gemini** (tiene capa gratuita). Corre en tu propia computadora y guarda todo en tu **bóveda de Obsidian**: campañas, personajes, fichas e historial quedan como notas Markdown que podés leer y editar. Cada canal de Discord es una campaña independiente.

## Cómo se juega

| Comando | Qué hace |
|---|---|
| `/importar archivo` | Trae tu personaje desde el **PDF de tu ficha** (ver abajo). También acepta `enlace` de Nivel20 |
| `/unirse personaje descripcion` | Alternativa sin Nivel20: te une con nombre y descripción a mano (ej. `Kael` · `humano guerrero nv1, 12 HP`) |
| `/ficha [jugador]` | Ver tu ficha o la de otro jugador (solo la ves vos) |
| `/campaña ambientacion tono` | Empieza una campaña nueva y el DM narra la escena inicial. La anterior del canal se mueve a `Archivo/` en Obsidian |
| `/accion texto` | Declarás lo que hace tu personaje |
| `/tirar dados` | Tira dados: `1d20+5`, `2d20kh1` (ventaja), `2d20kl1` (desventaja), `4d6kh3`, `8d6` |
| `/narrar` | El DM continúa sin esperar a todos |
| `/ooc pregunta` | Pregunta fuera de personaje (reglas, dudas); no afecta la historia |
| `/estado` | Ver personajes, acciones pendientes y el resumen (solo lo ves vos) |
| `/salir` | Saca a tu personaje de la mesa |

**Turnos:** el DM espera a que **todos** los jugadores hagan una `/accion` o `/tirar`, y entonces narra. Si alguien no tiene nada que hacer, usen `/narrar`.

**Dados:** las tiradas son reales y el DM respeta el resultado. Cuando el DM pida una prueba, tirá con `/tirar 1d20+tu_modificador`.

**Memoria:** cuando la historia crece, el bot resume lo más viejo automáticamente (historia, estado de personajes, NPCs, misiones), así la campaña puede durar meses sin perder el hilo.

Orden recomendado para la primera sesión: los dos hacen `/importar` con su PDF, luego uno hace `/campaña`.

## Personajes desde un PDF

1. Exportá la ficha como PDF:
   - **Nivel20:** abrí la ficha → **Imprimir en PDF**.
   - **D&D Beyond:** ficha → *Export to PDF*.
   - **Hoja oficial de 5e rellenable:** llenala en la compu y guardala.
2. En el canal escribí `/importar`, elegí el campo **archivo** y adjuntá el PDF.

El bot lee el texto del PDF (y los campos, si es una hoja rellenable) y la IA arma una ficha compacta: HP, CA, características, habilidades, salvaciones, ataques, conjuros, rasgos y equipo. Con eso el DM:
- te pide tiradas con tu bonificador real (`/tirar 1d20+7` para Atletismo),
- respeta tus HP, CA, ataques y espacios de conjuro, y lleva la cuenta durante la partida,
- te avisa si intentás usar algo que no está en tu ficha.

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
    ├── Pendientes.md     acciones declaradas que el DM todavía no narró
    ├── Personajes/
    │   ├── Kael.md       ficha de cada personaje
    │   └── Lyra.md
    └── Archivo/          campañas anteriores de este canal
```

**Podés editar en Obsidian** y el bot usa los cambios en el siguiente turno, sin reiniciarlo:
- **Fichas** (`Personajes/*.md`): todo lo que esté debajo de `## Ficha` es lo que el DM sabe de ese personaje. Corregí HP, agregá un objeto mágico, lo que quieras.
- **Resumen** (`Campaña.md`): lo que esté debajo de `## Resumen` es la memoria del DM. Podés agregar notas propias (NPCs, secretos, ganchos de trama).
- **Historial**: se puede leer y releer como el diario de la partida. Si lo editás, no borres las marcas `<!-- msg N ... -->` (en modo lectura no se ven); son las que usa el bot para separar los turnos.

No cambies el `(número)` al final del nombre de la carpeta: es el ID del canal y así la encuentra el bot. El resto del nombre sí lo podés cambiar. Tampoco edites el bloque `---` de arriba de cada nota (las propiedades), salvo que sepas lo que hacés.

Cuando el historial crece, el bot resume lo más viejo en `Campaña.md` y le manda a la IA solo el resumen más los turnos recientes, pero **el `Historial.md` completo se conserva**.

## Instalación (≈20 min)

Requisitos:
- **Node.js 20.12 o superior** (en Arch/Garuda: `sudo pacman -S nodejs npm`; en Windows/macOS: https://nodejs.org, versión LTS).
- **Obsidian** con una bóveda creada.
- Una cuenta de Discord y un servidor donde seas dueño o admin.
- Una API key de Gemini: entrá a https://aistudio.google.com/apikey con tu cuenta de Google → **Create API key** (gratis, sin tarjeta).

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

### 4. Registrar los comandos
```bash
npm run register
```
Tiene que responder `✅ 10 comandos registrados en el servidor`. Solo hace falta la primera vez (o si cambian los comandos).

### 5. Arrancar
```bash
npm start
```
Tiene que decir `🎲 DM bot conectado como ... · campañas en ...`. Dejá esa terminal abierta mientras jueguen. En Discord, creá un canal tipo `#campaña-brumas`, escribí `/` y deberían aparecer los comandos.

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
| "Se alcanzó el límite de uso de Gemini" | La capa gratuita tiene límites por minuto y por día (se reinician a medianoche hora del Pacífico). Esperen, o cambien a `gemini-3.5-flash-lite`, que tiene más cuota. Ver tus límites en https://aistudio.google.com. |
| "Gemini bloqueó la respuesta" | Los filtros de seguridad de Google frenaron la escena. Reformulen la acción o pidan al DM que siga con `/narrar`. |
| `/importar` dice que el PDF no tiene texto | Es una foto o un escaneo. Exportá la ficha como PDF desde Nivel20, D&D Beyond o la hoja rellenable. |
| `/importar` con enlace falla | La ficha debe ser visible con el enlace de **Compartir** de Nivel20; si igual falla, usá el PDF. `/unirse` funciona sin ficha. |

## Configuración

Todo en `.env` (reiniciá el bot después de cambiarlo):
- **Modelo:** `GEMINI_MODEL`. `gemini-3.8-flash` narra mejor; `gemini-3.5-flash-lite` es más rápido y tiene más cuota gratuita.
- **Razonamiento:** `GEMINI_THINKING` (`low`, `medium`, `high`). Más alto puede mejorar combates complejos, pero tarda más y gasta más cuota.
- **Carpeta en la bóveda:** `OBSIDIAN_FOLDER` (por defecto `DnD`).

En el código:
- **Personalidad del DM:** `src/prompts.ts`.
- **Largo de la memoria:** `COMPACT_AFTER` y `COMPACT_CHUNK` en `src/game.ts`.
- **Filtros de seguridad:** `SAFETY_SETTINGS` en `src/ai.ts` (por defecto solo bloquea contenido claramente dañino, para permitir combates y villanos).

## Cómo funciona

```
Discord ◀──(gateway)──▶ bot en tu PC (Node + discord.js) ──▶ bóveda de Obsidian (notas .md)
                                    │
                                    └──▶ API de Gemini ──▶ narración ──▶ Discord
```

- Discord exige respuesta en 3 s, así que el bot responde "pensando…" y publica la narración cuando Gemini termina.
- Las notas se leen del disco en cada comando, así que lo que edites en Obsidian se usa enseguida.
- Un candado evita que dos acciones simultáneas generen dos narraciones, y las escrituras de un mismo canal van en fila.
- Si la API falla, las acciones quedan en `Pendientes.md` y basta con `/narrar`.

## Límites conocidos

- El bot solo funciona mientras tu computadora esté prendida y el bot corriendo.
- Corré **una sola copia** del bot a la vez sobre la misma bóveda.
- Si sincronizás la bóveda entre dispositivos (Obsidian Sync, Syncthing, Drive), evitá editar las notas de una campaña en otro dispositivo mientras se está jugando: puede generar conflictos de sincronización.
- Los comandos son por canal: si cambian de canal, es otra campaña.

## Desarrollo
```bash
npm run dev         # reinicia el bot al guardar cambios
npm run typecheck
```
