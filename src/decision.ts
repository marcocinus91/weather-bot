import { HourlySnapshot, WeatherData } from "./weather";

// --- Descrizione condizioni meteo (codici WMO) ---

const WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: "cielo sereno",
  1: "prevalentemente sereno",
  2: "parzialmente nuvoloso",
  3: "nuvoloso",
  45: "nebbia",
  48: "nebbia con brina",
  51: "pioviggine leggera",
  53: "pioviggine moderata",
  55: "pioviggine intensa",
  56: "pioviggine gelata leggera",
  57: "pioviggine gelata intensa",
  61: "pioggia leggera",
  63: "pioggia moderata",
  65: "pioggia forte",
  66: "pioggia gelata leggera",
  67: "pioggia gelata forte",
  71: "nevicata leggera",
  73: "nevicata moderata",
  75: "nevicata forte",
  77: "granelli di neve",
  80: "rovesci di pioggia leggeri",
  81: "rovesci di pioggia moderati",
  82: "rovesci di pioggia violenti",
  85: "rovesci di neve leggeri",
  86: "rovesci di neve forti",
  95: "temporale",
  96: "temporale con grandine leggera",
  99: "temporale con grandine forte",
};

export function describeWeatherCode(code: number): string {
  return WEATHER_DESCRIPTIONS[code] ?? "condizioni non disponibili";
}

const RAIN_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99,
]);

// --- Ombrello ---

export interface UmbrellaAdvice {
  needed: boolean;
  reason: string;
}

export function getUmbrellaAdvice(weather: WeatherSnapshot): UmbrellaAdvice {
  const isRainingNow =
    weather.precipitation > 0 || RAIN_CODES.has(weather.weatherCode);

  if (isRainingNow) {
    return { needed: true, reason: "sta già piovendo" };
  }
  if (weather.precipitationProbability >= 40) {
    return {
      needed: true,
      reason: `probabilità di pioggia del ${weather.precipitationProbability}%`,
    };
  }
  return {
    needed: false,
    reason: `probabilità di pioggia bassa (${weather.precipitationProbability}%)`,
  };
}

// --- Corsa / attività all'aperto ---

export interface RunningAdvice {
  recommended: boolean;
  reason: string;
}

export function getRunningAdvice(weather: WeatherSnapshot): RunningAdvice {
  if (RAIN_CODES.has(weather.weatherCode) || weather.precipitation > 0) {
    return { recommended: false, reason: "è in corso o prevista pioggia" };
  }
  if (weather.precipitationProbability >= 50) {
    return {
      recommended: false,
      reason: `alta probabilità di pioggia (${weather.precipitationProbability}%)`,
    };
  }
  if (weather.windSpeed >= 40) {
    return {
      recommended: false,
      reason: `vento troppo forte (${weather.windSpeed} km/h)`,
    };
  }
  if (weather.temperature >= 32) {
    return {
      recommended: false,
      reason: `temperatura troppo alta (${weather.temperature}°C)`,
    };
  }
  if (weather.temperature <= 0) {
    return {
      recommended: false,
      reason: `temperatura troppo rigida (${weather.temperature}°C)`,
    };
  }
  return { recommended: true, reason: "condizioni favorevoli" };
}

// --- Affidabilità della previsione ---

export type ReliabilityLevel = "alta" | "media" | "bassa";

export interface ReliabilityAdvice {
  level: ReliabilityLevel;
  reason: string;
}

export interface WeatherSnapshot {
  temperature: number;
  precipitation: number;
  weatherCode: number;
  windSpeed: number;
  precipitationProbability: number;
}

function reliabilityFromProbabilities(
  probabilities: number[],
): ReliabilityAdvice {
  if (probabilities.length === 0) {
    return {
      level: "media",
      reason: "dati insufficienti per valutare la stabilità",
    };
  }

  const range = Math.max(...probabilities) - Math.min(...probabilities);

  if (range <= 15) {
    return { level: "alta", reason: "previsione stabile nelle prossime ore" };
  }
  if (range <= 40) {
    return {
      level: "media",
      reason: "previsione con qualche variazione nelle prossime ore",
    };
  }
  return {
    level: "bassa",
    reason: "previsione molto variabile nelle prossime ore",
  };
}

export function getReliability(
  weather: WeatherData,
  hoursAhead = 6,
): ReliabilityAdvice {
  const upcoming = weather.hourly
    .slice(0, hoursAhead)
    .map((h) => h.precipitationProbability);
  return reliabilityFromProbabilities(upcoming);
}

export function getPeriodReliability(
  hours: HourlySnapshot[],
): ReliabilityAdvice {
  return reliabilityFromProbabilities(
    hours.map((h) => h.precipitationProbability),
  );
}

const WEATHER_CODE_SEVERITY: number[] = [
  99,
  96,
  95, // temporali
  86,
  85, // rovesci di neve
  75,
  77,
  73,
  71, // neve
  82,
  81,
  80, // rovesci di pioggia
  67,
  66, // pioggia gelata
  65,
  63,
  61, // pioggia
  57,
  56,
  55,
  53,
  51, // pioviggine
  48,
  45, // nebbia
  3,
  2,
  1,
  0, // nuvoloso -> sereno
];

export function pickWorstWeatherCode(codes: number[]): number {
    for (const code of WEATHER_CODE_SEVERITY) {
        if (codes.includes(code)) return code;
    }
    return codes[0] ?? 0;
}

import { DayOffset, DayPeriod, PERIOD_HOURS } from "./time";

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface PeriodForecast {
  snapshot: WeatherSnapshot;
  hours: HourlySnapshot[];
}

export function getPeriodForecast(
  hourly: HourlySnapshot[],
  dayOffset: DayOffset,
  period: DayPeriod,
): PeriodForecast | null {
  if (hourly.length === 0) return null;

  const targetDate = addDays(hourly[0].time.split("T")[0], dayOffset);
  const [startHour, endHour] = PERIOD_HOURS[period];

  const hours = hourly.filter((h) => {
    const [date, time] = h.time.split("T");
    const hour = Number(time.slice(0, 2));
    return date === targetDate && hour >= startHour && hour <= endHour;
  });

  if (hours.length === 0) return null;

  const snapshot: WeatherSnapshot = {
    temperature: Math.round(
      hours.reduce((sum, h) => sum + h.temperature, 0) / hours.length,
    ),
    precipitation:
      Math.round(hours.reduce((sum, h) => sum + h.precipitation, 0) * 10) / 10,
    precipitationProbability: Math.max(...hours.map((h) => h.precipitationProbability)),
    windSpeed: Math.max(...hours.map((h) => h.windSpeed)),
    weatherCode: pickWorstWeatherCode(hours.map((h) => h.weatherCode)),
  };

  return { snapshot, hours };
}

export function getWeatherEmoji(code: number): string {
  if (code === 0 || code === 1) return "☀️";
  if (code === 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}
export interface WeeklyDayForecast {
  date: string;
  tempMin: number;
  tempMax: number;
  weatherCode: number;
  precipitationProbability: number;
}

export function getWeeklyOverview(hourly: HourlySnapshot[]): WeeklyDayForecast[] {
  const byDate = new Map<string, HourlySnapshot[]>();

  for (const h of hourly) {
    const date = h.time.split("T")[0];
    const hours = byDate.get(date) ?? [];
    hours.push(h);
    byDate.set(date, hours);
  }

  return [...byDate.entries()].map(([date, hours]) => ({
    date,
    tempMin: Math.min(...hours.map((h) => h.temperature)),
    tempMax: Math.max(...hours.map((h) => h.temperature)),
    weatherCode: pickWorstWeatherCode(hours.map((h) => h.weatherCode)),
    precipitationProbability: Math.max(...hours.map((h) => h.precipitationProbability)),
  }));
}
