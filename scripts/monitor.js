/**
 * Corona Ice Tracker — Motor de monitorizare automată
 * Surse:
 *   1. Eventim.ro (bilete directe, preț, status)
 *   2. coronabrasov.ro/hochei-pe-gheata-seniori/ (program oficial meciuri)
 *   3. coronabrasov.ro (știri și anunțuri punere în vânzare bilete)
 *
 * Utilizare:
 *   node scripts/monitor.js                 # verificare normală
 *   node scripts/monitor.js --test-notify   # trimite doar o notificare de test
 *   node scripts/monitor.js --force         # ignoră fereastra orară 08:00–23:00
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DATA_FILE = path.join(__dirname, '..', 'data', 'matches.json');

const EVENTIM_URL =
  'https://www.eventim.ro/artist/csm-corona-brasov/csm-corona-brasov-hochei-4277387/?affiliate=ROF';
const CORONA_SITE_URL = 'https://www.coronabrasov.ro';
const CORONA_HOCKEY_URL = 'https://www.coronabrasov.ro/hochei-pe-gheata-seniori/';

const ACTIVE_HOUR_START = 8; // 08:00 ora României
const ACTIVE_HOUR_END = 23; // până la 23:00 (exclusiv)
const HEARTBEAT_MINUTES = 60;
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

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
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
// 1) Scraper Eventim
// ---------------------------------------------------------------------------

function parseEventimHtml(html, defaultUrl) {
  const matches = [];
  const scriptRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

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

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const ldEvents = [];
      collect(parsed, ldEvents);

      for (const ev of ldEvents) {
        const title = String(ev.name || '').trim();
        const start = String(ev.startDate || '');
        let date = null;
        let time = null;
        const m = start.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
        if (m) {
          date = `${m[1]}-${m[2]}-${m[3]}`;
          if (m[4] && !(m[4] === '00' && m[5] === '00')) time = `${m[4]}:${m[5]}`;
        }
        if (!title || !date) continue;

        const offers = Array.isArray(ev.offers) ? ev.offers[0] : ev.offers || {};
        const priceVal = offers.lowPrice ?? offers.price;
        const avail = String(offers.availability || '').toLowerCase();
        let status = 'Disponibil';
        if (/soldout|outofstock/.test(avail)) status = 'Epuizat';
        else if (/preorder|presale/.test(avail)) status = 'În curând';

        let url = ev.url || offers.url || null;
        try {
          if (url) url = new URL(url, 'https://www.eventim.ro').href;
        } catch (_) {}

        const direct = Boolean(url && /eventim\.ro\/event\//.test(url));
        const opponent = extractOpponent(title);
        const id = direct
          ? `eventim-${url.replace(/\/$/, '').split('/').pop()}`
          : `eventim-${slugify(title)}-${date}`;

        if (!matches.some((x) => x.id === id || (x.date === date && x.opponent === opponent))) {
          matches.push({
            id,
            title,
            opponent,
            competition: detectCompetition(title),
            date,
            time,
            location: ev.location?.name || 'Patinoarul Olimpic Brașov',
            startingPrice: priceVal != null && priceVal !== '' ? `${priceVal} ${offers.priceCurrency || 'RON'}` : null,
            status,
            ticketUrl: direct ? url : defaultUrl,
            ticketUrlIsDirect: direct,
            isHome: true,
            source: 'eventim'
          });
        }
      }
    } catch (_) {}
  }

  const eventLinkRegex = /<a\b[^>]*href=["']([^"']*\/event\/csm-corona-brasov[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = eventLinkRegex.exec(html)) !== null) {
    const rawHref = match[1];
    let fullUrl = defaultUrl;
    try {
      fullUrl = new URL(rawHref, 'https://www.eventim.ro').href;
    } catch (_) {}

    const innerText = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (innerText.length > 5 && !matches.some((m) => m.ticketUrl === fullUrl)) {
      const dateMatch = innerText.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
      const timeMatch = innerText.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
      if (dateMatch) {
        const cleanDate = `${dateMatch[3]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[1]).padStart(2, '0')}`;
        const cleanTime = timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null;
        const opponent = extractOpponent(innerText);
        const id = `eventim-${fullUrl.replace(/\/$/, '').split('/').pop()}`;

        matches.push({
          id,
          title: innerText,
          opponent,
          competition: detectCompetition(innerText),
          date: cleanDate,
          time: cleanTime,
          location: 'Patinoarul Olimpic Brașov',
          startingPrice: null,
          status: 'Disponibil',
          ticketUrl: fullUrl,
          ticketUrlIsDirect: true,
          isHome: true,
          source: 'eventim'
        });
      }
    }
  }

  return matches;
}

async function scrapeEventim(context) {
  console.log(`🔍 Eventim: ${EVENTIM_URL}`);
  let results = [];
  let lastError = null;

  if (context) {
    let page;
    try {
      page = await context.newPage();
      const response = await page.goto(EVENTIM_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      const httpStatus = response ? response.status() : 0;
      if (httpStatus < 400) {
        for (const sel of ['#cmpbntyestxt', 'button:has-text("Accept")', 'button:has-text("Sunt de acord")']) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
            await btn.click().catch(() => {});
            break;
          }
        }
        await page.waitForTimeout(1500);
        results = parseEventimHtml(await page.content(), EVENTIM_URL);
      } else {
        lastError = `HTTP ${httpStatus}`;
      }
    } catch (err) {
      lastError = err.message.split('\n')[0];
      console.warn(`⚠️ Playwright Eventim (${lastError}), încerc fetch HTTP/1.1...`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  if (results.length === 0 && lastError) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(EVENTIM_URL, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });
      clearTimeout(timer);
      if (res.ok) {
        results = parseEventimHtml(await res.text(), EVENTIM_URL);
        lastError = null;
        console.log(`✅ Eventim HTTP/1.1: ${results.length} meciuri.`);
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (fetchErr) {
      lastError = fetchErr.cause?.code || fetchErr.message;
      console.warn(`⚠️ Eventim blocat din Cloud (${lastError}).`);
    }
  }

  const ok = !lastError;
  console.log(`   ↳ Eventim ok=${ok}, meciuri=${results.length}`);
  return { ok, error: lastError, matches: results };
}

// ---------------------------------------------------------------------------
// 2) Scraper program oficial de pe coronabrasov.ro/hochei-pe-gheata-seniori/
// ---------------------------------------------------------------------------

function parseCoronaScheduleHtml(html) {
  const matches = [];
  // Înlocuim tag-urile bloc cu newline pentru a analiza linie cu linie
  const text = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|br\s*\/?)>/gi, '\n')
      .replace(/<td[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );

  // Detectăm competiția curentă pe măsură ce parcurgem secțiunile paginii
  let currentComp = 'Erste Liga';
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  for (const line of lines) {
    const norm = normalizeText(line);
    if (line.length < 40) {
      if (norm.includes('cupa romaniei')) currentComp = 'Cupa României';
      else if (norm.includes('campionatul national')) currentComp = 'Campionatul Național';
      else if (norm.includes('erste liga')) currentComp = 'Erste Liga';
    }

    // Căutăm linii de tipul: "15.11.2026 ... CSM Corona Brașov – Gyergyói Hoki Klub" (sau invers)
    const dm = line.match(/\b(\d{1,2})\.(\d{1,2})\.(202\d)\b/);
    if (!dm || !norm.includes('corona')) continue;

    const date = `${dm[3]}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
    const tm = line.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    const time = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null;

    // Extragem cele două echipe separate prin –, —, - sau vs
    const afterDate = line
      .replace(dm[0], ' ')
      .replace(tm ? tm[0] : '', ' ')
      .replace(/^[\s:.,\-–—]+/, '')
      .trim();

    const teamSplit = afterDate.split(/\s+(?:–|—|-|vs\.?)\s+/i);
    if (teamSplit.length < 2) continue;

    const teamA = teamSplit[0].replace(/\s*\d+\s*$/, '').trim();
    const teamB = teamSplit[1].split(/[|(•]/)[0].replace(/\s*\d+\s*$/, '').trim();
    if (teamA.length < 3 || teamB.length < 3) continue;

    const isHome = normalizeText(teamA).includes('corona');
    const opponent = (isHome ? teamB : teamA).trim();
    const title = isHome ? `CSM Corona Brașov – ${opponent}` : `${opponent} – CSM Corona Brașov`;
    const id = `corona-${date}-${slugify(opponent)}`;

    if (!matches.some((m) => m.id === id || (m.date === date && normalizeText(m.opponent) === normalizeText(opponent)))) {
      matches.push({
        id,
        title,
        opponent,
        competition: detectCompetition(`${currentComp} ${line}`),
        date,
        time,
        location: isHome ? 'Patinoarul Olimpic Brașov' : `Deplasare (${opponent})`,
        startingPrice: null,
        status: isHome ? 'Programat' : 'Deplasare',
        ticketUrl: EVENTIM_URL,
        ticketUrlIsDirect: false,
        isHome,
        source: 'coronabrasov.ro'
      });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// 3) Scraper știri + program coronabrasov.ro
// ---------------------------------------------------------------------------

async function scrapeCoronaSite() {
  console.log(`🔍 Știri & Program: ${CORONA_SITE_URL}`);
  let news = [];
  let scheduleMatches = [];
  let ok = false;
  let error = null;

  try {
    const resNews = await fetch(CORONA_SITE_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9'
      }
    });
    if (!resNews.ok) throw new Error(`HTTP ${resNews.status}`);
    ok = true;

    const html = await resNews.text();
    const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set();
    let m;

    while ((m = linkRegex.exec(html)) !== null) {
      const href = m[1];
      const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!href || seen.has(href) || href.includes('#') || !/^https?:/.test(href)) continue;
      if (title.length < 22) continue;

      let itemHost = '';
      try {
        itemHost = new URL(href).hostname.replace(/^www\./, '');
      } catch (_) {
        continue;
      }
      if (!itemHost.includes('coronabrasov.ro')) continue;
      seen.add(href);

      const t = normalizeText(title);
      const matched = KEYWORDS.filter((kw) => t.includes(normalizeText(kw)));
      if (!matched.length) continue;

      news.push({
        id: `news-${slugify(href.replace(/^https?:\/\/[^/]+/, '')) || slugify(title)}`,
        title,
        url: href,
        isTicketAlert: TICKET_ALERT_KEYWORDS.some((k) => t.includes(normalizeText(k))),
        keywordsMatched: matched,
        source: 'coronabrasov.ro'
      });
    }
  } catch (err) {
    error = err.message;
    console.warn(`⚠️ coronabrasov.ro știri: ${err.message}`);
  }

  // Programul oficial de pe pagina de hochei seniori
  try {
    const resSched = await fetch(CORONA_HOCKEY_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9'
      }
    });
    if (resSched.ok) {
      const schedHtml = await resSched.text();
      scheduleMatches = parseCoronaScheduleHtml(schedHtml);
      console.log(`   ↳ Meciuri extrase din programul oficial coronabrasov.ro: ${scheduleMatches.length}`);
    }
  } catch (err) {
    console.warn(`⚠️ coronabrasov.ro program hochei: ${err.message}`);
  }

  console.log(`   ↳ Articole relevante găsite pe coronabrasov.ro: ${news.length}`);
  return { ok, error, news: news.slice(0, MAX_NEWS), scheduleMatches };
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
  const isManual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || args.includes('--force');

  if (isScheduled && !isManual && (now.hour < ACTIVE_HOUR_START || now.hour >= ACTIVE_HOUR_END)) {
    console.log(`🌙 Ora ${now.hour}:xx în România — în afara intervalului 08:00–23:00. Nu rulez.`);
    return;
  }

  const existing = loadExistingData();
  const isFirstRun = !existing.lastChecked;
  const nowIso = new Date().toISOString();

  let browser;
  let context;
  let eventim = { ok: false, error: 'neinițializat', matches: [] };
  let corona = { ok: false, error: 'neinițializat', news: [], scheduleMatches: [] };

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-http2',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ]
    });
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
      locale: 'ro-RO',
      timezoneId: 'Europe/Bucharest',
      extraHTTPHeaders: { 'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7' }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  } catch (err) {
    console.warn('⚠️ Chromium nu a pornit, continui cu HTTP direct:', err.message);
  }

  try {
    eventim = await scrapeEventim(context);
    corona = await scrapeCoronaSite();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  let changed = false;
  const notifications = [];

  // ---- Combinăm meciurile reale din ambele surse (prioritate Eventim) ----
  const incomingMatches = [...eventim.matches];
  for (const cm of corona.scheduleMatches) {
    const dup = incomingMatches.some(
      (em) => em.date === cm.date && normalizeText(em.opponent) === normalizeText(cm.opponent)
    );
    if (!dup) incomingMatches.push(cm);
  }

  let matches = (existing.matches || []).filter(
    (m) => m.source === 'eventim' || m.source === 'coronabrasov.ro'
  );
  if (matches.length !== (existing.matches || []).length) changed = true;

  const newlyFound = [];
  for (const fresh of incomingMatches) {
    const old = matches.find(
      (m) =>
        m.id === fresh.id ||
        (fresh.ticketUrlIsDirect && m.ticketUrl === fresh.ticketUrl) ||
        (m.date === fresh.date && normalizeText(m.opponent) === normalizeText(fresh.opponent))
    );

    if (!old) {
      matches.push({ ...fresh, firstSeen: nowIso, stillListed: true });
      newlyFound.push(fresh);
      changed = true;
      continue;
    }

    const becameAvailable = old.status !== 'Disponibil' && fresh.status === 'Disponibil';
    // Dacă apare acum pe Eventim, actualizăm sursa și link-ul direct
    if (fresh.source === 'eventim' || old.source === fresh.source) {
      for (const key of ['title', 'opponent', 'time', 'startingPrice', 'status', 'ticketUrl', 'ticketUrlIsDirect', 'location', 'source', 'isHome']) {
        if (fresh[key] != null && fresh[key] !== old[key]) {
          old[key] = fresh[key];
          changed = true;
        }
      }
    }
    if (becameAvailable && !isFirstRun) {
      notifications.push({
        title: `BILETE DISPONIBILE: Corona vs ${old.opponent || old.title}`,
        message: `${old.title}\n📅 ${old.date}${old.time ? ' ora ' + old.time : ''}\n💰 ${old.startingPrice || 'preț pe Eventim'}`,
        url: old.ticketUrl
      });
    }
  }

  // Curățăm meciurile mai vechi de KEEP_PAST_MATCH_DAYS și sortăm cronologic
  const before = matches.length;
  matches = matches.filter((m) => daysBetween(now.date, m.date) <= KEEP_PAST_MATCH_DAYS);
  if (matches.length !== before) changed = true;
  matches.sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));

  if (newlyFound.length) {
    const eventimNew = newlyFound.filter((m) => m.source === 'eventim');
    if (eventimNew.length) {
      notifications.push({
        title: eventimNew.length === 1
          ? `Bilete Eventim: ${eventimNew[0].opponent || eventimNew[0].title}`
          : `${eventimNew.length} meciuri Corona pe Eventim`,
        message: eventimNew.map((m) => `• ${m.date} — ${m.opponent || m.title} (${m.status})`).join('\n'),
        url: eventimNew.length === 1 ? eventimNew[0].ticketUrl : EVENTIM_URL
      });
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
    if (item.isTicketAlert && !isFirstNewsRun) {
      notifications.push({ title: 'Anunț bilete pe coronabrasov.ro', message: item.title, url: item.url });
    }
  }
  news = news.slice(0, MAX_NEWS);

  // ---- Salvare ----
  const minutesSinceCheck = existing.lastChecked
    ? (Date.now() - new Date(existing.lastChecked).getTime()) / 60000
    : Infinity;
  const heartbeatDue = minutesSinceCheck >= HEARTBEAT_MINUTES;
  const statusChanged = existing.sources?.eventim?.error !== eventim.error || existing.sources?.coronabrasov?.ok !== corona.ok;

  if (changed || heartbeatDue || isFirstRun || isManual || statusChanged) {
    const payload = {
      lastChecked: nowIso,
      sources: {
        eventim: { url: EVENTIM_URL, ok: eventim.ok, found: eventim.matches.length, error: eventim.error || null },
        coronabrasov: {
          url: CORONA_SITE_URL,
          ok: corona.ok,
          found: corona.news.length,
          scheduleFound: corona.scheduleMatches.length,
          error: corona.error || null
        }
      },
      matches,
      news
    };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`💾 data/matches.json salvat (${matches.length} meciuri, ${news.length} știri).`);
  } else {
    console.log('✅ Nicio modificare nouă.');
  }

  for (const n of notifications) {
    await sendPushNotification(n);
  }
}

runMonitor().catch((err) => {
  console.error('❌ Eroare neprevăzută:', err);
  process.exitCode = 1;
});
