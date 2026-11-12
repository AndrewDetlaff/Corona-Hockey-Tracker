# 🏒 Corona Ice Tracker

Bot gratuit care verifică automat anunțurile despre bilete și programul oficial al meciurilor de hochei **CSM Corona Brașov** de pe [coronabrasov.ro](https://www.coronabrasov.ro). Te anunță imediat pe telefon (ntfy.sh sau Telegram) cu link direct către [Eventim](https://www.eventim.ro/artist/csm-corona-brasov/csm-corona-brasov-hochei-4277387/?affiliate=ROF) și include o interfață web (PWA) optimizată pentru mobil (iOS & Android) și desktop.

- **Fără AI, fără costuri, fără dependențe grele:** rulează gratuit pe GitHub Actions în câteva secunde folosind Node.js 20.
- **Fără date inventate:** interfața afișează **doar** meciurile și știrile găsite pe site-ul oficial al clubului.

## Cum funcționează

1. La fiecare 10 minute (08:00–23:00 ora României), GitHub Actions rulează `scripts/monitor.js`.
2. Scriptul citește pagina oficială `coronabrasov.ro` și programul echipei de hochei seniori (`coronabrasov.ro/hochei-pe-gheata-seniori/`).
3. Rezultatul e comparat cu `data/matches.json`. Când apare un **anunț nou despre bilete** („bilete”, „punem în vânzare”, „abonamente”, „eventim”), botul trimite o notificare cu **prioritate maximă (`urgent`)** și buton direct către pagina Eventim.
4. Fișierul actualizat e salvat automat în repository, iar `index.html` (pe GitHub Pages) îl afișează.

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
├── data/matches.json                     # meciuri + știri (scris de bot)
├── scripts/monitor.js                    # monitorizare + comparare + notificări
├── icons/                                # pictograme PWA (iOS & Android)
├── index.html                            # interfața web
├── manifest.json                         # manifest PWA
└── package.json
```
