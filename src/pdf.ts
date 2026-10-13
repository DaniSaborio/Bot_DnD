// Lee fichas de personaje en PDF adjuntas en Discord (Nivel20 "Imprimir en PDF", D&D Beyond, hoja oficial rellenable...).
import { getDocumentProxy, extractText } from "unpdf";

const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 20_000;

export interface DiscordAttachment {
  url: string;
  filename: string;
  size: number;
  content_type?: string;
}

/** Validación rápida antes de descargar, para responder al instante si no es un PDF. */
export function checkAttachment(a: DiscordAttachment | undefined): DiscordAttachment {
  if (!a) throw new Error("No recibí el archivo; adjuntalo de nuevo");
  const isPdf = (a.content_type ?? "").includes("pdf") || a.filename.toLowerCase().endsWith(".pdf");
  if (!isPdf) throw new Error("El archivo tiene que ser un PDF de la ficha");
  if (a.size > MAX_PDF_BYTES) throw new Error("El PDF pesa más de 10 MB; exportá solo la ficha");
  const host = new URL(a.url).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new Error("El archivo no viene de Discord");
  return a;
}

export async function fetchPdfText(a: DiscordAttachment): Promise<string> {
  checkAttachment(a);
  const res = await fetch(a.url);
  if (!res.ok) throw new Error(`No pude descargar el PDF de Discord (${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.byteLength > MAX_PDF_BYTES) throw new Error("El PDF pesa más de 10 MB");
  return pdfToText(data);
}

/** Extrae el texto del PDF y, si es un formulario rellenable, también los valores de sus campos. */
export async function pdfToText(data: Uint8Array): Promise<string> {
  let pdf;
  try {
    pdf = await getDocumentProxy(data);
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/password/i.test(msg)) throw new Error("El PDF tiene contraseña; exportalo sin protección");
    throw new Error("No pude abrir el PDF; ¿está dañado?");
  }

  // Campos de formulario (la hoja oficial de 5e guarda los datos ahí, no en el texto)
  const fields: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const annotations = (await page.getAnnotations()) as Array<Record<string, any>>;
    for (const a of annotations) {
      if (a.subtype !== "Widget") continue;
      // El nombre técnico del campo primero (lo usa el lector en código); la descripción entre paréntesis ayuda a la IA.
      const field = String(a.fieldName || "").trim();
      const alt = String(a.alternativeText || "").trim();
      const name = field && alt && alt !== field ? `${field} (${alt})` : field || alt;
      let value = a.fieldValue;
      if (Array.isArray(value)) value = value.join(", ");
      if (a.checkBox || a.radioButton) {
        if (value && value !== "Off") fields.push(`${name}: ✓`);
        continue;
      }
      if (typeof value === "string" && value.trim()) fields.push(name ? `${name}: ${value.trim()}` : value.trim());
    }
  }

  const { text } = await extractText(pdf, { mergePages: true });
  const body = String(text)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  const combined = [body, fields.length ? `CAMPOS DEL FORMULARIO:\n${fields.join("\n")}` : ""].filter(Boolean).join("\n\n");
  if (combined.replace(/\s/g, "").length < 50) {
    throw new Error("El PDF no tiene texto legible (¿es una foto o un escaneo?). Exportá la ficha como PDF desde la computadora.");
  }
  return combined.slice(0, MAX_TEXT);
}
