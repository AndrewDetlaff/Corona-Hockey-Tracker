/**
 * Corona Ice Tracker — Motor de monitorizare automată (Eventim.ro + coronabrasov.ro)
 * Playwright + Chromium headless + HTTP/1.1 Fallback. 100% determinist, fără AI.
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

const ACTIVE_HOUR_START = 8; // 08:00 ora României
const ACTIVE_HOUR_END = 23; // până la 23:00 (exclusiv)
const HEARTBEAT_MINUTES = 60; // actualizează timestamp-ul o dată pe oră chiar fără meciuri noi
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
// Extragere meciuri din JSON-LD / HTML Eventim
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
            source: 'eventim'
          });
        }
      }
    } catch (_) {}
  }

  // Scanare link-uri evenimente directe dacă nu s-au extras din JSON-LD
  const eventLinkRegex = /<a\b[^>]*href=["']([^"']*\/event\/csm-corona-brasov[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = eventLinkRegex.exec(html)) !== null) {
    const rawHref = match[1];
    let fullUrl = defaultUrl;
    try {
      fullUrl = new URL(rawHref, 'https://www.eventim.ro').href;
    } catch (_) {}

    const innerText = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
          source: 'eventim'
        });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Scraper Eventim cu Playwright (--disable-http2) + Fallback HTTP/1.1 direct
// ---------------------------------------------------------------------------

async function scrapeEventim(context) {
  console.log(`🔍 Eventim: ${EVENTIM_URL}`);
  let results = [];

  // Metoda 1: Încercare cu Playwright (Chromium headless fără HTTP/2)
  if (context) {
    let page;
    try {
      page = await context.newPage();
      const response = await page.goto(EVENTIM_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      const httpStatus = response ? response.status() : 0;
      if (httpStatus < 400) {
        // Acceptare cookies dacă e necesar
        for (const sel of ['#cmpbntyestxt', 'button:has-text("Accept")', 'button:has-text("Sunt de acord")']) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
            await btn.click().catch(() => {});
            break;
          }
        }
        await page.waitForTimeout(2000);
        const html = await page.content();
        results = parseEventimHtml(html, EVENTIM_URL);
      }
    } catch (err) {
      console.warn(`⚠️ Playwright Eventim întâmpină eroare (${err.message}), activez fallback-ul HTTP/1.1 direct...`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // Metoda 2 (Fallback robust): Dacă Playwright a fost blocat de HTTP/2, facem fetch direct pe HTTP/1.1
  if (results.length === 0) {
    try {
      console.log('🌐 Conectare directă la Eventim prin HTTP/1.1...');
      const res = await fetch(EVENTIM_URL, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
          'Connection': 'keep-alive'
        }
      });
      if (res.ok) {
        const html = await res.text();
        results = parseEventimHtml(html, EVENTIM_URL);
        console.log(`✅ Fallback HTTP/1.1 a funcționat cu succes (${results.length} meciuri găsite).`);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (fetchErr) {
      console.warn(`⚠️ Fallback-ul HTTP/1.1 a raportat: ${fetchErr.message}`);
    }
  }

  console.log(`   ↳ Meciuri valide Eventim: ${results.length}`);
  return { ok: results.length > 0, error: results.length === 0 ? 'Niciun meci activ listat momentan' : null, matches: results };
}

// ---------------------------------------------------------------------------
// Scraper știri coronabrasov.ro
// ---------------------------------------------------------------------------

async function scrapeCoronaNews(context) {
  console.log(`🔍 Știri: ${CORONA_SITE_URL}`);
  let news = [];

  // Încercare fetch direct (rapid și fără riscuri de protocol browser)
  try {
    const res = await fetch(CORONA_SITE_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9'
      }
    });
    if (res.ok) {
      const html = await res.text();
      const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      const seen = new Set();
      let m;

      while ((m = linkRegex.exec(html)) !== null) {
        const href = m[1];
        const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
    }
  } catch (err) {
    console.warn(`⚠️ coronabrasov.ro fetch direct: ${err.message}`);
  }

  console.log(`   ↳ ${news.length} articole relevante găsite pe coronabrasov.ro.`);
  return { ok: true, news: news.slice(0, MAX_NEWS) };
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
  let context;
  let eventim = { ok: false, error: 'neinițializat', matches: [] };
  let corona = { ok: false, error: 'neinițializat', news: [] };

  try {
    // Lansăm Chromium cu flag-urile anti-bot și DEZACTIVARE HTTP/2 (elimină ERR_HTTP2_PROTOCOL_ERROR)
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
    console.warn('⚠️ Chromium nu a putut fi pornit, se va folosi motorul HTTP direct:', err.message);
  }

  try {
    eventim = await scrapeEventim(context);
    corona = await scrapeCoronaNews(context);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  let changed = false;
  const notifications = [];

  // ---- Meciuri ----
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

  // Meciuri care nu mai apar pe Eventim
  if (eventim.ok && eventim.matches.length > 0) {
    for (const m of matches) {
      const listed = eventim.matches.some((f) => f.id === m.id || f.ticketUrl === m.ticketUrl);
      if (!listed && m.date >= now.date && m.stillListed !== false) {
        m.stillListed = false;
        changed = true;
      }
    }
  }

  // Curățăm meciurile mai vechi de KEEP_PAST_MATCH_DAYS
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

  if (changed || heartbeatDue || isFirstRun) {
    const payload = {
      lastChecked: nowIso,
      sources: {
        eventim: { url: EVENTIM_URL, ok: eventim.ok, found: eventim.matches.length, error: eventim.error || null },
        coronabrasov: { url: CORONA_SITE_URL, ok: corona.ok, found: corona.news.length, error: null }
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
