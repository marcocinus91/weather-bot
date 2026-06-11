import { Bot, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import { getCoordinates, getWeather } from "./weather";
import {
  describeWeatherCode,
  getUmbrellaAdvice,
  getRunningAdvice,
  getReliability,
} from "./decision";

const bot = new Bot(process.env.BOT_TOKEN!);

// Risponde al comando /start
bot.command("start", (ctx) => {
  ctx.reply(
    "Ciao! Sono il tuo assistente meteo. Scrivimi una città per sapere che tempo fa.",
  );
});

// Risponde a qualsiasi messaggio di testo
bot.on("message:text", async (ctx) => {
  const city = ctx.message.text.trim();

  try {
    const location = await getCoordinates(city);

    if (!location) {
      await ctx.reply(`Non ho trovato "${city}". Controlla il nome e riprova.`);
      return;
    }

    const weather = await getWeather(location.latitude, location.longitude);
    const description = describeWeatherCode(weather.weatherCode);
    const umbrella = getUmbrellaAdvice(weather);
    const running = getRunningAdvice(weather);
    const reliability = getReliability(weather);

    const locationLabel = [location.name, location.admin1, location.country]
      .filter(Boolean)
      .join(", ");

    await ctx.reply(
      `📍 ${locationLabel}\n` +
        `${description}, ${weather.temperature}°C\n\n` +
        `☂️ Ombrello: ${umbrella.needed ? "sì" : "no"} — ${umbrella.reason}\n` +
        `🏃 Uscire/correre: ${running.recommended ? "consigliato" : "sconsigliato"} — ${running.reason}\n` +
        `📊 Affidabilità previsione: ${reliability.level} — ${reliability.reason}\n\n` +
        `💨 Vento: ${weather.windSpeed} km/h | 🌧️ Precipitazioni: ${weather.precipitation} mm`,
    );
  } catch (err) {
    console.error("Errore nel recupero meteo:", err);

    if (err instanceof Error && err.name === "AbortError") {
      await ctx.reply(
        "Il servizio meteo sta impiegando troppo tempo a rispondere. Riprova tra poco.",
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
