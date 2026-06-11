import { Bot, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import { getCoordinates, getWeather, WeatherServiceError, Location } from "./weather";
import {
  describeWeatherCode,
  getUmbrellaAdvice,
  getRunningAdvice,
  getReliability,
} from "./decision";

const bot = new Bot(process.env.BOT_TOKEN!);

bot.command("start", (ctx) => {
  ctx.reply(
    "Ciao! Sono il tuo assistente meteo. Scrivimi una città per sapere che tempo fa.",
  );
});

function formatLocation(loc: Location): string {
  return [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");
}

// Considera "ambigua" una città solo se gli altri risultati indicano
// luoghi davvero diversi (paese o regione diversi dal primo risultato).
function findAmbiguousAlternatives(best: Location, alternatives: Location[]): Location[] {
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
    await ctx.reply("Il nome della città sembra troppo lungo. Riprova con un nome più breve.");
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

// Setup Express + webhook
const app = express();
app.use(express.json());
app.use(`/webhook`, webhookCallback(bot, "express", { timeoutMilliseconds: 25000 }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
