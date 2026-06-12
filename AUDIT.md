# Report di analisi — Weather Decision Assistant Bot

**Data:** 2026-06-12
**Scope:** analisi statica dell'intera codebase (`src/`) alla ricerca di bug, fragilità e rischi di sicurezza/configurazione.
**Metodo:** lettura completa di `index.ts`, `weather.ts`, `decision.ts`, `scheduler.ts`, `store.ts`, `format.ts`, `time.ts`, `logger.ts`.

> Nota: nessuno di questi è un crash bloccante "sempre". Sono ordinati per impatto/probabilità reale. La gravità è una stima pratica per un bot Telegram personale, non per un servizio multi-tenant ad alto traffico.

---

## 🔴 Alta priorità

### 1. `callback_data` può superare il limite di 64 byte di Telegram ✅ risolto
**File:** [src/index.ts:259-278](src/index.ts#L259-L278)

**Fix applicato:** `truncateForCallback()` tronca `location.name` a 18 caratteri prima di inserirlo nella `callback_data`, garantendo che il totale resti sempre ≤ 64 byte indipendentemente dalla lunghezza/accentazione del nome città. Per nomi molto lunghi il titolo dopo "🔄 Aggiorna" mostra il nome troncato (cosmetico).

<details>
<summary>Descrizione originale del problema</summary>

`buildRefreshKeyboard()` costruisce la `callback_data` concatenando coordinate **e nome città intero**:

```
r:p:45.4642,9.1900:0m:Reggio nell'Emilia
```

Telegram impone un massimo di **64 byte** sulla `callback_data`. Con nomi città lunghi e/o accentati (i caratteri non-ASCII contano 2 byte in UTF-8) il limite può essere superato. Quando succede, `ctx.reply(...)` con quella tastiera fallisce con `BUTTON_DATA_INVALID`, l'errore viene catturato dal try/catch dell'handler e l'utente riceve un generico "Si è verificato un errore" — **senza capire perché**, e per quella città il bot risulta rotto.

**Rischio:** il messaggio meteo non viene mai inviato per certe città.
**Fix consigliato:** non mettere il nome città nella `callback_data`. Mettere solo le coordinate (già sufficienti a rifare la query) e recuperare il nome via reverse-lookup, oppure salvare un ID breve in una mappa lato server e referenziarlo. In alternativa, troncare/normalizzare il nome e accettare che dopo il refresh il titolo mostri solo le coordinate-derivate.

</details>

---

### 2. Il segreto del webhook è opzionale → endpoint potenzialmente aperto ✅ risolto
**File:** [src/index.ts:306-316](src/index.ts#L306-L316), [src/index.ts:941](src/index.ts#L941)

**Fix applicato:** `BOT_TOKEN` e `WEBHOOK_SECRET` vengono letti e validati all'avvio; se mancanti il processo lancia un `Error` esplicito invece di partire in uno stato insicuro/criptico. `secretToken` ora usa la costante validata `WEBHOOK_SECRET`.

⚠️ **Azione richiesta su Railway:** verificare che la variabile `WEBHOOK_SECRET` sia impostata in produzione e che lo stesso valore sia stato passato a Telegram in `setWebhook` (parametro `secret_token`), altrimenti il bot smetterà di rispondere (401 su ogni update).

<details>
<summary>Descrizione originale del problema</summary>

```ts
webhookCallback(bot, "express", {
  timeoutMilliseconds: 25000,
  secretToken: process.env.WEBHOOK_SECRET,
});
```

Se `WEBHOOK_SECRET` non è impostato in produzione, `secretToken` è `undefined` e grammY **non valida** l'header `X-Telegram-Bot-Api-Secret-Token`. Chiunque conosca/indovini l'URL `/webhook` può iniettare update arbitrari (messaggi finti, comandi, callback) facendoli processare come se venissero da Telegram.

**Rischio:** spoofing di update, spam verso utenti, abuso delle chiamate Open-Meteo.
**Fix consigliato:** rendere `WEBHOOK_SECRET` obbligatorio (fail-fast all'avvio se mancante) e assicurarsi che lo stesso secret sia passato a `setWebhook` su Telegram. Stesso discorso per `BOT_TOKEN` ([src/index.ts:299](src/index.ts#L299) usa `process.env.BOT_TOKEN!` con non-null assertion: se manca, l'errore è criptico).

</details>

---

## 🟠 Media priorità

### 3. Scrittura dello store non atomica → rischio corruzione/perdita dati
**File:** [src/store.ts:27-30](src/store.ts#L27-L30)

```ts
fs.writeFileSync(STORE_PATH, JSON.stringify(...));
```

La scrittura è diretta sul file finale. Se il processo crasha o viene killato (Railway redeploy) **durante** la `writeFileSync`, il file resta troncato/corrotto. Al riavvio `loadFromDisk()` ([src/store.ts:18-25](src/store.ts#L18-L25)) intercetta l'errore di parsing e restituisce una `Map` vuota → **tutte le preferenze utente (città, alert) vengono perse silenziosamente**.

**Fix consigliato:** scrittura atomica con file temporaneo + `rename` (`fs.writeFileSync(tmp); fs.renameSync(tmp, STORE_PATH)`). Il `rename` su stesso filesystem è atomico. Opzionalmente fare backup del file precedente.

---

### 4. Handler `start`/`help` non `await`-ano la reply → possibili unhandled rejection
**File:** [src/index.ts:325-329](src/index.ts#L325-L329) e [src/index.ts:331-357](src/index.ts#L331-L357)

```ts
bot.command("start", (ctx) => {
  ctx.reply(...);   // promessa non restituita né awaitata
});
```

Il corpo è un blocco `{ }` che **non ritorna** la promise di `ctx.reply`. grammY quindi non la attende e, se la reply fallisce (rete, utente che ha bloccato il bot, ecc.), il rejection **sfugge a `bot.catch`** ([src/index.ts:305](src/index.ts#L305)) e diventa un unhandled promise rejection. Tutti gli altri handler usano `async/await` correttamente; questi due sono l'eccezione.

**Fix consigliato:** `return ctx.reply(...)` oppure rendere gli handler `async` con `await`.

---

### 5. Offset UTC mai ricalcolato → alert sbagliato di un'ora con l'ora legale
**File:** [src/store.ts:10](src/store.ts#L10), [src/index.ts:404](src/index.ts#L404), [src/scheduler.ts:17](src/scheduler.ts#L17)

`utcOffsetSeconds` viene salvato **una sola volta** al momento di `/setcity` e mai aggiornato. Lo scheduler calcola l'ora locale come `Date.now() + utcOffsetSeconds*1000`. Quando scatta/finisce l'ora legale (DST), l'offset salvato diventa stale e **l'alert mattutino arriva un'ora prima/dopo** finché l'utente non rifà `/setcity`.

Già documentato come limite noto in `FEATURES.md` (decisione C), ma vale la pena ribadirlo: è un bug latente che si manifesterà alle date di cambio ora.
**Fix consigliato:** ricalcolare l'offset periodicamente (es. job giornaliero che rifà geocoding/forecast per gli utenti con alert) oppure salvare l'IANA timezone (`timezone` dalla risposta Open-Meteo) e calcolare l'offset al volo.

---

### 6. Dopo "🔄 Aggiorna" si perdono regione e nazione nel titolo
**File:** [src/index.ts:772-781](src/index.ts#L772-L781) (e analoghi `r:p`, `r:o`)

La `Location` viene ricostruita dalla `callback_data` con `country: ""` e senza `admin1`. Quindi `formatLocation()` ([src/index.ts:576-581](src/index.ts#L576-L581)) — che filtra i campi vuoti — mostra **solo il nome città** dopo un refresh, mentre il primo messaggio mostrava "Città, Regione, Nazione". Incoerenza UX (e potenziale ambiguità: "Cambridge" UK vs US dopo refresh non si distinguono).

**Fix consigliato:** legato al punto 1 — se si smette di mettere il nome nella callback e si fa un lookup server-side, si recuperano anche admin1/country.

---

## 🟡 Bassa priorità / robustezza

### 7. Cache stampede su `getWeather`
**File:** [src/weather.ts:200-247](src/weather.ts#L200-L247)

La cache è popolata solo **dopo** che la risposta arriva. N richieste simultanee per la stessa città (es. broadcast alert + utente attivo) producono N fetch paralleli verso Open-Meteo invece di condividerne uno. Basso impatto su un bot personale; rilevante solo sotto carico.
**Fix:** cache delle *promise* in volo, non solo dei valori risolti.

### 8. `loadFromDisk` si fida del JSON senza validazione
**File:** [src/store.ts:18-25](src/store.ts#L18-L25)

Il contenuto viene castato a `UserPrefs` senza validare i tipi. Se il file viene modificato a mano/corrotto in modo parzialmente valido (JSON ok ma campi sbagliati), gli errori emergono a runtime altrove. Rischio basso (file controllato da noi), ma una validazione con `zod` o controlli minimi renderebbe il caricamento difensivo.

### 9. Ramo `index === -1` di fatto irraggiungibile in `/corsa HH:MM`
**File:** [src/index.ts:184-193](src/index.ts#L184-L193)

`findIndex` cerca un'ora `HH` nell'intero array orario di 7 giorni: ogni ora 0–23 compare ogni giorno, quindi un match esiste **sempre** entro 24h (a meno che `hourly` sia vuoto). Il messaggio "Non ho previsioni per le HH:MM" non scatterà mai per orari validi. Inoltre, se l'ora richiesta è già passata oggi, viene selezionata quella di **domani** ma l'etichetta dice correttamente "domani" — comportamento accettabile ma potenzialmente sorprendente per l'utente che si aspettava "oggi".

### 10. Possibile crash su `hourly` vuoto
**File:** [src/index.ts:235](src/index.ts#L235), [src/decision.ts:294-297](src/decision.ts#L294-L297)

`getRunningAdvice(weather.hourly[0])` e l'uso di `hourly[0]` assumono almeno un elemento. In pratica `getWeather` restituisce sempre dati, ma se Open-Meteo restituisse `hourly` vuoto/malformato si avrebbe un accesso a `undefined`. Una guardia esplicita renderebbe il codice più robusto.

### 11. Collisione nomi-fascia nel parser temporale
**File:** [src/time.ts:39-42](src/time.ts#L39-L42)

Parole come `mattina`, `sera`, `notte`, `pomeriggio` vengono sempre interpretate come fasce orarie. Una città/frazione che le contiene (es. toponimi con "Sera") verrebbe stripata dal testo. Edge case raro, ma è una fonte di falsi positivi nota.

### 12. Comando `help` leggermente disallineato
**File:** [src/index.ts:351](src/index.ts#L351)

C'è uno spazio in coda dopo il `+` di concatenazione (innocuo) e mancano nell'elenco `help` i comandi `/oggi`/`/domani` raggruppati in modo coerente con `setMyCommands`. Solo cosmetico.

---

## ✅ Aspetti solidi (nessun intervento richiesto)

- **Escaping MarkdownV2 sistematico** ([src/format.ts](src/format.ts)): tutte le stringhe dinamiche (nomi città dal geocoding, descrizioni, valori numerici) passano da `escapeMarkdownV2()`. Nessuna injection MarkdownV2 evidente.
- **Gestione errori tipizzata** della rete ([src/weather.ts:29-51](src/weather.ts#L29-L51)) con retry/backoff e classificazione (`TIMEOUT`/`RATE_LIMITED`/`NETWORK`), mappata a messaggi utente chiari ([src/index.ts:729-759](src/index.ts#L729-L759)).
- **`bot.catch` globale** ([src/index.ts:305-310](src/index.ts#L305-L310)) come rete di sicurezza per gli handler `async`.
- **Rate limiting** per-utente con finestra scorrevole e cleanup periodico ([src/index.ts:273-297](src/index.ts#L273-L297)).
- **Nessun segreto loggato**: i log includono `userId`/città ma mai il token.
- **Uso corretto del timezone locale** (`timezone=auto`): l'estrazione dell'ora da `time.slice(11,13)` è valida perché Open-Meteo restituisce già orari locali.

---

## Riepilogo priorità

| # | Problema | Gravità | Sforzo fix |
|---|----------|---------|-----------|
| 1 | `callback_data` > 64 byte | ✅ Risolto | Medio |
| 2 | Webhook secret opzionale | ✅ Risolto | Basso |
| 3 | Scrittura store non atomica | 🟠 Media | Basso |
| 4 | `start`/`help` non awaited | 🟠 Media | Basso |
| 5 | Offset UTC stale (DST) | 🟠 Media | Medio |
| 6 | Refresh perde admin1/country | 🟠 Media | Medio (lega a #1) |
| 7 | Cache stampede | 🟡 Bassa | Medio |
| 8 | Store senza validazione | 🟡 Bassa | Basso |
| 9 | Ramo irraggiungibile `/corsa` | 🟡 Bassa | Basso |
| 10 | Crash su `hourly` vuoto | 🟡 Bassa | Basso |
| 11 | Collisione nomi-fascia | 🟡 Bassa | Medio |
| 12 | `help` disallineato | 🟡 Cosmetico | Basso |

**Raccomandazione:** affrontare prima #2 (sicurezza, fix banale) e #1 (rompe funzionalità per certe città), poi #3 e #4 (robustezza dati e stabilità, entrambi a basso sforzo).
