# 🏒 Corona Ice Tracker

Bot gratuit care monitorizează automat meciurile de hochei **CSM Corona Brașov** (Erste Liga, Campionatul Național, Cupa României), oferă **rezumate ale meciurilor trecute și scor live în timp real**, și te anunță imediat pe telefon (ntfy.sh sau Telegram) când se marchează un **gol**, se întâmplă un eveniment important sau apar **bilete noi** pe [Eventim](https://www.eventim.ro/artist/csm-corona-brasov/csm-corona-brasov-hochei-4277387/?affiliate=ROF).

- **Fără AI, fără costuri, fără dependențe grele:** rulează gratuit pe GitHub Actions folosind Node.js 20.
- **Fără date inventate:** interfața afișează **doar** date reale preluate din sursele oficiale (`coronabrasov.ro`, `ersteliga.hu` / `api.icehockey.hu`, `icehockey.ro`).

## Cum funcționează

1. La fiecare 10 minute (08:00–23:00 ora României), GitHub Actions rulează `scripts/monitor.js`.
2. Scriptul verifică:
   - `coronabrasov.ro` & `coronabrasov.ro/hochei-seniori/` (anunțuri bilete & program oficial)
   - **Erste Liga** (`api.icehockey.hu/vbr/v2/`) — program, scor live, reprize, șuturi pe poartă, eliminări și cronologia golurilor
   - **FRHG** (`icehockey.ro`) — Campionatul Național & Cupa României (scoruri, rezumate și evenimente)
3. Rezultatul e comparat cu `data/matches.json`. Botul trimite notificări push pentru:
   - 🚨 **Goluri marcate** (marcator, pase decisive, minut, repriză, scor actualizat, PP/SH/EN)
   - 🏒 **Evenimente importante** (start meci, final de repriză, OT/SO, eliminări majore 5+ min, portar scos, scor final + sumar)
   - 🎟️ **Anunțuri noi de bilete** („bilete”, „punem în vânzare”, „abonamente”, „eventim”)
4. Pentru urmărire **live la ~30 secunde** în timpul unui meci, poți porni din GitHub tab-ul **Actions → Corona Ice Tracker - Live Match Watcher → Run workflow** (sau local `npm run watch`).
5. Fișierul `data/matches.json` este salvat automat în repository, iar `index.html` (pe GitHub Pages) afișează Live Match Center, Rezultate & Sumare, Calendarul și Radarul de Știri.

## Pornire rapidă

### 1. Urcă proiectul pe GitHub
Poți folosi **GitHub Desktop** (*Publish repository*) sau linia de comandă:
```bash
git init
git add .
git commit -m "Corona Ice Tracker"
git branch -M main
git remote add origin https://github.com/<utilizator>/corona-ice-tracker.git
git push -u origin main
```

### 2. Activează alertele pe telefon (iOS & Android)

**Varianta A – ntfy.sh (recomandat, fără cont)**
1. Instalează aplicația **ntfy** din App Store (iOS) sau Google Play (Android).
2. Abonează-te la un topic greu de ghicit, de exemplu `corona-bv-x7k29`.
3. În GitHub: **Settings → Secrets and variables → Actions → New repository secret**
   - `NTFY_TOPIC` = `corona-bv-x7k29`

**Varianta B – Telegram**
1. Creează un bot cu [@BotFather](https://t.me/BotFather) și copiază token-ul.
2. Trimite un mesaj botului, apoi deschide `https://api.telegram.org/bot<TOKEN>/getUpdates` și copiază `chat.id`.
3. Adaugă secretele `TELEGRAM_BOT_TOKEN` și `TELEGRAM_CHAT_ID`.

Poți folosi ambele variante simultan.

### 3. Pornește botul
- **Settings → Actions → General → Workflow permissions** → bifează **Read and write permissions**.
- **Actions → Corona Ice Tracker → Run workflow** pentru prima rulare manuală.

### 4. Activează interfața web (GitHub Pages)
- **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`** (repository-ul trebuie să fie Public pentru GitHub Pages gratuit).
- Deschide link-ul pe telefon:
  - **iOS (Safari):** *Share → Add to Home Screen*
  - **Android (Chrome):** *Meniu ⋮ → Install app / Add to Home screen*

## Rulare locală (opțional)

Necesită [Node.js 18+](https://nodejs.org).

```bash
node scripts/monitor.js --force          # verificare completă (ignoră intervalul orar)
node scripts/monitor.js --watch          # urmărire live continuă (goluri la 25s)
node scripts/monitor.js --test-notify    # doar notificare de test
npx serve .                              # interfața la http://localhost:3000
```

Pe Windows (PowerShell), variabilele de mediu se setează așa:
```powershell
$env:NTFY_TOPIC = "corona-bv-x7k29"; node scripts/monitor.js --test-notify
```

## Structura proiectului

```
├── .github/workflows/check-tickets.yml   # rulare automată la 10 minute
├── .github/workflows/live-match.yml      # urmărire live la 30s (manual în timpul meciului)
├── data/matches.json                     # meciuri + scoruri + rezumate + știri
├── scripts/monitor.js                    # monitorizare + comparare + notificări
├── icons/                                # pictograme PWA (iOS & Android)
├── index.html                            # interfața web (Live, Rezultate, Calendar, Știri)
├── manifest.json                         # manifest PWA
└── package.json
```
