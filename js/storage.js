// Хранилище: облако Telegram (CloudStorage, общее для всех устройств пользователя)
// + localStorage как быстрый кэш. В обычном браузере — только localStorage.
// В CloudStorage значение не длиннее 4096 символов, поэтому данные режутся на части:
// ключ `name` хранит число частей, `name_0`, `name_1`… — сами части JSON.
window.createStore = function (prefix) {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = Boolean(tg && tg.platform && tg.platform !== 'unknown');
  const cloud = inTelegram && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;
  const CHUNK = 4000;

  const call = (method, arg) => new Promise((resolve, reject) => {
    cloud[method](arg, (err, res) => (err ? reject(err) : resolve(res)));
  });
  const setItem = (key, value) => new Promise((resolve, reject) => {
    cloud.setItem(key, value, (err) => (err ? reject(err) : resolve()));
  });

  function readLocal(name) {
    try {
      const raw = localStorage.getItem(prefix + name);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeLocal(name, value) {
    try { localStorage.setItem(prefix + name, JSON.stringify(value)); } catch (e) { /* приватный режим */ }
  }

  // режем строку на части, не разрывая эмодзи (суррогатные пары)
  function split(str) {
    const parts = [];
    let i = 0;
    while (i < str.length) {
      let end = Math.min(i + CHUNK, str.length);
      const code = str.charCodeAt(end - 1);
      if (end < str.length && code >= 0xd800 && code <= 0xdbff) end--;
      parts.push(str.slice(i, end));
      i = end;
    }
    return parts.length ? parts : [''];
  }

  async function readCloud(name) {
    const count = parseInt(await call('getItem', name), 10);
    if (!count) return null;
    const keys = Array.from({ length: count }, (_, i) => name + '_' + i);
    const parts = await call('getItems', keys);
    return JSON.parse(keys.map((k) => parts[k] || '').join(''));
  }

  async function writeCloud(name, value) {
    const parts = split(JSON.stringify(value));
    const oldCount = parseInt(await call('getItem', name), 10) || 0;
    for (let i = 0; i < parts.length; i++) await setItem(name + '_' + i, parts[i]);
    await setItem(name, String(parts.length));
    if (oldCount > parts.length) {
      await call('removeItems', Array.from({ length: oldCount - parts.length }, (_, i) => name + '_' + (parts.length + i)));
    }
  }

  // записи в облако идут по очереди, а частые сохранения склеиваются в одно
  const pending = {};
  let queue = Promise.resolve();

  return {
    isCloud: Boolean(cloud),

    // мгновенно — из кэша на устройстве
    peek: readLocal,

    // из облака (если есть), иначе из кэша
    async load(name) {
      if (!cloud) return readLocal(name);
      try {
        const value = await readCloud(name);
        if (value !== null) writeLocal(name, value);
        return value;
      } catch (e) {
        // облако недоступно: берём кэш, а если его нет — ошибка, чтобы не затереть облако пустыми данными
        const local = readLocal(name);
        if (local === null) throw e;
        return local;
      }
    },

    save(name, value) {
      writeLocal(name, value);
      if (!cloud) return;
      clearTimeout(pending[name]);
      pending[name] = setTimeout(() => {
        queue = queue.then(() => writeCloud(name, value)).catch((e) => console.warn('CloudStorage:', e));
      }, 400);
    },
  };
};
