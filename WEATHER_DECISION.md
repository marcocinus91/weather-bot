# Weather Decision Assistant — Bot Telegram

## Descrizione progetto

Bot Telegram che aiuta gli utenti a prendere decisioni pratiche basate sul meteo. Non mostra solo dati meteorologici grezzi, ma traduce le previsioni in suggerimenti concreti e indica il livello di affidabilità della previsione.

## Problema che risolve

Le app meteo classiche mostrano dati (temperatura, probabilità pioggia, vento) senza aiutare l'utente a capire cosa fare. Questo bot risponde a domande pratiche come:
- "Mi serve l'ombrello?"
- "Posso andare a correre oggi pomeriggio?"
- "Quanto è affidabile questa previsione?"

## Stack tecnico

- **Runtime:** Node.js
- **Linguaggio:** TypeScript
- **Framework bot:** grammY
- **API meteo:** Open-Meteo (gratuita, no API key)
- **Server HTTP:** Express
- **Architettura:** Webhook (Telegram invia i messaggi al server)
- **Deploy:** Railway
- **Package manager:** npm

## Struttura progetto

```
weather-bot/
├── src/
│   └── index.ts        # Entry point — bot + server Express
├── .env                # Variabili d'ambiente (non committare)
├── .gitignore
├── package.json
├── tsconfig.json
└── CLAUDE.md           # Questo file
```

## Variabili d'ambiente

```env
BOT_TOKEN=token_del_bot_da_botfather
PORT=3000
```

## Comandi npm

```bash
npm run dev     # Avvia in locale con ts-node
npm run build   # Compila TypeScript in JavaScript
npm run start   # Avvia la versione compilata (produzione)
```

## Come funziona

1. L'utente manda un messaggio con il nome di una città al bot
2. Il server riceve il messaggio tramite webhook
3. La funzione `getCoordinates()` converte la città in lat/lon tramite Open-Meteo Geocoding API
4. La funzione `getWeather()` recupera le previsioni correnti tramite Open-Meteo Forecast API
5. Il bot risponde con temperatura, precipitazioni, probabilità pioggia e vento

## API utilizzate

### Open-Meteo Geocoding
```
GET https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1&language=it
```

### Open-Meteo Forecast
```
GET https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,precipitation,weathercode,windspeed_10m&hourly=precipitation_probability&timezone=auto&forecast_days=1
```

## Stato attuale

- [x] Setup progetto Node.js + TypeScript
- [x] Integrazione grammY
- [x] Webhook funzionante
- [x] Integrazione Open-Meteo (geocoding + forecast)
- [x] Risposta meteo via bot Telegram (temperatura, precipitazioni, vento, probabilità pioggia)
- [x] Logica decisionale (suggerimento pratico: ombrello, corsa)
- [x] Indicatore affidabilità previsione
- [x] Gestione errori robusta
- [x] Deploy su Railway

## Analisi critica (pre-deploy)

### Bloccanti

- [x] `npm run build` falliva (errore TS7016 su `node-fetch`, dipendenza interna di grammY) — risolto con `skipLibCheck: true` in `tsconfig.json`
- [x] Endpoint `/webhook` pubblico senza autenticazione — risolto con `secret_token` di Telegram + opzione `secretToken` di `webhookCallback`
- [x] Manca un gestore di errori globale (`bot.catch`) — aggiunto in `index.ts`

### Da sistemare a breve

- [x] Nessuna route di health-check (`GET /`) per monitoraggio Railway
- [x] Messaggi non testuali (foto, sticker, vocali...) ignorati senza risposta
- [x] `package.json` senza `engines.node` — rischio mismatch versione Node tra locale e Railway
- [x] Manca `.env.example` con le variabili richieste per il deploy

### Miglioramenti futuri

- [x] Cache in-memory (TTL 5-10 min) su geocoding/forecast per ridurre chiamate a Open-Meteo
- [x] Gestione dedicata delle risposte 429 (rate limit) di Open-Meteo
- [x] Comando `/help`: spiegare all'utente cosa può chiedere al bot oltre al nome della città
- [x] Rate limiting: evitare che un utente possa spammare richieste e martellare l'API Open-Meteo
- [x] Contesto temporale: l'utente può chiedere "oggi pomeriggio", "domani mattina", "stasera", ecc. (parser in `src/time.ts`, aggregazione per fascia oraria in `src/decision.ts`)
- [x] Logging più strutturato (pino, JSON in produzione / pretty-print in dev)

## Prossimi step

Tutti i miglioramenti pianificati sono stati completati.
