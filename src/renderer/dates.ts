// Дати в українському форматі ДД.ММ.РРРР незалежно від мови Windows
// (вбудоване поле дати браузера бере формат із системної мови).

/** 'РРРР-ММ-ДД' → 'ДД.ММ.РРРР' (порожньо, якщо дати немає). */
export function isoToUa(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** 'ДД.ММ.РРРР' → 'РРРР-ММ-ДД' або null, якщо такої дати не існує. */
export function uaToIso(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Маска під час введення: крапки ставляться автоматично; вставлена дата 'РРРР-ММ-ДД' перетворюється. */
export function maskDateTyping(raw: string): string {
  if (/^\s*\d{4}-\d{2}-\d{2}\s*$/.test(raw)) return isoToUa(raw.trim());
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}
