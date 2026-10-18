(function () {
  'use strict';

  const app = window.APP;
  const store = window.createStore('tg-habits-');
  const tg = window.Telegram && window.Telegram.WebApp;
  // SDK загружается и в браузере, но platform там 'unknown'
  const inTelegram = Boolean(tg && tg.platform && tg.platform !== 'unknown');

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Адрес бот-сервера: из ссылки кнопки меню (?api=...) или из config.js
  const apiUrl = (() => {
    const fromLink = new URLSearchParams(location.search).get('api');
    return ((fromLink && /^https:\/\//.test(fromLink) ? fromLink : app.apiUrl) || '').replace(/\/+$/, '');
  })();
  // напоминания работают только внутри Telegram: сервер узнаёт пользователя по initData
  const remindersLive = Boolean(apiUrl && inTelegram && tg.initData);

  const state = {
    habits: store.peek('habits') || [], // { id, title, emoji, days: [1..7], remind: 'HH:MM' | '', done: ['YYYY-MM-DD'], created }
    tasks: store.peek('tasks') || [], // { id, title, date, time, remind, done, doneAt, ts }
    tab: 'habits',
    showDone: false,
    sheet: null, // { kind: 'habit' | 'task', draft } | { kind: 'reminders' }
    server: remindersLive ? 'pending' : 'demo', // 'pending' | 'ok' | 'error' | 'demo'
  };

  // ---------- Даты ----------

  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const weekday = (d) => d.getDay() || 7; // 1 — понедельник … 7 — воскресенье
  const todayIso = () => isoDate(new Date());

  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const longDayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const shortDayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // ---------- Привычки ----------

  const isScheduled = (h, d) => h.days.includes(weekday(d));
  const isDone = (h, iso) => h.done.includes(iso);

  // серия: сколько запланированных дней подряд выполнено (сегодня ещё можно успеть — его не ломаем)
  function streak(h) {
    let d = new Date();
    if (!isDone(h, isoDate(d))) d = addDays(d, -1);
    let count = 0;
    for (let i = 0; i < 400; i++, d = addDays(d, -1)) {
      const iso = isoDate(d);
      if (iso < h.created) break;
      if (!isScheduled(h, d)) continue;
      if (!isDone(h, iso)) break;
      count++;
    }
    return count;
  }

  function toggleHabit(id) {
    const h = state.habits.find((x) => x.id === id);
    const today = todayIso();
    if (isDone(h, today)) {
      h.done = h.done.filter((d) => d !== today);
      haptic('light');
    } else {
      h.done = [...h.done, today].sort().slice(-180); // храним полгода истории
      haptic('success');
      const left = state.habits.filter((x) => isScheduled(x, new Date()) && !isDone(x, today)).length;
      if (!left) toast('Все привычки на сегодня выполнены 🎉');
    }
    saveHabits();
    render();
  }

  // ---------- Задачи ----------

  function taskGroups() {
    const today = todayIso();
    const tomorrow = isoDate(addDays(new Date(), 1));
    const groups = { overdue: [], today: [], tomorrow: [], later: [], nodate: [], done: [] };
    state.tasks.forEach((t) => {
      if (t.done) groups.done.push(t);
      else if (!t.date) groups.nodate.push(t);
      else if (t.date < today) groups.overdue.push(t);
      else if (t.date === today) groups.today.push(t);
      else if (t.date === tomorrow) groups.tomorrow.push(t);
      else groups.later.push(t);
    });
    const byWhen = (a, b) => (a.date || '9').localeCompare(b.date || '9') || (a.time || '99').localeCompare(b.time || '99') || a.ts - b.ts;
    Object.values(groups).forEach((g) => g.sort(byWhen));
    groups.done.sort((a, b) => b.doneAt - a.doneAt);
    return groups;
  }

  function toggleTask(id) {
    const t = state.tasks.find((x) => x.id === id);
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : 0;
    haptic(t.done ? 'success' : 'light');
    if (t.done) toast('Готово!');
    saveTasks();
    render();
  }

  // ---------- Хранение и напоминания ----------

  function saveHabits() { store.save('habits', state.habits); syncReminders(); }
  function saveTasks() { store.save('tasks', state.tasks); syncReminders(); }

  // список напоминаний в том виде, в каком его ждёт бот-сервер
  function reminderList() {
    const today = todayIso();
    return [
      ...state.habits.filter((h) => h.remind).map((h) => ({
        id: 'h-' + h.id, kind: 'habit', text: h.emoji + ' ' + h.title, time: h.remind, days: h.days,
        skip: isDone(h, today) ? today : null, // сегодня уже выполнено — не напоминаем
      })),
      ...state.tasks.filter((t) => t.remind && !t.done && t.date && t.time).map((t) => ({
        id: 't-' + t.id, kind: 'task', text: t.title, date: t.date, time: t.time,
      })),
    ];
  }

  let syncTimer;
  function syncReminders() {
    if (!remindersLive) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const res = await fetch(apiUrl + '/api/reminders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            initData: tg.initData,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            reminders: reminderList(),
          }),
        });
        state.server = res.ok ? 'ok' : 'error';
      } catch (e) {
        state.server = 'error';
      }
      updateReminderDot();
      if (state.sheet && state.sheet.kind === 'reminders') renderSheet();
    }, 700);
  }

  // при первом включении напоминания просим разрешение боту писать пользователю
  function askWriteAccess() {
    if (!remindersLive || !tgCan('6.9')) return;
    try {
      if (localStorage.getItem('tg-habits-write-access')) return;
      localStorage.setItem('tg-habits-write-access', '1');
    } catch (e) { /* без localStorage просто спросим ещё раз */ }
    tg.requestWriteAccess();
  }

  function reminderNote() {
    return remindersLive
      ? 'Бот пришлёт сообщение в Telegram в это время.'
      : 'Демо-режим: напоминание сохранится, но сообщение не придёт — сервер бота не подключён.';
  }

  // ---------- Пример данных ----------

  function demoData() {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const now = new Date();
    const day = (n) => isoDate(addDays(now, n));
    const created = day(-35);

    const habits = [
      { emoji: '💧', title: 'Выпить 2 литра воды', days: [1, 2, 3, 4, 5, 6, 7], remind: '10:00', rate: 1, today: true },
      { emoji: '🏃', title: 'Утренняя пробежка', days: [1, 3, 5], remind: '07:30', rate: 0.8, today: true },
      { emoji: '📚', title: 'Читать 20 страниц', days: [1, 2, 3, 4, 5, 6, 7], remind: '21:30', rate: 0.75 },
      { emoji: '🗣️', title: 'Английский 15 минут', days: [1, 2, 3, 4, 5], remind: '19:00', rate: 0.85 },
      { emoji: '🧘', title: 'Медитация', days: [1, 2, 3, 4, 5, 6, 7], remind: '', rate: 0.6 },
    ].map((h, i) => {
      const done = [];
      for (let n = 34; n >= 1; n--) if (rnd() < h.rate) done.push(day(-n));
      if (h.today) done.push(day(0));
      return { id: 'demo' + i, title: h.title, emoji: h.emoji, days: h.days, remind: h.remind, done, created };
    });

    const task = (title, date, time, remind, done) => ({
      id: newId() + Math.floor(rnd() * 1000), title, date: date === null ? '' : day(date), time: time || '',
      remind: Boolean(remind), done: Boolean(done), doneAt: done ? Date.now() - Math.floor(rnd() * 1e8) : 0, ts: Date.now(),
    });
    const tasks = [
      task('Оплатить интернет', -1),
      task('Позвонить в банк', 0, '12:00', true),
      task('Купить продукты на неделю', 0),
      task('Отправить отчёт по проекту', 0, '17:00', true),
      task('Забрать посылку на почте', 1, '18:30', true),
      task('Записаться к стоматологу', 3),
      task('Выбрать подарок маме', 6, '10:00', true),
      task('Разобрать фото в телефоне', null),
      task('Продлить подписку', -1, '', false, true),
      task('Ответить друзьям про выходные', 0, '', false, true),
    ];
    return { habits, tasks };
  }

  // ---------- Telegram ----------

  const tgCan = (version) => inTelegram && tg.isVersionAtLeast(version);

  function haptic(kind) {
    if (!tgCan('6.1')) return;
    if (kind === 'success' || kind === 'error' || kind === 'warning') tg.HapticFeedback.notificationOccurred(kind);
    else tg.HapticFeedback.impactOccurred(kind);
  }

  function confirmAsk(text) {
    if (tgCan('6.2')) return new Promise((resolve) => tg.showConfirm(text, resolve));
    return Promise.resolve(window.confirm(text));
  }

  let mainAction = null;

  // В Telegram — нативная кнопка внизу, в браузере — своя
  function setMainButton(text, action) {
    mainAction = action || null;
    if (inTelegram) {
      if (text) {
        tg.MainButton.setText(text);
        tg.MainButton.show();
      } else {
        tg.MainButton.hide();
      }
    } else {
      $('bottomBar').hidden = !text;
      $('mainBtn').textContent = text || '';
    }
    document.body.classList.toggle('has-bottom-bar', !inTelegram && Boolean(text));
  }

  function updateChrome() {
    if (tgCan('6.1')) {
      if (state.sheet) tg.BackButton.show();
      else tg.BackButton.hide();
    }
    if (state.sheet) return setMainButton(null);
    if (state.tab === 'habits') setMainButton('Новая привычка', () => openHabit(null));
    else setMainButton('Новая задача', () => openTask(null));
  }

  function updateReminderDot() {
    const dot = $('remindersDot');
    dot.hidden = state.server !== 'ok' && state.server !== 'error';
    dot.classList.toggle('is-error', state.server === 'error');
  }

  function initTelegram() {
    if (!inTelegram) return;
    tg.ready();
    tg.expand();
    tg.MainButton.setParams({ color: app.accent, text_color: '#ffffff' });
    tg.MainButton.onClick(() => mainAction && mainAction());
    if (tgCan('6.1')) tg.BackButton.onClick(closeSheet);
  }

  // ---------- Отрисовка ----------

  function render() {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === state.tab));
    $('view-habits').hidden = state.tab !== 'habits';
    $('view-tasks').hidden = state.tab !== 'tasks';

    const now = new Date();
    const scheduled = state.habits.filter((h) => isScheduled(h, now));
    const doneToday = scheduled.filter((h) => isDone(h, todayIso())).length;
    $('habitsCount').textContent = scheduled.length ? doneToday + '/' + scheduled.length : '';
    const open = state.tasks.filter((t) => !t.done && t.date && t.date <= todayIso()).length;
    $('tasksCount').textContent = open || '';

    if (state.tab === 'habits') renderHabits(scheduled, doneToday);
    else renderTasks();
    updateChrome();
    updateReminderDot();
  }

  function ringHtml(share) {
    const r = 26;
    const length = 2 * Math.PI * r;
    return `<svg class="ring" viewBox="0 0 64 64" aria-hidden="true">
      <circle r="${r}" cx="32" cy="32" class="ring__track"/>
      <circle r="${r}" cx="32" cy="32" class="ring__value" transform="rotate(-90 32 32)"
        stroke-dasharray="${(share * length).toFixed(2)} ${length.toFixed(2)}"/>
    </svg>`;
  }

  function renderHabits(scheduled, doneToday) {
    const total = scheduled.length;
    if (!state.habits.length) {
      $('today').innerHTML = '';
      $('habitList').innerHTML = `<div class="empty-state">
        <div class="empty-state__icon">🌱</div>
        <p>Добавьте первую привычку — маленький шаг каждый день</p>
      </div>`;
      return;
    }

    const left = total - doneToday;
    const mood = !total ? 'Сегодня день отдыха'
      : !left ? 'Все привычки выполнены 🎉'
      : doneToday ? `Осталось ${left} — ты справишься`
      : 'Начни с самой простой';
    $('today').innerHTML = `
      <div class="today__ring">${ringHtml(total ? doneToday / total : 0)}<b>${total ? Math.round((doneToday / total) * 100) : 0}%</b></div>
      <div>
        <p class="today__date">${longDayFmt.format(new Date())}</p>
        <p class="today__title">Сегодня ${doneToday} из ${total}</p>
        <p class="today__hint">${mood}</p>
      </div>`;

    const rest = state.habits.filter((h) => !scheduled.includes(h));
    $('habitList').innerHTML = scheduled.map((h) => habitHtml(h, true)).join('') +
      (rest.length ? `<h3 class="group-title">Сегодня отдых</h3>${rest.map((h) => habitHtml(h, false)).join('')}` : '');
  }

  function habitHtml(h, active) {
    const today = new Date();
    const done = isDone(h, isoDate(today));
    const s = streak(h);
    const meta = [
      s ? `🔥 ${s} ${plural(s, 'день', 'дня', 'дней')} подряд` : 'Серия ещё впереди',
      h.remind ? '⏰ ' + h.remind : '',
    ].filter(Boolean).join(' · ');

    const dots = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      const iso = isoDate(d);
      let cls = 'off';
      if (iso >= h.created && isScheduled(h, d)) cls = isDone(h, iso) ? 'done' : i === 0 ? 'wait' : 'miss';
      dots.push(`<span class="week__day"><small>${WEEKDAYS[weekday(d) - 1]}</small><i class="week__dot is-${cls}"></i></span>`);
    }

    return `<div class="habit${done ? ' is-done' : ''}${active ? '' : ' is-rest'}" data-habit="${h.id}">
      <span class="habit__emoji">${h.emoji}</span>
      <div class="habit__info">
        <div class="habit__title">${esc(h.title)}</div>
        <div class="habit__meta">${meta}</div>
        <div class="week">${dots.join('')}</div>
      </div>
      ${active ? `<button type="button" class="check${done ? ' is-done' : ''}" data-check="${h.id}" aria-label="${done ? 'Снять отметку' : 'Выполнено'}">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>` : ''}
    </div>`;
  }

  const GROUP_TITLES = { overdue: 'Просрочено', today: 'Сегодня', tomorrow: 'Завтра', later: 'Позже', nodate: 'Без срока' };

  function taskHtml(t, group) {
    const when = [];
    if (t.date && group !== 'today' && group !== 'tomorrow') when.push(shortDayFmt.format(parseDate(t.date)));
    if (t.time) when.push(t.time);
    if (t.remind && t.date && t.time) when.push('🔔');
    return `<div class="task${t.done ? ' is-done' : ''}" data-task="${t.id}">
      <button type="button" class="task__check" data-toggle="${t.id}" aria-label="${t.done ? 'Вернуть в работу' : 'Выполнено'}">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="task__info">
        <div class="task__title">${esc(t.title)}</div>
        ${when.length ? `<div class="task__meta${group === 'overdue' ? ' is-overdue' : ''}">${when.join(' · ')}</div>` : ''}
      </div>
    </div>`;
  }

  function renderTasks() {
    const groups = taskGroups();
    const active = Object.keys(GROUP_TITLES).filter((g) => groups[g].length);
    let html = active.map((g) => `
      <h3 class="group-title${g === 'overdue' ? ' is-overdue' : ''}">${GROUP_TITLES[g]} <span>${groups[g].length}</span></h3>
      ${groups[g].map((t) => taskHtml(t, g)).join('')}`).join('');

    if (!active.length) {
      html = `<div class="empty-state">
        <div class="empty-state__icon">${groups.done.length ? '🏖️' : '📝'}</div>
        <p>${groups.done.length ? 'Все задачи выполнены. Можно отдохнуть!' : 'Задач пока нет — добавьте первую'}</p>
      </div>`;
    }
    if (groups.done.length) {
      html += `<button type="button" class="done-toggle" data-show-done>
        ${state.showDone ? 'Скрыть' : 'Показать'} выполненные (${groups.done.length})
      </button>`;
      if (state.showDone) {
        html += groups.done.slice(0, 30).map((t) => taskHtml(t, 'done')).join('') +
          '<button type="button" class="link-btn" data-clear-done>Удалить выполненные</button>';
      }
    }
    $('taskList').innerHTML = html;
  }

  // ---------- Шторка ----------

  function openSheet(sheet) {
    state.sheet = sheet;
    renderSheet();
    const el = $('sheet');
    el.hidden = false;
    void el.offsetWidth; // чтобы сработала анимация появления
    el.classList.add('is-open');
    haptic('light');
    updateChrome();
  }

  function closeSheet() {
    if (!state.sheet) return;
    state.sheet = null;
    $('sheet').classList.remove('is-open');
    setTimeout(() => { if (!state.sheet) $('sheet').hidden = true; }, 250);
    updateChrome();
  }

  function renderSheet() {
    const kind = state.sheet.kind;
    $('sheetBody').innerHTML = kind === 'habit' ? habitFormHtml() : kind === 'task' ? taskFormHtml() : remindersHtml();
  }

  function switchHtml(on, disabled) {
    return `<button type="button" role="switch" class="switch${on ? ' is-on' : ''}" data-switch aria-checked="${on}"${disabled ? ' disabled' : ''}></button>`;
  }

  function openHabit(id) {
    const h = id && state.habits.find((x) => x.id === id);
    const draft = h
      ? { ...h, remindOn: Boolean(h.remind), remind: h.remind || '09:00' }
      : { id: null, title: '', emoji: app.emojis[0], days: [1, 2, 3, 4, 5, 6, 7], remindOn: false, remind: '09:00' };
    openSheet({ kind: 'habit', draft });
    if (!h) setTimeout(() => $('fTitle') && $('fTitle').focus(), 260);
  }

  function habitFormHtml() {
    const d = state.sheet.draft;
    const preset = (days) => days.length === d.days.length && days.every((x) => d.days.includes(x));
    return `
      <h2 class="sheet__title">${d.id ? 'Привычка' : 'Новая привычка'}</h2>
      <div class="field${d.error ? ' has-error' : ''}">
        <input id="fTitle" maxlength="60" autocomplete="off" placeholder="Например: пить воду" value="${esc(d.title)}" aria-label="Название">
        <div class="field__error">${d.error || ''}</div>
      </div>
      <div class="label">Иконка</div>
      <div class="emojis">
        ${app.emojis.map((e) => `<button type="button" class="emoji${e === d.emoji ? ' is-active' : ''}" data-emoji="${e}">${e}</button>`).join('')}
      </div>
      <div class="label">Дни</div>
      <div class="days">
        ${WEEKDAYS.map((w, i) => `<button type="button" class="${d.days.includes(i + 1) ? 'is-active' : ''}" data-day="${i + 1}">${w}</button>`).join('')}
      </div>
      <div class="presets">
        <button type="button" class="${preset([1, 2, 3, 4, 5, 6, 7]) ? 'is-active' : ''}" data-preset="1,2,3,4,5,6,7">Каждый день</button>
        <button type="button" class="${preset([1, 2, 3, 4, 5]) ? 'is-active' : ''}" data-preset="1,2,3,4,5">Будни</button>
        <button type="button" class="${preset([6, 7]) ? 'is-active' : ''}" data-preset="6,7">Выходные</button>
      </div>
      <div class="switch-row">
        <span>Напоминание</span>
        ${d.remindOn ? `<input type="time" id="fRemind" value="${d.remind}" aria-label="Время напоминания">` : ''}
        ${switchHtml(d.remindOn)}
      </div>
      ${d.remindOn ? `<p class="sheet__note">${reminderNote()}</p>` : ''}
      <div class="sheet__footer">
        ${d.id ? '<button type="button" class="danger-btn" data-sheet="delete">Удалить</button>' : ''}
        <button type="button" class="primary-btn" data-sheet="save">${d.id ? 'Сохранить' : 'Добавить'}</button>
      </div>`;
  }

  function openTask(id) {
    const t = id && state.tasks.find((x) => x.id === id);
    const draft = t ? { ...t } : { id: null, title: '', date: todayIso(), time: '', remind: false, done: false };
    openSheet({ kind: 'task', draft });
    if (!t) setTimeout(() => $('fTitle') && $('fTitle').focus(), 260);
  }

  function taskFormHtml() {
    const d = state.sheet.draft;
    const canRemind = Boolean(d.date && d.time);
    const today = todayIso();
    const tomorrow = isoDate(addDays(new Date(), 1));
    return `
      <h2 class="sheet__title">${d.id ? 'Задача' : 'Новая задача'}</h2>
      <div class="field${d.error ? ' has-error' : ''}">
        <input id="fTitle" maxlength="120" autocomplete="off" placeholder="Что нужно сделать?" value="${esc(d.title)}" aria-label="Задача">
        <div class="field__error">${d.error || ''}</div>
      </div>
      <div class="presets">
        <button type="button" class="${d.date === today ? 'is-active' : ''}" data-date="${today}">Сегодня</button>
        <button type="button" class="${d.date === tomorrow ? 'is-active' : ''}" data-date="${tomorrow}">Завтра</button>
        <button type="button" class="${!d.date ? 'is-active' : ''}" data-date="">Без срока</button>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="fDate">Дата</label>
          <input id="fDate" type="date" value="${d.date}">
        </div>
        <div class="field">
          <label for="fTime">Время</label>
          <input id="fTime" type="time" value="${d.time}"${d.date ? '' : ' disabled'}>
        </div>
      </div>
      <div class="switch-row">
        <span>Напомнить${canRemind ? ' в ' + d.time : ''}</span>
        ${switchHtml(d.remind && canRemind, !canRemind)}
      </div>
      <p class="sheet__note">${canRemind ? (d.remind ? reminderNote() : 'Бот напишет вам в Telegram в назначенное время.') : 'Чтобы включить напоминание, укажите дату и время.'}</p>
      <div class="sheet__footer">
        ${d.id ? '<button type="button" class="danger-btn" data-sheet="delete">Удалить</button>' : ''}
        <button type="button" class="primary-btn" data-sheet="save">${d.id ? 'Сохранить' : 'Добавить'}</button>
      </div>`;
  }

  function remindersHtml() {
    const list = reminderList();
    const status = {
      ok: ['is-ok', 'Напоминания включены', 'Бот пришлёт сообщение в Telegram в назначенное время.'],
      pending: ['', 'Подключаемся к боту…', 'Проверяем связь с сервером напоминаний.'],
      error: ['is-error', 'Сервер недоступен', 'Напоминания сохранены и отправятся на сервер, когда он снова заработает.'],
      demo: ['', 'Демо-режим', 'Сервер бота не подключён, поэтому сообщения не отправляются. В рабочей версии бот пишет вам в Telegram в назначенное время.'],
    }[state.server];
    const rows = list.map((r) => {
      const when = r.kind === 'habit'
        ? (r.days.length === 7 ? 'каждый день' : r.days.map((x) => WEEKDAYS[x - 1]).join(', ')) + ', ' + r.time
        : shortDayFmt.format(parseDate(r.date)) + ', ' + r.time;
      return `<li><span>${esc(r.text)}</span><small>${when}</small></li>`;
    }).join('');
    return `
      <h2 class="sheet__title">Напоминания</h2>
      <div class="status ${status[0]}"><b>${status[1]}</b><p>${status[2]}</p></div>
      ${list.length ? `<ul class="reminders">${rows}</ul>` : '<p class="sheet__note">Напоминаний пока нет. Включите их в привычке или задаче.</p>'}
      <div class="sheet__actions">
        <button type="button" class="secondary-btn" data-sheet="demo">Заполнить примером</button>
        <button type="button" class="secondary-btn secondary-btn--danger" data-sheet="clear">Удалить все данные</button>
      </div>`;
  }

  function saveDraft() {
    const s = state.sheet;
    const d = s.draft;
    d.title = d.title.trim();
    if (!d.title) {
      d.error = s.kind === 'habit' ? 'Назовите привычку' : 'Опишите задачу';
      haptic('error');
      renderSheet();
      $('fTitle').focus();
      return;
    }

    if (s.kind === 'habit') {
      if (!d.days.length) d.days = [1, 2, 3, 4, 5, 6, 7];
      const habit = {
        id: d.id || newId(), title: d.title, emoji: d.emoji, days: d.days.slice().sort(),
        remind: d.remindOn ? d.remind || '09:00' : '', done: d.done || [], created: d.created || todayIso(),
      };
      const i = state.habits.findIndex((h) => h.id === habit.id);
      if (i >= 0) state.habits[i] = habit;
      else state.habits.push(habit);
      if (habit.remind) askWriteAccess();
      saveHabits();
      toast(i >= 0 ? 'Сохранено' : 'Привычка добавлена');
    } else {
      const task = {
        id: d.id || newId(), title: d.title, date: d.date, time: d.date ? d.time : '',
        remind: Boolean(d.remind && d.date && d.time), done: d.done, doneAt: d.doneAt || 0, ts: d.ts || Date.now(),
      };
      const i = state.tasks.findIndex((t) => t.id === task.id);
      if (i >= 0) state.tasks[i] = task;
      else state.tasks.push(task);
      if (task.remind) askWriteAccess();
      saveTasks();
      toast(i >= 0 ? 'Сохранено' : 'Задача добавлена');
    }
    haptic('success');
    closeSheet();
    render();
  }

  async function sheetAction(action) {
    const s = state.sheet;
    if (action === 'save') return saveDraft();
    if (action === 'delete') {
      const isHabit = s.kind === 'habit';
      if (!(await confirmAsk(isHabit ? 'Удалить привычку вместе с историей?' : 'Удалить задачу?'))) return;
      if (isHabit) { state.habits = state.habits.filter((h) => h.id !== s.draft.id); saveHabits(); }
      else { state.tasks = state.tasks.filter((t) => t.id !== s.draft.id); saveTasks(); }
      haptic('warning');
      toast('Удалено');
    }
    if (action === 'demo') {
      if ((state.habits.length || state.tasks.length) && !(await confirmAsk('Заменить ваши привычки и задачи примером?'))) return;
      Object.assign(state, demoData());
      saveHabits();
      saveTasks();
    }
    if (action === 'clear') {
      if (!(await confirmAsk('Удалить все привычки и задачи? Это нельзя отменить.'))) return;
      state.habits = [];
      state.tasks = [];
      saveHabits();
      saveTasks();
    }
    closeSheet();
    render();
  }

  // ---------- Прочее ----------

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 1800);
  }

  function bindEvents() {
    $('tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn || btn.dataset.tab === state.tab) return;
      state.tab = btn.dataset.tab;
      haptic('light');
      window.scrollTo(0, 0);
      render();
    });

    $('habitList').addEventListener('click', (e) => {
      const check = e.target.closest('[data-check]');
      if (check) return toggleHabit(check.dataset.check);
      const card = e.target.closest('[data-habit]');
      if (card) openHabit(card.dataset.habit);
    });

    $('taskList').addEventListener('click', async (e) => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) return toggleTask(toggle.dataset.toggle);
      if (e.target.closest('[data-show-done]')) {
        state.showDone = !state.showDone;
        return render();
      }
      if (e.target.closest('[data-clear-done]')) {
        if (!(await confirmAsk('Удалить все выполненные задачи?'))) return;
        state.tasks = state.tasks.filter((t) => !t.done);
        saveTasks();
        return render();
      }
      const row = e.target.closest('[data-task]');
      if (row) openTask(row.dataset.task);
    });

    $('quickAdd').addEventListener('submit', (e) => {
      e.preventDefault();
      const title = $('quickInput').value.trim();
      if (!title) return;
      state.tasks.push({ id: newId(), title, date: todayIso(), time: '', remind: false, done: false, doneAt: 0, ts: Date.now() });
      $('quickInput').value = '';
      haptic('light');
      saveTasks();
      render();
    });

    $('sheet').addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return closeSheet();
      const d = state.sheet && state.sheet.draft;
      const pick = (selector) => e.target.closest(selector);
      let el;
      if ((el = pick('[data-emoji]'))) d.emoji = el.dataset.emoji;
      else if ((el = pick('[data-day]'))) {
        const day = Number(el.dataset.day);
        d.days = d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day];
      } else if ((el = pick('[data-preset]'))) d.days = el.dataset.preset.split(',').map(Number);
      else if ((el = pick('[data-date]'))) {
        d.date = el.dataset.date;
        if (!d.date) { d.time = ''; d.remind = false; }
      } else if ((el = pick('[data-switch]'))) {
        if (state.sheet.kind === 'habit') d.remindOn = !d.remindOn;
        else d.remind = !d.remind;
      } else if ((el = pick('[data-sheet]'))) return sheetAction(el.dataset.sheet);
      else return;
      haptic('light');
      renderSheet();
    });

    // запоминаем ввод, чтобы он не терялся при перерисовке шторки
    $('sheet').addEventListener('input', (e) => {
      const d = state.sheet && state.sheet.draft;
      if (!d) return;
      const id = e.target.id;
      if (id === 'fTitle') {
        d.title = e.target.value;
        if (d.error) {
          d.error = '';
          e.target.closest('.field').classList.remove('has-error');
        }
      }
      if (id === 'fRemind') d.remind = e.target.value;
      if (id === 'fDate') d.date = e.target.value;
      if (id === 'fTime') d.time = e.target.value;
    });

    // дата и время влияют на пресеты и доступность напоминания — перерисовываем, сохраняя фокус
    $('sheet').addEventListener('change', (e) => {
      const id = e.target.id;
      if (id !== 'fDate' && id !== 'fTime') return;
      renderSheet();
      $(id).focus();
    });

    $('sheet').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'fTitle') {
        e.preventDefault();
        saveDraft();
      }
    });

    $('remindersBtn').addEventListener('click', () => openSheet({ kind: 'reminders' }));
    $('mainBtn').addEventListener('click', () => mainAction && mainAction());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSheet();
    });
  }

  async function init() {
    document.documentElement.style.setProperty('--accent', app.accent);
    document.title = app.name;
    $('appName').textContent = app.name;
    $('appLogo').textContent = app.logo;
    const user = inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user;
    $('greeting').textContent = user ? `Привет, ${user.first_name}!` : app.tagline;

    initTelegram();
    bindEvents();
    render();

    // подтягиваем данные из облака Telegram; при самом первом запуске — пример
    try {
      const [habits, tasks] = await Promise.all([store.load('habits'), store.load('tasks')]);
      if (!habits && !tasks) {
        Object.assign(state, demoData());
        store.save('habits', state.habits);
        store.save('tasks', state.tasks);
      } else {
        state.habits = habits || [];
        state.tasks = tasks || [];
      }
    } catch (e) {
      toast('Не удалось загрузить данные из облака');
    }
    render();
    syncReminders(); // отправляем актуальное расписание на сервер (и проверяем связь)
  }

  init();
})();
