/* tooltip.js — кастомный фэнтези-тултип, заменяющий нативный browser-title.

   ИНТЕГРАЦИЯ С АРХИТЕКТУРОЙ ПРОЕКТА:
     • Никаких правок в render-panel.js / других модулях не требуется.
       render-panel.js по-прежнему пишет `title="..."` на слотах, чипах,
       кнопках. Этот скрипт перехватывает наведение мышки и рисует свой
       popup, скрывая нативный.
     • При первом наведении на элемент с `title="..."` мы
       переносим значение в `data-tip-title` (и опционально парсим как
       JSON в `data-tip`), а сам атрибут title зачищаем — браузер
       перестаёт показывать нативный «жёлтый прямоугольник».
     • Дополнительно поддерживается богатый формат: `data-tip='{"title":"...",
       "subtitle":"...","lines":[...],"warn":[...],"icon":"path","emoji":"🔥"}'`.
       Если render когда-нибудь начнёт писать `data-tip=` — будет
       автоматически рендериться полная карточка с большой иконкой.

   СТИЛИ:
     • Три темы: `codex` / `forged` / `sigil` — переключаются через
       `<html data-tip-style="...">` (см. tooltip.css). Текущая тема
       сохраняется в localStorage.
     • Опциональная Tweaks-панель в правом верхнем углу — переключатель
       темы. Активируется ТОЛЬКО если в DOM есть `<html data-tweaks="on">`
       или вручную `Tooltip.showTweaks()`. Скрытая по умолчанию.

   API (window.Tooltip):
     • Tooltip.init()              — создать DOM, повесить хендлеры.
                                      Безопасно вызывать много раз.
     • Tooltip.setStyle(name)      — сменить тему (`codex|forged|sigil`).
     • Tooltip.showTweaks()        — показать Tweaks-панель.
     • Tooltip.hideTweaks()        — скрыть.

   Что НЕ внутри:
     • Сам стиль тултипа — `styles/tooltip.css`.
     • Логика игры/панели/слотов — `src/render/render-panel.js` и т.д.
*/

(function () {
  if (window.Tooltip) return;  // не пере-инициализируемся

  const STORAGE_KEY = 'tooltipStyle';
  const STYLES = ['codex', 'forged', 'sigil'];
  const DEFAULT_STYLE = 'forged';

  let tipEl = null;          // #customTooltip
  let tweaksEl = null;       // .tooltip-tweaks
  let currentTarget = null;  // элемент, из которого сейчас читается тип
  let rafId = null;
  let lastMouse = { x: 0, y: 0 };

  /* ============ DOM ============ */
  function buildTooltip() {
    if (tipEl) return tipEl;
    const el = document.createElement('div');
    el.id = 'customTooltip';
    el.className = 'custom-tooltip';
    el.innerHTML = `
      <div class="tt-icon"></div>
      <div class="tt-text">
        <div class="tt-title"></div>
        <div class="tt-subtitle"></div>
        <div class="tt-body"></div>
      </div>
    `;
    document.body.appendChild(el);
    tipEl = el;
    return el;
  }

  function buildTweaks() {
    if (tweaksEl) return tweaksEl;
    const el = document.createElement('div');
    el.className = 'tooltip-tweaks';
    el.innerHTML = `
      <div class="tt-tweaks-title">Стиль подсказок</div>
      <div class="tt-tweaks-options">
        ${STYLES.map(s => `
          <label>
            <input type="radio" name="tt-style" value="${s}">
            <span>${labelOf(s)}</span>
          </label>
        `).join('')}
      </div>
      <div class="tt-tweaks-hint">меняется мгновенно, сохраняется в браузере</div>
    `;
    document.body.appendChild(el);
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'tt-style') setStyle(t.value);
    });
    tweaksEl = el;
    syncTweaksRadios();
    return el;
  }

  function labelOf(s) {
    return s === 'codex'  ? 'Пергамент (codex)'
         : s === 'forged' ? 'Кованая плашка (forged)'
         : s === 'sigil'  ? 'Стеклянный сигил (sigil)'
         : s;
  }

  /* ============ ТЕМА ============ */
  function setStyle(name) {
    if (!STYLES.includes(name)) return;
    document.documentElement.setAttribute('data-tip-style', name);
    try { localStorage.setItem(STORAGE_KEY, name); } catch (_) {}
    syncTweaksRadios();
  }

  function syncTweaksRadios() {
    if (!tweaksEl) return;
    const cur = document.documentElement.getAttribute('data-tip-style') || DEFAULT_STYLE;
    tweaksEl.querySelectorAll('input[name="tt-style"]').forEach(r => {
      r.checked = (r.value === cur);
    });
  }

  function loadStoredStyle() {
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    setStyle(STYLES.includes(saved) ? saved : DEFAULT_STYLE);
  }

  /* ============ ЧТЕНИЕ ДАННЫХ ИЗ ЭЛЕМЕНТА ============ */
  /* Возвращает объект {title, subtitle, lines[], warn[], icon, emoji} или null,
     если элемент не несёт никакой подсказки. */
  function readTipData(el) {
    if (!el) return null;

    // 1) Богатый формат: data-tip='{"title":"...","lines":[...]}'
    const rich = el.getAttribute('data-tip');
    if (rich) {
      try {
        const obj = JSON.parse(rich);
        if (obj && typeof obj === 'object') return normalizeTip(obj);
      } catch (_) { /* ignore — упадём в title-парсер */ }
    }

    // 2) Раньше уже перенесли title → data-tip-title — берём из кеша.
    let raw = el.getAttribute('data-tip-title');

    // 3) Первое появление: переносим title → data-tip-title и зачищаем title,
    //    чтобы браузер перестал рисовать нативный popup.
    if (raw == null) {
      const title = el.getAttribute('title');
      if (title != null) {
        raw = title;
        el.setAttribute('data-tip-title', raw);
        el.removeAttribute('title');
      }
    }

    if (raw == null || raw === '') return null;
    return parsePlainTitle(raw, el);
  }

  /* Превращает обычный title='Лук\nДальность 4\nформула…' в структурированный
     объект. Первая строка — заголовок, вторая (если она «короткая капс»-метка
     или начинается с «—» / типа доставки) — subtitle, остальное — lines. */
  function parsePlainTitle(raw, el) {
    const lines = String(raw).split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    const title = lines.shift();
    let subtitle = null;
    if (lines.length && /^(физический|огненный|морозный|электрический|ядовитый|магический|святой|специальный|по площади|ближний|дальний|melee|ranged|aoe)/i.test(lines[0])) {
      subtitle = lines.shift();
    }
    // Иконка выводится из <img> внутри элемента — она же spriteSrc у
    // скилла/оружия/стата/класса. Если <img> нет, tip.icon остаётся
    // null, рендерер переключает карточку в .no-icon (грид схлопывается,
    // текст занимает всю ширину). Автоматический emoji-fallback из
    // text-контента отключён — пользовательское решение «при наличии
    // спрайтов эмодзи в тултипе не нужны». Богатый формат
    // data-tip='{"emoji":"..."}' по-прежнему работает (см. renderTip
    // и normalizeTip) — но render-panel им сейчас не пользуется.
    const tip = { title, subtitle, lines, warn: [] };
    const img = el.querySelector('img');
    if (img && img.src) {
      tip.icon = img.src;
    }
    return tip;
  }

  function normalizeTip(obj) {
    return {
      title:    obj.title    || '',
      subtitle: obj.subtitle || null,
      lines:    Array.isArray(obj.lines) ? obj.lines : [],
      warn:     Array.isArray(obj.warn)  ? obj.warn  : [],
      icon:     obj.icon     || null,
      emoji:    obj.emoji    || null,
    };
  }

  /* ============ РЕНДЕР ============ */
  function renderTip(data) {
    const el = buildTooltip();
    const iconBox = el.querySelector('.tt-icon');
    const titleEl = el.querySelector('.tt-title');
    const subEl   = el.querySelector('.tt-subtitle');
    const bodyEl  = el.querySelector('.tt-body');

    // ─── ИКОНКА ───
    iconBox.innerHTML = '';
    if (data.icon) {
      const img = document.createElement('img');
      img.src = data.icon;
      img.alt = '';
      iconBox.appendChild(img);
      el.classList.remove('no-icon');
    } else if (data.emoji) {
      const span = document.createElement('span');
      span.className = 'tt-emoji';
      span.textContent = data.emoji;
      iconBox.appendChild(span);
      el.classList.remove('no-icon');
    } else {
      el.classList.add('no-icon');
    }

    // ─── ЗАГОЛОВОК / ПОДЗАГОЛОВОК ───
    titleEl.textContent = data.title || '';
    titleEl.style.display = data.title ? '' : 'none';
    subEl.textContent = data.subtitle || '';
    subEl.style.display = data.subtitle ? '' : 'none';

    // ─── ТЕЛО ───
    bodyEl.innerHTML = '';
    (data.lines || []).forEach(line => {
      if (!line) return;
      const div = document.createElement('div');
      div.className = 'tt-line';
      div.textContent = line;
      bodyEl.appendChild(div);
    });
    if ((data.warn || []).length && (data.lines || []).length) {
      const sep = document.createElement('div');
      sep.className = 'tt-line tt-divider';
      bodyEl.appendChild(sep);
    }
    (data.warn || []).forEach(line => {
      if (!line) return;
      const div = document.createElement('div');
      div.className = 'tt-line tt-warn';
      div.textContent = line;
      bodyEl.appendChild(div);
    });
  }

  /* ============ ПОЗИЦИОНИРОВАНИЕ ============ */
  function positionTip(x, y) {
    if (!tipEl) return;
    const margin = 14;        // отступ от курсора
    const pad = 8;            // зажатие в viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = tipEl.getBoundingClientRect();
    let left = x + margin;
    let top  = y + margin;
    if (left + rect.width + pad > vw) left = x - margin - rect.width;
    if (top  + rect.height + pad > vh) top  = y - margin - rect.height;
    if (left < pad) left = pad;
    if (top  < pad) top  = pad;
    tipEl.style.left = left + 'px';
    tipEl.style.top  = top  + 'px';
  }

  /* ============ ХЕНДЛЕРЫ ============ */
  function show(target, mx, my) {
    const data = readTipData(target);
    if (!data) { hide(); return; }
    currentTarget = target;
    renderTip(data);
    // Сразу делаем visible — иначе у элемента visibility:hidden и
    // getBoundingClientRect возвращает 0×0, что ломает positionTip.
    // Двойное позиционирование (сразу + после rAF) гарантирует, что
    // popup не «прыгает» при первом появлении.
    tipEl.classList.add('visible');
    positionTip(mx, my);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => positionTip(mx, my));
  }

  function move(mx, my) {
    if (!currentTarget) return;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => positionTip(mx, my));
  }

  function hide() {
    currentTarget = null;
    if (tipEl) tipEl.classList.remove('visible');
  }

  /* Ищем ближайший «носитель тултипа» — элемент с title/data-tip/data-tip-title.
     Скипаем элементы внутри уже обработанного, чтобы не перепрыгивать тултип
     при движении мыши по дочерним нодам. */
  function findTipHost(node) {
    while (node && node !== document.body) {
      if (node.nodeType === 1) {
        if (node.hasAttribute('data-tip') ||
            node.hasAttribute('data-tip-title') ||
            node.hasAttribute('title')) {
          return node;
        }
      }
      node = node.parentNode;
    }
    return null;
  }

  function onMouseOver(e) {
    const host = findTipHost(e.target);
    if (!host) {
      // Курсор покинул область с подсказкой
      if (currentTarget && !currentTarget.contains(e.target)) hide();
      return;
    }
    if (host !== currentTarget) {
      show(host, e.clientX, e.clientY);
    }
  }

  function onMouseMove(e) {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
    if (currentTarget) move(e.clientX, e.clientY);
  }

  function onMouseOut(e) {
    if (!currentTarget) return;
    // Покинули currentTarget наружу (relatedTarget вне него) — гасим.
    const to = e.relatedTarget;
    if (!to || !currentTarget.contains(to)) hide();
  }

  function onScroll() { hide(); }

  /* ============ ИНИЦИАЛИЗАЦИЯ ============ */
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    buildTooltip();
    buildTweaks();
    loadStoredStyle();
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseout',  onMouseOut,  true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur',   hide);
    // Если страница что-то рендерит асинхронно — нативный title мог
    // появиться позже. Не страшно: readTipData ловит его при первом hover.
  }

  /* ============ ПУБЛИЧНОЕ API ============ */
  window.Tooltip = {
    init,
    setStyle,
    showTweaks() { buildTweaks().classList.add('visible'); },
    hideTweaks() { if (tweaksEl) tweaksEl.classList.remove('visible'); },
    toggleTweaks() {
      const el = buildTweaks();
      el.classList.toggle('visible');
    },
  };

  // Авто-инициализация после загрузки DOM, чтобы можно было просто
  // подключить скрипт и забыть.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
