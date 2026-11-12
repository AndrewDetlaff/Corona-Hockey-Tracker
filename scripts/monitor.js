/**
 * Corona Ice Tracker — Motor de monitorizare automată (Eventim.ro + coronabrasov.ro)
 * Playwright + Chromium headless. 100% determinist, fără AI.
 *
 * Utilizare:
 *   node scripts/monitor.js                 # verificare normală
 *   node scripts/monitor.js --test-notify   # trimite doar o notificare de test
 *   node scripts/monitor.js --force         # ignoră fereastra orară 08:00–23:00
 *
 * Reguli de integritate a datelor:
 *   - În data/matches.json ajung DOAR meciuri găsite efectiv pe Eventim (source: "eventim").
 *   - Nu se inventează prețuri / date: câmpurile necunoscute rămân null.
 *   - ticketUrlIsDirect = true doar când link-ul duce la pagina evenimentului (/event/...).
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DATA_FILE = path.join(__dirname, '..', 'data', 'matches.json');

const EVENTIM_URL =
  'https://www.eventim.ro/artist/csm-corona-brasov/csm-corona-brasov-hochei-4277387/?affiliate=ROF';
const CORONA_SITE_URL = 'https://www.coronabrasov.ro';

const ACTIVE_HOUR_START = 8; // 08:00 ora României
const ACTIVE_HOUR_END = 23; // până la 23:00 (exclusiv)
const HEARTBEAT_MINUTES = 60; // cât de des se actualizează lastChecked chiar fără modificări
const KEEP_PAST_MATCH_DAYS = 30;
const MAX_NEWS = 15;

const KEYWORDS = ['hochei', 'bilete', 'patinoar', 'punem în vânzare', 'abonamente', 'erste', 'meci'];
const TICKET_ALERT_KEYWORDS = ['bilete', 'punem în vânzare', 'abonament', 'eventim', 'vânzare'];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Utilitare
// ---------------------------------------------------------------------------

function normalizeText(str = '') {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pentru headere HTTP: doar ASCII (fără diacritice / emoji). */
function toAsciiHeader(str = '') {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(str = '') {
  return normalizeText(str)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bucharestNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour'))
  };
}

function daysBetween(isoDateA, isoDateB) {
  return Math.round((new Date(isoDateA) - new Date(isoDateB)) / 86400000);
}

function detectCompetition(text = '') {
  const t = normalizeText(text);
  if (t.includes('cupa romaniei') || /\bcupa\b/.test(t)) return 'Cupa României';
  if (t.includes('campionatul national') || t.includes('liga nationala')) return 'Campionatul Național';
  return 'Erste Liga';
}

function extractOpponent(title = '') {
  const cleaned = title
    .replace(/csm\s+corona\s+bra[sș]ov/gi, '')
    .replace(/\bcorona\s+bra[sș]ov\b/gi, '')
    .replace(/\bhochei\b/gi, '')
    .replace(/\s(vs\.?|v\.|contra)\s/gi, ' ')
    .replace(/^[\s\-–—:|.]+|[\s\-–—:|.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 2 ? cleaned : null;
}

function loadExistingData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('⚠️ data/matches.json nu poate fi citit, pornesc de la zero:', err.message);
  }
  return { lastChecked: null, matches: [], news: [] };
}

// ---------------------------------------------------------------------------
// Notificări
// ---------------------------------------------------------------------------

async function sendPushNotification({ title, message, url }) {
  const ntfyTopic = process.env.NTFY_TOPIC;
  const ntfyServer = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const targetUrl = url || EVENTIM_URL;
  let sent = false;

  if (ntfyTopic) {
    try {
      const res = await fetch(`${ntfyServer}/${encodeURIComponent(ntfyTopic)}`, {
        method: 'POST',
        headers: {
          Title: toAsciiHeader(title) || 'Corona Ice Tracker',
          Priority: 'high',
          Tags: 'ice_hockey,ticket',
          Click: targetUrl,
          Actions: `view, Deschide Eventim, ${targetUrl}, clear=true`
        },
        body: `${message}\n\n${targetUrl}`
      });
      if (res.ok) {
        console.log(`✅ ntfy.sh: notificare trimisă pe topicul "${ntfyTopic}".`);
        sent = true;
      } else {
        console.error(`❌ ntfy.sh HTTP ${res.status}:`, await res.text());
      }
    } catch (err) {
      console.error('❌ ntfy.sh:', err.message);
    }
  }

  if (telegramToken && telegramChatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: `🏒 <b>${escapeHtml(title)}</b>\n\n${escapeHtml(message)}`,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '🎟️ Deschide pe Eventim', url: targetUrl }]] }
        })
      });
      if (res.ok) {
        console.log('✅ Telegram: notificare trimisă.');
        sent = true;
      } else {
        console.error(`❌ Telegram HTTP ${res.status}:`, await res.text());
      }
    } catch (err) {
      console.error('❌ Telegram:', err.message);
    }
  }

  if (!ntfyTopic && !(telegramToken && telegramChatId)) {
    console.log(`ℹ️ Niciun canal configurat. Alertă doar în consolă: [${title}] ${message} -> ${targetUrl}`);
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Scraper Eventim
// ---------------------------------------------------------------------------

async function scrapeEventim(context) {
  console.log(`🔍 Eventim: ${EVENTIM_URL}`);
  const page = await context.newPage();
  try {
    const response = await page.goto(EVENTIM_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const httpStatus = response ? response.status() : 0;
    if (httpStatus >= 400) throw new Error(`HTTP ${httpStatus} (posibil blocat de filtrul anti-bot)`);

    // Acceptă cookie-urile dacă apare bannerul (altfel lista poate rămâne ascunsă)
    for (const sel of ['#cmpbntyestxt', 'button:has-text("Accept")', 'button:has-text("Sunt de acord")']) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click().catch(() => {});
        break;
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const raw = await page.evaluate(() => {
      const out = [];
      const MONTHS = {
        ian: 1, feb: 2, mar: 3, apr: 4, mai: 5, iun: 6, iul: 7, aug: 8, sep: 9, oct: 10, noi: 11, nov: 11, dec: 12
      };
      const pad = (n) => String(n).padStart(2, '0');

      // --- 1) JSON-LD (Schema.org Event), căutare recursivă ---
      const isEvent = (o) => {
        const t = o && o['@type'];
        const types = Array.isArray(t) ? t : [t];
        return types.some((x) => typeof x === 'string' && /Event$/.test(x));
      };
      const collect = (node, acc) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach((n) => collect(n, acc));
        if (isEvent(node)) acc.push(node);
        for (const key of ['@graph', 'itemListElement', 'item', 'subEvent', 'event', 'events']) {
          if (node[key]) collect(node[key], acc);
        }
      };
      const ldEvents = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          collect(JSON.parse(s.textContent || ''), ldEvents);
        } catch (_) {}
      });

      for (const ev of ldEvents) {
        const title = String(ev.name || '').trim();
        const start = String(ev.startDate || '');
        let date = null;
        let time = null;
        const m = start.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
        if (m) {
          // Folosim ora locală afișată de Eventim (fără conversii de fus orar)
          date = `${m[1]}-${m[2]}-${m[3]}`;
          if (m[4] && !(m[4] === '00' && m[5] === '00')) time = `${m[4]}:${m[5]}`;
        }
        const offers = Array.isArray(ev.offers) ? ev.offers[0] : ev.offers || {};
        const priceVal = offers.lowPrice ?? offers.price;
        const avail = String(offers.availability || '').toLowerCase();
        let status = null;
        if (/soldout|outofstock/.test(avail)) status = 'Epuizat';
        else if (/preorder|presale/.test(avail)) status = 'În curând';
        else if (/instock|limitedavailability/.test(avail)) status = 'Disponibil';

        out.push({
          via: 'json-ld',
          title,
          date,
          time,
          location: ev.location?.name || null,
          startingPrice: priceVal != null && priceVal !== '' ? `${priceVal} ${offers.priceCurrency || 'RON'}` : null,
          status,
          url: ev.url || offers.url || null
        });
      }

      // --- 2) Fallback DOM: link-uri directe către evenimente (/event/...) ---
      const anchors = Array.from(document.querySelectorAll('a[href*="/event/"]'));
      for (const a of anchors) {
        const card = a.closest('article, li, [class*="listing"], [class*="event"]') || a;
        const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 8) continue;

        const titleEl = card.querySelector('h1, h2, h3, h4, [data-qa*="title"], [class*="title"]');
        const title = ((titleEl && titleEl.innerText) || a.innerText || '').split('\n')[0].trim();

        let date = null;
        let dm = text.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
        if (dm) date = `${dm[3]}-${pad(dm[2])}-${pad(dm[1])}`;
        else {
          dm = normalizeLocal(text).match(/\b(\d{1,2})\s+(ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|noi|nov|dec)[a-z]*\.?\s+(20\d{2})\b/);
          if (dm) date = `${dm[3]}-${pad(MONTHS[dm[2]])}-${pad(dm[1])}`;
        }
        const tm = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
        const pm = text.match(/(\d+(?:[.,]\d{1,2})?)\s*(lei|ron)\b/i);
        const low = normalizeLocal(text);
        let status = null;
        if (/epuizat|sold out|indisponibil/.test(low)) status = 'Epuizat';
        else if (/in curand|in curând/.test(low)) status = 'În curând';
        else if (/bilete|cumpara|de la/.test(low)) status = 'Disponibil';

        out.push({
          via: 'dom',
          title,
          date,
          time: tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null,
          location: /patinoar/i.test(text) ? 'Patinoarul Olimpic Brașov' : null,
          startingPrice: pm ? `${pm[1].replace(',', '.')} RON` : null,
          status,
          url: a.href
        });
      }

      function normalizeLocal(s) {
        return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }
      return out;
    });

    const results = [];
    for (const r of raw) {
      let url = null;
      try {
        url = r.url ? new URL(r.url, 'https://www.eventim.ro').href : null;
      } catch (_) {}
      const direct = Boolean(url && /eventim\.ro\/event\//.test(url));
      const relevant = /corona|hochei/.test(normalizeText(`${r.title} ${url || ''}`));
      if (!relevant || !r.date || !r.title) continue; // nu păstrăm nimic nesigur

      const opponent = extractOpponent(r.title);
      const id = direct
        ? `eventim-${url.replace(/\/$/, '').split('/').pop()}`
        : `eventim-${slugify(r.title)}-${r.date}`;

      if (results.some((x) => x.id === id || (x.date === r.date && x.opponent === opponent))) continue;

      results.push({
        id,
        title: r.title,
        opponent,
        competition: detectCompetition(r.title),
        date: r.date,
        time: r.time,
        location: r.location || 'Patinoarul Olimpic Brașov',
        startingPrice: r.startingPrice,
        status: r.status || (direct ? 'Disponibil' : 'Necunoscut'),
        ticketUrl: direct ? url : EVENTIM_URL,
        ticketUrlIsDirect: direct,
        source: 'eventim'
      });
    }

    console.log(`   ↳ ${results.length} meciuri valide (din ${raw.length} candidați).`);
    return { ok: true, matches: results };
  } catch (err) {
    console.warn(`⚠️ Eventim inaccesibil: ${err.message}`);
    return { ok: false, error: err.message, matches: [] };
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Scraper știri coronabrasov.ro
// ---------------------------------------------------------------------------

async function scrapeCoronaNews(context) {
  console.log(`🔍 Știri: ${CORONA_SITE_URL}`);
  const page = await context.newPage();
  try {
    const response = await page.goto(CORONA_SITE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const httpStatus = response ? response.status() : 0;
    if (httpStatus >= 400) throw new Error(`HTTP ${httpStatus}`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const links = await page.evaluate(() => {
      const seen = new Set();
      const items = [];
      document.querySelectorAll('a[href]').forEach((a) => {
        const title = (a.innerText || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const href = a.href;
        if (!href || seen.has(href) || href.includes('#') || !/^https?:/.test(href)) return;
        if (title.length < 25) return; // exclude meniuri / categorii scurte
        seen.add(href);
        items.push({ title, url: href });
      });
      return items;
    });

    const host = new URL(CORONA_SITE_URL).hostname.replace(/^www\./, '');
    const news = [];
    for (const item of links) {
      let itemHost = '';
      try {
        itemHost = new URL(item.url).hostname.replace(/^www\./, '');
      } catch (_) {
        continue;
      }
      if (itemHost !== host) continue;

      const t = normalizeText(item.title);
      const matched = KEYWORDS.filter((kw) => t.includes(normalizeText(kw)));
      if (!matched.length) continue;

      news.push({
        id: `news-${slugify(item.url.replace(/^https?:\/\/[^/]+/, '')) || slugify(item.title)}`,
        title: item.title,
        url: item.url,
        isTicketAlert: TICKET_ALERT_KEYWORDS.some((k) => t.includes(normalizeText(k))),
        keywordsMatched: matched,
        source: 'coronabrasov.ro'
      });
    }
    console.log(`   ↳ ${news.length} articole relevante.`);
    return { ok: true, news: news.slice(0, MAX_NEWS) };
  } catch (err) {
    console.warn(`⚠️ coronabrasov.ro inaccesibil: ${err.message}`);
    return { ok: false, error: err.message, news: [] };
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Logica principală
// ---------------------------------------------------------------------------

async function runMonitor() {
  const args = process.argv.slice(2);

  if (args.includes('--test-notify')) {
    await sendPushNotification({
      title: 'Test Corona Ice Tracker',
      message: 'Alertele pentru biletele CSM Corona Brașov funcționează!',
      url: EVENTIM_URL
    });
    return;
  }

  const now = bucharestNow();
  const isScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  if (isScheduled && !args.includes('--force') && (now.hour < ACTIVE_HOUR_START || now.hour >= ACTIVE_HOUR_END)) {
    console.log(`🌙 Ora ${now.hour}:xx în România — în afara intervalului 08:00–23:00. Nu rulez.`);
    return;
  }

  const existing = loadExistingData();
  const isFirstRun = !existing.lastChecked;
  const nowIso = new Date().toISOString();

  let browser;
  let eventim = { ok: false, error: 'neinițializat', matches: [] };
  let corona = { ok: false, error: 'neinițializat', news: [] };

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
      locale: 'ro-RO',
      timezoneId: 'Europe/Bucharest',
      extraHTTPHeaders: { 'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7' }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    eventim = await scrapeEventim(context);
    corona = await scrapeCoronaNews(context);
  } catch (err) {
    console.error('❌ Playwright/Chromium:', err.message);
  } finally {
    if (browser) await browser.close();
  }

  let changed = false;
  const notifications = [];

  // ---- Meciuri ----
  // Păstrăm doar meciuri provenite de pe Eventim (elimină orice date demo vechi)
  let matches = (existing.matches || []).filter((m) => m.source === 'eventim');
  if (matches.length !== (existing.matches || []).length) changed = true;

  const newlyFound = [];
  for (const fresh of eventim.matches) {
    const old = matches.find(
      (m) => m.id === fresh.id || (fresh.ticketUrlIsDirect && m.ticketUrl === fresh.ticketUrl)
    );
    if (!old) {
      matches.push({ ...fresh, firstSeen: nowIso, stillListed: true });
      newlyFound.push(fresh);
      changed = true;
      continue;
    }

    const becameAvailable = old.status !== 'Disponibil' && fresh.status === 'Disponibil';
    for (const key of ['title', 'opponent', 'time', 'startingPrice', 'status', 'ticketUrl', 'ticketUrlIsDirect', 'location']) {
      if (fresh[key] != null && fresh[key] !== old[key]) {
        old[key] = fresh[key];
        changed = true;
      }
    }
    if (old.stillListed === false) {
      old.stillListed = true;
      changed = true;
    }
    if (becameAvailable && !isFirstRun) {
      notifications.push({
        title: `BILETE DISPONIBILE: Corona vs ${old.opponent || old.title}`,
        message: `${old.title}\n📅 ${old.date}${old.time ? ' ora ' + old.time : ''}\n💰 ${old.startingPrice || 'preț pe Eventim'}`,
        url: old.ticketUrl
      });
    }
  }

  // Meciuri viitoare care nu mai apar pe Eventim (doar dacă scraping-ul a reușit și a găsit ceva)
  if (eventim.ok && eventim.matches.length > 0) {
    for (const m of matches) {
      const listed = eventim.matches.some((f) => f.id === m.id || f.ticketUrl === m.ticketUrl);
      if (!listed && m.date >= now.date && m.stillListed !== false) {
        m.stillListed = false;
        changed = true;
      }
    }
  }

  // Curățăm meciurile foarte vechi și sortăm
  const before = matches.length;
  matches = matches.filter((m) => daysBetween(now.date, m.date) <= KEEP_PAST_MATCH_DAYS);
  if (matches.length !== before) changed = true;
  matches.sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));

  if (newlyFound.length) {
    if (isFirstRun || newlyFound.length > 3) {
      notifications.push({
        title: `${newlyFound.length} meciuri Corona pe Eventim`,
        message: newlyFound.map((m) => `• ${m.date} — ${m.opponent || m.title} (${m.status})`).join('\n'),
        url: EVENTIM_URL
      });
    } else {
      for (const m of newlyFound) {
        notifications.push({
          title: `Meci nou pe Eventim: ${m.opponent || m.title}`,
          message: `${m.title}\n📅 ${m.date}${m.time ? ' ora ' + m.time : ''}\n📍 ${m.location}\n💰 ${m.startingPrice || 'preț pe Eventim'}\n🎟️ ${m.status}`,
          url: m.ticketUrl
        });
      }
    }
  }

  // ---- Știri ----
  let news = (existing.news || []).filter((n) => n.source === 'coronabrasov.ro');
  if (news.length !== (existing.news || []).length) changed = true;
  const isFirstNewsRun = news.length === 0;

  for (const item of corona.news) {
    if (news.some((n) => n.id === item.id || n.url === item.url)) continue;
    news.unshift({ ...item, firstSeen: nowIso });
    changed = true;
    // La prima rulare doar populăm lista, fără să trimitem alerte pentru știri vechi
    if (item.isTicketAlert && !isFirstNewsRun) {
      notifications.push({ title: 'Anunt bilete pe coronabrasov.ro', message: item.title, url: item.url });
    }
  }
  news = news.slice(0, MAX_NEWS);

  // ---- Salvare ----
  const minutesSinceCheck = existing.lastChecked
    ? (Date.now() - new Date(existing.lastChecked).getTime()) / 60000
    : Infinity;
  const heartbeatDue = minutesSinceCheck >= HEARTBEAT_MINUTES;

  if (changed || heartbeatDue) {
    const payload = {
      lastChecked: nowIso,
      sources: {
        eventim: { url: EVENTIM_URL, ok: eventim.ok, found: eventim.matches.length, error: eventim.error || null },
        coronabrasov: { url: CORONA_SITE_URL, ok: corona.ok, found: corona.news.length, error: corona.error || null }
      },
      matches,
      news
    };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`💾 data/matches.json salvat (${matches.length} meciuri, ${news.length} știri${changed ? '' : ', doar heartbeat'}).`);
  } else {
    console.log('✅ Nicio modificare.');
  }

  for (const n of notifications) {
    await sendPushNotification(n);
  }

  // Dacă ambele surse au eșuat, marcăm rularea ca eșuată (vizibil în GitHub Actions)
  if (!eventim.ok && !corona.ok) process.exitCode = 1;
}

runMonitor().catch((err) => {
  console.error('❌ Eroare neprevăzută:', err);
  process.exitCode = 1;
});
