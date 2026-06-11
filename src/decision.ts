import { WeatherData } from "./weather";

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

const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

// --- Ombrello ---

export interface UmbrellaAdvice {
    needed: boolean;
    reason: string;
}

export function getUmbrellaAdvice(weather: WeatherData): UmbrellaAdvice {
    const isRainingNow = weather.precipitation > 0 || RAIN_CODES.has(weather.weatherCode);

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

export function getRunningAdvice(weather: WeatherData): RunningAdvice {
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
        return { recommended: false, reason: `vento troppo forte (${weather.windSpeed} km/h)` };
    }
    if (weather.temperature >= 32) {
        return { recommended: false, reason: `temperatura troppo alta (${weather.temperature}°C)` };
    }
    if (weather.temperature <= 0) {
        return { recommended: false, reason: `temperatura troppo rigida (${weather.temperature}°C)` };
    }
    return { recommended: true, reason: "condizioni favorevoli" };
}

// --- Affidabilità della previsione ---

export type ReliabilityLevel = "alta" | "media" | "bassa";

export interface ReliabilityAdvice {
    level: ReliabilityLevel;
    reason: string;
}

/**
 * Euristica: misura quanto varia la probabilità di pioggia nelle prossime ore.
 * Una previsione "stabile" (poca variazione) è considerata più affidabile.
 */
export function getReliability(weather: WeatherData, hoursAhead = 6): ReliabilityAdvice {
    const upcoming = weather.hourlyProbabilities.slice(0, hoursAhead).map((h) => h.probability);

    if (upcoming.length === 0) {
        return { level: "media", reason: "dati insufficienti per valutare la stabilità" };
    }

    const range = Math.max(...upcoming) - Math.min(...upcoming);

    if (range <= 15) {
        return { level: "alta", reason: "previsione stabile nelle prossime ore" };
    }
    if (range <= 40) {
        return { level: "media", reason: "previsione con qualche variazione nelle prossime ore" };
    }
    return { level: "bassa", reason: "previsione molto variabile nelle prossime ore" };
}
