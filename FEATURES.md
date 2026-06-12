# Feature Roadmap — Weather Decision Assistant Bot

## Stato implementazione

Checklist da aggiornare ad ogni feature completata.

- [x] Decisioni trasversali A — store persistente (`src/store.ts`)
- [x] Decisioni trasversali B — `escapeMarkdownV2()` (`src/format.ts`)
- [x] Decisioni trasversali C — `utcOffsetSeconds` in `WeatherData`/`UserPrefs`
- [x] 1. Formattazione MarkdownV2
- [x] 2. Bottoni inline
- [x] 3. Città preferita (`/setcity`, `/meteo`, `/mycity`)
- [x] 4. Panoramica giornata (miglioramenti)
- [ ] 5. Alert mattutino
- [ ] 6. Meteo settimanale
- [ ] 7. Modalità runner
- [ ] 8. Feedback previsione

---

## Contesto codebase attuale

### File principali
- `src/index.ts` — entry point, bot grammY + server Express, handler messaggi, rate limiting, formatting risposte
- `src/weather.ts` — geocoding + forecast Open-Meteo, cache in-memory con TTL, gestione errori tipizzata (`WeatherServiceError`)
- `src/decision.ts` — logica decisionale (ombrello, corsa, affidabilità), forecast per fascia oraria (`getPeriodForecast`)
- `src/time.ts` — parser contesto temporale (`parseTimeContext` → `DayOffset`, `DayPeriod`)
- `src/store.ts` — store persistente `UserPrefs` (JSON su file)
- `src/format.ts` — `escapeMarkdownV2()`
- `src/logger.ts` — logger strutturato (pino)

### Stack
- Node.js + TypeScript
- grammY (framework bot Telegram)
- Express (server webhook)
- Open-Meteo (geocoding + forecast, no API key)
- Railway (deploy)

### Tipi chiave da conoscere
```typescript
// weather.ts
export interface Location { name, admin1, country, latitude, longitude, population }
export interface WeatherData { temperature, precipitation, weatherCode, windSpeed, precipitationProbability, utcOffsetSeconds, hourly: HourlySnapshot[] }
export interface HourlySnapshot { time, temperature, precipitation, weatherCode, windSpeed, precipitationProbability }

// decision.ts
export interface WeatherSnapshot { temperature, precipitation, weatherCode, windSpeed, precipitationProbability }
export interface PeriodForecast { snapshot: WeatherSnapshot, hours: HourlySnapshot[] }
export type DayOffset = 0 | 1
export type DayPeriod = "mattina" | "pomeriggio" | "sera" | "notte"

// store.ts
export interface UserPrefs { cityName, cityAdmin1, cityCountry, lat, lon, utcOffsetSeconds, alertTime }
```

### Comandi bot esistenti
- `/start` — benvenuto
- `/help` — guida utilizzo
- `/setcity <città>` — imposta la città preferita
- `/meteo` — meteo attuale della città preferita
- `/mycity` — mostra la città preferita
- `/oggi` — panoramica meteo di oggi (città preferita)
- `/domani` — panoramica meteo di domani (città preferita)

### Pattern risposta attuale
Risposte in MarkdownV2 con escape sistematico (`escapeMarkdownV2()`), bottoni inline `🔄 Aggiorna` / `📍 Cambia città` su tutti i report meteo.

---

## Decisioni di design trasversali

Queste tre scelte sono prerequisiti di più feature contemporaneamente. **Implementate.**

### A. Persistenza dello store utenti
`/setcity`, `/alert` (5) e il logging feedback (8) hanno tutti bisogno di ricordare dati per utente. Una `Map` in-memory si azzera ad ogni redeploy — e questo progetto fa redeploy frequenti, quindi `/alert` smetterebbe di funzionare in silenzio ad ogni push.

**Scelta:** `src/store.ts` basato su file JSON.

```typescript
interface UserPrefs {
  cityName?: string;
  cityAdmin1?: string;
  cityCountry?: string;
  lat?: number;
  lon?: number;
  utcOffsetSeconds?: number; // per gli alert, vedi punto 5
  alertTime?: string;        // "HH:MM"
}
```

- Caricare il file in memoria all'avvio, scrivere su disco ad ogni modifica.
- **Nota Railway:** il filesystem del container è effimero ad ogni redeploy a meno di montare un [Volume](https://docs.railway.app/reference/volumes). Senza volume, il file persiste tra restart/crash ma non tra redeploy — comunque un netto miglioramento rispetto a una `Map` pura.
- Niente campo `chatId`: per chat private `ctx.chat.id === ctx.from.id`, è ridondante.

### B. MarkdownV2 + escape sistematico
**Scelta:** `escapeMarkdownV2(text: string): string` in `src/format.ts`, applicato a tutte le stringhe dinamiche (nomi città, descrizioni meteo, valori numerici) prima di inserirle nei template; le parti statiche dei template si scrivono già escapate a mano. Tutte le `ctx.reply()` con report meteo passano `{ parse_mode: "MarkdownV2" }`.

### C. Timezone per gli alert
`utc_offset_seconds` dalla risposta forecast Open-Meteo è stato aggiunto a `WeatherData` e viene salvato in `UserPrefs.utcOffsetSeconds` al momento di `/setcity`. Lo scheduler (punto 5) confronterà l'ora locale calcolata (`UTC now + offset`) con `alertTime`, **non** l'ora del server. L'offset può cambiare con l'ora legale: va ricalcolato periodicamente (es. ad ogni `/setcity` o una volta al giorno) — accettabile non gestirlo in modo perfetto per l'MVP, ma va documentato come limite noto.

---

## Feature da implementare

---

### 1. Formattazione MarkdownV2 ✅

**Obiettivo:** rendere le risposte più leggibili evidenziando i dati chiave, con un sistema di escape robusto fin da subito (vedi decisione B).

**Implementazione:**
- Creare `src/format.ts` con `escapeMarkdownV2()`.
- Aggiornare `formatCurrentReport()`, `formatPeriodReport()`, `formatDayOverview()` in `index.ts`:
  - Applicare `escapeMarkdownV2()` a nome città, admin1, country, descrizione meteo e valori numerici.
  - Grassetto (`*...*`) su: temperatura, risposta ombrello, risposta corsa, livello affidabilità.
- Aggiungere `{ parse_mode: "MarkdownV2" }` a tutte le `ctx.reply()` con report meteo.

---

### 2. Bottoni inline ✅

**Obiettivo:** migliorare l'UX permettendo all'utente di aggiornare il meteo o cambiare città senza riscrivere il messaggio.

**Comportamento implementato:**
- Dopo ogni risposta meteo (corrente, per fascia, panoramica giornata), due bottoni inline:
  - `🔄 Aggiorna` — richiama `getWeather()` con le stesse coordinate e rimanda la risposta aggiornata, nello stesso formato
  - `📍 Cambia città` — invita a scrivere una nuova città
- `callback_data` con prefissi compatti (`r:c:`, `r:p:`, `r:o:`, `cc`), gestiti con `bot.callbackQuery()`, `ctx.editMessageText()`.

---

### 3. Città preferita ✅

**Obiettivo:** l'utente imposta una città default e poi può chiedere il meteo senza specificarla ogni volta.

**Comandi implementati:**
- `/setcity <città>` — salva la città preferita (geocoding + lat/lon/utcOffsetSeconds nello store)
- `/meteo` — restituisce il meteo della città preferita (o messaggio di errore se non impostata)
- `/mycity` — mostra la città preferita attuale

**Note:**
- Nel handler `message:text`, se non viene trovata una città nel testo si usa la città preferita (se impostata).
- Le alternative ambigue con popolazione sotto soglia (`MIN_AMBIGUOUS_POPULATION`) vengono filtrate per evitare falsi positivi (es. frazioni omonime).

---

### 4. Panoramica mattina/pomeriggio/sera/notte ✅

**Obiettivo:** risposta compatta con tutte le fasce orarie della giornata in un solo messaggio.

**Implementazione:**
- `formatDayOverview()` mostra un'emoji per fascia in base al codice meteo (`getWeatherEmoji()` in `decision.ts`).
- Indicatore di affidabilità complessivo calcolato su tutte le ore delle fasce della giornata (`getPeriodReliability()` applicato a `allHours`).
- Comandi `/oggi` e `/domani` come shortcut sulla città preferita (`replyWithDayOverview()`).

---

### 5. Alert mattutino

**Obiettivo:** l'utente riceve automaticamente il meteo ogni mattina all'orario scelto.

**Comandi da aggiungere:**
- `/alert <HH:MM>` — attiva l'alert giornaliero all'orario specificato (es. `/alert 07:30`), riferito all'ora locale della città preferita
- `/stopalert` — disattiva l'alert
- `/myalert` — mostra l'orario attuale dell'alert

**Implementazione suggerita:**
- `UserPrefs` ha già `alertTime` e `utcOffsetSeconds` (decisione A/C).
- Creare `src/scheduler.ts` con un interval ogni minuto che:
  1. Per ogni utente con `alertTime` impostato, calcola l'ora locale come `new Date(Date.now() + utcOffsetSeconds * 1000)` e la confronta (HH:MM) con `alertTime`.
  2. Per ogni match, chiama `getWeather()` e manda il report con `bot.api.sendMessage(userId, ...)`.

**Note:**
- L'interval ogni minuto è semplice ma non preciso al secondo — accettabile per un alert mattutino.
- Richiedere che l'utente abbia già impostato una città preferita (`/setcity`) prima di poter attivare l'alert (così `utcOffsetSeconds` è già disponibile).
- L'offset UTC non viene ricalcolato automaticamente per il cambio ora legale — limite noto, accettabile per l'MVP.
- Aggiornare `/help` con i nuovi comandi.

---

### 6. Meteo settimanale

**Obiettivo:** panoramica dei prossimi 7 giorni.

**Comando da aggiungere:**
- `/settimana <città>` — riassunto meteo per i prossimi 7 giorni

**Implementazione suggerita:**
- Modificare `getWeather()` in `weather.ts` per richiedere sempre `forecast_days=7` (non solo per `/settimana`), e lasciare che i consumer (`getPeriodForecast`, report corrente/fascia) continuino a usare solo le prime ore/il primo giorno come già fanno. Questo evita di avere due varianti di richiesta con cache key diverse.
- Aggiornare `FORECAST_TTL_MS` a 30 minuti per riflettere la dimensione maggiore della risposta.
- Creare funzione `getWeeklyOverview()` in `decision.ts` che aggrega i dati per giorno:
  - Temperatura min/max
  - Codice meteo predominante (usare `pickWorstWeatherCode()` già esistente)
  - Probabilità pioggia massima

**Note:**
- L'affidabilità decresce significativamente oltre i 3 giorni — mostrare un disclaimer nel messaggio `/settimana`.

---

### 7. Modalità runner

**Obiettivo:** comando dedicato per chi vuole sapere la fascia oraria migliore per correre.

> Nota: feature di nicchia (utile solo a chi corre regolarmente), ma a basso costo di implementazione perché riusa `getRunningAdvice()` e `HourlySnapshot[]` già esistenti. Per questo è stata spostata dopo le feature a beneficio più ampio (alert, meteo settimanale).

**Comando da aggiungere:**
- `/corsa <città> [orario]` — analizza le condizioni per correre
  - senza orario: trova la fascia oraria migliore nelle prossime 12 ore
  - con orario (es. `/corsa Cagliari 18:00`): analizza quella fascia specifica

**Implementazione suggerita:**
- Aggiungere handler `bot.command("corsa", ...)` in `index.ts`.
- Logica "fascia migliore" in `src/decision.ts`:
```typescript
export function getBestRunningWindow(hourly: HourlySnapshot[]): HourlySnapshot | null
```
  - Filtra le ore con `getRunningAdvice()` che restituisce `recommended: true`.
  - Tra quelle, sceglie la più fresca (temperatura più bassa) e con meno vento.
- Output dedicato più dettagliato rispetto alla risposta standard: temperatura, vento, probabilità pioggia per la fascia consigliata, confronto con le ore adiacenti.

**Note:**
- Usare `HourlySnapshot[]` già disponibile in `WeatherData.hourly`.
- Aggiornare `/help` con il nuovo comando.

---

### 8. Feedback previsione

**Obiettivo:** raccogliere dati su quanto le previsioni sono state accurate.

**Comportamento atteso:**
- Solo sui report di **meteo corrente** (non su fascia/giorno futuri, dove l'utente non può ancora sapere se la previsione è corretta), aggiungere due bottoni:
  - `✅ Previsione corretta`
  - `❌ Era sbagliata`
- Loggare il feedback con `logger.info()` includendo userId, città, ora della previsione, feedback.

**Implementazione suggerita:**
- Gestire con `bot.callbackQuery(/^feedback:/)`.
- `callback_data` formato: `feedback:correct:<lat>,<lon>` / `feedback:wrong:<lat>,<lon>`.
- Per ora solo logging, nessun DB.

**Note:**
- Bottoni feedback e bottoni refresh (punto 2) sullo stesso messaggio: usare due righe della `InlineKeyboard` per non sovraffollare l'UI.
- Il dato è utile per validazione del prodotto, non per migliorare il modello meteo.
- Estensione futura (fuori scope MVP): un follow-up automatico via scheduler che chiede feedback su previsioni di fascia/giorno *dopo* che l'orario previsto è passato — riusa lo scheduler del punto 5.

---

## Ordine di implementazione consigliato

1. ~~Decisioni trasversali (A, B, C)~~ ✅
2. ~~Formattazione MarkdownV2~~ ✅
3. ~~Bottoni inline~~ ✅
4. ~~Città preferita~~ ✅
5. ~~Panoramica giornata~~ ✅
6. **Alert mattutino** — dipende da città preferita (4) e da `utcOffsetSeconds` (C), richiede scheduler.
7. **Meteo settimanale** — modifica a `weather.ts` (richiesta unica a 7 giorni) + nuova funzione in `decision.ts`.
8. **Modalità runner** — niche, basso costo, riusa logica esistente.
9. **Feedback** — riusa la `InlineKeyboard` del punto 2, scope ridotto a meteo corrente.
