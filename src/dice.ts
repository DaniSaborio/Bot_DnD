// Parser y tirador de dados: 1d20+5, 2d20kh1 (ventaja), 2d20kl1 (desventaja), 4d6kh3, 1d8+1d6-1
export interface RollResult {
  total: number;
  detail: string;
  note?: string;
}

export function rollDice(expr: string, rng: () => number = Math.random): RollResult {
  if (/[\dd]\s+\d/i.test(expr)) throw new Error("Falta un + o - entre términos");
  const clean = expr.toLowerCase().replace(/\s+/g, "");
  if (!clean || clean.length > 60) throw new Error("Expresión de dados inválida");

  const termRe = /([+-]?)(\d*d\d+(?:k[hl]\d+)?|\d+)/g;
  let pos = 0;
  let total = 0;
  const parts: string[] = [];
  let note: string | undefined;
  let diceTerms = 0;
  let lastD20: number | null = null;
  let m: RegExpExecArray | null;

  while ((m = termRe.exec(clean)) !== null) {
    if (m.index !== pos) throw new Error(`No entiendo "${clean.slice(pos)}"`);
    if (parts.length > 0 && !m[1]) throw new Error("Falta un + o - entre términos");
    pos = termRe.lastIndex;

    const sign = m[1] === "-" ? -1 : 1;
    const prefix = sign < 0 ? "- " : parts.length ? "+ " : "";
    const term = m[2];

    if (term.includes("d")) {
      const dm = /^(\d*)d(\d+)(?:k([hl])(\d+))?$/.exec(term)!;
      const n = dm[1] ? parseInt(dm[1], 10) : 1;
      const sides = parseInt(dm[2], 10);
      if (n < 1 || n > 100) throw new Error("Entre 1 y 100 dados por término");
      if (sides < 2 || sides > 1000) throw new Error("Los dados deben tener entre 2 y 1000 caras");

      const rolls = Array.from({ length: n }, () => 1 + Math.floor(rng() * sides));
      let keep = new Set(rolls.map((_, i) => i));
      if (dm[3]) {
        const k = parseInt(dm[4], 10);
        if (k < 1 || k > n) throw new Error("La cantidad a conservar debe estar entre 1 y el número de dados");
        const order = rolls
          .map((v, i) => ({ v, i }))
          .sort((a, b) => (dm[3] === "h" ? b.v - a.v : a.v - b.v));
        keep = new Set(order.slice(0, k).map((x) => x.i));
      }
      const sum = rolls.reduce((s, v, i) => (keep.has(i) ? s + v : s), 0);
      total += sign * sum;
      const shown = rolls.map((v, i) => (keep.has(i) ? `${v}` : `~~${v}~~`)).join(", ");
      parts.push(`${prefix}${term}[${shown}]`);

      diceTerms++;
      if (sides === 20 && keep.size === 1) lastD20 = sum;
    } else {
      const v = parseInt(term, 10);
      total += sign * v;
      parts.push(`${prefix}${v}`);
    }
  }

  if (pos !== clean.length || parts.length === 0) throw new Error("Expresión de dados inválida");
  if (diceTerms === 1 && lastD20 === 20) note = "¡20 natural!";
  if (diceTerms === 1 && lastD20 === 1) note = "1 natural...";

  return { total, detail: parts.join(" "), note };
}
