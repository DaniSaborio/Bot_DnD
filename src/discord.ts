export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
export const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, DEFERRED_CHANNEL_MESSAGE: 5 } as const;
export const EPHEMERAL = 64;

const API = "https://discord.com/api/v10";
const MAX_LEN = 1900;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function verifyDiscordRequest(req: Request, body: string, publicKey: string): Promise<boolean> {
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(sig), new TextEncoder().encode(ts + body));
  } catch {
    return false;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function reply(content: string, ephemeral = false): Response {
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: { content: content.slice(0, 2000), flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] } },
  });
}

/** Divide un texto largo en trozos que quepan en un mensaje de Discord, cortando en párrafos o líneas. */
export function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf("\n\n", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = rest.lastIndexOf("\n", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = rest.lastIndexOf(" ", MAX_LEN);
    if (cut <= 0) cut = MAX_LEN;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : ["(sin respuesta)"];
}

/** Publica la respuesta de una interacción diferida (el primer trozo edita el "pensando...", el resto van como seguimiento). */
export async function postDeferred(appId: string, token: string, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const url = i === 0 ? `${API}/webhooks/${appId}/${token}/messages/@original` : `${API}/webhooks/${appId}/${token}`;
    const res = await fetch(url, {
      method: i === 0 ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chunks[i], allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) console.error("Discord webhook", res.status, await res.text());
  }
}
