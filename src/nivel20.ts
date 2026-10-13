// Lee fichas públicas de Nivel20 (nivel20.com). No hay API, así que se descarga la página y se pasa a texto.
const ALLOWED_HOST = /(^|\.)nivel20\.com$/i;
const MAX_TEXT = 20_000;
const MAX_REDIRECTS = 5;

export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("Ese enlace no es válido. Pegá el enlace de la ficha, ej. https://nivel20.com/s/abcd1234");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("El enlace debe empezar con https://");
  if (!ALLOWED_HOST.test(u.hostname)) throw new Error("Solo puedo importar fichas de nivel20.com");
  u.protocol = "https:";
  return u;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", bull: "•", hellip: "…",
  ndash: "–", mdash: "—", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»", ordm: "º", ordf: "ª", times: "×", minus: "−", deg: "°",
};
// &aacute; &Eacute; &uuml; &ntilde; ... → letra + acento combinado, normalizado
const ACCENTS: Record<string, string> = { acute: "́", grave: "̀", uml: "̈", circ: "̂", tilde: "̃" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    if (ENTITIES[e]) return ENTITIES[e];
    const acc = /^([a-z])(acute|grave|uml|circ|tilde)$/i.exec(e);
    return acc ? (acc[1] + ACCENTS[acc[2]]).normalize("NFC") : m;
  });
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|dt|dd|table|ul|ol)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter((l) => l && l !== "|")
    .join("\n");
}

/** Descarga la ficha siguiendo redirecciones (enlaces cortos /s/...) sin salir de nivel20.com. */
export async function fetchNivel20Sheet(raw: string): Promise<{ url: string; text: string }> {
  let url = checkUrl(raw);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(url.toString(), {
      redirect: "manual",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; DnD-DM-Bot/1.0)",
        accept: "text/html",
        "accept-language": "es",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Nivel20 redirigió sin destino");
      url = checkUrl(new URL(location, url).toString());
      continue;
    }

    if (/sign_in|login/i.test(url.pathname) || res.status === 401 || res.status === 403) {
      throw new Error("Esa ficha es privada. En Nivel20 abrí la ficha → Compartir, y usá ese enlace.");
    }
    if (res.status === 404) throw new Error("No encontré esa ficha en Nivel20 (¿el enlace está completo?)");
    if (!res.ok) throw new Error(`Nivel20 respondió ${res.status}; probá de nuevo en un rato`);
    if (!/\/characters\//.test(url.pathname)) {
      throw new Error("Ese enlace no lleva a una ficha de personaje de Nivel20");
    }

    const text = htmlToText(await res.text());
    if (text.length < 200) throw new Error("La página de la ficha llegó vacía; probá de nuevo");
    return { url: url.toString(), text: text.slice(0, MAX_TEXT) };
  }
  throw new Error("Demasiadas redirecciones desde Nivel20");
}
