// Розпізнавання номерів рішень (doc_id) у тексті. Використовується і в інтерфейсі, і в двигуні.

const REVIEW_LINK = /\/Review\/(\d{4,12})/gi;

export function uniqueIds(list: string[]): string[] {
  return [...new Set(list.map((s) => s.replace(/^0+/, '')).filter(Boolean))];
}

/** Знаходить ID у довільному тексті: посилання на рішення, список номерів або скопійована сторінка пошуку. */
export function extractIdsFromText(text: string): string[] {
  const links = [...text.matchAll(REVIEW_LINK)].map((m) => m[1]);
  if (links.length) return uniqueIds(links);

  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length && tokens.every((t) => /^\d{4,12}$/.test(t))) return uniqueIds(tokens);

  // Скопійована сторінка результатів пошуку: окремі числа з 6–10 цифр, які не є
  // частиною номера справи (320/8023/24), дати (30.12.2025) чи часу.
  const loose = [...text.matchAll(/(?<![\d/.\-:№])\d{6,10}(?![\d/.\-:])/g)].map((m) => m[0]);
  return uniqueIds(loose);
}
