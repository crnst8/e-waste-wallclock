(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const els = {
    temp: $('#temp'), wicon: $('#wicon'), cond: $('#cond'), rain: $('#rain'),
    tomorrow: $('#tomorrow'),
    time: $('#time'), ampm: $('#ampm'), clock: $('#clock'),
    todos: $('#todos'),
    warmth: $('#warmth'),
    houseBtn: $('#houseBtn'), upstairsBtn: $('#upstairsBtn'),
    alarmBtn: $('#alarmBtn'), timerBtn: $('#timerBtn'), calendarBtn: $('#calendarBtn'),
    alarmCap: $('#alarmCap'), timerCap: $('#timerCap'),
    timerModal: $('#timerModal'), alarmModal: $('#alarmModal'), calendarModal: $('#calendarModal'),
    timerOptions: $('#timerOptions'), calendarBody: $('#calendarBody'),
    hourWheel: $('#hourWheel'), minuteWheel: $('#minuteWheel'),
    ampmToggle: $('#ampmToggle'), alarmCommit: $('#alarmCommit'),
    firing: $('#firing'), firingText: $('#firingText'),
    audio: $('#alarmAudio'),
  };

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------- clock ----------
  function renderClock() {
    const d = new Date();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    els.time.textContent = `${h}:${m}`;
    els.ampm.textContent = ampm;
  }
  renderClock();
  setInterval(renderClock, 1000);

  // ---------- warm evening gradient ----------
  // 0 through the day; fades in 5PM→8PM, holds overnight, fades out 5AM→6AM.
  const WARMTH_MAX = 0.92;
  function warmthLevel(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h >= 6 && h < 17) return 0;        // daytime: plain white
    if (h >= 17 && h < 20) return (h - 17) / 3; // evening ramp up
    if (h >= 5 && h < 6) return 1 - (h - 5);    // morning ramp down
    return 1;                              // night (20:00–05:00)
  }
  function renderWarmth() {
    els.warmth.style.opacity = (warmthLevel(new Date()) * WARMTH_MAX).toFixed(3);
  }
  renderWarmth();
  setInterval(renderWarmth, 60 * 1000);

  // ---------- weather ----------
  const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    'clear':   `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
    'partly':  `<svg ${SVG_ATTRS}><path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2"/><circle cx="12" cy="12" r="4"/><path d="M15.947 12.65a4 4 0 0 1 0 7.35H8a5 5 0 1 1 4.9-6z"/></svg>`,
    'cloud':   `<svg ${SVG_ATTRS}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/></svg>`,
    'rain':    `<svg ${SVG_ATTRS}><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6M8 14v6M12 16v6"/></svg>`,
    'shower':  `<svg ${SVG_ATTRS}><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 19v1M8 14v1M16 19v1M16 14v1M12 21v1M12 16v1"/></svg>`,
    'storm':   `<svg ${SVG_ATTRS}><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>`,
    'fog':     `<svg ${SVG_ATTRS}><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 17H7M17 21H9"/></svg>`,
    'snow':    `<svg ${SVG_ATTRS}><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><path d="m20 16-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4"/></svg>`,
    'wind':    `<svg ${SVG_ATTRS}><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2M9.6 4.6A2 2 0 1 1 11 8H2M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>`,
  };
  const ICON_MAP = [
    ['storm', ['thunderstorm', 'storm']],
    ['rain',  ['rain']],
    ['shower', ['shower', 'drizzle', 'light rain']],
    ['fog',   ['fog', 'mist', 'haze']],
    ['snow',  ['snow', 'sleet', 'hail']],
    ['wind',  ['wind']],
    ['partly', ['partly cloudy', 'mostly sunny', 'few clouds']],
    ['cloud',  ['cloud', 'overcast']],
    ['clear',  ['clear', 'sunny', 'fine']],
  ];
  function iconFor(cond) {
    const c = (cond || '').toLowerCase();
    for (const [key, terms] of ICON_MAP) {
      if (terms.some(t => c.includes(t))) return ICONS[key];
    }
    return ICONS['cloud'];
  }

  let weatherFailures = 0;
  async function loadWeather() {
    try {
      const res = await fetch('/api/weather');
      if (!res.ok) throw new Error(res.status);
      const w = await res.json();
      els.temp.textContent = `${Math.round(w.tempC)}°`;
      const svgDoc = new DOMParser().parseFromString(iconFor(w.condition), 'image/svg+xml');
      els.wicon.replaceChildren(svgDoc.documentElement);
      els.cond.textContent = w.condition || '';
      els.rain.textContent = w.rainMm > 0 ? `${w.rainMm}mm rain` : 'no rain';
      if (w.tomorrow) {
        els.tomorrow.textContent = `tomorrow   ${Math.round(w.tomorrow.tempC)}°   ${w.tomorrow.summary || '—'}`;
      } else {
        els.tomorrow.textContent = '';
      }
      weatherFailures = 0;
    } catch (err) {
      weatherFailures++;
      if (weatherFailures > 20) location.reload();
    }
  }

  async function loadTodos() {
    try {
      const res = await fetch('/api/todos');
      if (!res.ok) throw new Error(res.status);
      const { items } = await res.json();
      clearChildren(els.todos);
      for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it.title;
        els.todos.appendChild(li);
      }
    } catch {
      /* keep previous */
    }
  }

  loadWeather();
  loadTodos();
  setInterval(loadWeather, 5 * 60 * 1000);
  setInterval(loadTodos, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadWeather(); loadTodos(); }
  });


  // ---------- calendar ----------
  function line(text, className) {
    const div = document.createElement('div');
    div.className = className || 'calendar-line';
    div.textContent = text;
    return div;
  }

  function renderCalendar(data) {
    clearChildren(els.calendarBody);
    const hasAllDay = Array.isArray(data.allDay) && data.allDay.length;
    const hasEvents = Array.isArray(data.events) && data.events.length;
    if (!hasAllDay && !hasEvents) {
      els.calendarBody.appendChild(line('No events today', 'calendar-empty'));
      return;
    }
    if (hasAllDay) {
      for (const title of data.allDay) els.calendarBody.appendChild(line(title, 'calendar-allday'));
    }
    if (hasAllDay && hasEvents) els.calendarBody.appendChild(line('', 'calendar-rule'));
    if (hasEvents) {
      for (const ev of data.events) {
        const row = document.createElement('div');
        row.className = 'calendar-event';
        const time = document.createElement('div');
        time.className = 'calendar-time';
        time.textContent = ev.end ? `${ev.start} – ${ev.end}` : ev.start;
        const title = document.createElement('div');
        title.className = 'calendar-title';
        title.textContent = ev.title || 'Untitled';
        row.append(time, title);
        els.calendarBody.appendChild(row);
      }
    }
  }

  async function loadCalendarModal() {
    clearChildren(els.calendarBody);
    els.calendarBody.appendChild(line('loading…', 'calendar-empty'));
    try {
      const res = await fetch('/api/calendar');
      if (!res.ok) throw new Error(res.status);
      renderCalendar(await res.json());
    } catch (err) {
      clearChildren(els.calendarBody);
      els.calendarBody.appendChild(line('Calendar unavailable', 'calendar-empty'));
    }
  }

  // ---------- audio unlock ----------
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    const a = els.audio;
    const prev = a.volume;
    a.volume = 0;
    a.play().then(() => {
      a.pause();
      a.currentTime = 0;
      a.volume = prev;
      audioUnlocked = true;
    }).catch(() => { a.volume = prev; });
  }
  document.addEventListener('touchend', unlockAudio);
  document.addEventListener('click', unlockAudio);

  // ---------- wake lock ----------
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* ignore */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !wakeLock) requestWakeLock();
  });
  document.addEventListener('click', () => { if (!wakeLock) requestWakeLock(); }, { once: true });

  // ---------- alarm/timer state ----------
  const STORAGE_KEY = 'ipad-dash-timer';
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveState(s) {
    if (!s || (!s.alarmAt && !s.timerEndAt)) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }

  function shortRemaining(ms) {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  function clockLabel(ts) {
    const d = new Date(ts);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${m}${ap}`;
  }

  function renderFooter() {
    const s = loadState();
    const now = Date.now();
    const alarmOn = s.alarmAt && s.alarmAt > now;
    els.alarmBtn.dataset.state = alarmOn ? 'on' : 'off';
    els.alarmCap.textContent = alarmOn ? clockLabel(s.alarmAt) : '';
    const timerOn = s.timerEndAt && s.timerEndAt > now;
    els.timerBtn.dataset.state = timerOn ? 'on' : 'off';
    els.timerCap.textContent = timerOn ? shortRemaining(s.timerEndAt - now) : '';
  }

  function checkFire() {
    const s = loadState();
    const now = Date.now();
    if (s.alarmAt && s.alarmAt <= now) {
      fire('alarm');
      s.alarmAt = null; saveState(s);
    }
    if (s.timerEndAt && s.timerEndAt <= now) {
      fire('timer');
      s.timerEndAt = null; saveState(s);
    }
  }

  setInterval(() => { renderFooter(); checkFire(); }, 1000);
  renderFooter();

  // ---------- firing ----------
  function fire(kind) {
    els.firingText.textContent = `${kind} — tap to dismiss`;
    els.firing.hidden = false;
    els.clock.classList.add('pulsing');
    if (audioUnlocked) {
      els.audio.currentTime = 0;
      els.audio.play().catch(() => {});
    }
    const dismiss = () => {
      els.firing.hidden = true;
      els.clock.classList.remove('pulsing');
      els.audio.pause();
      els.audio.currentTime = 0;
      els.firing.removeEventListener('click', dismiss);
    };
    els.firing.addEventListener('click', dismiss);
  }

  // ---------- modals ----------
  function openModal(m) { m.hidden = false; }
  function closeModal(m) { m.hidden = true; }
  document.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', () => { closeModal(b.closest('.modal')); });
  });

  // calendar
  els.calendarBtn.addEventListener('click', async () => {
    openModal(els.calendarModal);
    await loadCalendarModal();
  });

  // timer
  els.timerBtn.addEventListener('click', () => {
    const s = loadState();
    if (s.timerEndAt && s.timerEndAt > Date.now()) {
      s.timerEndAt = null; saveState(s); renderFooter(); return;
    }
    openModal(els.timerModal);
  });
  els.timerOptions.addEventListener('click', e => {
    const li = e.target.closest('[data-minutes]');
    if (!li) return;
    const min = Number(li.dataset.minutes);
    const s = loadState();
    s.timerEndAt = Date.now() + min * 60 * 1000;
    saveState(s);
    closeModal(els.timerModal);
    renderFooter();
  });

  // alarm
  els.alarmBtn.addEventListener('click', () => {
    const s = loadState();
    if (s.alarmAt && s.alarmAt > Date.now()) {
      s.alarmAt = null; saveState(s); renderFooter(); return;
    }
    buildWheels();
    openModal(els.alarmModal);
  });

  const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
  const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
  let wheelAmpm = 'am';

  function buildWheels() {
    fillWheel(els.hourWheel, HOURS.map(h => String(h)));
    fillWheel(els.minuteWheel, MINUTES.map(m => String(m).padStart(2, '0')));
    const now = new Date();
    const curH = now.getHours();
    wheelAmpm = curH >= 12 ? 'pm' : 'am';
    updateAmpmToggle();
    const h12 = (curH % 12) || 12;
    scrollWheelTo(els.hourWheel, HOURS.indexOf(h12));
    const mIdx = Math.round(now.getMinutes() / 5) % 12;
    scrollWheelTo(els.minuteWheel, mIdx);
  }

  function fillWheel(wheel, values) {
    clearChildren(wheel);
    for (const v of values) {
      const d = document.createElement('div');
      d.textContent = v;
      d.dataset.value = v;
      wheel.appendChild(d);
    }
  }

  function scrollWheelTo(wheel, idx) {
    requestAnimationFrame(() => {
      wheel.scrollTop = idx * 80;
    });
  }

  function selectedWheelValue(wheel) {
    const idx = Math.round(wheel.scrollTop / 80);
    const child = wheel.children[Math.max(0, Math.min(idx, wheel.children.length - 1))];
    return child ? child.dataset.value : null;
  }

  function updateAmpmToggle() {
    els.ampmToggle.querySelectorAll('button').forEach(b => {
      b.classList.toggle('on', b.dataset.ampm === wheelAmpm);
    });
  }
  els.ampmToggle.addEventListener('click', e => {
    const b = e.target.closest('[data-ampm]');
    if (!b) return;
    wheelAmpm = b.dataset.ampm;
    updateAmpmToggle();
  });

  els.alarmCommit.addEventListener('click', () => {
    const h = Number(selectedWheelValue(els.hourWheel));
    const m = Number(selectedWheelValue(els.minuteWheel));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    let hour24 = h % 12;
    if (wheelAmpm === 'pm') hour24 += 12;
    const target = new Date();
    target.setHours(hour24, m, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    const s = loadState();
    s.alarmAt = target.getTime();
    saveState(s);
    closeModal(els.alarmModal);
    renderFooter();
  });

  // ---------- home assistant lights ----------
  const LIGHTS = [
    { target: 'house', btn: els.houseBtn },
    { target: 'upstairs', btn: els.upstairsBtn },
  ];

  function applyLightState(states) {
    for (const { target, btn } of LIGHTS) {
      const st = states[target];
      if (st === 'on' || st === 'off') btn.dataset.state = st;
    }
  }

  async function pollLights() {
    try {
      const res = await fetch('/api/ha/state');
      if (!res.ok) throw new Error(res.status);
      applyLightState(await res.json());
    } catch { /* keep previous */ }
  }

  for (const { target, btn } of LIGHTS) {
    btn.addEventListener('click', async () => {
      // optimistic flip for instant feedback
      btn.dataset.state = btn.dataset.state === 'on' ? 'off' : 'on';
      try {
        const res = await fetch('/api/ha/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        });
        if (res.ok) {
          const { state } = await res.json();
          if (state === 'on' || state === 'off') btn.dataset.state = state;
        }
      } catch { /* next poll reconciles */ }
      setTimeout(pollLights, 1500);
    });
  }

  pollLights();
  setInterval(pollLights, 8000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollLights();
  });
})();
