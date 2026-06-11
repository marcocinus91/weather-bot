import { Bot, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import {
  getCoordinates,
  getWeather,
  WeatherServiceError,
  Location,
} from "./weather";
import {
  describeWeatherCode,
  getUmbrellaAdvice,
  getRunningAdvice,
  getReliability,
} from "./decision";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

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

const bot = new Bot(process.env.BOT_TOKEN!);

// Gestore di errori globale: cattura tutto ciò che sfugge ai try/catch
// nei singoli handler, evitando unhandled rejection / crash del processo.
bot.catch((err) => {
  console.error(
    `Errore non gestito durante l'elaborazione dell'update ${err.ctx.update.update_id}:`,
    err.error,
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
  ctx.reply(
    "Ciao! Sono il tuo assistente meteo. Scrivimi una città per sapere che tempo fa.\nScrivi /help per saperne di più.",
  );
});

bot.command("help", (ctx) => {
  ctx.reply(
    "Ecco cosa posso fare:\n\n" +
      '📍 Scrivimi il nome di una città (es. "Milano" o "Milano, Italia") e ti dico:\n' +
      "  • temperatura e condizioni attuali\n" +
      "  • se ti serve l'ombrello ☂️\n" +
      "  • se è una buona giornata per correre 🏃\n" +
      "  • quanto è affidabile la previsione 📊\n\n" +
      "Comandi disponibili:\n" +
      "/start — messaggio di benvenuto\n" +
      "/help — questo messaggio",
  );
});

function formatLocation(loc: Location): string {
  return [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");
}

function findAmbiguousAlternatives(
  best: Location,
  alternatives: Location[],
): Location[] {
  return alternatives.filter(
    (alt) => alt.country !== best.country || alt.admin1 !== best.admin1,
  );
}

bot.on("message:text", async (ctx) => {
  const city = ctx.message.text.trim();

  if (!city || city.startsWith("/")) {
    await ctx.reply("Scrivimi il nome di una città per sapere che tempo fa.");
    return;
  }

  if (city.length > 80) {
    await ctx.reply(
      "Il nome della città sembra troppo lungo. Riprova con un nome più breve.",
    );
    return;
  }

  try {
    const geocoding = await getCoordinates(city);

    if (!geocoding) {
      await ctx.reply(`Non ho trovato "${city}". Controlla il nome e riprova.`);
      return;
    }

    const { location, alternatives } = geocoding;
    const ambiguous = findAmbiguousAlternatives(location, alternatives);

    if (ambiguous.length > 0) {
      const options = [location, ...ambiguous.slice(0, 2)]
        .map((loc) => `• ${formatLocation(loc)}`)
        .join("\n");

      await ctx.reply(
        `Ho trovato più città con questo nome. Specifica meglio (es. "Milano, Italia"):\n${options}`,
      );
      return;
    }

    const weather = await getWeather(location.latitude, location.longitude);
    const description = describeWeatherCode(weather.weatherCode);
    const umbrella = getUmbrellaAdvice(weather);
    const running = getRunningAdvice(weather);
    const reliability = getReliability(weather);

    await ctx.reply(
      `📍 ${formatLocation(location)}\n` +
        `${description}, ${weather.temperature}°C\n\n` +
        `☂️ Ombrello: ${umbrella.needed ? "sì" : "no"} — ${umbrella.reason}\n` +
        `🏃 Uscire/correre: ${running.recommended ? "consigliato" : "sconsigliato"} — ${running.reason}\n` +
        `📊 Affidabilità previsione: ${reliability.level} — ${reliability.reason}\n\n` +
        `💨 Vento: ${weather.windSpeed} km/h | 🌧️ Precipitazioni: ${weather.precipitation} mm`,
    );
  } catch (err) {
    console.error("Errore nel recupero meteo:", err);

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
    secretToken: process.env.WEBHOOK_SECRET,
  }),
);

bot.api
  .setMyCommands([
    { command: "start", description: "Messaggio di benvenuto" },
    { command: "help", description: "Cosa posso fare" },
  ])
  .catch((err) => console.error("Errore setMyCommands", err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
