/* debug-log.js (ui/) — встроенный отладочный лог для удалённой диагностики (С25+).

   Зачем существует:
     Когда баг проявляется визуально, но причина запутана (race-condition,
     браузерная quirk, неявная мутация state), агенту, который не может
     запустить игру в браузере, нужны конкретные данные. Этот модуль
     собирает их:
       • кольцевой буфер последних N событий (300 по умолчанию);
       • снапшот текущего состояния (state, DOM-метрики, scroll, focus);
       • глобальные перехватчики (scroll/style mutations/errors);
       • кнопка «Дамп для агента» в DevTools popover.

   Как пользоваться:
     1) Воспроизвёл баг → открыл DevTools → 🛠 → «📋 Дамп для агента».
     2) Содержимое буфера обмена (JSON) вставил в чат.
     3) Агент видит timeline событий + точное состояние в момент бага.

   Альтернативно из консоли:
     window.DebugLog.dump()             // вернёт JSON-строку
     window.DebugLog.copyToClipboard()  // в clipboard
     window.DebugLog.snapshot()         // объект (для inspecт-просмотра)
     window.DebugLog.enable('ai')       // включить категорию
     window.DebugLog.disable('render')  // отключить шумную категорию
     window.DebugLog.clear()            // очистить буфер

   Категории (DebugLog.log(category, msg, data)):
     • init          — старт модуля.
     • camera        — applyView, setZoomAt, panBy, resetView, clampPan.
     • wave          — forceWaveVictory, startNextWave, spawnZombieWave.
     • level-up      — advance/finish/apply level-up queue.
     • action        — dispatchActiveSkill (player action).
     • ai            — runAiTurn (NPC action).
     • combat        — applyDamage (последствия атаки).
     • render        — render() top-level (start/end).
     • scroll        — window.scrollY изменился (auto-listener).
     • dom-mutation  — html/body inline-style изменился (MutationObserver).
     • error         — runtime error / unhandled rejection.

   Что внутри snapshot:
     • timestamp, window-размеры, scroll-позиции;
     • html/body: scrollTop, computed overflow, inline-style;
     • viewport/battlefield: getBoundingClientRect + clientWidth/Height;
     • document.activeElement (tag/id/class);
     • state: wave, mode, ids активных юнитов, gameOver, view,
       activeLevelUp, levelUpQueue, units.length, objects.length;
     • buffer: последние 200 событий (с отметкой времени).

   Что НЕ собираем намеренно:
     • Полный state.units (тяжёлый, для большинства багов не нужен).
       Если потребуется — расширить stateSnapshot ниже.
     • Innerхтмл крупных контейнеров (overlay/panel) — возьми сам через
       DevTools при нужде.
     • Ссылки на DOM-узлы (не сериализуются в JSON).

   Подключается в index.html ПЕРВЫМ среди ui/, чтобы перехватчики
   успели до основного цикла. Активен ВСЕГДА; перфоманс-impact
   незначителен (~300 событий держим в RAM, MutationObserver узких
   фильтров). Для production-сборки модуль можно удалить одной
   строкой <script src=...> в index.html. */

(function () {
  const MAX_BUFFER = 300;
  const SNAPSHOT_BUFFER_TAIL = 200;
  const buffer = [];
  // По умолчанию активны все категории. disable() выкидывает по ключу.
  const enabled = new Set([
    'init', 'camera', 'wave', 'level-up', 'action', 'ai',
    'combat', 'render', 'scroll', 'dom-mutation', 'error'
  ]);

  /* ================================================================
     Camp v1.5-popups (12.05.2026): зеркальная запись буфера в
     localStorage. Зачем: если игра зависла или JS упал, кнопка «Дамп»
     не работает — но содержимое localStorage остаётся доступным через
     DevTools → Application → Local Storage. Игрок копирует значение
     ключа _PERSIST_KEY и пересылает агенту.

     Запись throttled (раз в _PERSIST_INTERVAL_MS), чтобы не убить
     перфоманс в горячих циклах рендера. Дополнительно flush'имся
     синхронно при beforeunload и на runtime-ошибках, чтобы не
     потерять последние секунды перед крашем.
     ================================================================ */
  const _PERSIST_KEY = 'tactics_debug_log_v1';
  const _PERSIST_INTERVAL_MS = 250;
  // Категории, которые НЕ триггерят персист (шумные, не критичны для
  // диагностики). При записи попадают в буфер, но запись в localStorage
  // не дёргают — она всё равно случится с ближайшим важным событием.
  const _PERSIST_SKIP_CATEGORIES = new Set(['render', 'scroll', 'dom-mutation']);
  let _persistTimer = null;
  let _persistDirty = false;
  let _persistDisabled = false; // выставляется в true если localStorage недоступен

  function _flushPersist() {
    _persistTimer = null;
    if (_persistDisabled) return;
    if (!_persistDirty) return;
    _persistDirty = false;
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        uptime_ms: Math.round(performance.now()),
        buffer: buffer.slice(),  // полный буфер (до 300 событий)
        state: (typeof _stateSnapshot === 'function') ? _stateSnapshot() : null,
      };
      localStorage.setItem(_PERSIST_KEY, JSON.stringify(payload));
    } catch (e) {
      // QuotaExceeded или localStorage недоступен — отключаем до перезагрузки.
      _persistDisabled = true;
      console.warn('[DebugLog] localStorage persist disabled:', e && e.message);
    }
  }

  function _schedulePersist(category) {
    _persistDirty = true;
    if (_PERSIST_SKIP_CATEGORIES.has(category)) return; // не дёргаем для шума
    if (_persistTimer) return;
    _persistTimer = setTimeout(_flushPersist, _PERSIST_INTERVAL_MS);
  }

  function _persistSyncNow() {
    // Синхронный flush — для beforeunload / onerror. Игнорируем throttle.
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    _persistDirty = true;
    _flushPersist();
  }

  function _push(record) {
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push(record);
    _schedulePersist(record.cat);
  }

  function log(category, message, data) {
    if (!enabled.has(category)) return;
    const rec = {
      t: Math.round(performance.now()),  // мс от загрузки страницы
      cat: category,
      msg: String(message == null ? '' : message),
    };
    if (data !== undefined) rec.data = _safeData(data);
    _push(rec);
  }

  /* Урезаем data до сериализуемого: примитивы as-is, объекты —
     поверхностный clone (1-2 уровня), массивы — slice до 20 элементов.
     Стек-трейсы оставляем как строки. */
  function _safeData(data) {
    if (data == null) return data;
    if (typeof data !== 'object') return data;
    if (Array.isArray(data)) {
      return data.slice(0, 20).map(_safeData);
    }
    const out = {};
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (v == null || typeof v !== 'object') {
        out[k] = v;
      } else if (Array.isArray(v)) {
        out[k] = v.slice(0, 20);
      } else {
        // Плоский clone объекта (без вложенных object'ов глубже 1 уровня).
        const clone = {};
        for (const kk of Object.keys(v)) {
          const vv = v[kk];
          clone[kk] = (vv == null || typeof vv !== 'object') ? vv : '[object]';
        }
        out[k] = clone;
      }
    }
    return out;
  }

  function _domRect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width), height: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
      bottom: Math.round(r.bottom), right: Math.round(r.right),
    };
  }

  function _stateSnapshot() {
    if (typeof state === 'undefined' || !state) return null;
    // Camp v1.5-popups (12.05.2026): добавлены campScreen, calendar,
    // pendingTrophyPopup, pendingCampEvents, monthEndSummary — чтобы
    // дамп показывал, какая модалка сейчас должна быть видна.
    let trophy = null;
    if (state.pendingTrophyPopup && state.pendingTrophyPopup.itemRef) {
      const it = state.pendingTrophyPopup.itemRef;
      trophy = {
        itemId: (typeof it === 'string') ? it : (it.id || null),
        itemName: (typeof it === 'object' && it) ? (it.name || null) : null,
        slotKind: (typeof it === 'object' && it) ? (it.slotKind || null) : null
      };
    }
    return {
      wave: state.wave ? { ...state.wave } : null,
      mode: state.mode,
      activeUnitId: state.activeUnitId,
      selectedUnitId: state.selectedUnitId,
      gameOver: state.gameOver,
      round: state.round,
      view: state.view ? { ...state.view } : null,
      activeLevelUp: state.activeLevelUp ? { ...state.activeLevelUp } : null,
      levelUpQueue: state.levelUpQueue ? state.levelUpQueue.slice() : null,
      unitsCount: Array.isArray(state.units) ? state.units.length : 0,
      objectsCount: Array.isArray(state.objects) ? state.objects.length : 0,
      treesCount: Array.isArray(state.trees) ? state.trees.length : 0,
      campScreen: state.campScreen || null,
      currentMissionRegionId: state.currentMissionRegionId || null,
      calendar: state.calendar ? { ...state.calendar } : null,
      pendingTrophyPopup: trophy,
      pendingCampEvents: Array.isArray(state.pendingCampEvents)
        ? state.pendingCampEvents.map(e => ({ kind: e && e.kind || null, text: e && e.text || null }))
        : state.pendingCampEvents,
      monthEndSummary: state.monthEndSummary ? {
        month: state.monthEndSummary.month,
        year: state.monthEndSummary.year,
        deltasCount: Array.isArray(state.monthEndSummary.deltas) ? state.monthEndSummary.deltas.length : 0
      } : null,
      partyCount: Array.isArray(state.party) ? state.party.length : 0,
      partyAliveCount: Array.isArray(state.party) ? state.party.filter(h => h && h.alive).length : 0,
    };
  }

  function _viewSnapshot() {
    const VIEW_obj = (typeof VIEW !== 'undefined') ? VIEW : null;
    return VIEW_obj ? { ...VIEW_obj } : null;
  }

  function snapshot() {
    const vp = document.getElementById('viewport');
    const bf = document.getElementById('battlefield');
    const html = document.documentElement;
    const body = document.body;
    return {
      timestamp: new Date().toISOString(),
      uptime_ms: Math.round(performance.now()),
      window: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio,
      },
      html: {
        scrollTop: html.scrollTop,
        scrollHeight: html.scrollHeight,
        clientHeight: html.clientHeight,
        clientWidth: html.clientWidth,
        overflow: getComputedStyle(html).overflow,
        style: html.style.cssText || '(empty)',
      },
      body: {
        scrollTop: body.scrollTop,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        clientWidth: body.clientWidth,
        overflow: getComputedStyle(body).overflow,
        style: body.style.cssText || '(empty)',
      },
      viewport: vp ? {
        rect: _domRect(vp),
        clientWidth: vp.clientWidth,
        clientHeight: vp.clientHeight,
      } : null,
      battlefield: bf ? {
        rect: _domRect(bf),
        cssCell: bf.style.getPropertyValue('--cell') || null,
        cssPanX: bf.style.getPropertyValue('--pan-x') || null,
        cssPanY: bf.style.getPropertyValue('--pan-y') || null,
      } : null,
      activeElement: document.activeElement ? {
        tag: document.activeElement.tagName,
        id: document.activeElement.id || null,
        className: document.activeElement.className || null,
      } : null,
      state: _stateSnapshot(),
      VIEW: _viewSnapshot(),
      categoriesEnabled: Array.from(enabled),
      buffer: buffer.slice(-SNAPSHOT_BUFFER_TAIL),
    };
  }

  function dump() {
    try {
      return JSON.stringify(snapshot(), null, 2);
    } catch (e) {
      return JSON.stringify({ error: 'dump failed: ' + (e && e.message) }, null, 2);
    }
  }

  function copyToClipboard() {
    const text = dump();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(() => {
          console.log('[DebugLog] Дамп скопирован в буфер обмена (' + text.length + ' символов). Вставьте в чат.');
          return true;
        })
        .catch(err => {
          console.warn('[DebugLog] navigator.clipboard.writeText упал, fallback на console:', err);
          console.log(text);
          return false;
        });
    }
    // Старые браузеры — fallback через текстовый area + execCommand.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      console.log('[DebugLog] Дамп скопирован через fallback (' + text.length + ' символов).');
      return Promise.resolve(ok);
    } catch (e) {
      console.warn('[DebugLog] fallback не сработал, выводим в console:', e);
      console.log(text);
      return Promise.resolve(false);
    }
  }

  function enable(cat) { enabled.add(cat); }
  function disable(cat) { enabled.delete(cat); }
  function clear() { buffer.length = 0; }

  // === ГЛОБАЛЬНЫЕ ПЕРЕХВАТЧИКИ ====================================

  // 1. Скролл окна. Любое изменение window.scrollY → лог + stack.
  //    Capture-фаза, чтобы перехватить даже если scroll-event
  //    остановят на каком-то элементе.
  let _lastScrollY = 0;
  let _lastScrollX = 0;
  window.addEventListener('scroll', () => {
    const sy = window.scrollY, sx = window.scrollX;
    if (sy !== _lastScrollY || sx !== _lastScrollX) {
      const stack = (new Error()).stack;
      log('scroll', 'window scroll changed', {
        from: { x: _lastScrollX, y: _lastScrollY },
        to: { x: sx, y: sy },
        stack: stack ? stack.split('\n').slice(2, 8).join('\n') : null,
      });
      _lastScrollY = sy;
      _lastScrollX = sx;
    }
  }, true);

  // 2. MutationObserver на inline-стили html/body. Поймает любого, кто
  //    меняет overflow/transform/etc через element.style.* или style.cssText.
  if (typeof MutationObserver === 'function') {
    const styleObs = new MutationObserver(records => {
      for (const r of records) {
        if (r.attributeName !== 'style') continue;
        const el = r.target;
        log('dom-mutation', el.tagName + ' inline-style changed', {
          tag: el.tagName,
          newStyle: el.style.cssText || '(empty)',
          oldStyle: r.oldValue || '(unknown)',
        });
      }
    });
    try {
      styleObs.observe(document.documentElement, {
        attributes: true, attributeFilter: ['style'], attributeOldValue: true
      });
      styleObs.observe(document.body, {
        attributes: true, attributeFilter: ['style'], attributeOldValue: true
      });
    } catch (e) {
      log('error', 'MutationObserver setup failed', { error: String(e) });
    }
  }

  // 2b. Обёртки нативных API, которые могут вызвать скролл.
  //     Перехват синхронный → стек указывает на конкретное место в коде,
  //     откуда был вызван метод. scroll-event ниже даёт только сам факт,
  //     стек там обычно пустой/внутренний.
  function _wrap(obj, name, label) {
    if (!obj || typeof obj[name] !== 'function') return;
    const orig = obj[name];
    obj[name] = function () {
      try {
        const stack = (new Error()).stack;
        const args = Array.prototype.slice.call(arguments).map(a => {
          if (a == null) return a;
          if (typeof a === 'object') {
            try { return JSON.parse(JSON.stringify(a)); } catch (_) { return '[object]'; }
          }
          return a;
        });
        log('scroll', label + '() called', {
          target: this && this.tagName ? this.tagName + (this.id ? '#' + this.id : '') : '(window)',
          args: args,
          stack: stack ? stack.split('\n').slice(2, 9).join('\n') : null,
        });
      } catch (_) { /* лог не должен ронять оригинал */ }
      return orig.apply(this, arguments);
    };
  }
  _wrap(window, 'scrollTo', 'window.scrollTo');
  _wrap(window, 'scrollBy', 'window.scrollBy');
  if (typeof Element !== 'undefined' && Element.prototype) {
    _wrap(Element.prototype, 'scrollTo', 'Element.scrollTo');
    _wrap(Element.prototype, 'scrollBy', 'Element.scrollBy');
    _wrap(Element.prototype, 'scrollIntoView', 'Element.scrollIntoView');
  }
  // focus() с дефолтными опциями вызывает scroll-into-view браузером.
  // Логируем focus только если targetElement не равен document.activeElement
  // на момент вызова — иначе шум от фокусировки уже-сфокусированных элементов.
  if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype) {
    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options) {
      try {
        const sameTarget = (document.activeElement === this);
        if (!sameTarget) {
          const stack = (new Error()).stack;
          log('scroll', 'HTMLElement.focus() (may scroll)', {
            target: this.tagName + (this.id ? '#' + this.id : ''),
            preventScroll: !!(options && options.preventScroll),
            stack: stack ? stack.split('\n').slice(2, 9).join('\n') : null,
          });
        }
      } catch (_) { /* */ }
      return origFocus.apply(this, arguments);
    };
  }

  // 3. Глобальные ошибки и rejected promises.
  window.addEventListener('error', e => {
    log('error', e.message || 'error event', {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: (e.error && e.error.stack) ? e.error.stack.split('\n').slice(0, 8).join('\n') : null,
    });
    // Camp v1.5-popups (12.05.2026): sync-flush буфера в localStorage —
    // если игра сейчас умрёт, последние события не потеряются.
    try { _persistSyncNow(); } catch (_) {}
  });

  // 3. unhandledrejection.
  window.addEventListener('unhandledrejection', e => {
    log('error', 'unhandled promise rejection', {
      reason: String(e.reason),
      stack: (e.reason && e.reason.stack) ? e.reason.stack.split('\n').slice(0, 8).join('\n') : null,
    });
    try { _persistSyncNow(); } catch (_) {}
  });

  // 4. beforeunload - last chance flush.
  window.addEventListener('beforeunload', () => {
    try { _persistSyncNow(); } catch (_) {}
  });

  function persistedDump() {
    try {
      const raw = localStorage.getItem(_PERSIST_KEY);
      return raw || '(empty)';
    } catch (e) {
      return '(error: ' + (e && e.message) + ')';
    }
  }
  function copyPersistedToClipboard() {
    const text = persistedDump();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(() => { console.log('[DebugLog] persisted dump copied (' + text.length + ' chars)'); return true; })
        .catch(err => { console.warn('[DebugLog] copy failed:', err); console.log(text); return false; });
    }
    console.log(text);
    return Promise.resolve(false);
  }
  function clearPersisted() {
    try { localStorage.removeItem(_PERSIST_KEY); } catch (_) {}
  }

  window.DebugLog = {
    log, snapshot, dump, copyToClipboard,
    enable, disable, clear,
    persistedDump, copyPersistedToClipboard, clearPersisted,
    flushPersist: _persistSyncNow,
    get buffer() { return buffer.slice(); },
    get bufferSize() { return buffer.length; },
    get persistKey() { return _PERSIST_KEY; },
  };
  log('init', 'DebugLog initialized', { maxBuffer: MAX_BUFFER, persistKey: _PERSIST_KEY });
})();
