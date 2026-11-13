/**
 * Corona Ice Tracker — Motor de monitorizare automată
 * Surse:
 *   1. coronabrasov.ro & coronabrasov.ro/hochei-seniori/ (știri bilete + program oficial)
 *   2. api.icehockey.hu/vbr/v2/ (Erste Liga — program, scoruri live, statistici, evenimente goluri/eliminări)
 *   3. icehockey.ro (FRHG — Campionatul Național & Cupa României: program, scoruri live, evenimente)
 *
 * Utilizare:
 *   node scripts/monitor.js                 # verificare normală
 *   node scripts/monitor.js --test-notify   # trimite o notificare de test
 *   node scripts/monitor.js --force         # ignoră fereastra orară 08:00–23:00
 *   node scripts/monitor.js --watch         # urmărire live continuă (polling rapid 25s pentru goluri)
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'matches.json');

const EVENTIM_URL =
  'https://www.eventim.ro/artist/csm-corona-brasov/csm-corona-brasov-hochei-4277387/?affiliate=ROF';
const CORONA_SITE_URL = 'https://www.coronabrasov.ro';
const CORONA_HOCKEY_URL = 'https://coronabrasov.ro/hochei-seniori/';

const ERSTE_API_BASE = 'https://api.icehockey.hu/vbr/v2';
const ERSTE_API_KEY = process.env.ERSTE_API_KEY || '7b4f4d1b466b5a3572990ae24452abf2a086e7ee';
const ERSTE_CHAMPIONSHIP_ID = 4126;

const FRHG_TEAM_SOURCES = [
  { eventId: 49, competition: 'Campionatul Național', url: 'https://icehockey.ro/team/320/event/49/season/4' },
  { eventId: 50, competition: 'Cupa României', url: 'https://icehockey.ro/team/320/event/50/season/4' }
];

const ACTIVE_HOUR_START = 8; // 08:00 ora României
const ACTIVE_HOUR_END = 23; // până la 23:00 (exclusiv)
const HEARTBEAT_MINUTES = 60; // actualizează timestamp-ul o dată pe oră chiar fără modificări
const KEEP_PAST_MATCH_DAYS = 180;
const MAX_DETAILED_PAST_MATCHES = 25;
const MAX_NEWS = 15;
const MAX_SEEN_EVENT_IDS = 1500;

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

function stripTags(html = '') {
  return decodeHtmlEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function isCoronaName(name = '') {
  const n = normalizeText(name);
  return n.includes('corona') || n.includes('brasov');
}

function bucharestParts(dateObj = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(dateObj);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    hour: Number(get('hour'))
  };
}

function daysBetween(isoDateA, isoDateB) {
  return Math.round((new Date(isoDateA) - new Date(isoDateB)) / 86400000);
}

function detectCompetition(text = '') {
  const t = normalizeText(text);
  if (t.includes('cupa romaniei') || /\bcupa\b/.test(t) || /\bcrm\b/.test(t)) return 'Cupa României';
  if (t.includes('campionatul national') || t.includes('liga nationala') || /\bcnm\b/.test(t)) {
    return 'Campionatul Național';
  }
  return 'Erste Liga';
}

function parseScorePair(str = '') {
  const m = String(str).match(/(\d+)\s*[:\-]\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function parseMonthNameToNum(mon = '') {
  const map = {
    jan: '01', ian: '01', feb: '02', mar: '03', apr: '04', may: '05', mai: '05',
    jun: '06', iun: '06', jul: '07', iul: '07', aug: '08', sep: '09', oct: '10',
    nov: '11', dec: '12'
  };
  return map[normalizeText(mon).slice(0, 3)] || null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function loadExistingData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('⚠️ data/matches.json nu poate fi citit, pornesc de la zero:', err.message);
  }
  return { lastChecked: null, matches: [], news: [], liveState: { seeded: false, seenEventIds: [], matchPhaseStates: {} } };
}

// ---------------------------------------------------------------------------
// Notificări (ntfy.sh + Telegram)
// ---------------------------------------------------------------------------

async function sendPushNotification({ title, message, url, urgent = false, tags = 'ice_hockey', actionLabel = 'Deschide Eventim' }) {
  const ntfyTopic = process.env.NTFY_TOPIC;
  const ntfyServer = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const targetUrl = url || EVENTIM_URL;
  let sent = false;

  if (ntfyTopic) {
    try {
      const res = await fetchWithTimeout(`${ntfyServer}/${encodeURIComponent(ntfyTopic)}`, {
        method: 'POST',
        headers: {
          Title: toAsciiHeader(title) || 'Corona Ice Tracker',
          Priority: urgent ? 'urgent' : 'high',
          Tags: tags,
          Click: targetUrl,
          Actions: `view, ${toAsciiHeader(actionLabel)}, ${targetUrl}, clear=true`
        },
        body: `${message}\n\n🔗 ${targetUrl}`
      });
      if (res.ok) {
        console.log(`✅ ntfy.sh: "${title}" (prioritate: ${urgent ? 'urgent' : 'high'}).`);
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
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: `${urgent ? '🚨' : '🏒'} <b>${escapeHtml(title)}</b>\n\n${escapeHtml(message)}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: `🔗 ${actionLabel}`, url: targetUrl }]]
          }
        })
      });
      if (res.ok) {
        console.log(`✅ Telegram: "${title}" trimis.`);
        sent = true;
      } else {
        console.error(`❌ Telegram HTTP ${res.status}:`, await res.text());
      }
    } catch (err) {
      console.error('❌ Telegram:', err.message);
    }
  }

  if (!ntfyTopic && !(telegramToken && telegramChatId)) {
    console.log(`ℹ️ [Notificare simulată] ${title} — ${message.replace(/\n+/g, ' | ')} (${targetUrl})`);
  }
  return sent;
}

// ---------------------------------------------------------------------------
// 1. Erste Liga API (api.icehockey.hu/vbr/v2)
// ---------------------------------------------------------------------------

async function fetchErsteApi(endpoint) {
  const res = await fetchWithTimeout(`${ERSTE_API_BASE}${endpoint}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'X-API-KEY': ERSTE_API_KEY,
      Origin: 'https://www.ersteliga.hu',
      Referer: 'https://www.ersteliga.hu/'
    }
  });
  if (!res.ok) throw new Error(`Erste API HTTP ${res.status} (${endpoint})`);
  const json = await res.json();
  return json.data;
}

function mapErstePeriodLabel(period) {
  const p = normalizeText(period);
  if (p === 'p1' || p === '1') return 'Repriza 1';
  if (p === 'p2' || p === '2') return 'Repriza 2';
  if (p === 'p3' || p === '3') return 'Repriza 3';
  if (p === 'ot' || p === '4') return 'Prelungiri (OT)';
  if (p === 'so' || p === 'gws') return 'Lovituri de departajare (SO)';
  if (p === 'wu') return 'Încălzire';
  if (p === 'end') return 'Final';
  return period || '';
}

function normalizeErsteEvents(rawEvents = [], homeTeamId) {
  const items = [];
  for (let i = 0; i < rawEvents.length; i++) {
    const ev = rawEvents[i];
    const teamId = ev.team?.id ?? null;
    const side = teamId === homeTeamId ? 'home' : teamId ? 'away' : null;
    const isCorona = ev.team ? isCoronaName(ev.team.longName || ev.team.clubName) : false;
    const fullName = [ev.firstName, ev.lastName].filter(Boolean).join(' ').trim();
    const playerLabel = fullName ? `${ev.jerseyNumber ? `#${ev.jerseyNumber} ` : ''}${fullName}` : null;
    const period = mapErstePeriodLabel(ev.eventPeriod);

    if (ev.goal || normalizeText(ev.type) === 'gol') {
      const assists = [ev.assists1, ev.assists2]
        .flat()
        .filter((a) => a && (a.firstName || a.lastName))
        .map((a) => `${a.jerseyNumber ? `#${a.jerseyNumber} ` : ''}${[a.firstName, a.lastName].filter(Boolean).join(' ')}`.trim());
      const flags = [];
      if (ev.advantage && ev.advantage !== 'EQ') flags.push(ev.advantage);
      if (ev.en) flags.push('EN');
      if (ev.ps) flags.push('PS');
      if (ev.gwg) flags.push('GWG');
      if (ev.gtg) flags.push('GTG');

      items.push({
        id: `el-ev-${ev.eventId || `${ev.eventPeriod}-${ev.eventTime}-${i}`}`,
        type: 'goal',
        period,
        time: ev.eventTime || '',
        team: side,
        teamName: ev.team?.shortName || ev.team?.longName || '',
        isCorona,
        player: playerLabel || 'Marcator necunoscut',
        assists,
        score: ev.score || null,
        flags,
        label: `Gol ${ev.score || ''}`.trim()
      });
    } else if (normalizeText(ev.type).includes('kiallit')) {
      const mins = Number(ev.penaltyLength || 2);
      items.push({
        id: `el-ev-${ev.eventId || `${ev.eventPeriod}-${ev.eventTime}-${i}`}`,
        type: 'penalty',
        period,
        time: ev.eventTime || '',
        team: side,
        teamName: ev.team?.shortName || ev.team?.longName || '',
        isCorona,
        player: playerLabel || 'Echipă',
        minutes: mins,
        cause: ev.penaltyCause || '',
        isMajor: mins >= 5,
        label: `Eliminare ${mins} min${ev.penaltyCause ? ` (${ev.penaltyCause})` : ''}`
      });
    } else if (normalizeText(ev.type) === 'kapus') {
      items.push({
        id: `el-ev-${ev.eventId || `gk-${ev.eventPeriod}-${ev.eventTime}-${i}`}`,
        type: 'goalie',
        period,
        time: ev.eventTime || '',
        team: side,
        teamName: ev.team?.shortName || ev.team?.longName || '',
        isCorona,
        player: playerLabel,
        direction: ev.gkDirection || '',
        label: ev.gkDirection === 'out' ? 'Portar scos (6-la-5)' : 'Schimbare portar'
      });
    } else if (normalizeText(ev.type) === 'period' && ev.eventPeriod && ev.eventPeriod !== 'wu') {
      items.push({
        id: `el-period-${ev.eventPeriod}-${ev.eventTime || i}`,
        type: 'period',
        period,
        time: ev.eventTime || '',
        team: null,
        isCorona: false,
        label: `${period} (${ev.eventTime || '00:00'})`
      });
    }
  }
  return items;
}

function extractErsteStats(gameData, gameStats) {
  const homeId = String(gameData.homeTeam?.id || '');
  const awayId = String(gameData.awayTeam?.id || '');

  let sogHome = 0;
  let sogAway = 0;
  const sogByPeriod = {};

  for (const row of gameStats?.teamSOG || []) {
    const h = row[homeId];
    const a = row[awayId];
    const p = h?.period || a?.period;
    if (h) sogHome += Number(h.shots || 0);
    if (a) sogAway += Number(a.shots || 0);
    if (p) sogByPeriod[p] = `${h?.shots ?? 0}:${a?.shots ?? 0}`;
  }

  let pimHome = 0;
  let pimAway = 0;
  for (const row of gameStats?.teamPenalties || []) {
    if (row[homeId]) pimHome += Number(row[homeId].penaltyLength || 0);
    if (row[awayId]) pimAway += Number(row[awayId].penaltyLength || 0);
  }

  let ppGoalsHome = 0;
  let ppTotalHome = 0;
  let ppGoalsAway = 0;
  let ppTotalAway = 0;
  for (const row of gameStats?.teamPowerPlay || []) {
    if (row[homeId]) {
      ppGoalsHome += Number(row[homeId].ppGoals || row[homeId].goals || 0);
      ppTotalHome += Number(row[homeId].ppCount || row[homeId].count || 0);
    }
    if (row[awayId]) {
      ppGoalsAway += Number(row[awayId].ppGoals || row[awayId].goals || 0);
      ppTotalAway += Number(row[awayId].ppCount || row[awayId].count || 0);
    }
  }

  return {
    sogHome,
    sogAway,
    sogByPeriod,
    pimHome,
    pimAway,
    ppHome: ppTotalHome ? `${ppGoalsHome}/${ppTotalHome}` : null,
    ppAway: ppTotalAway ? `${ppGoalsAway}/${ppTotalAway}` : null,
    attendance: gameData.attendance || null
  };
}

async function scrapeErsteLiga(existingMatchesMap) {
  console.log('🔍 Verificare Erste Liga (api.icehockey.hu)...');
  const result = { ok: false, found: 0, live: false, error: null, matches: [] };
  try {
    const games = await fetchErsteApi(`/games-list?championshipId=${ERSTE_CHAMPIONSHIP_ID}`);
    const coronaGames = (games || []).filter(
      (g) => isCoronaName(g.homeTeam?.longName || g.homeTeam?.clubName) || isCoronaName(g.awayTeam?.longName || g.awayTeam?.clubName)
    );
    result.ok = true;
    result.found = coronaGames.length;

    // Selectăm meciurile care au nevoie de detalii complete: live + ultimele 15 finalizate fără cache
    const sortedFinished = coronaGames
      .filter((g) => g.gameStatus === 2)
      .sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)))
      .slice(0, MAX_DETAILED_PAST_MATCHES);
    const detailIds = new Set([
      ...coronaGames.filter((g) => g.gameStatus === 1).map((g) => g.id),
      ...sortedFinished.map((g) => g.id)
    ]);

    result.matches = await mapWithConcurrency(coronaGames, 5, async (g) => {
      const id = `el-${g.id}`;
      const localDate = bucharestParts(new Date(g.gameDate));
      const homeName = g.homeTeam?.longName || 'Gazde';
      const awayName = g.awayTeam?.longName || 'Oaspeți';
      const isHome = isCoronaName(homeName);
      const opponent = isHome ? awayName : homeName;
      const matchState = g.gameStatus === 1 ? 'live' : g.gameStatus === 2 ? 'finished' : 'scheduled';
      if (matchState === 'live') result.live = true;

      const prev = existingMatchesMap.get(id);
      const canUseCache =
        matchState === 'finished' &&
        prev &&
        prev.detailsLoaded &&
        prev.homeScore === g.homeTeamScore &&
        prev.awayScore === g.awayTeamScore;

      let periodScores = prev?.periodScores || null;
      let stats = prev?.stats || null;
      let events = prev?.events || [];
      let liveInfo = null;
      let links = prev?.links || {
        gameCenter: `https://www.ersteliga.hu/game/id/${g.id}`,
        video: null,
        reportPdf: null,
        lineupPdf: null
      };
      let detailsLoaded = Boolean(prev?.detailsLoaded);

      if (detailIds.has(g.id) && !canUseCache) {
        try {
          const [gameData, gameEvents, gameStats] = await Promise.all([
            fetchErsteApi(`/game-data?gameId=${g.id}`),
            fetchErsteApi(`/game-events?gameId=${g.id}`),
            fetchErsteApi(`/game-stats?gameId=${g.id}`).catch(() => null)
          ]);
          const sp = gameData?.structuredPeriodResults || {};
          periodScores = {
            p1: sp['1'] || null,
            p2: sp['2'] || null,
            p3: sp['3'] || null,
            ot: sp.ot && sp.ot !== '-:-' ? sp.ot : null,
            so: sp.so && sp.so !== '-:-' ? sp.so : null
          };
          if (matchState === 'live' && gameData) {
            liveInfo = {
              periodLabel: mapErstePeriodLabel(gameData.period || `p${gameData.actualPeriod || 1}`),
              clock: gameData.periodTime || gameData.actualTime || '',
              statusText: gameData.period === 'int' ? 'Pauză' : 'În desfășurare'
            };
          }
          events = normalizeErsteEvents(gameEvents || [], g.homeTeam?.id);
          if (gameStats) stats = extractErsteStats(gameData || g, gameStats);
          links = {
            gameCenter: `https://www.ersteliga.hu/game/id/${g.id}`,
            video: gameData?.video || null,
            reportPdf: gameData?.electronicReportUrl || null,
            lineupPdf: gameData?.lineupReportUrl || null
          };
          detailsLoaded = true;
        } catch (detailErr) {
          console.warn(`⚠️ Detalii Erste Liga #${g.id}: ${detailErr.message}`);
        }
      }

      return {
        id,
        gameNo: g.gameName || null,
        title: `${homeName} – ${awayName}`,
        homeTeam: homeName,
        awayTeam: awayName,
        homeShort: g.homeTeam?.shortName || null,
        awayShort: g.awayTeam?.shortName || null,
        homeLogo: g.homeTeam?.logo || null,
        awayLogo: g.awayTeam?.logo || null,
        opponent,
        isHome,
        competition: 'Erste Liga',
        date: localDate.date,
        time: localDate.time,
        location: g.location?.locationName || (isHome ? 'Patinoarul Olimpic Brașov' : opponent),
        startingPrice: null,
        status: matchState === 'live' ? 'LIVE' : matchState === 'finished' ? 'Finalizat' : isHome ? 'Programat' : 'Deplasare',
        matchState,
        homeScore: g.homeTeamScore ?? null,
        awayScore: g.awayTeamScore ?? null,
        periodScores,
        isOvertime: Boolean(g.isOvertime),
        isShootout: Boolean(g.isShootout),
        liveInfo,
        stats,
        events,
        links,
        detailsLoaded,
        ticketUrl: EVENTIM_URL,
        ticketUrlIsDirect: false,
        source: 'ersteliga.hu'
      };
    });
    console.log(`   ↳ Erste Liga: ${result.matches.length} meciuri Corona (${result.live ? 'LIVE ACTIV!' : 'niciunul live'}).`);
  } catch (err) {
    result.error = err.message;
    console.warn(`⚠️ Erste Liga API: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 2. FRHG (icehockey.ro) — Campionatul Național & Cupa României
// ---------------------------------------------------------------------------

function parseIceHockeyRoDate(dateStr = '') {
  const m = String(dateStr).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(202\d)$/);
  if (!m) return null;
  const mon = parseMonthNameToNum(m[2]);
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
}

function mapFrhgPeriodLabel(header = '') {
  const h = normalizeText(header);
  if (h.includes('1st')) return 'Repriza 1';
  if (h.includes('2nd')) return 'Repriza 2';
  if (h.includes('3rd')) return 'Repriza 3';
  if (h.includes('overtime') || h === 'ot') return 'Prelungiri (OT)';
  if (h.includes('shootout') || h === 'so') return 'Lovituri de departajare (SO)';
  return header.trim();
}

function parseIceHockeyRoGamePage(html, gameUrl, homeTeamName) {
  // Score & periods from <!-- Game Status START -->
  let homeScore = null;
  let awayScore = null;
  let periodScores = null;
  let statusRaw = '';
  let isLive = false;

  const gsIdx = html.indexOf('<!-- Game Status START -->');
  const gsEnd = gsIdx >= 0 ? html.indexOf('<!-- Game Status END -->', gsIdx) : -1;
  if (gsIdx >= 0 && gsEnd > gsIdx) {
    const gsBlock = html.slice(gsIdx, gsEnd);
    const scoreMatch = gsBlock.match(/display-1[^>]*>\s*(\d+)\s*:\s*(\d+)\s*</i);
    if (scoreMatch) {
      homeScore = Number(scoreMatch[1]);
      awayScore = Number(scoreMatch[2]);
    }
    const perMatch = gsBlock.match(/<div class="fs-3">\s*\(([^)]+)\)\s*<\/div>/i);
    if (perMatch) {
      const parts = perMatch[1].split(',').map((s) => s.trim());
      periodScores = {
        p1: parts[0] || null,
        p2: parts[1] || null,
        p3: parts[2] || null,
        ot: parts[3] || null,
        so: parts[4] || null
      };
    }
    const statusMatch = gsBlock.match(/<div class="fs-5 fw-bold">([^<]+)<\/div>/i);
    if (statusMatch) statusRaw = stripTags(statusMatch[1]);
    // Comentariul refresh.js apare când jocul este live (status între 1 și 13)
    isLive =
      /refresh\.js/i.test(gsBlock) ||
      (/live|period|repriza|intermission|overtime|shootout/i.test(statusRaw) && !/completed|final/i.test(statusRaw));
  }

  // Stats: Penalty Minutes & Shots on Goal
  let pimHome = null;
  let pimAway = null;
  let sogHome = null;
  let sogAway = null;
  const sogByPeriod = {};

  const pimMatch = html.match(/Penalty Minutes:[\s\S]{0,180}?<b>\s*(\d+)\s*:\s*(\d+)\s*<\/b>/i);
  if (pimMatch) {
    pimHome = Number(pimMatch[1]);
    pimAway = Number(pimMatch[2]);
  }
  const sogMatch = html.match(/Shots on Goal:[\s\S]{0,220}?<b>\s*(\d+)\s*:\s*(\d+)\s*<\/b>(?:[\s\S]{0,120}?<div class="fs-3">\s*\(([^)]+)\))?/i);
  if (sogMatch) {
    sogHome = Number(sogMatch[1]);
    sogAway = Number(sogMatch[2]);
    if (sogMatch[3]) {
      const parts = sogMatch[3].split(',').map((s) => s.trim());
      parts.forEach((p, idx) => {
        sogByPeriod[idx < 3 ? `p${idx + 1}` : 'ot'] = p;
      });
    }
  }

  // Links: PDF game sheet & video
  const sheetPdf = html.match(/https:\/\/admin\.icehockey\.ro\/storage\/sheet_pdf\/[^"'\s]+/i)?.[0] || null;
  const lineupPdf = html.match(/https:\/\/admin\.icehockey\.ro\/storage\/team_pdf\/[^"'\s]+/i)?.[0] || null;
  const ytMatch = html.match(/https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^"'\s)]+/i)?.[0] || null;

  // Play-by-play table (rows are reversed on icehockey.ro: 3rd period -> 1st period)
  const events = [];
  const pIdx = html.search(/1ST PERIOD|2ND PERIOD|3RD PERIOD|OVERTIME|SHOOTOUT/i);
  if (pIdx >= 0) {
    const tblStart = html.lastIndexOf('<table', pIdx);
    const tblEnd = html.indexOf('</table>', pIdx);
    if (tblStart >= 0 && tblEnd > tblStart) {
      const tbl = html.slice(tblStart, tblEnd);
      const tokenRegex = /<th[^>]*>([\s\S]*?)<\/th>|<td[^>]*>([\s\S]*?)<\/td>/gi;
      let currentPeriod = '';
      let rowCells = [];
      let m;

      while ((m = tokenRegex.exec(tbl)) !== null) {
        if (m[1] !== undefined) {
          const header = stripTags(m[1]);
          if (/period|overtime|shootout/i.test(header)) {
            currentPeriod = mapFrhgPeriodLabel(header);
            rowCells = [];
          }
          continue;
        }
        rowCells.push(m[2]);
        if (rowCells.length === 7) {
          const [cPerNum, cTime, cTeam, cType, cAdv, cPlayer, cExtra] = rowCells.map(stripTags);
          const time = cTime;
          const teamName = cTeam;
          const isHomeTeam = normalizeText(teamName) === normalizeText(homeTeamName);
          const side = isHomeTeam ? 'home' : 'away';
          const isCorona = isCoronaName(teamName);
          const period = currentPeriod || (cPerNum ? `Repriza ${cPerNum}` : '');

          if (/^goal\b/i.test(cType)) {
            const score = cType.match(/(\d+\s*:\s*\d+)/)?.[1]?.replace(/\s+/g, '') || null;
            const rawExtra = decodeHtmlEntities(rowCells[6].replace(/<br\s*\/?>/gi, '\n'));
            const assists = rawExtra
              .replace(/Assisted by:/i, '')
              .split('\n')
              .map((s) => stripTags(s))
              .filter(Boolean);
            const flags = cAdv && cAdv !== 'EQ' ? [cAdv] : [];
            events.push({
              id: `frhg-${slugify(gameUrl)}-g-${cPerNum}-${time}-${slugify(cPlayer)}`,
              type: 'goal',
              period,
              time,
              team: side,
              teamName,
              isCorona,
              player: cPlayer || 'Marcator necunoscut',
              assists,
              score,
              flags,
              label: `Gol ${score || ''}`.trim()
            });
          } else if (/penalty/i.test(cType)) {
            const minsMatch = cAdv.match(/(\d+)/);
            const mins = minsMatch ? Number(minsMatch[1]) : 2;
            events.push({
              id: `frhg-${slugify(gameUrl)}-p-${cPerNum}-${time}-${slugify(cPlayer)}-${events.length}`,
              type: 'penalty',
              period,
              time,
              team: side,
              teamName,
              isCorona,
              player: cPlayer || 'Echipă',
              minutes: mins,
              cause: cExtra || cType.replace(/^.*Penalty\s*-\s*/i, ''),
              isMajor: mins >= 5,
              label: `Eliminare ${mins} min${cExtra ? ` (${cExtra})` : ''}`
            });
          } else if (/goalkeeper/i.test(cType)) {
            events.push({
              id: `frhg-${slugify(gameUrl)}-gk-${cPerNum}-${time}-${events.length}`,
              type: 'goalie',
              period,
              time,
              team: side,
              teamName,
              isCorona,
              player: cPlayer,
              label: /out/i.test(cType) ? 'Portar scos' : 'Schimbare portar'
            });
          }
          rowCells = [];
        }
      }
      // Ordonăm cronologic (pe icehockey.ro sunt afișate invers, de la R3 la R1)
      events.reverse();
    }
  }

  return {
    homeScore,
    awayScore,
    periodScores,
    statusRaw,
    isLive,
    isOvertime: Boolean(periodScores?.ot),
    isShootout: Boolean(periodScores?.so),
    stats:
      sogHome !== null || pimHome !== null
        ? { sogHome, sogAway, sogByPeriod, pimHome, pimAway, ppHome: null, ppAway: null, attendance: null }
        : null,
    events,
    links: {
      gameCenter: gameUrl,
      video: ytMatch,
      reportPdf: sheetPdf,
      lineupPdf
    }
  };
}

async function scrapeIceHockeyRo(existingMatchesMap) {
  console.log('🔍 Verificare FRHG (icehockey.ro)...');
  const result = { ok: false, found: 0, live: false, error: null, matches: [] };
  const todayRo = bucharestParts().date;

  try {
    const allParsed = [];
    for (const src of FRHG_TEAM_SOURCES) {
      const res = await fetchWithTimeout(src.url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) continue;
      result.ok = true;
      const html = await res.text();

      // 1. Verificăm tabelul #gamesTableTeam
      const tblStart = html.indexOf('id="gamesTableTeam"');
      if (tblStart >= 0) {
        const tblEnd = html.indexOf('</table>', tblStart);
        const tbl = html.slice(tblStart, tblEnd);
        const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
        for (const row of rows) {
          const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
          if (cells.length < 9) continue;
          const gameNo = stripTags(cells[0]);
          const date = parseIceHockeyRoDate(stripTags(cells[1]));
          if (!date) continue;
          const time = stripTags(cells[2]).match(/\d{2}:\d{2}/)?.[0] || null;
          const location = stripTags(cells[3]);
          const homeTeam = stripTags(cells[4]);
          const awayTeam = stripTags(cells[5]);
          const scorePair = parseScorePair(stripTags(cells[6]));
          const phase = stripTags(cells[7]);
          const gameUrl = cells[8].match(/https:\/\/icehockey\.ro\/game\/\d+\/event\/\d+\/season\/\d+/i)?.[0] || null;

          allParsed.push({
            gameNo,
            date,
            time,
            location,
            homeTeam,
            awayTeam,
            scorePair,
            phase,
            gameUrl,
            competition: src.competition
          });
        }
      }

      // 2. Verificăm slider-ul de sus pentru meciuri live/azi ale Coronei care nu au intrat încă în tabel
      const sliderMatches = html.matchAll(
        /<div class="game-slider-item[^"]*"[^>]*data-game-date="([^"]+)"([\s\S]*?)<div class="game-slider-footer">/gi
      );
      for (const sm of sliderMatches) {
        const dtStr = sm[1];
        const block = sm[2];
        const date = dtStr.slice(0, 10);
        const time = dtStr.slice(11, 16);
        const teams = [...block.matchAll(/<div class="game-team-name">[\s\S]*?<span>([\s\S]*?)<\/span>/gi)].map((t) =>
          stripTags(t[1])
        );
        if (teams.length < 2 || (!isCoronaName(teams[0]) && !isCoronaName(teams[1]))) continue;
        if (allParsed.some((p) => p.date === date && normalizeText(p.homeTeam) === normalizeText(teams[0]))) continue;
        const gameNo = stripTags(block.match(/<span class="game-no">([\s\S]*?)<\/span>/i)?.[1] || '');
        const scores = [...block.matchAll(/<span class="game-score">([\s\S]*?)<\/span>/gi)].map((s) =>
          Number(stripTags(s[1]))
        );
        const scorePair = scores.length === 2 && !Number.isNaN(scores[0]) && !Number.isNaN(scores[1]) ? scores : null;
        const gameUrl =
          block.match(/https:\/\/icehockey\.ro\/game\/\d+\/event\/\d+\/season\/\d+/i)?.[0] || null;
        allParsed.push({
          gameNo,
          date,
          time,
          location: isCoronaName(teams[0]) ? 'Patinoarul Olimpic Brașov' : teams[0],
          homeTeam: teams[0],
          awayTeam: teams[1],
          scorePair,
          phase: '',
          gameUrl,
          competition: src.competition
        });
      }
    }

    // Fetch detalii Game Center doar pentru meciuri live, de azi sau ultimele finalizate fără cache
    const pastSorted = allParsed
      .filter((m) => m.scorePair && m.gameUrl)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_DETAILED_PAST_MATCHES);
    const detailUrls = new Set([
      ...allParsed.filter((m) => m.gameUrl && m.date === todayRo).map((m) => m.gameUrl),
      ...pastSorted.map((m) => m.gameUrl)
    ]);

    result.matches = await mapWithConcurrency(allParsed, 5, async (m) => {
      const gameIdMatch = m.gameUrl?.match(/\/game\/(\d+)\//);
      const id = gameIdMatch ? `frhg-${gameIdMatch[1]}` : `frhg-${m.date}-${slugify(m.homeTeam)}-${slugify(m.awayTeam)}`;
      const isHome = isCoronaName(m.homeTeam);
      const opponent = isHome ? m.awayTeam : m.homeTeam;
      const prev = existingMatchesMap.get(id);

      let homeScore = m.scorePair ? m.scorePair[0] : null;
      let awayScore = m.scorePair ? m.scorePair[1] : null;
      let matchState = m.scorePair ? 'finished' : 'scheduled';
      let periodScores = prev?.periodScores || null;
      let stats = prev?.stats || null;
      let events = prev?.events || [];
      let liveInfo = null;
      let isOvertime = Boolean(prev?.isOvertime);
      let isShootout = Boolean(prev?.isShootout);
      let links = prev?.links || { gameCenter: m.gameUrl || null, video: null, reportPdf: null, lineupPdf: null };
      let detailsLoaded = Boolean(prev?.detailsLoaded);

      const canUseCache =
        matchState === 'finished' &&
        prev &&
        prev.detailsLoaded &&
        prev.homeScore === homeScore &&
        prev.awayScore === awayScore &&
        m.date !== todayRo;

      if (m.gameUrl && detailUrls.has(m.gameUrl) && !canUseCache) {
        try {
          const gRes = await fetchWithTimeout(m.gameUrl, { headers: { 'User-Agent': USER_AGENT } });
          if (gRes.ok) {
            const gHtml = await gRes.text();
            const parsed = parseIceHockeyRoGamePage(gHtml, m.gameUrl, m.homeTeam);
            if (parsed.homeScore !== null) homeScore = parsed.homeScore;
            if (parsed.awayScore !== null) awayScore = parsed.awayScore;
            periodScores = parsed.periodScores || periodScores;
            stats = parsed.stats || stats;
            events = parsed.events.length ? parsed.events : events;
            isOvertime = parsed.isOvertime;
            isShootout = parsed.isShootout;
            links = parsed.links;
            if (parsed.isLive) {
              matchState = 'live';
              result.live = true;
              const lastEv = events[events.length - 1];
              liveInfo = {
                periodLabel: lastEv?.period || parsed.statusRaw || 'Live',
                clock: lastEv?.time || '',
                statusText: parsed.statusRaw || 'În desfășurare'
              };
            } else if (/completed|final/i.test(parsed.statusRaw) || homeScore !== null) {
              matchState = 'finished';
            }
            detailsLoaded = true;
          }
        } catch (err) {
          console.warn(`⚠️ Detalii FRHG (${m.gameUrl}): ${err.message}`);
        }
      }

      return {
        id,
        gameNo: m.gameNo || null,
        title: `${m.homeTeam} – ${m.awayTeam}`,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        opponent,
        isHome,
        competition: m.competition,
        date: m.date,
        time: m.time,
        location: m.location || (isHome ? 'Patinoarul Olimpic Brașov' : opponent),
        startingPrice: null,
        status: matchState === 'live' ? 'LIVE' : matchState === 'finished' ? 'Finalizat' : isHome ? 'Programat' : 'Deplasare',
        matchState,
        homeScore,
        awayScore,
        periodScores,
        isOvertime,
        isShootout,
        liveInfo,
        stats,
        events,
        links,
        detailsLoaded,
        ticketUrl: EVENTIM_URL,
        ticketUrlIsDirect: false,
        source: 'icehockey.ro'
      };
    });
    result.found = result.matches.length;
    console.log(`   ↳ FRHG (icehockey.ro): ${result.matches.length} meciuri CN + Cupă.`);
  } catch (err) {
    result.error = err.message;
    console.warn(`⚠️ icehockey.ro: ${err.message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3. coronabrasov.ro — Știri bilete + fallback program TablePress
// ---------------------------------------------------------------------------

function parseCoronaScheduleHtml(html) {
  const matches = [];
  const tableRegex = /<table[^>]*id=["']tablepress-([^"']+)["'][^>]*>([\s\S]*?)<\/table>/gi;
  let tm;

  while ((tm = tableRegex.exec(html)) !== null) {
    const tableId = tm[1];
    const tableHtml = tm[2];
    const headerRow = tableHtml.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || '';
    if (!normalizeText(headerRow).includes('gazde') && !normalizeText(headerRow).includes('meci')) continue;

    // 26270706 = Campionatul National, 26270703 = Erste Liga
    const defaultComp = tableId.includes('706') ? 'Campionatul Național' : 'Erste Liga';
    const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];

    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1]));
      if (cells.length < 4) continue;
      const [gameNo, dateRaw, homeTeam, awayTeam] = cells;
      const dm = dateRaw.match(/\b(\d{1,2})\.(\d{1,2})\.(202\d)\b/);
      if (!dm) continue;
      if (!isCoronaName(homeTeam) && !isCoronaName(awayTeam)) continue;

      const date = `${dm[3]}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
      const isHome = isCoronaName(homeTeam);
      const opponent = isHome ? awayTeam : homeTeam;
      const id = `corona-${date}-${slugify(opponent)}`;

      if (!matches.some((m) => m.id === id)) {
        matches.push({
          id,
          gameNo: gameNo || null,
          title: `${homeTeam} – ${awayTeam}`,
          homeTeam,
          awayTeam,
          opponent,
          isHome,
          competition: defaultComp,
          date,
          time: null,
          location: isHome ? 'Patinoarul Olimpic Brașov' : `Deplasare (${opponent})`,
          startingPrice: null,
          status: isHome ? 'Programat' : 'Deplasare',
          matchState: 'scheduled',
          homeScore: null,
          awayScore: null,
          periodScores: null,
          isOvertime: false,
          isShootout: false,
          liveInfo: null,
          stats: null,
          events: [],
          links: null,
          detailsLoaded: false,
          ticketUrl: EVENTIM_URL,
          ticketUrlIsDirect: false,
          source: 'coronabrasov.ro'
        });
      }
    }
  }
  return matches;
}

async function scrapeCoronaSite() {
  console.log(`🔍 Verificare site oficial: ${CORONA_SITE_URL}`);
  const news = [];
  let scheduleMatches = [];
  let ok = false;
  let error = null;

  try {
    const resNews = await fetchWithTimeout(CORONA_SITE_URL, {
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
      const title = stripTags(m[2]);
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
    const resSched = await fetchWithTimeout(CORONA_HOCKEY_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9'
      }
    });
    if (resSched.ok) {
      const schedHtml = await resSched.text();
      scheduleMatches = parseCoronaScheduleHtml(schedHtml);
      console.log(`   ↳ Meciuri extrase din programul coronabrasov.ro: ${scheduleMatches.length}`);
    }
  } catch (err) {
    console.warn(`⚠️ coronabrasov.ro program hochei: ${err.message}`);
  }

  console.log(`   ↳ Articole relevante găsite pe coronabrasov.ro: ${news.length}`);
  return { ok, error, news: news.slice(0, MAX_NEWS), scheduleMatches };
}

// ---------------------------------------------------------------------------
// Unificare meciuri din toate sursele (fără dubluri EL+CN)
// ---------------------------------------------------------------------------

function teamMatchKey(name = '') {
  const n = normalizeText(name)
    .replace(/sport club|acs|csm|hc|sc|club/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.includes('csikszereda') || n.includes('miercurea ciuc')) return 'csikszereda';
  if (n.includes('gyergyoi') || n.includes('gheorgheni')) return 'gheorgheni';
  if (n.includes('haromszeki') || n.includes('fenestela')) return 'fenestela';
  if (n.includes('ftc') || n.includes('ferencvaros')) return 'ftc';
  if (n.includes('ute') || n.includes('ujpest')) return 'ute';
  if (n.includes('bja') || n.includes('jegkorong akademia')) return 'bja';
  if (n.includes('dunaujvaros') || n.includes('dab')) return 'dab';
  if (n.includes('dvtk')) return 'dvtk';
  if (n.includes('feha')) return 'feha19';
  if (n.includes('deac')) return 'deac';
  if (n.includes('ute')) return 'ute';
  if (n.includes('galati')) return 'galati';
  if (n.includes('steaua')) return 'steaua';
  if (n.includes('sapientia')) return 'sapientia';
  if (n.includes('sportul')) return 'sportul';
  return slugify(n);
}

function mergeMatchLists(ersteMatches, frhgMatches, coronaMatches, existingMatchesMap, nowIso) {
  const merged = [];
  const bySignature = new Map();

  function addOrMerge(m) {
    const sig = `${m.date}|${teamMatchKey(m.opponent)}`;
    const existingIdx = bySignature.get(sig);
    const prevSaved = existingMatchesMap.get(m.id);
    const firstSeen = prevSaved?.firstSeen || nowIso;

    if (existingIdx === undefined) {
      bySignature.set(sig, merged.length);
      merged.push({ ...m, firstSeen });
      return;
    }

    const cur = merged[existingIdx];
    // Dacă avem deja meciul din Erste Liga și vine același meci din CN (meci dublu EL+CN), păstrăm datele bogate EL și notăm competiția dublă
    if (cur.source === 'ersteliga.hu' && m.competition === 'Campionatul Național') {
      cur.alsoCountsFor = 'Campionatul Național';
      if (!cur.links?.reportPdf && m.links?.reportPdf) cur.links.reportPdf = m.links.reportPdf;
      return;
    }
    // Dacă coronabrasov.ro are un meci deja găsit în Erste Liga / FRHG, păstrăm sursa cu scor/statistici
    if (m.source === 'coronabrasov.ro') {
      return;
    }
    // Altfel, dacă sursa nouă are scor/detalii mai bune decât cea curentă, actualizăm
    if (m.matchState !== 'scheduled' && cur.matchState === 'scheduled') {
      merged[existingIdx] = { ...m, firstSeen: cur.firstSeen };
    }
  }

  for (const m of ersteMatches) addOrMerge(m);
  for (const m of frhgMatches) addOrMerge(m);
  for (const m of coronaMatches) addOrMerge(m);

  return merged;
}

// ---------------------------------------------------------------------------
// Detectare goluri & evenimente importante pentru notificări
// ---------------------------------------------------------------------------

function collectMatchNotifications(matches, liveState) {
  const notifications = [];
  const seenSet = new Set(liveState.seenEventIds || []);
  const phaseStates = { ...(liveState.matchPhaseStates || {}) };
  const isSeeded = Boolean(liveState.seeded);

  for (const m of matches) {
    const scoreStr = m.homeScore !== null && m.awayScore !== null ? `${m.homeScore}:${m.awayScore}` : null;
    const prevPhase = phaseStates[m.id] || null;
    const currentPhase = `${m.matchState}${scoreStr ? `:${scoreStr}` : ''}`;

    const prevState = prevPhase ? prevPhase.split(':')[0] : null;
    // 1. Notificări pentru tranziții de fază (Start meci, Final meci)
    if (isSeeded && prevPhase && prevPhase !== currentPhase) {
      if (m.matchState === 'live' && prevState === 'scheduled') {
        notifications.push({
          title: `A INCEPUT MECIUL! ${m.homeTeam} vs ${m.awayTeam}`,
          message: `🏆 ${m.competition}${m.location ? ` • 📍 ${m.location}` : ''}\nUrmărește scorul live și evenimentele în Corona Ice Tracker.`,
          url: m.links?.video || m.links?.gameCenter || CORONA_SITE_URL,
          urgent: false,
          tags: 'ice_hockey,loudspeaker',
          actionLabel: m.links?.video ? 'Urmărește Video' : 'Vezi Meciul Live'
        });
      } else if (m.matchState === 'finished' && prevState === 'live') {
        const coronaGoals = m.isHome ? m.homeScore : m.awayScore;
        const oppGoals = m.isHome ? m.awayScore : m.homeScore;
        const won = coronaGoals > oppGoals;
        const otTag = m.isShootout ? ' (SO)' : m.isOvertime ? ' (OT)' : '';
        const ps = m.periodScores
          ? [m.periodScores.p1, m.periodScores.p2, m.periodScores.p3, m.periodScores.ot, m.periodScores.so]
              .filter(Boolean)
              .join(', ')
          : '';
        const sogLine = m.stats?.sogHome != null ? `\n🎯 Șuturi pe poartă: ${m.stats.sogHome}:${m.stats.sogAway}` : '';
        notifications.push({
          title: `FINAL${otTag}: ${m.homeTeam} ${m.homeScore} - ${m.awayScore} ${m.awayTeam}`,
          message: `${won ? '🏆 VICTORIE CORONA BRAȘOV!' : '📊 Meci încheiat.'}${ps ? `\nPe reprize: (${ps})` : ''}${sogLine}`,
          url: m.links?.gameCenter || CORONA_SITE_URL,
          urgent: true,
          tags: won ? 'trophy,ice_hockey' : 'checkered_flag,ice_hockey',
          actionLabel: 'Vezi Sumarul Meciului'
        });
      }
    }
    phaseStates[m.id] = currentPhase;

    // 2. Notificări pentru evenimente din meciuri ACTIVE (sau nou finalizate recent)
    for (const ev of m.events || []) {
      if (seenSet.has(ev.id)) continue;
      seenSet.add(ev.id);

      // Nu trimitem notificări pentru meciuri vechi sau la prima populare (seed)
      const justFinishedFromLive = m.matchState === 'finished' && prevState === 'live';
      if (!isSeeded || (m.matchState !== 'live' && !justFinishedFromLive)) continue;

      if (ev.type === 'goal') {
        const coronaScored = ev.isCorona;
        const assistsStr = ev.assists?.length ? ` (pasă: ${ev.assists.join(', ')})` : '';
        const flagsStr = ev.flags?.length ? ` [${ev.flags.join(', ')}]` : '';
        notifications.push({
          title: coronaScored
            ? `GOOOL CORONA! ${m.homeShort || m.homeTeam} ${ev.score || scoreStr || ''} ${m.awayShort || m.awayTeam}`
            : `Gol ${ev.teamName || 'adversar'}: ${ev.score || scoreStr || ''}`,
          message: `🚨 ${ev.player}${assistsStr}${flagsStr}\n⏱️ ${ev.time} • ${ev.period} • ${m.competition}`,
          url: m.links?.video || m.links?.gameCenter || CORONA_SITE_URL,
          urgent: true,
          tags: coronaScored ? 'rotating_light,goal_net,ice_hockey' : 'ice_hockey',
          actionLabel: 'Vezi Scor Live'
        });
      } else if (ev.type === 'penalty' && ev.isMajor) {
        notifications.push({
          title: `ELIMINARE MAJORA (${ev.minutes} min) - ${ev.teamName || ''}`,
          message: `🟥 ${ev.player} (${ev.cause || 'penalitate majoră'}) la ${ev.time} (${ev.period})`,
          url: m.links?.gameCenter || CORONA_SITE_URL,
          urgent: true,
          tags: 'warning,ice_hockey',
          actionLabel: 'Detalii Meci'
        });
      } else if (ev.type === 'period' && m.matchState === 'live') {
        notifications.push({
          title: `${ev.period} • ${m.homeTeam} ${m.homeScore ?? 0} - ${m.awayScore ?? 0} ${m.awayTeam}`,
          message: `⏱️ ${ev.label} • ${m.competition}`,
          url: m.links?.gameCenter || CORONA_SITE_URL,
          urgent: false,
          tags: 'stopwatch,ice_hockey',
          actionLabel: 'Scor Live'
        });
      } else if (ev.type === 'goalie' && /scos|out/i.test(ev.label || '') && m.matchState === 'live') {
        notifications.push({
          title: `PORTAR SCOS (6-la-5)! ${m.homeTeam} ${m.homeScore ?? 0} - ${m.awayScore ?? 0} ${m.awayTeam}`,
          message: `🥅 ${ev.teamName || ''} a scos portarul la ${ev.time} (${ev.period})!`,
          url: m.links?.gameCenter || CORONA_SITE_URL,
          urgent: true,
          tags: 'exclamation,ice_hockey',
          actionLabel: 'Scor Live'
        });
      }
    }
  }

  return {
    notifications,
    liveState: {
      seeded: true,
      seenEventIds: Array.from(seenSet).slice(-MAX_SEEN_EVENT_IDS),
      matchPhaseStates: phaseStates
    }
  };
}

// ---------------------------------------------------------------------------
// Ciclul unic de verificare
// ---------------------------------------------------------------------------

async function runSingleCheck({ isManual = false, isWatchTick = false, noNotify = false } = {}) {
  const now = bucharestParts();
  const existing = loadExistingData();
  const isFirstRun = !existing.lastChecked;
  const nowIso = new Date().toISOString();

  const existingMatchesMap = new Map((existing.matches || []).map((m) => [m.id, m]));

  const coronaPromise = isWatchTick
    ? Promise.resolve({
        ok: existing.sources?.coronabrasov?.ok ?? true,
        error: existing.sources?.coronabrasov?.error || null,
        news: [],
        scheduleMatches: []
      })
    : scrapeCoronaSite();

  const [corona, erste, frhg] = await Promise.all([
    coronaPromise,
    scrapeErsteLiga(existingMatchesMap),
    scrapeIceHockeyRo(existingMatchesMap)
  ]);

  let matches = mergeMatchLists(erste.matches, frhg.matches, corona.scheduleMatches, existingMatchesMap, nowIso);
  matches = matches.filter((m) => daysBetween(now.date, m.date) <= KEEP_PAST_MATCH_DAYS);
  matches.sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));

  // Păstrăm detalii/evenimente doar pentru meciul live + cele mai recente MAX_DETAILED_PAST_MATCHES meciuri
  const recentFinishedIds = new Set(
    matches
      .filter((m) => m.matchState === 'finished')
      .slice(-MAX_DETAILED_PAST_MATCHES)
      .map((m) => m.id)
  );
  matches = matches.map((m) =>
    m.matchState === 'live' || recentFinishedIds.has(m.id) ? m : { ...m, events: [], stats: null }
  );

  const activeMatch = matches.find((m) => m.matchState === 'live') || null;

  // Știri & alerte bilete
  const notifications = [];
  let news = (existing.news || []).filter((n) => n.source === 'coronabrasov.ro');
  const isFirstNewsRun = news.length === 0;
  let newsChanged = false;

  for (const item of corona.news) {
    if (news.some((n) => n.id === item.id || n.url === item.url)) continue;
    news.unshift({ ...item, firstSeen: nowIso });
    newsChanged = true;
    if (item.isTicketAlert && !isFirstNewsRun) {
      notifications.push({
        title: 'BILETE CORONA BRASOV - Anunt Nou!',
        message: `${item.title}\n\nApasă pentru a intra direct pe Eventim.`,
        url: EVENTIM_URL,
        urgent: true,
        tags: 'rotating_light,ice_hockey,ticket',
        actionLabel: 'Cumpara Bilete Eventim'
      });
    }
  }
  news = news.slice(0, MAX_NEWS);

  // Evenimente meciuri (goluri, start, final, eliminări majore)
  const prevLiveState = existing.liveState || { seeded: false, seenEventIds: [], matchPhaseStates: {} };
  const { notifications: matchAlerts, liveState } = collectMatchNotifications(matches, prevLiveState);
  notifications.push(...matchAlerts);

  const prevComparable = JSON.stringify({
    matches: existing.matches || [],
    news: existing.news || [],
    activeMatchId: existing.activeMatch?.id || null
  });
  const nextComparable = JSON.stringify({
    matches,
    news,
    activeMatchId: activeMatch?.id || null
  });

  const changed = prevComparable !== nextComparable || newsChanged || !prevLiveState.seeded;
  const minutesSinceCheck = existing.lastChecked
    ? (Date.now() - new Date(existing.lastChecked).getTime()) / 60000
    : Infinity;
  const heartbeatDue = !isWatchTick && minutesSinceCheck >= HEARTBEAT_MINUTES;
  const statusChanged =
    existing.sources?.coronabrasov?.ok !== corona.ok ||
    existing.sources?.ersteliga?.ok !== erste.ok ||
    existing.sources?.icehockeyro?.ok !== frhg.ok;

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
        },
        ersteliga: {
          url: 'https://www.ersteliga.hu',
          ok: erste.ok,
          found: erste.found,
          live: erste.live,
          error: erste.error || null
        },
        icehockeyro: {
          url: FRHG_TEAM_SOURCES[0].url,
          ok: frhg.ok,
          found: frhg.found,
          live: frhg.live,
          error: frhg.error || null
        }
      },
      liveState,
      activeMatch,
      matches,
      news
    };
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload), 'utf8');
    console.log(
      `💾 data/matches.json salvat (${matches.length} meciuri, ${news.length} știri${activeMatch ? `, LIVE: ${activeMatch.title}` : ''}).`
    );
  } else {
    console.log('✅ Nicio modificare nouă.');
  }

  if (!noNotify) {
    for (const n of notifications) {
      await sendPushNotification(n);
    }
  } else if (notifications.length) {
    console.log(`🔕 --no-notify activ: ${notifications.length} notificări sărite la re-sincronizare.`);
  }

  if (!corona.ok && !erste.ok && !frhg.ok) {
    process.exitCode = 1;
  }

  return { activeMatch, matches, changed, notificationsSent: notifications.length };
}

// ---------------------------------------------------------------------------
// Entrypoint & Mod Watch Live
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMonitor() {
  const args = process.argv.slice(2);

  if (args.includes('--test-notify')) {
    await sendPushNotification({
      title: 'Test Corona Ice Tracker',
      message: 'Alertele pentru bilete, goluri și rezumate CSM Corona Brașov funcționează!',
      url: EVENTIM_URL,
      urgent: true,
      tags: 'ice_hockey,rotating_light,ticket',
      actionLabel: 'Deschide Eventim'
    });
    return;
  }

  const now = bucharestParts();
  const isScheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  const isWatch = args.includes('--watch');
  const isWatchTick = args.includes('--watch-tick');
  const noNotify = args.includes('--no-notify');
  const isManual = (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || args.includes('--force')) && !isWatchTick;

  if (isScheduled && !isManual && !isWatch && !isWatchTick && (now.hour < ACTIVE_HOUR_START || now.hour >= ACTIVE_HOUR_END)) {
    console.log(`🌙 Ora ${now.hour}:xx în România — în afara intervalului 08:00–23:00. Nu rulez.`);
    return;
  }

  if (!isWatch) {
    await runSingleCheck({ isManual, isWatchTick, noNotify });
    return;
  }

  // Mod Watch Live (--watch): verifică continuu la 25s pentru goluri în timp real
  const intervalArg = args.find((a) => a.startsWith('--interval='));
  const maxMinArg = args.find((a) => a.startsWith('--max-minutes='));
  const intervalSec = Math.max(15, Number(intervalArg?.split('=')[1] || 25));
  const maxMinutes = Math.max(5, Number(maxMinArg?.split('=')[1] || 180));
  const deadline = Date.now() + maxMinutes * 60 * 1000;

  console.log(`🔴 Mod LIVE WATCH pornit (interval: ${intervalSec}s, maxim ${maxMinutes} min).`);
  let sawActiveMatch = false;

  while (Date.now() < deadline) {
    const res = await runSingleCheck({ isManual: false, isWatchTick: true });
    if (res.activeMatch) {
      sawActiveMatch = true;
      console.log(
        `   🔴 LIVE: ${res.activeMatch.homeTeam} ${res.activeMatch.homeScore ?? 0}:${res.activeMatch.awayScore ?? 0} ${res.activeMatch.awayTeam}`
      );
    } else if (sawActiveMatch) {
      console.log('🏁 Meciul activ s-a încheiat. Opresc modul Live Watch.');
      break;
    } else {
      const todayRo = bucharestParts().date;
      const hasMatchToday = res.matches.some((m) => m.date === todayRo && m.matchState === 'scheduled');
      if (!hasMatchToday) {
        console.log('ℹ️ Nu există niciun meci programat azi. Opresc modul Live Watch.');
        break;
      }
      console.log('⏳ Meci programat azi, aștept începerea...');
    }
    await sleep(intervalSec * 1000);
  }
}

runMonitor().catch((err) => {
  console.error('❌ Eroare neprevăzută:', err);
  process.exitCode = 1;
});
