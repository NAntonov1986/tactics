/* render.js (render/) — оркестратор рендера и шаренные хелперы.

   Что внутри:
     • `render()` — единственная точка входа из боя/UI. Вызывает все
       специализированные `renderXxx` в фиксированном порядке: сетка
       → юниты → overlay → инициатива → портрет → нижняя панель → лог
       → game-over. Порядок намеренный: сетка должна быть первой
       (она статична и рисуется один раз), overlay поверх юнитов,
       game-over поверх всего.
     • `renderClassVisual(parentEl, cls, opts)` — общий хелпер,
       вставляющий в DOM-контейнер либо `<img>` (sprite), либо
       textContent (emoji). Используется renderUnits, renderInitiative
       (через визуал в чипе очерёдности), и tomb-tooltip-частью units
       (через classVisualHtml, см. ниже).
     • `classVisualHtml(cls)` — HTML-вариант того же самого (для
       innerHTML-шаблонов): возвращает либо `<img src="…">`, либо строку-эмодзи.
       Используется в `renderUnits` (tooltip надгробия — innerHTML)
       и `renderPortraitPanel` (innerHTML портрета).
     • `statIconHtml(key, label, opts)` — HTML для иконки характеристики
       (sprite или emoji) из STAT_ICONS[key]. Префикс CSS-классов задаётся
       через opts.classPrefix: 'stat' (по умолчанию, для нижней панели
       юнита) или 'lu-stat' (для окна прокачки). Используется в
       render-panel.js (секция «Характеристики») и render-level-up.js
       (карточки выбора +2 и шапка окна апа). До 06.05.2026 жили две
       разные копии этой логики — после унификации источник один здесь.
     • `renderGrid()` — статичная сетка 20×20. Рисуется ОДИН раз: при
       первом вызове создаёт N×M `.cell`-divs в `#gridLayer`, при
       последующих — выходит сразу (сетка не меняется по ходу боя).
     • `renderGameOver()` — оверлей конца игры/волны. При
       `state.gameOver === 'defeat'` показывает «Поражение» с указанием
       номера павшей волны и кнопку «Новый бой» (зовёт `restartGame`).
       Если `state.gameOver === null` — скрывает оверлей.

   Что НЕ внутри:
     • `renderUnits` + анимации юнитов — `render/render-units.js`.
     • `renderOverlay` + превью маршрута/AoE — `render/render-overlay.js`.
     • Спецэффекты на effects-layer (вспышка фаербола) —
       `render/render-effects.js`.
     • `renderLog` + log-writer — `render/render-log.js`.
     • `renderInitiative` — `render/render-initiative.js`.
     • `renderPortraitPanel` + `renderBottomPanel` — `render/render-panel.js`.

   Где править:
     • Порядок слоёв рендера (если поменяется глубина: например, сначала
       initiative, потом units) — `render()`.
     • Размер сетки — НЕ ЗДЕСЬ. Меняется в `state.grid.rows/cols`
       (определяется в `core/state.js` → `createInitialState`). renderGrid
       просто читает state.grid.
     • Экран конца игры (новые состояния `gameOver`: 'pause', 'paused-by-ai'
       и т.п.) — `renderGameOver`.

   Тонкость с порядком загрузки. render.js подключается ПЕРВЫМ среди
   `render/*` — он определяет шаренные хелперы, на которые опираются
   остальные render-модули. Тела renderClassVisual/classVisualHtml
   читают `cls.visual` без обращения к state, поэтому безопасны
   на любом этапе бутстрапа. Имена `renderUnits`/`renderOverlay`/
   `renderInitiative`/`renderPortraitPanel`/`renderBottomPanel`/
   `renderLog`, на которые ссылается `render()`, резолвятся в момент
   ВЫЗОВА — к первому вызову render() (внутри `init()` или `startNextWave`)
   все render-модули уже загружены.

   Внешние имена через script-scope (резолв при вызове):
   `state` (core/state), `restartGame` (core/state),
   `renderUnits`/`renderOverlay`/`renderInitiative`/`renderPortraitPanel`/
   `renderBottomPanel`/`renderLog` (render/render-*.js). */

function render() {
  if (typeof DebugLog !== 'undefined') DebugLog.log('render', 'render() top-level', { mode: state && state.mode, activeUnitId: state && state.activeUnitId });
  renderGrid();
  // С22: объекты на поле (капканы, приманки) — слой #objectsLayer ПОД
  // юнитами визуально. Рендерим до renderUnits — порядок DOM не влияет
  // (z-index задаётся слоями), но логически объекты на сцене существуют
  // независимо от юнитов и должны попасть в DOM до них.
  if (typeof renderObjects === 'function') renderObjects();
  renderUnits();
  renderOverlay();
  renderInitiative();
  renderPortraitPanel();
  renderBottomPanel();
  renderLog();
  renderGameOver();
  // С1-предметы: оверлей инвентаря отряда. Скрыт, если state.inventoryOpen
  // не установлен (флаг переключается toggleInventoryOverlay из hotkeys).
  if (typeof renderInventoryOverlay === 'function') renderInventoryOverlay();
  // Camp v1: оверлей лагеря/глобальной карты. Виден когда state.campScreen
  // не null. Перекрывает поле боя; инвентарь по-прежнему может открываться
  // поверх (z-index 950 > 940).
  if (typeof renderCampOverlay === 'function') renderCampOverlay();
  // Camp v1.5-popups (12.05.2026): модальные попапы трофея и событий.
  // Trophy — на поле боя, после level-up, до лагеря. Events — при входе
  // в лагерь, поверх campScreen. См. render-modals.js.
  if (typeof renderTrophyPopup === 'function') renderTrophyPopup();
  if (typeof renderEventsPopup === 'function') renderEventsPopup();
  // Camp v1.5-popups (12.05.2026): попап-предупреждение «лёгкая миссия».
  if (typeof renderMissionWarning === 'function') renderMissionWarning();
}

/* Универсальный рендер визуала класса (emoji/sprite) внутрь DOM-контейнера.
   Используется на поле (.unit-inner), в портрете в боковой панели, в чипах
   очерёдности, в мини-портрете на тултипе могилы. Контейнер очищается,
   затем туда пишется либо textContent (эмодзи), либо <img> со спрайтом.
   Вернёт DOM-узел (img или текстовый узел) — на случай, если вызывающему
   коду нужно что-то с ним ещё сделать. */
function renderClassVisual(parentEl, cls, opts) {
  if (!parentEl || !cls || !cls.visual) return null;
  parentEl.innerHTML = '';
  const v = cls.visual;
  if (v.type === 'sprite' && v.src) {
    const img = document.createElement('img');
    img.src = v.src;
    img.alt = (cls.name || '');
    if (opts && opts.imgClass) img.className = opts.imgClass;
    parentEl.appendChild(img);
    return img;
  }
  // emoji-fallback: либо честный type:'emoji', либо спрайт без src/неизвестного
  // типа — в любом случае берём v.symbol, чтобы не показывать «?».
  const txt = v.symbol || '?';
  parentEl.textContent = txt;
  return parentEl.firstChild;
}

/* HTML-вариант для случаев, где визуал юнита надо вставить в шаблонную
   строку (innerHTML). Возвращает либо эмодзи-символ, либо тег <img>.
   Безопасно для контейнеров фиксированного размера: CSS .portrait img
   и т.п. растягивает картинку до 100%. */
function classVisualHtml(cls) {
  if (!cls || !cls.visual) return '';
  const v = cls.visual;
  if (v.type === 'sprite' && v.src) {
    const alt = (cls.name || '').replace(/"/g, '&quot;');
    return `<img src="${v.src}" alt="${alt}">`;
  }
  return v.symbol || '?';
}

/* statIconHtml(key, label, opts) — HTML для иконки характеристики.
   Читает запись из STAT_ICONS[key] (см. data/stats.js):
     { type: 'sprite', src: '...' } → <img class="${prefix}-icon" src=...>
     { type: 'emoji',  char: '...' } → <span class="${prefix}-emoji">...</span>
   Если запись отсутствует или поля невалидны — возвращает '' (caller
   получает пустоту, ячейка визуально схлопывается).

   Параметр opts:
     • classPrefix — префикс имён CSS-классов:
         'stat'    (по умолчанию) — для нижней панели юнита
                                    (.stat-icon / .stat-emoji);
         'lu-stat' — для окна прокачки (карточки выбора +2 и шапки)
                                    (.lu-stat-icon / .lu-stat-emoji).
       Если в будущем появится третий читатель с другим CSS-окружением,
       передаст свой префикс — общий код переиспользуется.

   label — человекочитаемая подпись для alt/aria-label. Обычно
   STAT_LABELS[key]. Если не передана — фолбэк на сам key.

   Унифицировано 06.05.2026: до этого момента эта же логика
   дублировалась в render-panel.js (inline в renderBottomPanel) и
   в render-level-up.js (локальный renderStatIconHtml). Теперь оба
   читателя зовут эту функцию. */
function statIconHtml(key, label, opts) {
  const icon = (typeof STAT_ICONS === 'object' && STAT_ICONS) ? STAT_ICONS[key] : null;
  if (!icon) return '';
  const prefix = (opts && opts.classPrefix) || 'stat';
  const labelEsc = String(label != null ? label : key).replace(/"/g, '&quot;');
  if (icon.type === 'sprite' && icon.src) {
    const srcEsc = String(icon.src).replace(/"/g, '&quot;');
    return `<img class="${prefix}-icon" src="${srcEsc}" alt="${labelEsc}">`;
  }
  if (icon.type === 'emoji' && icon.char) {
    // Минимальный escape для emoji-char (на всякий — обычно это
    // пиктограмма без спецсимволов, но защита от случайного '<').
    const charEsc = String(icon.char)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="${prefix}-emoji" role="img" aria-label="${labelEsc}">${charEsc}</span>`;
  }
  return '';
}

function renderGrid() {
  const gridLayer = document.getElementById('gridLayer');
  if (gridLayer.children.length > 0) return; // сетка статична, рисуем 1 раз
  const frag = document.createDocumentFragment();
  for (let r = 0; r < state.grid.rows; r++) {
    for (let c = 0; c < state.grid.cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell ' + (((r + c) % 2 === 0) ? 'even' : 'odd');
      cell.dataset.row = r;
      cell.dataset.col = c;
      frag.appendChild(cell);
    }
  }
  gridLayer.appendChild(frag);
}

function renderGameOver() {
  const overlay = document.getElementById('gameOverOverlay');
  if (!overlay) return;
  if (!state.gameOver) {
    overlay.style.display = 'none';
    overlay.innerHTML = '';
    return;
  }
  overlay.style.display = '';
  let title, sub;
  if (state.gameOver === 'defeat') {
    title = 'Поражение';
    const waveNum = (state.wave && state.wave.number) || 1;
    sub = `Все герои повержены в битве ${waveNum}`;
  } else if (state.gameOver === 'A') { title = 'Победа красных'; sub = 'Команда A выжила'; }
  else if (state.gameOver === 'B')   { title = 'Победа синих';   sub = 'Команда B выжила'; }
  else                                { title = 'Ничья';          sub = 'Все повержены';   }
  overlay.innerHTML = `
    <div class="victory-title">${title}</div>
    <div class="victory-sub">${sub}</div>
    <button class="restart-btn" id="restartBtn">Новый бой</button>
  `;
  document.getElementById('restartBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    restartGame();
  });
}
