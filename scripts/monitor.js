/**
 * Corona Ice Tracker — Motor de monitorizare automată
 * Surse:
 *   1. coronabrasov.ro/hochei-pe-gheata-seniori/ (program oficial meciuri)
 *   2. coronabrasov.ro (știri și anunțuri punere în vânzare bilete)
 *
 * Notificările și meciurile includ buton direct către pagina oficială Eventim,
 * astfel încât utilizatorii pot intra imediat de pe telefon sau desktop.
 *
 * Utilizare:
 *   node scripts/monitor.js                 # verificare normală
 *   node scripts/monitor.js --test-notify   # trimite doar o notificare de test
 *   node scripts/monitor.js --force         # ignoră fereastra orară 08:00–23:00
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'matches.json');

const EVENTIM_URL =
  'https://www.eventim.ro/artist/csm-corona-brasov/csm-corona-brasov-hochei-4277387/?affiliate=ROF';
const CORONA_SITE_URL = 'https://www.coronabrasov.ro';
const CORONA_HOCKEY_URL = 'https://www.coronabrasov.ro/hochei-pe-gheata-seniori/';

const ACTIVE_HOUR_START = 8; // 08:00 ora României
const ACTIVE_HOUR_END = 23; // până la 23:00 (exclusiv)
const HEARTBEAT_MINUTES = 60; // actualizează timestamp-ul o dată pe oră chiar fără modificări
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
// Notificări (ntfy.sh + Telegram)
// ---------------------------------------------------------------------------

async function sendPushNotification({ title, message, url, urgent = false }) {
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
          Priority: urgent ? 'urgent' : 'high',
          Tags: urgent ? 'rotating_light,ice_hockey,ticket' : 'ice_hockey,ticket',
          Click: EVENTIM_URL,
          Actions: `view, Cumpara Bilete Eventim, ${EVENTIM_URL}, clear=true`
        },
        body: `${message}\n\n🎟️ Bilete Eventim: ${EVENTIM_URL}${targetUrl !== EVENTIM_URL ? `\n📰 Sursa anunț: ${targetUrl}` : ''}`
      });
      if (res.ok) {
        console.log(`✅ ntfy.sh: notificare trimisă pe topicul "${ntfyTopic}" (prioritate: ${urgent ? 'urgent' : 'high'}).`);
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
          text: `${urgent ? '🚨' : '🏒'} <b>${escapeHtml(title)}</b>\n\n${escapeHtml(message)}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎟️ Cumpără Bilete pe Eventim', url: EVENTIM_URL }],
              ...(targetUrl !== EVENTIM_URL ? [[{ text: '📰 Citește anunțul', url: targetUrl }]] : [])
            ]
          }
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
// Extragere program oficial de pe coronabrasov.ro/hochei-pe-gheata-seniori/
// ---------------------------------------------------------------------------

function parseCoronaScheduleHtml(html) {
  const matches = [];
  const text = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|br\s*\/?)>/gi, '\n')
      .replace(/<td[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );

  let currentComp = 'Erste Liga';
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  for (const line of lines) {
    const norm = normalizeText(line);
    if (line.length < 40) {
      if (norm.includes('cupa romaniei')) currentComp = 'Cupa României';
      else if (norm.includes('campionatul national')) currentComp = 'Campionatul Național';
      else if (norm.includes('erste liga')) currentComp = 'Erste Liga';
    }

    const dm = line.match(/\b(\d{1,2})\.(\d{1,2})\.(202\d)\b/);
    if (!dm || !norm.includes('corona')) continue;

    const date = `${dm[3]}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
    const tm = line.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    const time = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null;

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
// Scraper știri + program coronabrasov.ro
// ---------------------------------------------------------------------------

async function scrapeCoronaSite() {
  console.log(`🔍 Verificare site oficial: ${CORONA_SITE_URL}`);
  let news = [];
  let scheduleMatches = [];
  let ok = false;
  let error = null;

  try {
    const resNews = await fetch(CORONA_SITE_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

  try {
    const resSched = await fetch(CORONA_HOCKEY_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9'
      }
    });
    if (resSched.ok) {
      const schedHtml = await resSched.text();
      scheduleMatches = parseCoronaScheduleHtml(schedHtml);
      console.log(`   ↳ Meciuri extrase din programul oficial: ${scheduleMatches.length}`);
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
      message: 'Alertele pentru biletele CSM Corona Brașov funcționează! Apasă pentru a deschide Eventim.',
      url: EVENTIM_URL,
      urgent: true
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

  const corona = await scrapeCoronaSite();

  let changed = false;
  const notifications = [];

  // ---- Meciuri ----
  let matches = (existing.matches || []).filter((m) => m.source === 'coronabrasov.ro');
  if (matches.length !== (existing.matches || []).length) changed = true;

  for (const fresh of corona.scheduleMatches) {
    const old = matches.find(
      (m) => m.id === fresh.id || (m.date === fresh.date && normalizeText(m.opponent) === normalizeText(fresh.opponent))
    );

    if (!old) {
      matches.push({ ...fresh, firstSeen: nowIso });
      changed = true;
      continue;
    }

    for (const key of ['title', 'opponent', 'time', 'status', 'location', 'isHome', 'competition']) {
      if (fresh[key] != null && fresh[key] !== old[key]) {
        old[key] = fresh[key];
        changed = true;
      }
    }
  }

  const before = matches.length;
  matches = matches.filter((m) => daysBetween(now.date, m.date) <= KEEP_PAST_MATCH_DAYS);
  if (matches.length !== before) changed = true;
  matches.sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));

  // ---- Știri & Alerte Bilete ----
  let news = (existing.news || []).filter((n) => n.source === 'coronabrasov.ro');
  if (news.length !== (existing.news || []).length) changed = true;
  const isFirstNewsRun = news.length === 0;

  for (const item of corona.news) {
    if (news.some((n) => n.id === item.id || n.url === item.url)) continue;
    news.unshift({ ...item, firstSeen: nowIso });
    changed = true;
    if (item.isTicketAlert && !isFirstNewsRun) {
      notifications.push({
        title: 'BILETE CORONA BRASOV - Anunt Nou!',
        message: `${item.title}\n\nApasă pentru a intra direct pe Eventim.`,
        url: item.url,
        urgent: true
      });
    }
  }
  news = news.slice(0, MAX_NEWS);

  // ---- Salvare ----
  const minutesSinceCheck = existing.lastChecked
    ? (Date.now() - new Date(existing.lastChecked).getTime()) / 60000
    : Infinity;
  const heartbeatDue = minutesSinceCheck >= HEARTBEAT_MINUTES;
  const statusChanged = existing.sources?.coronabrasov?.ok !== corona.ok;

  if (changed || heartbeatDue || isFirstRun || isManual || statusChanged) {
    const payload = {
      lastChecked: nowIso,
      sources: {
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

  if (!corona.ok) {
    process.exitCode = 1;
  }
}

runMonitor().catch((err) => {
  console.error('❌ Eroare neprevăzută:', err);
  process.exitCode = 1;
});
