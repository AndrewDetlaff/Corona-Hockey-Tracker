# 🏒 Corona Ice Tracker

Bot gratuit care verifică automat biletele la meciurile de hochei **CSM Corona Brașov** pe
[Eventim](https://www.eventim.ro/artist/csm-corona-brasov/csm-corona-brasov-hochei-4277387/?affiliate=ROF)
și știrile de pe [coronabrasov.ro](https://www.coronabrasov.ro). Te anunță pe telefon (ntfy.sh sau Telegram) și are o
interfață web (PWA) optimizată pentru iPhone.

- **Fără AI, fără costuri:** rulează gratuit pe GitHub Actions.
- **Fără date inventate:** interfața afișează **doar** meciurile găsite efectiv pe Eventim.

## Cum funcționează

1. La fiecare 10 minute (08:00–23:00 ora României), GitHub Actions rulează `scripts/monitor.js`.
2. Scriptul deschide Eventim și coronabrasov.ro cu Chromium (Playwright) și extrage meciurile și știrile.
3. Rezultatul e comparat cu `data/matches.json`. Primești notificare când:
   - apare un **meci nou** pe Eventim;
   - un meci trece în status **„Disponibil”**;
   - apare un **anunț nou despre bilete** pe coronabrasov.ro.
4. Fișierul actualizat e salvat automat în repository, iar `index.html` (pe GitHub Pages) îl afișează.

## Ce înseamnă etichetele din interfață

| Etichetă | Semnificație |
|---|---|
| ✔ **Găsit pe Eventim • link direct** | Butonul te duce exact pe pagina evenimentului, unde cumperi biletele. |
| ℹ **Link către pagina generală** | Meciul e listat, dar botul nu a găsit link-ul exact; butonul deschide pagina Corona de pe Eventim. |
| ⚠️ **Nu mai este listat pe Eventim** | Meciul a dispărut de pe Eventim (amânat, epuizat sau scos din vânzare). Verifică manual. |
| Banner galben/roșu sus | Botul nu a rulat încă, datele sunt vechi sau ultima verificare a eșuat. |

## Pornire rapidă

### 1. Urcă proiectul pe GitHub
```bash
git init
git add .
git commit -m "Corona Ice Tracker"
git branch -M main
git remote add origin https://github.com/<utilizator>/corona-ice-tracker.git
git push -u origin main
```

### 2. Activează alertele pe iPhone

**Varianta A – ntfy.sh (recomandat, fără cont)**
1. Instalează aplicația **ntfy** din App Store.
2. Abonează-te la un topic greu de ghicit, de exemplu `corona-bv-x7k29` (oricine cunoaște topicul poate citi mesajele).
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
- După prima rulare, `data/matches.json` se populează. Prima rulare trimite o singură notificare-rezumat
  (nu câte una pentru fiecare meci sau știre veche).

### 4. Activează interfața web (GitHub Pages)
- **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.
- Deschide link-ul în **Safari pe iPhone** → **Partajare → Adaugă pe ecranul principal**.

## Rulare locală (opțional)

Necesită [Node.js 18+](https://nodejs.org).

```bash
npm install
npx playwright install chromium
node scripts/monitor.js --force          # verificare completă (ignoră intervalul orar)
node scripts/monitor.js --test-notify    # doar notificare de test
npx serve .                              # interfața la http://localhost:3000
```

Pe Windows (PowerShell), variabilele de mediu se setează așa:
```powershell
$env:NTFY_TOPIC = "corona-bv-x7k29"; node scripts/monitor.js --test-notify
```

> Dacă deschizi `index.html` direct (dublu-click), browserul nu poate citi `data/matches.json` și apare un banner
> de avertizare. Folosește GitHub Pages sau `npx serve .`.

## Structura proiectului

```
├── .github/workflows/check-tickets.yml   # rulare automată la 10 minute
├── data/matches.json                     # meciuri + știri (scris de bot)
├── scripts/monitor.js                    # scraper + comparare + notificări
├── icons/                                # pictograme PWA / iPhone
├── index.html                            # interfața web
├── manifest.json                         # manifest PWA
└── package.json
```

## Limitări cunoscute

- **Structura site-urilor se poate schimba.** Dacă Eventim sau coronabrasov.ro își schimbă pagina, extragerea poate
  eșua. În acest caz apare un banner roșu în interfață, iar rularea e marcată cu eroare în tab-ul Actions.
- **Filtre anti-bot:** Eventim poate bloca uneori serverele GitHub. Botul raportează eroarea, nu inventează date.
- **Competiția** (Erste Liga / Campionatul Național / Cupa României) e dedusă din titlul evenimentului. Când titlul
  nu o menționează, meciul apare implicit la Erste Liga.
- **Intervalul orar:** GitHub poate întârzia rulările programate cu câteva minute în perioadele aglomerate.
- **Inactivitate:** GitHub dezactivează workflow-urile programate după 60 de zile fără activitate în repository.
  Commit-urile automate ale botului contează de obicei ca activitate; dacă primești e-mail de dezactivare, reactivează-l
  din tab-ul Actions.
