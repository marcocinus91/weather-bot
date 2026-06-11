# Feature Roadmap — Weather Decision Assistant Bot

## Contesto codebase attuale

### File principali
- `src/index.ts` — entry point, bot grammY + server Express, handler messaggi, rate limiting, formatting risposte
- `src/weather.ts` — geocoding + forecast Open-Meteo, cache in-memory con TTL, gestione errori tipizzata (`WeatherServiceError`)
- `src/decision.ts` — logica decisionale (ombrello, corsa, affidabilità), forecast per fascia oraria (`getPeriodForecast`)
- `src/time.ts` — parser contesto temporale (`parseTimeContext` → `DayOffset`, `DayPeriod`)
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
export interface Location { name, admin1, country, latitude, longitude }
export interface WeatherData { temperature, precipitation, weatherCode, windSpeed, precipitationProbability, hourly: HourlySnapshot[] }
export interface HourlySnapshot { time, temperature, precipitation, weatherCode, windSpeed, precipitationProbability }

// decision.ts
export interface WeatherSnapshot { temperature, precipitation, weatherCode, windSpeed, precipitationProbability }
export interface PeriodForecast { snapshot: WeatherSnapshot, hours: HourlySnapshot[] }
export type DayOffset = 0 | 1
export type DayPeriod = "mattina" | "pomeriggio" | "sera" | "notte"
```

### Comandi bot esistenti
- `/start` — benvenuto
- `/help` — guida utilizzo

### Pattern risposta attuale
Le risposte sono stringhe plain text con emoji. Nessun `parse_mode` attivo al momento.

---

## Decisioni di design trasversali

Queste tre scelte sono prerequisiti di più feature contemporaneamente: vanno prese **prima** di iniziare, altrimenti si rischia di rifare lavoro più avanti.

### A. Persistenza dello store utenti
`/setcity` (2), `/alert` (6) e il logging feedback (7) hanno tutti bisogno di ricordare dati per utente. Una `Map` in-memory si azzera ad ogni redeploy — e questo progetto fa redeploy frequenti, quindi `/alert` smetterebbe di funzionare in silenzio ad ogni push.

**Scelta:** `src/store.ts` basato su file JSON (o SQLite via `better-sqlite3` se si preferisce, ma per questo volume di dati un JSON va benissimo) invece di una semplice `Map`.

```typescript
interface UserPrefs {
  city?: string;
  cityDisplay?: string;
  lat?: number;
  lon?: number;
  utcOffsetSeconds?: number; // per gli alert, vedi punto 6
  alertTime?: string;        // "HH:MM"
}
```

- Caricare il file in memoria all'avvio, scrivere su disco (debounced o ad ogni modifica) ad ogni cambio.
- **Nota Railway:** il filesystem del container è effimero ad ogni redeploy a meno di montare un [Volume](https://docs.railway.app/reference/volumes). Senza volume, il file persiste tra restart/crash ma non tra redeploy — comunque un netto miglioramento rispetto a una `Map` pura, e se in futuro si monta un volume non serve cambiare codice.
- Niente campo `chatId`: per chat private `ctx.chat.id === ctx.from.id`, è ridondante.

### B. MarkdownV2 + escape sistematico
Plain `Markdown` si rompe facilmente su testo arbitrario (nomi città con apostrofi, trattini, ecc. → Telegram rifiuta il messaggio per entità malformate). Si parte direttamente con **MarkdownV2**.

- Creare `escapeMarkdownV2(text: string): string` in `src/format.ts` (nuovo file) che esegue l'escape dei caratteri speciali (`_*[]()~\`>#+-=|{}.!`).
- Applicarlo a **tutte** le stringhe dinamiche (nomi città, descrizioni meteo) prima di inserirle nei template; le parti statiche dei template si scrivono già escapate a mano.
- Tutte le `ctx.reply()` con report meteo passano `{ parse_mode: "MarkdownV2" }`.

### C. Timezone per gli alert
Open-Meteo, con `timezone=auto`, restituisce anche `utc_offset_seconds` nella risposta forecast. Va aggiunto a `WeatherData` e salvato in `UserPrefs.utcOffsetSeconds` al momento di `/setcity` (o del primo `/alert`). Lo scheduler (punto 6) confronta l'ora locale calcolata (`UTC now + offset`) con `alertTime`, **non** l'ora del server. L'offset può cambiare con l'ora legale: va ricalcolato periodicamente (es. ad ogni `/setcity` o una volta al giorno) — accettabile non gestirlo in modo perfetto per l'MVP, ma va documentato come limite noto.

---

## Feature da implementare

---

### 1. Formattazione MarkdownV2

**Obiettivo:** rendere le risposte più leggibili evidenziando i dati chiave, con un sistema di escape robusto fin da subito (vedi decisione B).

**Implementazione:**
- Creare `src/format.ts` con `escapeMarkdownV2()`.
- Aggiornare `formatCurrentReport()`, `formatPeriodReport()`, `formatDayOverview()` in `index.ts`:
  - Applicare `escapeMarkdownV2()` a nome città, admin1, country e descrizione meteo.
  - Grassetto (`*...*`, già escapato per il resto) su: temperatura, risposta ombrello, risposta corsa, livello affidabilità.
- Aggiungere `{ parse_mode: "MarkdownV2" }` a tutte le `ctx.reply()` con report meteo.

**Esempio trasformazione:**
```
// Prima
`${description}, ${weather.temperature}°C`

// Dopo
`${escapeMarkdownV2(description)}, *${weather.temperature}°C*`
```

**Note:**
- Testare con città che hanno caratteri speciali nel nome (es. "Castiglion Fibocchi", "Sant'Antonio", "Castel d'Ario").
- `°` non è tra i caratteri speciali da escapare in MarkdownV2.

---

### 2. Bottoni inline

**Obiettivo:** migliorare l'UX permettendo all'utente di aggiornare il meteo o cambiare città senza riscrivere il messaggio.

**Comportamento atteso:**
- Dopo ogni risposta meteo (corrente, per fascia, panoramica giornata), aggiungere due bottoni inline:
  - `🔄 Aggiorna` — richiama `getWeather()` con le stesse coordinate e rimanda la risposta aggiornata, nello stesso formato della risposta originale
  - `📍 Cambia città` — manda un messaggio che invita a scrivere una nuova città

**Implementazione suggerita:**
- Usare `InlineKeyboard` di grammY, gestire i callback con `bot.callbackQuery()`.
- `callback_data` deve contenere abbastanza informazioni per rigenerare **lo stesso tipo** di report:
  - Report corrente: `refresh:current:45.4654,9.1859`
  - Report per fascia: `refresh:period:45.4654,9.1859:1:sera`
  - Panoramica giornata: `refresh:overview:45.4654,9.1859:0`
- Le tre formatter functions (`formatCurrentReport`, `formatPeriodReport`, `formatDayOverview`) vanno aggiornate per restituire `{ text, keyboard }` invece di solo `text`, così il chiamante (handler messaggio o callback) applica lo stesso markup.

**Note:**
- `callback_data` ha un limite di 64 byte — anche la variante più lunga (`refresh:period:45.4654,-9.1859:1:pomeriggio`) rientra abbondantemente.
- Rispondere ai callback con `ctx.answerCallbackQuery()` per rimuovere il loading spinner.
- Usare `ctx.editMessageText()` per il refresh, invece di mandare un nuovo messaggio.

---

### 3. Città preferita

**Obiettivo:** l'utente imposta una città default e poi può chiedere il meteo senza specificarla ogni volta.

**Comandi da aggiungere:**
- `/setcity <città>` — salva la città preferita per l'utente (geocoding + salvataggio lat/lon/utcOffsetSeconds nello store, vedi decisione A/C)
- `/meteo` — restituisce il meteo della città preferita (o messaggio di errore se non impostata)
- `/mycity` — mostra la città preferita attuale

**Implementazione suggerita:**
- Usa `src/store.ts` (decisione A).
- In `index.ts`, nel handler `message:text`, se non viene trovata una città nel testo controllare se l'utente ha una città preferita impostata.

**Note:**
- Aggiornare `/help` con i nuovi comandi.

---

### 4. Modalità runner

**Obiettivo:** comando dedicato per chi vuole sapere la fascia oraria migliore per correre.

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

### 5. Panoramica mattina/pomeriggio/sera/notte

**Obiettivo:** risposta compatta con tutte le fasce orarie della giornata in un solo messaggio.

**Stato attuale:** `formatDayOverview()` esiste già in `index.ts` e viene usato quando l'utente scrive "Milano domani" senza specificare la fascia. Funziona già.

**Miglioramenti da fare:**
- Aggiungere emoji coerenti con il codice meteo di ogni fascia.
- Aggiungere indicatore sintetico affidabilità per l'intera giornata.
- Valutare se aggiungere un comando esplicito `/oggi` e `/domani` come shortcut.

---

### 6. Alert mattutino

**Obiettivo:** l'utente riceve automaticamente il meteo ogni mattina all'orario scelto.

**Comandi da aggiungere:**
- `/alert <HH:MM>` — attiva l'alert giornaliero all'orario specificato (es. `/alert 07:30`), riferito all'ora locale della città preferita
- `/stopalert` — disattiva l'alert
- `/myalert` — mostra l'orario attuale dell'alert

**Implementazione suggerita:**
- Estendere `UserPrefs` (già previsto in decisione A) con `alertTime` e `utcOffsetSeconds`.
- Creare `src/scheduler.ts` con un interval ogni minuto che:
  1. Per ogni utente con `alertTime` impostato, calcola l'ora locale come `new Date(Date.now() + utcOffsetSeconds * 1000)` e la confronta (HH:MM) con `alertTime`.
  2. Per ogni match, chiama `getWeather()` e manda il report con `bot.api.sendMessage(userId, ...)`.

**Note:**
- L'interval ogni minuto è semplice ma non preciso al secondo — accettabile per un alert mattutino.
- Richiedere che l'utente abbia già impostato una città preferita (`/setcity`) prima di poter attivare l'alert (così `utcOffsetSeconds` è già disponibile).
- L'offset UTC non viene ricalcolato automaticamente per il cambio ora legale — limite noto, accettabile per l'MVP, da rivedere se si nota uno sfasamento di un'ora nei periodi di cambio orario.
- Aggiornare `/help` con i nuovi comandi.

---

### 7. Feedback previsione

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
- Estensione futura (fuori scope MVP): un follow-up automatico via scheduler che chiede feedback su previsioni di fascia/giorno *dopo* che l'orario previsto è passato — riusa lo scheduler del punto 6.

---

### 8. Meteo settimanale

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

## Ordine di implementazione consigliato

1. **Decisioni trasversali (A, B, C)** — store persistente, helper MarkdownV2, campo `utcOffsetSeconds`. Fondamenta per quasi tutto il resto.
2. **Formattazione MarkdownV2** — usa l'helper di (B), nessuna logica di dominio nuova.
3. **Bottoni inline** — copre tutti e tre i formatter, incluso il refresh per fascia/giorno.
4. **Città preferita** — usa lo store persistente di (A).
5. **Modalità runner** — core del target utente, logica già parzialmente in place.
6. **Panoramica giornata** — già implementata, solo miglioramenti.
7. **Alert mattutino** — dipende da città preferita (4) e da `utcOffsetSeconds` (C), richiede scheduler.
8. **Feedback** — riusa la `InlineKeyboard` del punto 3, scope ridotto a meteo corrente.
9. **Meteo settimanale** — modifica a `weather.ts` (richiesta unica a 7 giorni) + nuova funzione in `decision.ts`.
