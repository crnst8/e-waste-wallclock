import express from 'express';
import { XMLParser } from 'fast-xml-parser';
import 'dotenv/config';

const PORT = Number(process.env.PORT) || 3000;
const UA = 'iPadDashboard/1.0 (local; contact=dashboard@localhost)';


// ---------------- WEATHER  ---------------- //

// BoM Config, change city via URLs from https://www.bom.gov.au/catalogue/data-feeds.shtml
const BOM_OBS_URL = 'http://www.bom.gov.au/fwo/IDV60901/IDV60901.95936.json';
const BOM_FORECAST_URL = 'http://www.bom.gov.au/fwo/IDV10450.xml';
const MELBOURNE_AAC = 'VIC_PT042';

const WEATHER_TTL_MS = 10 * 60 * 1000;
const TODOS_TTL_MS = 60 * 1000;
const CALENDAR_TTL_MS = 60 * 1000;
const DATES_TTL_MS = 60 * 1000;

const cache = {
  weather: { data: null, fetchedAt: 0, inflight: null },
  todos: { data: null, fetchedAt: 0, inflight: null },
  calendar: { data: null, fetchedAt: 0, inflight: null },
  dates: { data: null, fetchedAt: 0, inflight: null },
};

async function fetchBomObs() {
  const res = await fetch(BOM_OBS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`BoM obs ${res.status}`);
  const json = await res.json();
  const latest = json?.observations?.data?.[0];
  if (!latest) throw new Error('BoM obs empty');
  return {
    tempC: latest.air_temp,
    condition: (latest.weather && latest.weather !== '-') ? String(latest.weather).toLowerCase() : 'clear',
    rainMm: Number(latest.rain_trace) || 0,
  };
}


// You can change 'Melbourne' here but wont effect the functionality 
async function fetchBomForecast() {
  const res = await fetch(BOM_FORECAST_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`BoM forecast ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);
  const areas = doc?.product?.forecast?.area;
  const list = Array.isArray(areas) ? areas : [areas];
  const melbourne = list.find(a => a?.['@_aac'] === MELBOURNE_AAC)
    || list.find(a => String(a?.['@_description'] || '').toLowerCase() === 'melbourne');
  if (!melbourne) throw new Error('Melbourne area not found in forecast');
  const periods = Array.isArray(melbourne['forecast-period']) ? melbourne['forecast-period'] : [melbourne['forecast-period']];
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const tomorrowPeriod = periods.find(p => String(p?.['@_start-time-local'] || '').startsWith(tomorrow)) || periods[1];
  if (!tomorrowPeriod) throw new Error('No tomorrow period');

  const todayStr = today.toISOString().slice(0, 10);
  const todayPeriod = periods.find(p => String(p?.['@_start-time-local'] || '').startsWith(todayStr)) || periods[0];
  const todayEls = Array.isArray(todayPeriod?.element) ? todayPeriod.element : [todayPeriod?.element].filter(Boolean);
  const highC = Number(todayEls.find(e => e?.['@_type'] === 'air_temperature_maximum')?.['#text']) || null;

  const elements = Array.isArray(tomorrowPeriod.element) ? tomorrowPeriod.element : [tomorrowPeriod.element];
  const texts = Array.isArray(tomorrowPeriod.text) ? tomorrowPeriod.text : [tomorrowPeriod.text];
  const findEl = t => elements.find(e => e?.['@_type'] === t)?.['#text'];
  const findText = t => texts.find(e => e?.['@_type'] === t)?.['#text'];

  const tempC = Number(findEl('air_temperature_maximum'));
  const precis = findText('precis') || '';
  const pop = findText('probability_of_precipitation') || '';
  const summary = [precis.toLowerCase(), pop && `${pop} rain`].filter(Boolean).join(' / ');
  return { highC, tempC, summary };
}

async function loadWeather() {
  const [obs, forecast] = await Promise.allSettled([fetchBomObs(), fetchBomForecast()]);
  if (obs.status !== 'fulfilled') throw obs.reason;
  const out = { ...obs.value, highC: null, tomorrow: null };
  if (forecast.status === 'fulfilled') {
    const { highC, ...tomorrowData } = forecast.value;
    out.highC = highC || null;
    out.tomorrow = tomorrowData;
  }
  return out;
}

async function getWeather() {
  const now = Date.now();
  if (cache.weather.data && now - cache.weather.fetchedAt < WEATHER_TTL_MS) return cache.weather.data;
  if (cache.weather.inflight) return cache.weather.inflight;
  cache.weather.inflight = (async () => {
    try {
      const data = await loadWeather();
      cache.weather.data = data;
      cache.weather.fetchedAt = Date.now();
      return data;
    } finally {
      cache.weather.inflight = null;
    }
  })();
  try {
    return await cache.weather.inflight;
  } catch (err) {
    if (cache.weather.data) return cache.weather.data;
    throw err;
  }
}



// ---------------- NOTION  To-Do DB ---------------- //



// Query all pages in the task Notion database and return raw page objects.
async function queryNotionPages({ pageSize = 100 } = {}) {
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!dbId) throw new Error('Missing NOTION_DATABASE_ID');
  return queryNotionDatabasePages(dbId, { pageSize });
}

async function loadTodos() {
  const allPages = await queryNotionPages({ pageSize: 20 });

  const getPriority = page => {
    const props = page.properties || {};
    const p = Object.entries(props).find(([k]) => /priority/i.test(k))?.[1];
    return p?.type === 'select' && p.select?.name != null ? parseInt(p.select.name, 10) : 999;
  };

  allPages.sort((a, b) => getPriority(a) - getPriority(b));

  const items = allPages
    .map(page => {
      const props = page.properties || {};
      const titleProp = Object.values(props).find(p => p?.type === 'title');
      const title = (titleProp?.title || []).map(t => t.plain_text).join('').trim();
      const doneKey = Object.keys(props).find(k => props[k]?.type === 'checkbox' && /done|complete/i.test(k));
      const done = doneKey ? props[doneKey].checkbox === true : false;
      return { id: page.id, title, done };
    })
    .filter(i => i.title && !i.done)
    .slice(0, 5);
  return items;
}

async function getTodos() {
  const now = Date.now();
  if (cache.todos.data && now - cache.todos.fetchedAt < TODOS_TTL_MS) return cache.todos.data;
  if (cache.todos.inflight) return cache.todos.inflight;
  cache.todos.inflight = (async () => {
    try {
      const data = await loadTodos();
      cache.todos.data = data;
      cache.todos.fetchedAt = Date.now();
      return data;
    } finally {
      cache.todos.inflight = null;
    }
  })();
  try {
    return await cache.todos.inflight;
  } catch (err) {
    if (cache.todos.data) return cache.todos.data;
    throw err;
  }
}


// ---------------- NOTION ('Work')  ---------------- //
// Reads today's items from a separate Notion database configured as NOTION_WORK_ID
// This can be any database FYI, just named this for use case.
// The existing NOTION_DATABASE_ID remains reserved for tasks/todos.

function notionHeaders() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('Missing NOTION_TOKEN');
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2025-09-03',
    'Content-Type': 'application/json',
  };
}


function melbourneDateString(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function queryNotionDatabasePages(dbId, { pageSize = 100 } = {}) {
  if (!dbId) throw new Error('Missing Notion database ID');
  const headers = notionHeaders();

  const dbRes = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers });
  if (!dbRes.ok) {
    const body = await dbRes.text().catch(() => '');
    console.error('Notion DB error:', dbRes.status, body.slice(0, 500));
    throw new Error(`Notion ${dbRes.status} ${body.slice(0, 200)}`);
  }
  const dbJson = await dbRes.json();
  const dataSourceIds = (dbJson.data_sources || []).map(ds => ds.id);
  if (!dataSourceIds.length) throw new Error('No data sources found for database');

  const allPages = [];
  for (const dsId of dataSourceIds) {
    let cursor = null;
    do {
      const queryBody = { page_size: pageSize };
      if (cursor) queryBody.start_cursor = cursor;
      const res = await fetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify(queryBody),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('Notion data source error:', res.status, body.slice(0, 500));
        throw new Error(`Notion ${res.status} ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      allPages.push(...(json.results || []));
      cursor = json.has_more ? json.next_cursor : null;
    } while (cursor);
  }
  return allPages;
}

function notionPlainText(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.map(v => v.plain_text || '').join('').trim();
  return '';
}

function notionPageTitle(page) {
  const props = page.properties || {};
  const titleProp = Object.values(props).find(p => p?.type === 'title');
  return notionPlainText(titleProp?.title) || 'Untitled';
}

function firstNotionDate(page) {
  const props = page.properties || {};
  const preferred = Object.entries(props).find(([name, prop]) => prop?.type === 'date' && /date|day|when|time|calendar|start/i.test(name));
  const fallback = Object.entries(props).find(([, prop]) => prop?.type === 'date');
  const [, prop] = preferred || fallback || [];
  return prop?.date || null;
}

function isSameMelbourneDay(iso, targetDate) {
  if (!iso) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso === targetDate;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return melbourneDateString(new Date(ms)) === targetDate;
}

function dateOverlapsMelbourneDay(dateProp, targetDate) {
  if (!dateProp?.start) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateProp.start)) {
    const end = /^\d{4}-\d{2}-\d{2}$/.test(dateProp.end || '') ? dateProp.end : dateProp.start;
    return dateProp.start <= targetDate && targetDate <= end;
  }
  if (isSameMelbourneDay(dateProp.start, targetDate)) return true;
  if (dateProp.end && isSameMelbourneDay(dateProp.end, targetDate)) return true;
  return false;
}

function timeLabelFromNotion(iso) {
  if (!iso || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d).replace(/\s/g, '').toLowerCase();
}

async function loadCalendar() {
  const workDbId = process.env.NOTION_WORK_ID;
  if (!workDbId) throw new Error('Missing NOTION_WORK_ID');

  const today = melbourneDateString();
  const pages = await queryNotionDatabasePages(workDbId, { pageSize: 100 });
  const todaysPages = pages
    .map(page => ({ page, date: firstNotionDate(page) }))
    .filter(item => dateOverlapsMelbourneDay(item.date, today))
    .sort((a, b) => String(a.date?.start || '').localeCompare(String(b.date?.start || '')));

  const allDay = [];
  const events = [];
  for (const { page, date } of todaysPages) {
    const title = notionPageTitle(page);
    const start = timeLabelFromNotion(date.start);
    const end = timeLabelFromNotion(date.end);
    if (!start) {
      allDay.push(title);
    } else {
      events.push({ start, end, title });
    }
  }
  return { date: today, allDay, events };
}

async function getCalendar() {
  const now = Date.now();
  if (cache.calendar.data && now - cache.calendar.fetchedAt < CALENDAR_TTL_MS) return cache.calendar.data;
  if (cache.calendar.inflight) return cache.calendar.inflight;
  cache.calendar.inflight = (async () => {
    try {
      const data = await loadCalendar();
      cache.calendar.data = data;
      cache.calendar.fetchedAt = Date.now();
      return data;
    } finally {
      cache.calendar.inflight = null;
    }
  })();
  try {
    return await cache.calendar.inflight;
  } catch (err) {
    if (cache.calendar.data) return cache.calendar.data;
    throw err;
  }
}

// ---------------- NOTION Key Dates ---------------- //

function notionDateString(iso) {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : melbourneDateString(new Date(ms));
}

function calendarDayDifference(fromDate, toDate) {
  const toUtcDay = value => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtcDay(toDate) - toUtcDay(fromDate)) / (24 * 60 * 60 * 1000));
}

async function loadDates() {
  const datesDbId = process.env.NOTION_DATES_ID;
  if (!datesDbId) throw new Error('Missing NOTION_DATES_ID');

  const today = melbourneDateString();
  const pages = await queryNotionDatabasePages(datesDbId, { pageSize: 100 });

  return pages
    .map(page => {
      const date = notionDateString(firstNotionDate(page)?.start);
      const days = date ? calendarDayDifference(today, date) : null;
      return {
        id: page.id,
        title: notionPageTitle(page),
        date,
        days,
      };
    })
    .filter(item => item.title && item.date && item.days > 0)
    .sort((a, b) => a.days - b.days || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

async function getDates() {
  const now = Date.now();
  if (cache.dates.data && now - cache.dates.fetchedAt < DATES_TTL_MS) return cache.dates.data;
  if (cache.dates.inflight) return cache.dates.inflight;
  cache.dates.inflight = (async () => {
    try {
      const data = await loadDates();
      cache.dates.data = data;
      cache.dates.fetchedAt = Date.now();
      return data;
    } finally {
      cache.dates.inflight = null;
    }
  })();
  try {
    return await cache.dates.inflight;
  } catch (err) {
    if (cache.dates.data) return cache.dates.data;
    throw err;
  }
}

// ---- Slack reminders --------------------------------------------------------
// Reads the Notion DB for items with a `By` date and a `Freq` cadence, and posts
// "Reminder: <Name>" to Slack at the cadence's clock times once `By` has passed.
// Clock times are Melbourne wall-clock (same locale as the weather).

// Hours (Melbourne local, 24h) at which each frequency fires, on the hour.
const FREQ_HOURS = {
  'hourly': [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], // 8AM–11PM
  'once daily': [9],
  'twice daily': [9, 12],
  'markers': [9, 12, 16, 20, 22],
};

// Current Melbourne wall-clock parts, regardless of the server's own timezone.
function melbourneTimeParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24, // some engines emit "24" for midnight
    minute: Number(parts.minute),
  };
}

// Pull the reminder-relevant fields out of the same Notion DB the todos use.
async function fetchReminderItems() {
  const pages = await queryNotionPages({ pageSize: 100 });
  return pages
    .map(page => {
      const props = page.properties || {};
      const titleProp = Object.values(props).find(p => p?.type === 'title');
      const name = (titleProp?.title || []).map(t => t.plain_text).join('').trim();
      const byProp = Object.entries(props).find(([k, v]) => v?.type === 'date' && /^by$/i.test(k))?.[1];
      const by = byProp?.date?.start || null;
      const freqProp = Object.entries(props).find(([k, v]) => v?.type === 'select' && /^freq$/i.test(k))?.[1];
      const freq = freqProp?.select?.name || null;
      return { id: page.id, name, by, freq };
    })
    .filter(r => r.name && r.by && r.freq);
}

async function sendSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.error('Cannot send reminder: SLACK_WEBHOOK_URL not set');
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Slack send failed:', res.status, body.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Slack send error:', err.message || err);
    return false;
  }
}

// De-dupe within a process so a given item fires at most once per (date, hour).
const firedReminders = new Set();
let firedReminderDate = null;

async function reminderTick() {
  const { dateStr, hour, minute } = melbourneTimeParts();
  if (dateStr !== firedReminderDate) {
    firedReminders.clear();
    firedReminderDate = dateStr;
  }
  if (minute !== 0) return; // all cadences fire on the hour

  let items;
  try {
    items = await fetchReminderItems();
  } catch (err) {
    console.error('Reminder fetch failed:', err.message || err);
    return;
  }

  const nowMs = Date.now();
  for (const item of items) {
    const byMs = Date.parse(item.by);
    if (Number.isNaN(byMs) || nowMs < byMs) continue; // not due until `By` passes
    const hours = FREQ_HOURS[item.freq.trim().toLowerCase()];
    if (!hours || !hours.includes(hour)) continue;
    const key = `${item.id}|${dateStr}|${hour}`;
    if (firedReminders.has(key)) continue;
    firedReminders.add(key);
    await sendSlack(`Reminder: ${item.name}`);
  }
}

function startReminderScheduler() {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.warn('Reminders disabled: SLACK_WEBHOOK_URL not set');
    return;
  }
  // Align ticks to the top of each minute; reminderTick only acts on the hour.
  const scheduleNext = () => {
    const delay = 60000 - (Date.now() % 60000);
    setTimeout(async () => {
      try { await reminderTick(); } catch (err) { console.error('reminderTick error:', err); }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
  console.log('Slack reminder scheduler started');
}

// ---- Home Assistant --------------------------------------------------------
// Proxies light state/toggle to a local HA instance so the iPad never sees the
// token. `house` is the all-lights group; `upstairs` a subset.
const HA_IP = process.env.HA_IP;
const HA_TOKEN = process.env.ACCESS_TOKEN;
const HA_ENTITIES = {
  house: process.env.HOUSE_ENTITY_NAME,
  upstairs: process.env.UPSTAIRS_ENTITY_NAME,
};

async function haFetch(path, opts = {}) {
  if (!HA_IP || !HA_TOKEN) throw new Error('HA not configured');
  const res = await fetch(`${HA_IP}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(6000),
    headers: {
      Authorization: `Bearer ${HA_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HA ${res.status}`);
  return res;
}

async function haState(entityId) {
  const res = await haFetch(`/api/states/${entityId}`);
  const json = await res.json();
  return json.state; // "on" | "off" | "unavailable"
}

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/buttons', express.static('buttons'));

// Current on/off state of both light groups.
app.get('/api/ha/state', async (req, res) => {
  try {
    const entries = await Promise.all(
      Object.entries(HA_ENTITIES).map(async ([key, id]) => {
        if (!id) return [key, null];
        try { return [key, await haState(id)]; }
        catch { return [key, null]; }
      })
    );
    res.json(Object.fromEntries(entries));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Toggle one group; returns its resulting state.
app.post('/api/ha/toggle', async (req, res) => {
  const target = req.body?.target;
  const entityId = HA_ENTITIES[target];
  if (!entityId) return res.status(400).json({ error: 'unknown target' });
  try {
    await haFetch('/api/services/light/toggle', {
      method: 'POST',
      body: JSON.stringify({ entity_id: entityId }),
    });
    const state = await haState(entityId).catch(() => null);
    res.json({ target, state });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/weather', async (req, res) => {
  try {
    const data = await getWeather();
    res.json({ ...data, staleSince: cache.weather.fetchedAt });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/todos', async (req, res) => {
  try {
    const data = await getTodos();
    res.json({ items: data, staleSince: cache.todos.fetchedAt });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});


app.get('/api/calendar', async (req, res) => {
  try {
    const data = await getCalendar();
    res.json({ ...data, staleSince: cache.calendar.fetchedAt });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/dates', async (req, res) => {
  try {
    const data = await getDates();
    res.json({ items: data, staleSince: cache.dates.fetchedAt });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});


// Debug: see how reminder items are parsed and which would fire this hour.
app.get('/api/reminders', async (req, res) => {
  try {
    const { dateStr, hour, minute } = melbourneTimeParts();
    const items = await fetchReminderItems();
    const nowMs = Date.now();
    const out = items.map(item => {
      const byMs = Date.parse(item.by);
      const hours = FREQ_HOURS[item.freq.trim().toLowerCase()] || null;
      return {
        name: item.name,
        by: item.by,
        freq: item.freq,
        fireHours: hours,
        due: !Number.isNaN(byMs) && nowMs >= byMs,
        firesThisHour: !Number.isNaN(byMs) && nowMs >= byMs && !!hours && hours.includes(hour),
      };
    });
    res.json({ melbourne: { dateStr, hour, minute }, items: out });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Send a one-off test message to verify the Slack webhook.
app.post('/api/reminders/test', async (req, res) => {
  const ok = await sendSlack('Reminder: test');
  res.status(ok ? 200 : 502).json({ ok });
});

app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
  startReminderScheduler();
});
