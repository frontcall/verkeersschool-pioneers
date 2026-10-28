// Prijzen komen uit een gepubliceerde Google Sheet (CSV). Ze worden op de
// server opgehaald en direct in de HTML gezet, zodat elke bezoeker — ongeacht
// toestel, browser, adblocker of JavaScript — dezelfde prijs ziet als in de
// sheet staat.
//
// Kolommen verwacht: pakket, prijs, prijs_van, actief

// De sheet is openbaar gepubliceerd, dus de URL mag als standaardwaarde in de
// code staan; een env-variabele overschrijft hem.
const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vStrLqZP2MU6OqwVJxMl-FRGcra88ZoBKDc4YneREvkscFLSBtxsgQFjJvAlE-d_K4sxdl-3kKr9tzL/pub?gid=1809349212&single=true&output=csv';
const SHEET_URL =
  (import.meta.env.PUBLIC_PRICING_SHEET_URL as string | undefined) ||
  process.env.PUBLIC_PRICING_SHEET_URL ||
  DEFAULT_SHEET_URL;

// Hoe lang een opgehaalde sheet in het geheugen van de functie blijft.
const MEMORY_TTL = 30 * 1000;
const FETCH_TIMEOUT = 4000;

export interface PakketPrijs {
  prijs: string;     // geformatteerd, bv. "1.949" of "65"
  prijsVan: string;  // geformatteerd of leeg
  actief: boolean;
}

export type Prijzen = Record<string, PakketPrijs>;

// Laatste noodvangnet als de sheet niet bereikbaar is én er nog niets in het
// geheugen staat. Houd gelijk aan de sheet.
const FALLBACK: Prijzen = {
  'Actie Pakket':     { prijs: '1.599', prijsVan: '2.099', actief: true },
  'Start Pakket':     { prijs: '1.099', prijsVan: '', actief: true },
  'Studenten Pakket': { prijs: '1.699', prijsVan: '', actief: true },
  'Spoed Pakket':     { prijs: '2.349', prijsVan: '', actief: true },
  'Automaat Pakket':  { prijs: '1.949', prijsVan: '', actief: true },
  'Losse Rijles':     { prijs: '65',    prijsVan: '', actief: true },
};

let memory: { ts: number; data: Prijzen } | null = null;

function parseCsvRow(line: string): string[] {
  const cols: string[] = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur.trim());
  return cols;
}

// "1.949,00" → "1.949", "65,00" → "65", "1.599,50" → "1.599,50"
function formatPrijs(raw: string): string {
  return raw.replace(/"/g, '').trim().replace(/,00$/, '');
}

function parsePricing(csv: string): Prijzen {
  const lines   = csv.trim().split(/\r?\n/);
  const headers = parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/"/g, ''));
  const iNaam   = headers.indexOf('pakket');
  const iPrijs  = headers.indexOf('prijs');
  const iVan    = headers.indexOf('prijs_van');
  const iActief = headers.indexOf('actief');
  if (iNaam < 0 || iPrijs < 0) throw new Error('Onverwachte sheet-kolommen');

  const result: Prijzen = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const naam = cols[iNaam]?.trim();
    if (!naam) continue;
    result[naam] = {
      prijs:    formatPrijs(cols[iPrijs] || ''),
      prijsVan: iVan >= 0 ? formatPrijs(cols[iVan] || '') : '',
      actief:   iActief < 0 || (cols[iActief] || 'ja').trim().toLowerCase() !== 'nee',
    };
  }
  return result;
}

/**
 * Haalt de actuele prijzen op. `live` is false als de sheet niet bereikbaar
 * was en er op het vangnet is teruggevallen.
 */
export async function getPrijzen(): Promise<{ prijzen: Prijzen; live: boolean }> {
  if (memory && Date.now() - memory.ts < MEMORY_TTL) {
    return { prijzen: memory.data, live: true };
  }
  if (SHEET_URL) {
    try {
      const res = await fetch(SHEET_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!res.ok) throw new Error(`Sheet gaf ${res.status}`);
      const data = { ...FALLBACK, ...parsePricing(await res.text()) };
      memory = { ts: Date.now(), data };
      return { prijzen: data, live: true };
    } catch (err) {
      console.error('Prijzen-sheet niet bereikbaar:', err);
    }
  }
  return { prijzen: memory?.data ?? FALLBACK, live: false };
}

/**
 * Laat de Netlify-CDN de pagina kort cachen, zodat een wijziging in de sheet
 * binnen ongeveer een minuut overal zichtbaar is. Browsers cachen niet.
 */
export function setPrijsCacheHeaders(headers: Headers, live: boolean) {
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  headers.set(
    'Netlify-CDN-Cache-Control',
    live
      ? 'public, durable, s-maxage=60, stale-while-revalidate=120'
      : 'public, s-maxage=10',
  );
}

/** Prijs van een pakket, of het vangnet als de sheet geen prijs geeft. */
export function prijsVan(prijzen: Prijzen, naam: string): string {
  return prijzen[naam]?.prijs || FALLBACK[naam]?.prijs || '';
}
