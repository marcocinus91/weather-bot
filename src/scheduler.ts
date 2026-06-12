import { Bot } from "grammy";
import { getUserWithAlert } from "./store";
import { getWeather } from "./weather";
import { logger } from "./logger";
import { formatDayOverview, locationFromPrefs, buildRefreshKeyboard } from ".";

const CHECK_INTERVAL_MS = 60_000;

export function startAlertScheduler(bot: Bot): void {
    const sentToday = new Map<number, string>();

    setInterval(async () => {
        for (const [userId, prefs] of getUserWithAlert()) {
            const location = locationFromPrefs(prefs);
            if (!location || prefs.utcOffsetSeconds === undefined) continue;

            const localNow = new Date(Date.now() + prefs.utcOffsetSeconds * 1000);
            const hh = String(localNow.getUTCHours()).padStart(2, "0");
            const mm = String(localNow.getUTCMinutes()).padStart(2, "0");
            const localTime = `${hh}:${mm}`;
            const localDate = localNow.toISOString().slice(0, 10);

            if (localTime !== prefs.alertTime || sentToday.get(userId) === localDate) continue;

            try {
                const weather = await getWeather(location.latitude, location.longitude);
                await bot.api.sendMessage(userId, formatDayOverview(location, weather, 0), {
                    parse_mode: "MarkdownV2",
                    reply_markup: buildRefreshKeyboard(location, { type: "overview", dayOffset: 0 }),
                });
                sentToday.set(userId, localDate);
            } catch (err) {
                logger.error({ err, userId }, "Errore invio alert mattutino");
            }
        }
    }, CHECK_INTERVAL_MS);
}