# 🎲 DnD DM Bot

Bot de Discord que hace de Dungeon Master usando la API de **Google Gemini** (tiene capa gratuita). Corre en Cloudflare Workers con D1, sin servidor propio. Cada canal de Discord es una campaña independiente.

## Cómo se juega

| Comando | Qué hace |
|---|---|
| `/importar archivo` | Trae tu personaje desde el **PDF de tu ficha** (ver abajo). También acepta `enlace` de Nivel20 |
| `/unirse personaje descripcion` | Alternativa sin Nivel20: te une con nombre y descripción a mano (ej. `Kael` · `humano guerrero nv1, 12 HP`) |
| `/ficha [jugador]` | Ver tu ficha o la de otro jugador (solo la ves vos) |
| `/campaña ambientacion tono` | Empieza una campaña nueva y el DM narra la escena inicial. **Borra la campaña anterior del canal** |
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

## Instalación (≈20 min)

Requisitos: Node.js LTS (18 o superior), cuenta de Cloudflare (gratis), cuenta de Discord, un servidor de Discord donde seas dueño o admin, y una API key de Gemini: entrá a https://aistudio.google.com/apikey con tu cuenta de Google → **Create API key** (gratis, sin tarjeta).

Los comandos funcionan igual en Windows (PowerShell), Linux y macOS. Donde hay diferencias se indica.

### 0. Solo en Windows: permitir npm/npx en PowerShell
Si `npm -v` da *"running scripts is disabled on this system"*, corré una vez y respondé `S`/`Y`:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```
Alternativa sin cambiar la política: usar `npm.cmd` y `npx.cmd` en lugar de `npm` y `npx`.

### 1. Crear la app en Discord
En https://discord.com/developers/applications → **New Application**. Vas a necesitar:

| Dato | Dónde está | ¿Secreto? |
|---|---|---|
| **Application ID** (solo números) | General Information | No |
| **Public Key** (64 caracteres hex) | General Information | No |
| **Token** | Bot → Reset Token (se muestra una sola vez) | **Sí** |

> ⚠️ El **token** controla el bot: no lo pegues en chats, capturas ni en el código. Si se filtra, Bot → **Reset Token** y usá el nuevo. Solo se usa para registrar comandos; el Worker no lo necesita.

### 2. Instalar y crear la base de datos
Desde la carpeta del proyecto:
```bash
npm install
npx wrangler login          # abre el navegador para autorizar Cloudflare
npx wrangler d1 create dnd-dm
```
El último comando imprime un `database_id`. Abrí `wrangler.toml` (en Windows: `notepad wrangler.toml`), reemplazá `REEMPLAZAR_CON_EL_ID_DE_TU_D1` por ese ID (dejá las comillas) y guardá. Luego creá las tablas:
```bash
npm run db:init
```

### 3. Secretos y deploy
Cada comando pide el valor: pegalo y Enter (en PowerShell se pega con clic derecho; el texto no se ve, es normal).
```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```
Si pregunta si querés crear el Worker, respondé que sí. La primera vez que usás Workers te pide elegir un **subdominio de workers.dev** (si el que elegís está ocupado, probá otro). Los avisos sobre `workers_dev` y `preview_urls` son normales.

Al final aparece la URL del bot: `https://dnd-dm-bot.<tu-subdominio>.workers.dev`.

**Comprobá que está vivo:** abrí la URL en el navegador; tiene que decir **🎲 DM bot activo**. Si el subdominio es nuevo, puede tardar 5-10 minutos en funcionar.

### 4. Conectar Discord con el Worker
Portal de Discord → **General Information** → **Interactions Endpoint URL**: pegá la URL y **Save Changes**. Discord la verifica en el momento, así que hacelo recién cuando la URL cargue en el navegador.

### 5. Invitar el bot a tu servidor
Portal → **OAuth2** → **URL Generator** → en *Scopes* marcá **`applications.commands`** y **`bot`** (no hace falta ningún permiso) → abrí la URL generada abajo y elegí tu servidor.

> Este paso va **antes** de registrar los comandos: si el bot no está en el servidor, el registro falla con `403 Missing Access`.

### 6. Registrar los comandos
Necesitás el **ID del servidor**: en Discord, *Configuración de usuario → Avanzado → Modo desarrollador* (activar); después clic derecho en el **ícono del servidor** → **Copiar ID del servidor**.

**Windows (PowerShell):**
```powershell
$env:DISCORD_APP_ID="tu_application_id"
$env:DISCORD_BOT_TOKEN="tu_token"
$env:DISCORD_GUILD_ID="id_de_tu_servidor"
npm run register
```

**Linux / macOS:**
```bash
DISCORD_APP_ID=tu_application_id DISCORD_BOT_TOKEN=tu_token DISCORD_GUILD_ID=id_de_tu_servidor npm run register
```

Tiene que responder `✅ 10 comandos registrados en el servidor`. Con `DISCORD_GUILD_ID` los comandos aparecen al instante en ese servidor; sin él quedan globales y pueden tardar en aparecer.

¡Listo! Creá un canal tipo `#campaña-brumas`, escribí `/` y deberían aparecer los comandos del bot.

### ¿Ya tenías la versión anterior desplegada?
Si venías de la versión con Claude o Workers AI: corré `npx wrangler secret put GEMINI_API_KEY` y `npm run deploy`. Podés borrar el secreto viejo con `npx wrangler secret delete ANTHROPIC_API_KEY`.

Si además venías de la versión sin fichas: Corré `npm run db:migrate` (agrega las columnas de fichas), `npm run deploy` y `npm install` y volvé a registrar los comandos (paso 6) para que aparezcan `/importar` (con PDF) y `/ficha`.

## Solución de problemas

| Síntoma | Causa y solución |
|---|---|
| `running scripts is disabled` al usar npm/npx (Windows) | Ver paso 0. |
| `MODULE_NOT_FOUND` | Corriste `node <algo>` en lugar de `npm ...`, o no estás en la carpeta del proyecto. Con `dir`/`ls` tenés que ver `package.json`. |
| `Subdomain is unavailable` en el deploy | Ese subdominio de workers.dev ya existe; elegí otro. |
| Discord: *"No se ha podido verificar la URL del punto de conexión"* | 1) El subdominio aún no está activo: esperá a que la URL cargue en el navegador. 2) La Public Key está mal (es la de 64 caracteres, no el Application ID ni el Client Secret): `npx wrangler secret put DISCORD_PUBLIC_KEY` y probá de nuevo. |
| `npm run register` → `403 Missing Access (50001)` | El bot no está en ese servidor o el `DISCORD_GUILD_ID` es de otro servidor. Invitalo (paso 5) y verificá el ID. |
| `npm run register` → `401 Unauthorized` | Token incorrecto o reseteado: generá uno nuevo en Bot → Reset Token. |
| Los comandos no aparecen | Si los registraste sin `DISCORD_GUILD_ID`, pueden tardar; registralos con el ID del servidor. Probá también reiniciar Discord (Ctrl+R). |
| El bot dice "pensando…" y nunca responde, o da error de Gemini | Revisá la `GEMINI_API_KEY` (`npx wrangler secret put GEMINI_API_KEY`). |
| "Se alcanzó el límite de uso de Gemini" | La capa gratuita tiene límites por minuto y por día (se reinician a medianoche hora del Pacífico). Esperen, o cambien a `gemini-3.5-flash-lite`, que tiene más cuota. Ver tus límites en https://aistudio.google.com. |
| "Gemini bloqueó la respuesta" | Los filtros de seguridad de Google frenaron la escena. Reformulen la acción o pidan al DM que siga con `/narrar`. |
| `/importar` dice que el PDF no tiene texto | Es una foto o un escaneo. Exportá la ficha como PDF desde Nivel20, D&D Beyond o la hoja rellenable. |
| `/importar` con enlace falla | La ficha debe ser visible con el enlace de **Compartir** de Nivel20; si igual falla, usá el PDF. `/unirse` funciona sin ficha. |

Para ver los errores del Worker en vivo, dejá corriendo esto mientras usás el bot:
```bash
npx wrangler tail
```

## Configuración

- **Modelo:** en `wrangler.toml`, `GEMINI_MODEL`. `gemini-3.8-flash` narra mejor; `gemini-3.5-flash-lite` es más rápido y tiene más cuota gratuita. Redeployá después de cambiarlo.
- **Razonamiento:** `GEMINI_THINKING` (`low`, `medium`, `high`). Más alto puede mejorar combates complejos, pero tarda más y gasta más cuota.
- **Filtros de seguridad:** `SAFETY_SETTINGS` en `src/ai.ts` (por defecto solo bloquea contenido claramente dañino, para permitir combates y villanos).
- **Personalidad del DM:** todo está en `src/prompts.ts`.
- **Largo de la memoria:** `COMPACT_AFTER` y `COMPACT_CHUNK` en `src/game.ts`.

## Cómo funciona

```
Discord ──(slash command firmado)──▶ Worker ──▶ D1 (campañas, jugadores, historial, acciones pendientes)
                                       │
                                       └──▶ API de Gemini ──▶ narración ──▶ webhook de Discord
```

- Discord exige respuesta en 3 s, así que el bot responde "pensando…" y publica la narración cuando Gemini termina.
- Un candado en D1 evita que dos acciones simultáneas generen dos narraciones.
- Si la API falla, las acciones quedan guardadas y basta con `/narrar`.

## Límites conocidos

- La narración tiene que terminar dentro del tiempo que Cloudflare da a `waitUntil` tras responder (unos 30 s). Con el límite de ~900 tokens de narración sobra, pero si algún día ves narraciones que no llegan, bajá `NARRATION_TOKENS`, usá `GEMINI_THINKING = "low"` o pasá a `gemini-3.5-flash-lite`.
- Los comandos son por canal: si cambian de canal, es otra campaña.

## Desarrollo local
```bash
cp .dev.vars.example .dev.vars   # completá los valores
npx wrangler d1 execute dnd-dm --local --file=schema.sql
npm run dev
npm run typecheck
```
Para probar con Discord real en local, exponé el puerto con `cloudflared tunnel --url http://localhost:8787` y usá esa URL como Interactions Endpoint.
