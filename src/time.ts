export type DayOffset = 0 | 1; // 0 = oggi, 1 = domani
export type DayPeriod = "mattina" | "pomeriggio" | "sera" | "notte";

export interface TimeContext {
  dayOffset: DayOffset;
  period: DayPeriod | null; // null = nessuna fascia specifica (solo "oggi"/"domani")
}

export interface ParsedMessage {
  city: string;
  time: TimeContext | null; // null = nessun riferimento temporale -> meteo attuale
}

// Fasce orarie [oraInizio, oraFine] (inclusive), modificabili
export const PERIOD_HOURS: Record<DayPeriod, [number, number]> = {
  mattina: [6, 11],
  pomeriggio: [12, 17],
  sera: [18, 23],
  notte: [0, 5],
};

// Ordine importante: i pattern più specifici vanno PRIMA di quelli generici,
// altrimenti "domani mattina" verrebbe intercettato da "domani" (period: null)
const TIME_PATTERNS: { regex: RegExp; context: TimeContext }[] = [
  { regex: /\bdomani\s+mattina\b/i, context: { dayOffset: 1, period: "mattina" } },
  { regex: /\bdomani\s+pomeriggio\b/i, context: { dayOffset: 1, period: "pomeriggio" } },
  { regex: /\bdomani\s+sera\b/i, context: { dayOffset: 1, period: "sera" } },
  { regex: /\bdomani\s+notte\b/i, context: { dayOffset: 1, period: "notte" } },

  { regex: /\bstamattina\b/i, context: { dayOffset: 0, period: "mattina" } },
  { regex: /\bstasera\b/i, context: { dayOffset: 0, period: "sera" } },
  { regex: /\bstanotte\b/i, context: { dayOffset: 0, period: "notte" } },

  { regex: /\boggi\s+mattina\b/i, context: { dayOffset: 0, period: "mattina" } },
  { regex: /\boggi\s+pomeriggio\b/i, context: { dayOffset: 0, period: "pomeriggio" } },
  { regex: /\boggi\s+sera\b/i, context: { dayOffset: 0, period: "sera" } },
  { regex: /\boggi\s+notte\b/i, context: { dayOffset: 0, period: "notte" } },

  { regex: /\bmattina\b/i, context: { dayOffset: 0, period: "mattina" } },
  { regex: /\bpomeriggio\b/i, context: { dayOffset: 0, period: "pomeriggio" } },
  { regex: /\bsera\b/i, context: { dayOffset: 0, period: "sera" } },
  { regex: /\bnotte\b/i, context: { dayOffset: 0, period: "notte" } },

  { regex: /\bdomani\b/i, context: { dayOffset: 1, period: null } },
  { regex: /\boggi\b/i, context: { dayOffset: 0, period: null } },
];

// Preposizioni rimaste "appese" dopo aver rimosso il riferimento temporale
// (es. "domani a Milano" -> "a Milano" -> "Milano")
const DANGLING_PREPOSITIONS = /^(a|ad|per|di)\s+|\s+(a|ad|per|di)$/gi;

export function parseTimeContext(text: string): ParsedMessage {
  for (const { regex, context } of TIME_PATTERNS) {
    if (regex.test(text)) {
      const city = text
        .replace(regex, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(DANGLING_PREPOSITIONS, "")
        .trim();

      return { city, time: context };
    }
  }

  return { city: text.trim(), time: null };
}
