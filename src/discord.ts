// Utilidades para mensajes de Discord.
const MAX_LEN = 1900;

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
