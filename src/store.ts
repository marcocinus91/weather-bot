import fs from "fs";
import path from "path";

export interface UserPrefs {
  cityName?: string;
  cityAdmin1?: string;
  cityCountry?: string;
  lat?: number;
  lon?: number;
  utcOffsetSeconds?: number;
  alertTime?: string; // "HH:MM"
}

const STORE_PATH = path.join(process.cwd(), "data", "user-prefs.json");

let prefs: Map<number, UserPrefs> = loadFromDisk();

function loadFromDisk(): Map<number, UserPrefs> {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)).map(([k, v]) => [Number(k), v as UserPrefs]));
  } catch {
    return new Map();
  }
}

function saveToDisk(): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(Object.fromEntries(prefs)));
}

export function getUserPrefs(userId: number): UserPrefs | undefined {
  return prefs.get(userId);
}

export function setUserPrefs(userId: number, update: Partial<UserPrefs>): void {
  prefs.set(userId, { ...prefs.get(userId), ...update });
  saveToDisk();
}

export function getUserWithAlert(): [number, UserPrefs][] {
  return [...prefs.entries()].filter(([, p]) => p.alertTime !== undefined);
}
