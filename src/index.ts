import {
  Bot,
  Context,
  GrammyError,
  InlineKeyboard,
  webhookCallback,
} from "grammy";
import express from "express";
import "dotenv/config";
import {
  getCoordinates,
  getWeather,
  WeatherServiceError,
  WeatherData,
  Location,
} from "./weather";
import {
  describeWeatherCode,
  getUmbrellaAdvice,
  getRunningAdvice,
  getReliability,
  getPeriodForecast,
  getPeriodReliability,
  PeriodForecast,
  getWeatherEmoji,
  getWeeklyOverview,
  getBestRunningWindow,
} from "./decision";
import { parseTimeContext, DayOffset, DayPeriod } from "./time";
import { logger } from "./logger";
import { escapeMarkdownV2 } from "./format";
import { getUserPrefs, setUserPrefs, UserPrefs } from "./store";
import { startAlertScheduler } from "./scheduler";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const DAY_LABELS: Record<DayOffset, string> = { 0: "oggi", 1: "domani" };
const PERIOD_LABELS: Record<DayPeriod, string> = {
  mattina: "mattina",
  pomeriggio: "pomeriggio",
  sera: "sera",
  notte: "notte",
};
const ALL_PERIODS: DayPeriod[] = ["mattina", "pomeriggio", "sera", "notte"];
const PERIOD_CODES: Record<DayPeriod, string> = {
  mattina: "m",
  pomeriggio: "p",
  sera: "s",
  notte: "n",
};
const PERIOD_FROM_CODE: Record<string, DayPeriod> = {
  m: "mattina",
  p: "pomeriggio",
  s: "sera",
  n: "notte",
};

type ReportKind =
  | { type: "current" }
  | { type: "period"; dayOffset: DayOffset; period: DayPeriod }
  | { type: "overview"; dayOffset: DayOffset };

function formatCurrentReport(location: Location, weather: WeatherData): string {
  const description = describeWeatherCode(weather.weatherCode);
  const umbrella = getUmbrellaAdvice(weather);
  const running = getRunningAdvice(weather);
  const reliability = getReliability(weather);

  return (
    `📍 ${formatLocation(location)}\n` +
    `${escapeMarkdownV2(description)}, *${escapeMarkdownV2(String(weather.temperature))}°C*\n\n` +
    `☂️ Ombrello: *${umbrella.needed ? "sì" : "no"}* — ${escapeMarkdownV2(umbrella.reason)}\n` +
    `🏃 Uscire/correre: *${running.recommended ? "consigliato" : "sconsigliato"}* — ${escapeMarkdownV2(running.reason)}\n` +
    `📊 Affidabilità previsione: *${reliability.level}* — ${escapeMarkdownV2(reliability.reason)}\n\n` +
    `💨 Vento: *${escapeMarkdownV2(String(weather.windSpeed))} km/h* \\| 🌧️ Precipitazioni: *${escapeMarkdownV2(String(weather.precipitation))} mm*`
  );
}

function formatPeriodReport(
  location: Location,
  forecast: PeriodForecast,
  dayOffset: DayOffset,
  period: DayPeriod,
): string {
  const { snapshot, hours } = forecast;
  const description = describeWeatherCode(snapshot.weatherCode);
  const umbrella = getUmbrellaAdvice(snapshot);
  const running = getRunningAdvice(snapshot);
  const reliability = getPeriodReliability(hours);
  const label = `${DAY_LABELS[dayOffset]} ${PERIOD_LABELS[period]}`;

  return (
    `📍 ${formatLocation(location)} — ${label}\n` +
    `${escapeMarkdownV2(description)}, \\~${escapeMarkdownV2(String(snapshot.temperature))}°C\n\n` +
    `☂️ Ombrello: *${umbrella.needed ? "sì" : "no"}* — ${escapeMarkdownV2(umbrella.reason)}\n` +
    `🏃 Uscire/correre: *${running.recommended ? "consigliato" : "sconsigliato"}* — ${escapeMarkdownV2(running.reason)}\n` +
    `📊 Affidabilità previsione: *${reliability.level}* — ${escapeMarkdownV2(reliability.reason)}\n\n` +
    `💨 Vento \\(max\\): *${escapeMarkdownV2(String(snapshot.windSpeed))} km/h* \\| 🌧️ Precipitazioni \\(tot\\): *${escapeMarkdownV2(String(snapshot.precipitation))} mm*`
  );
}

export function formatDayOverview(
  location: Location,
  weather: WeatherData,
  dayOffset: DayOffset,
): string {
  const forecasts = ALL_PERIODS.map((period) => ({
    period,
    forecast: getPeriodForecast(weather.hourly, dayOffset, period),
  })).filter(
    (f): f is { period: DayPeriod; forecast: PeriodForecast } =>
      f.forecast !== null,
  );

  if (forecasts.length === 0) {
    return `Non ho previsioni disponibili per "${DAY_LABELS[dayOffset]}"\\.`;
  }

  const lines = forecasts.map(({ period, forecast }) => {
    const { snapshot } = forecast;
    const description = describeWeatherCode(snapshot.weatherCode);
    const umbrella = getUmbrellaAdvice(snapshot);
    return `• ${PERIOD_LABELS[period]}: ${getWeatherEmoji(snapshot.weatherCode)} ${escapeMarkdownV2(description)}, *${escapeMarkdownV2(String(snapshot.temperature))}°C* — ☂️ *${umbrella.needed ? "sì" : "no"}*`;
  });

  const allHours = forecasts.flatMap(({ forecast }) => forecast.hours);
  const reliability = getPeriodReliability(allHours);

  return (
    `📍 ${formatLocation(location)} — ${DAY_LABELS[dayOffset]}\n\n` +
    `${lines.join("\n")}\n\n` +
    `📊 Affidabilità previsione: *${reliability.level}* — ${escapeMarkdownV2(reliability.reason)}`
  );
}

const WEEKDAY_LABELS = [
  "domenica",
  "lunedì",
  "martedì",
  "mercoledì",
  "giovedì",
  "venerdì",
  "sabato",
];

function formatWeeklyReport(location: Location, weather: WeatherData): string {
  const days = getWeeklyOverview(weather.hourly);

  const lines = days.map((day, i) => {
    const label =
      i === 0
        ? "oggi"
        : i === 1
          ? "domani"
          : WEEKDAY_LABELS[new Date(`${day.date}T00:00:00Z`).getUTCDay()];
    const description = describeWeatherCode(day.weatherCode);
    return `• ${label}: ${getWeatherEmoji(day.weatherCode)} ${escapeMarkdownV2(description)}, *${escapeMarkdownV2(String(day.tempMin))}°C / ${escapeMarkdownV2(String(day.tempMax))}°C* — 🌧️ ${escapeMarkdownV2(String(day.precipitationProbability))}%`;
  });

  return (
    `📍 ${formatLocation(location)} — prossimi giorni\n\n` +
    `${lines.join("\n")}\n\n` +
    `⚠️ Affidabilità bassa oltre i 2\\-3 giorni\\.`
  );
}

function formatHourLabel(time: string, referenceDate: string): string {
  const [date, clock] = time.split("T");
  const hh = clock.slice(0, 2);
  const dayLabel = date === referenceDate ? "oggi" : "domani";
  return `${dayLabel} alle ${hh}:00`;
}

function formatRunningReport(
  location: Location,
  weather: WeatherData,
  timeArg: string | null,
): string {
  const referenceDate = weather.hourly[0]?.time.split("T")[0] ?? "";

  if (timeArg) {
    const [hourStr, minuteStr] = timeArg.split(":");
    const targetHour = Number(hourStr);
    const index = weather.hourly.findIndex(
      (h) => Number(h.time.slice(11, 13)) === targetHour,
    );

    if (index === -1) {
      return (
        `📍 ${formatLocation(location)} — modalità corsa\n\n` +
        `Non ho previsioni disponibili per le ${escapeMarkdownV2(timeArg)}\\.`
      );
    }

    const snapshot = weather.hourly[index];
    const advice = getRunningAdvice(snapshot);
    const label = formatHourLabel(snapshot.time, referenceDate);
    const verdict = advice.recommended ? "✅ Sì, condizioni favorevoli" : "❌ Meglio evitare";

    const lines = [
      `📍 ${formatLocation(location)} — modalità corsa`,
      "",
      `*${escapeMarkdownV2(label)}*: ${getWeatherEmoji(snapshot.weatherCode)} ${escapeMarkdownV2(describeWeatherCode(snapshot.weatherCode))}`,
      `🌡️ ${escapeMarkdownV2(String(snapshot.temperature))}°C — 💨 ${escapeMarkdownV2(String(snapshot.windSpeed))} km/h — 🌧️ ${escapeMarkdownV2(String(snapshot.precipitationProbability))}%`,
      "",
      `${verdict}: ${escapeMarkdownV2(advice.reason)}`,
    ];

    if (minuteStr !== "00") {
      lines.push("", "ℹ️ Dati orari, arrotondati all'ora\\.");
    }

    const before = weather.hourly[index - 1];
    const after = weather.hourly[index + 1];
    if (before || after) {
      lines.push("", "_Ore adiacenti:_");
      if (before) {
        lines.push(
          `${escapeMarkdownV2(formatHourLabel(before.time, referenceDate))}: ${escapeMarkdownV2(String(before.temperature))}°C, 💨 ${escapeMarkdownV2(String(before.windSpeed))} km/h, 🌧️ ${escapeMarkdownV2(String(before.precipitationProbability))}%`,
        );
      }
      if (after) {
        lines.push(
          `${escapeMarkdownV2(formatHourLabel(after.time, referenceDate))}: ${escapeMarkdownV2(String(after.temperature))}°C, 💨 ${escapeMarkdownV2(String(after.windSpeed))} km/h, 🌧️ ${escapeMarkdownV2(String(after.precipitationProbability))}%`,
        );
      }
    }

    return lines.join("\n");
  }

  const best = getBestRunningWindow(weather.hourly);

  if (!best) {
    const now = getRunningAdvice(weather.hourly[0]);
    return (
      `📍 ${formatLocation(location)} — modalità corsa\n\n` +
      `⚠️ Nessuna fascia ideale nelle prossime 12 ore\\.\n` +
      `Condizioni attuali: ${escapeMarkdownV2(now.reason)}\\.`
    );
  }

  const label = formatHourLabel(best.time, referenceDate);
  return (
    `📍 ${formatLocation(location)} — modalità corsa\n\n` +
    `🏃 Fascia migliore: *${escapeMarkdownV2(label)}*\n` +
    `${getWeatherEmoji(best.weatherCode)} ${escapeMarkdownV2(describeWeatherCode(best.weatherCode))} — 🌡️ ${escapeMarkdownV2(String(best.temperature))}°C — 💨 ${escapeMarkdownV2(String(best.windSpeed))} km/h — 🌧️ ${escapeMarkdownV2(String(best.precipitationProbability))}%`
  );
}

const MAX_CALLBACK_NAME_LENGTH = 18;

function truncateForCallback(name: string): string {
  return name.length > MAX_CALLBACK_NAME_LENGTH
    ? name.slice(0, MAX_CALLBACK_NAME_LENGTH)
    : name;
}

export function buildRefreshKeyboard(
  location: Location,
  kind: ReportKind,
): InlineKeyboard {
  const coords = `${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
  const name = truncateForCallback(location.name);

  let action: string;
  if (kind.type === "current") {
    action = `r:c:${coords}:${name}`;
  } else if (kind.type === "period") {
    action = `r:p:${coords}:${kind.dayOffset}${PERIOD_CODES[kind.period]}:${name}`;
  } else {
    action = `r:o:${coords}:${kind.dayOffset}:${name}`;
  }

  return new InlineKeyboard()
    .text("🔄 Aggiorna", action)
    .text("📍 Cambia città", "cc");
}

const requestLog = new Map<number, number[]>();

function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const timestamps = (requestLog.get(userId) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );

  timestamps.push(now);
  requestLog.set(userId, timestamps);

  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of requestLog) {
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      requestLog.delete(userId);
    } else {
      requestLog.set(userId, recent);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN non impostato. Imposta la variabile d'ambiente BOT_TOKEN.");
}
if (!WEBHOOK_SECRET) {
  throw new Error("WEBHOOK_SECRET non impostato. Imposta la variabile d'ambiente WEBHOOK_SECRET.");
}

const bot = new Bot(BOT_TOKEN);

startAlertScheduler(bot);

// Gestore di errori globale: cattura tutto ciò che sfugge ai try/catch
// nei singoli handler, evitando unhandled rejection / crash del processo.
bot.catch((err) => {
  logger.error(
    { updateId: err.ctx.update.update_id, err: err.error },
    "Errore non gestito durante l'elaborazione dell'update",
  );
});

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;

  if (userId && isRateLimited(userId)) {
    await ctx.reply(
      "Stai inviando troppe richieste. Aspetta un minuto e riprova.",
    );
    return;
  }

  await next();
});

bot.command("start", (ctx) => {
  return ctx.reply(
    "Ciao! Sono il tuo assistente meteo. Scrivimi una città per sapere che tempo fa.\nScrivi /help per saperne di più.",
  );
});

bot.command("help", (ctx) => {
  return ctx.reply(
    "Ecco cosa posso fare:\n\n" +
      '📍 Scrivimi il nome di una città (es. "Milano" o "Milano, Italia") e ti dico:\n' +
      "  • temperatura e condizioni attuali\n" +
      "  • se ti serve l'ombrello ☂️\n" +
      "  • se è una buona giornata per correre 🏃\n" +
      "  • quanto è affidabile la previsione 📊\n\n" +
      "Comandi disponibili:\n" +
      "/start — messaggio di benvenuto\n" +
      "/help — questo messaggio\n\n" +
      "/setcity <città> - imposta la tua città preferita\n" +
      "/meteo - meteo attuale della città preferita\n" +
      "/mycity - mostra la città preferita impostata\n" +
      "/oggi - panoramica meteo di oggi (città preferita)\n" +
      "/domani - panoramica meteo di domani (città preferita)\n\n" +
      "/alert <HH:MM> - attiva l'alert meteo giornaliero (panoramica della giornata)\n" +
      "/stopalert - disattiva l'alert\n" +
      "/myalert - mostra l'orario dell'alert impostato\n" +
      "/settimana [città] - panoramica meteo dei prossimi giorni\n" +
      "/corsa [città] [HH:MM] - trova la fascia migliore per correre\n\n" + 
      "📅 Puoi anche chiedere il meteo per un altro momento, es.:\n" +
      '  • "Milano stasera"\n' +
      '  • "Roma domani mattina"\n' +
      '  • "Torino domani" (panoramica dell\'intera giornata)\n\n',
  );
});

bot.command("setcity", async (ctx) => {
  const cityArg = ctx.match.trim();

  if (!cityArg) {
    await ctx.reply(
      "Usa /setcity seguito dal nome della città, es. /setcity Cagliari",
    );
    return;
  }

  try {
    const geocoding = await getCoordinates(cityArg);

    if (!geocoding) {
      await ctx.reply(
        `Non ho trovato "${cityArg}". Controlla il nome e riprova.`,
      );
      return;
    }

    const { location, alternatives, disambiguated } = geocoding;
    const ambiguous = disambiguated
      ? []
      : findAmbiguousAlternatives(location, alternatives);

    if (ambiguous.length > 0) {
      const options = [location, ...ambiguous.slice(0, 2)]
        .map((loc) => `• ${formatLocation(loc)}`)
        .join("\n");

      await ctx.reply(
        `Ho trovato più città con questo nome\\. Specifica meglio \\(es\\. "Milano, Italia"\\):\n${options}`,
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const weather = await getWeather(location.latitude, location.longitude);

    setUserPrefs(ctx.from!.id, {
      cityName: location.name,
      cityAdmin1: location.admin1,
      cityCountry: location.country,
      lat: location.latitude,
      lon: location.longitude,
      utcOffsetSeconds: weather.utcOffsetSeconds,
    });

    await ctx.reply(
      `Città preferita impostata: ${formatLocation(location)} ✅`,
      {
        parse_mode: "MarkdownV2",
      },
    );
  } catch (err) {
    await replyWithWeatherError(ctx, err, cityArg);
  }
});

bot.command("meteo", async (ctx) => {
  const prefs = getUserPrefs(ctx.from!.id);
  const location = prefs && locationFromPrefs(prefs);

  if (!location) {
    await ctx.reply(
      "Non hai ancora impostato una città preferita. Usa /setcity <città> per impostarla.",
    );
    return;
  }

  try {
    await replyWithCurrentWeather(ctx, location);
  } catch (err) {
    await replyWithWeatherError(ctx, err, location.name);
  }
});

bot.command("mycity", async (ctx) => {
  const prefs = getUserPrefs(ctx.from!.id);
  const location = prefs && locationFromPrefs(prefs);

  if (!location) {
    await ctx.reply(
      "Non hai ancora impostato una città preferita. Usa /setcity <città> per impostarla.",
    );
    return;
  }

  await ctx.reply(`La tua città preferita è: ${formatLocation(location)}`, {
    parse_mode: "MarkdownV2",
  });
});

bot.command("oggi", async (ctx) => {
  await replyWithDayOverview(ctx, 0);
});

bot.command("domani", async (ctx) => {
  await replyWithDayOverview(ctx, 1);
});

const ALERT_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

bot.command("alert", async (ctx) => {
  const arg = ctx.match.trim();

  if (!ALERT_TIME_REGEX.test(arg)) {
    await ctx.reply(
      "Usa /alert seguito dall'orario nel formato HH:MM, es. /alert 07:30",
    );
    return;
  }

  const prefs = getUserPrefs(ctx.from!.id);
  if (!prefs || prefs.utcOffsetSeconds === undefined) {
    await ctx.reply(
      "Devi prima impostare una città preferita con /setcity <città>.",
    );
    return;
  }

  setUserPrefs(ctx.from!.id, { alertTime: arg });
  await ctx.reply(
    `Alert impostato per le ${arg} (ora locale di ${prefs.cityName}) ✅`,
  );
});

bot.command("stopalert", async (ctx) => {
  const prefs = getUserPrefs(ctx.from!.id);

  if (!prefs?.alertTime) {
    await ctx.reply("Non hai nessun alert attivo");
    return;
  }

  setUserPrefs(ctx.from!.id, { alertTime: undefined });
  await ctx.reply("Alert disattivato.");
});

bot.command("myalert", async (ctx) => {
  const prefs = getUserPrefs(ctx.from!.id);

  if (!prefs?.alertTime) {
    await ctx.reply(
      "Non hai nessun alert impostato. Usa /alert <HH:MM> per attivarlo.",
    );
    return;
  }

  await ctx.reply(`Il tuo alert è impostato per le ${prefs.alertTime}.`);
});

bot.command("settimana", async (ctx) => {
  const cityArg = ctx.match.trim();

  try {
    const location = await resolveLocation(ctx, cityArg);
    if (!location) return;

    const weather = await getWeather(location.latitude, location.longitude);
    await ctx.reply(formatWeeklyReport(location, weather), { parse_mode: "MarkdownV2" });
  } catch (error) {
    await replyWithWeatherError(ctx, error, cityArg || "città preferita");
  }
});

bot.command("corsa", async (ctx) => {
  const raw = ctx.match.trim();
  const parts = raw.length > 0 ? raw.split(/\s+/) : [];

  let timeArg: string | null = null;
  if (parts.length > 0 && ALERT_TIME_REGEX.test(parts[parts.length - 1])) {
    timeArg = parts.pop()!;
  }
  const cityArg = parts.join(" ");

  try {
      const location = await resolveLocation(ctx, cityArg);
      if (!location) return;

      const weather = await getWeather(location.latitude, location.longitude);
      await ctx.reply(formatRunningReport(location, weather, timeArg), {
        parse_mode: "MarkdownV2",
      });
    } catch (error) {
      await replyWithWeatherError(ctx, error, cityArg || "città preferita");
    }
})

async function replyWithDayOverview(
  ctx: Context,
  dayOffset: DayOffset,
): Promise<void> {
  const prefs = getUserPrefs(ctx.from!.id);
  const location = prefs && locationFromPrefs(prefs);

  if (!location) {
    await ctx.reply(
      "Non hai ancora impostato una città preferita. Usa /setcity <città> per impostarla.",
    );
    return;
  }

  try {
    const weather = await getWeather(location.latitude, location.longitude);
    await ctx.reply(formatDayOverview(location, weather, dayOffset), {
      parse_mode: "MarkdownV2",
      reply_markup: buildRefreshKeyboard(location, {
        type: "overview",
        dayOffset,
      }),
    });
  } catch (err) {
    await replyWithWeatherError(ctx, err, location.name);
  }
}

function formatLocation(loc: Location): string {
  return [loc.name, loc.admin1, loc.country]
    .filter(Boolean)
    .map((part) => escapeMarkdownV2(part as string))
    .join(", ");
}

export function locationFromPrefs(prefs: UserPrefs): Location | null {
  if (prefs.lat === undefined || prefs.lon === undefined || !prefs.cityName) {
    return null;
  }
  return {
    name: prefs.cityName,
    admin1: prefs.cityAdmin1,
    country: prefs.cityCountry ?? "",
    latitude: prefs.lat,
    longitude: prefs.lon,
  };
}

const MIN_AMBIGUOUS_POPULATION = 1000;

function findAmbiguousAlternatives(
  best: Location,
  alternatives: Location[],
): Location[] {
  return alternatives.filter(
    (alt) =>
      (alt.country !== best.country || alt.admin1 !== best.admin1) &&
      (alt.population ?? 0) >= MIN_AMBIGUOUS_POPULATION,
  );
}

async function resolveLocation(
  ctx: Context,
  cityArg: string,
): Promise<Location | null> {
  if (cityArg) {
    const geocoding = await getCoordinates(cityArg);

    if (!geocoding) {
      await ctx.reply(
        `Non ho trovato "${cityArg}". Controlla il nome e riprova.`,
      );
      return null;
    }

    const { location: found, alternatives, disambiguated } = geocoding;
    const ambiguous = disambiguated
      ? []
      : findAmbiguousAlternatives(found, alternatives);

    if (ambiguous.length > 0) {
      const options = [found, ...ambiguous.slice(0, 2)]
        .map((loc) => `• ${formatLocation(loc)}`)
        .join("\n");

      await ctx.reply(
        `Ho trovato più città con questo nome\\. Specifica meglio \\(es\\. "Milano, Italia"\\):\n${options}`,
        { parse_mode: "MarkdownV2" },
      );
      return null;
    }

    return found;
  }

  const prefs = getUserPrefs(ctx.from!.id);
  const saved = prefs && locationFromPrefs(prefs);

  if (!saved) {
    await ctx.reply(
      "Scrivimi il nome di una città per sapere che tempo fa, oppure impostane una predefinita con /setcity <città>.",
    );
    return null;
  }

  return saved;
}

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (!text || text.startsWith("/")) {
    await ctx.reply("Scrivimi il nome di una città per sapere che tempo fa.");
    return;
  }

  if (text.length > 80) {
    await ctx.reply(
      "Il messaggio sembra troppo lungo. Riprova con un testo più breve.",
    );
    return;
  }

  const { city, time } = parseTimeContext(text);

  try {
    const location = await resolveLocation(ctx, city ?? "");
    if (!location) return;

    const weather = await getWeather(location.latitude, location.longitude);

    if (!time) {
      await ctx.reply(formatCurrentReport(location, weather), {
        parse_mode: "MarkdownV2",
        reply_markup: buildRefreshKeyboard(location, { type: "current" }),
      });
      return;
    }

    if (!time.period) {
      await ctx.reply(formatDayOverview(location, weather, time.dayOffset), {
        parse_mode: "MarkdownV2",
        reply_markup: buildRefreshKeyboard(location, {
          type: "overview",
          dayOffset: time.dayOffset,
        }),
      });
      return;
    }

    const dayOffset = time.dayOffset;
    const period = time.period;
    const forecast = getPeriodForecast(weather.hourly, dayOffset, period);

    if (!forecast) {
      await ctx.reply(
        `Non ho previsioni disponibili per "${DAY_LABELS[dayOffset]} ${PERIOD_LABELS[period]}". Probabilmente è un orario già passato.`,
      );
      return;
    }

    await ctx.reply(formatPeriodReport(location, forecast, dayOffset, period), {
      parse_mode: "MarkdownV2",
      reply_markup: buildRefreshKeyboard(location, {
        type: "period",
        dayOffset,
        period,
      }),
    });
  } catch (error) {
    await replyWithWeatherError(ctx, error, city || "città preferita");
  }
});

function isNotModifiedError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.description.includes("message is not modified")
  );
}

async function replyWithWeatherError(
  ctx: Context,
  err: unknown,
  city: string,
): Promise<void> {
  logger.error(
    { err, userId: ctx.from?.id, city },
    "Errore nel recupero meteo",
  );

  if (err instanceof WeatherServiceError && err.code === "TIMEOUT") {
    await ctx.reply(
      "Il servizio meteo sta impiegando troppo tempo a rispondere. Riprova tra poco.",
    );
  } else if (
    err instanceof WeatherServiceError &&
    err.code === "RATE_LIMITED"
  ) {
    await ctx.reply(
      "Il servizio meteo è momentaneamente sovraccarico. Riprova tra qualche minuto.",
    );
  } else if (err instanceof WeatherServiceError && err.code === "NETWORK") {
    await ctx.reply(
      "Il servizio meteo non è raggiungibile al momento. Riprova tra qualche minuto.",
    );
  } else {
    await ctx.reply(
      "Si è verificato un errore nel recuperare i dati meteo. Riprova tra poco.",
    );
  }
}

async function replyWithCurrentWeather(
  ctx: Context,
  location: Location,
): Promise<void> {
  const weather = await getWeather(location.latitude, location.longitude);
  await ctx.reply(formatCurrentReport(location, weather), {
    parse_mode: "MarkdownV2",
    reply_markup: buildRefreshKeyboard(location, { type: "current" }),
  });
}

bot.callbackQuery(/^r:c:(-?\d+\.\d+),(-?\d+\.\d+):(.+)$/, async (ctx) => {
  const [, latStr, lonStr, name] = ctx.match;
  const lat = Number(latStr);
  const lon = Number(lonStr);
  const location: Location = {
    name,
    country: "",
    latitude: lat,
    longitude: lon,
  };

  try {
    const weather = await getWeather(lat, lon);
    await ctx.editMessageText(formatCurrentReport(location, weather), {
      parse_mode: "MarkdownV2",
      reply_markup: buildRefreshKeyboard(location, { type: "current" }),
    });
    await ctx.answerCallbackQuery();
  } catch (err) {
    if (isNotModifiedError(err)) {
      await ctx.answerCallbackQuery();
      return;
    }
    logger.error(
      { err, userId: ctx.from?.id },
      "Errore nel refresh meteo corrente",
    );
    await ctx.answerCallbackQuery({
      text: "Errore nell'aggiornamento, riprova.",
      show_alert: true,
    });
  }
});

bot.callbackQuery(
  /^r:p:(-?\d+\.\d+),(-?\d+\.\d+):(\d)([mpsn]):(.+)$/,
  async (ctx) => {
    const [, latStr, lonStr, dayOffsetStr, periodCode, name] = ctx.match;
    const lat = Number(latStr);
    const lon = Number(lonStr);
    const dayOffset = Number(dayOffsetStr) as DayOffset;
    const period = PERIOD_FROM_CODE[periodCode];
    const location: Location = {
      name,
      country: "",
      latitude: lat,
      longitude: lon,
    };

    try {
      const weather = await getWeather(lat, lon);
      const forecast = getPeriodForecast(weather.hourly, dayOffset, period);
      if (!forecast) {
        await ctx.answerCallbackQuery({
          text: "Previsione non più disponibile.",
          show_alert: true,
        });
        return;
      }
      await ctx.editMessageText(
        formatPeriodReport(location, forecast, dayOffset, period),
        {
          parse_mode: "MarkdownV2",
          reply_markup: buildRefreshKeyboard(location, {
            type: "period",
            dayOffset,
            period,
          }),
        },
      );
      await ctx.answerCallbackQuery();
    } catch (err) {
      if (isNotModifiedError(err)) {
        await ctx.answerCallbackQuery();
        return;
      }
      logger.error(
        { err, userId: ctx.from?.id },
        "Errore nel refresh meteo per fascia",
      );
      await ctx.answerCallbackQuery({
        text: "Errore nell'aggiornamento, riprova.",
        show_alert: true,
      });
    }
  },
);

bot.callbackQuery(/^r:o:(-?\d+\.\d+),(-?\d+\.\d+):(\d):(.+)$/, async (ctx) => {
  const [, latStr, lonStr, dayOffsetStr, name] = ctx.match;
  const lat = Number(latStr);
  const lon = Number(lonStr);
  const dayOffset = Number(dayOffsetStr) as DayOffset;
  const location: Location = {
    name,
    country: "",
    latitude: lat,
    longitude: lon,
  };

  try {
    const weather = await getWeather(lat, lon);
    await ctx.editMessageText(formatDayOverview(location, weather, dayOffset), {
      parse_mode: "MarkdownV2",
      reply_markup: buildRefreshKeyboard(location, {
        type: "overview",
        dayOffset,
      }),
    });
    await ctx.answerCallbackQuery();
  } catch (err) {
    if (isNotModifiedError(err)) {
      await ctx.answerCallbackQuery();
      return;
    }
    logger.error(
      { err, userId: ctx.from?.id },
      "Errore nel refresh panoramica giornata",
    );
    await ctx.answerCallbackQuery({
      text: "Errore nell'aggiornamento, riprova.",
      show_alert: true,
    });
  }
});

bot.callbackQuery("cc", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Scrivimi il nome della nuova città.");
});

// Fallback per messaggi non testuali (foto, sticker, vocali, ecc.)
// Va registrato DOPO bot.on("message:text") perché grammY ferma la
// catena se un handler precedente ha già gestito l'update.
bot.on("message", async (ctx) => {
  await ctx.reply(
    "Posso rispondere solo a messaggi di testo con il nome di una città.",
  );
});

// Setup Express + webhook
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("OK");
});

app.use(
  `/webhook`,
  webhookCallback(bot, "express", {
    timeoutMilliseconds: 25000,
    secretToken: WEBHOOK_SECRET,
  }),
);

bot.api
  .setMyCommands([
    { command: "start", description: "Messaggio di benvenuto" },
    { command: "help", description: "Cosa posso fare" },
    { command: "setcity", description: "Imposta la città preferita" },
    { command: "meteo", description: "Meteo della città preferita" },
    { command: "mycity", description: "Mostra la città preferita" },
    { command: "oggi", description: "Panoramica meteo di oggi" },
    { command: "domani", description: "Panoramica meteo di domani" },
    { command: "alert", description: "Attiva l'alert meteo giornaliero" },
    { command: "stopalert", description: "Disattiva l'alert" },
    { command: "myalert", description: "mostra l'orario dell'alert" },
    { command: "settimana", description: "Panoramica meteo dei prossimi giorni" },
    { command: "corsa", description: "Trova la fascia migliore per correre" },
  ])
  .catch((err) => logger.error({ err }, "Errore setMyCommands"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info({ port: PORT }, "Server avviato");
});
