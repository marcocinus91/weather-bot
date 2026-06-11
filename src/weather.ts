import axios from "axios";
import https from "https";

const httpsAgent = new https.Agent({ keepAlive: false });

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Errori tipizzati ---

export type WeatherErrorCode = "TIMEOUT" | "NETWORK" | "UNKNOWN";

export class WeatherServiceError extends Error {
  constructor(
    public code: WeatherErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "WeatherServiceError";
  }
}

function classifyError(err: unknown): WeatherServiceError {
  if (axios.isAxiosError(err)) {
    if (err.code === "ECONNABORTED") {
      return new WeatherServiceError("TIMEOUT", "Richiesta scaduta", err);
    }
    if (
      err.code === "ECONNRESET" ||
      err.code === "ECONNREFUSED" ||
      err.code === "ENOTFOUND" ||
      !err.response
    ) {
      return new WeatherServiceError(
        "NETWORK",
        "Servizio meteo non raggiungibile",
        err,
      );
    }
  }
  return new WeatherServiceError("UNKNOWN", "Errore sconosciuto", err);
}

async function getJson<T>(url: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get<T>(url, {
        timeout: FETCH_TIMEOUT_MS,
        httpsAgent,
      });
      return res.data;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  throw classifyError(lastError);
}

// --- Geocoding ---

interface GeocodingResponse {
  results?: {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
  }[];
}

export interface Location {
  name: string;
  admin1?: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface GeocodingResult {
  location: Location;
  alternatives: Location[];
}

export async function getCoordinates(
  city: string,
): Promise<GeocodingResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    city,
  )}&count=1&language=it&format=json`;

  const data = await getJson<GeocodingResponse>(url);
  const results = data.results;
  if (!results || results.length === 0) return null;

  const toLocation = (r: (typeof results)[number]): Location => ({
    name: r.name,
    admin1: r.admin1,
    country: r.country,
    latitude: r.latitude,
    longitude: r.longitude,
  });

  return {
    location: toLocation(results[0]),
    alternatives: results.slice(1).map(toLocation),
  };
}

// --- Forecast ---

interface ForecastResponse {
  current: {
    time: string;
    temperature_2m: number;
    precipitation: number;
    weathercode: number;
    windspeed_10m: number;
  };
  hourly: {
    time: string[];
    precipitation_probability: number[];
  };
}

export interface WeatherData {
  temperature: number;
  precipitation: number;
  weatherCode: number;
  windSpeed: number;
  precipitationProbability: number;
  hourlyProbabilities: { time: string; probability: number }[];
}

export async function getWeather(
  lat: number,
  lon: number,
): Promise<WeatherData> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,precipitation,weathercode,windspeed_10m` +
    `&hourly=precipitation_probability&timezone=auto&forecast_days=1`;

  const data = await getJson<ForecastResponse>(url);

  const currentHourIndex = data.hourly.time.findIndex(
    (t) => t === data.current.time,
  );
  const currentProbability =
    currentHourIndex >= 0
      ? data.hourly.precipitation_probability[currentHourIndex]
      : 0;

  return {
    temperature: data.current.temperature_2m,
    precipitation: data.current.precipitation,
    weatherCode: data.current.weathercode,
    windSpeed: data.current.windspeed_10m,
    precipitationProbability: currentProbability,
    hourlyProbabilities: data.hourly.time
      .map((time, i) => ({
        time,
        probability: data.hourly.precipitation_probability[i],
      }))
      .slice(currentHourIndex >= 0 ? currentHourIndex : 0),
  };
}
