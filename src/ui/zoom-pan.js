/* zoom-pan.js (ui/) — камера: зум и панорама поля.

   Что внутри:
     • `VIEW` — конфиг камеры: размер viewport (динамически
       синхронизируется с DOM), базовый размер клетки (постоянный
       40px), пределы зума (0.5–2.7), шаг колеса (0.15), шаг
       стрелок (40px), порог драга (4px).
     • `scaledGridWidth()` / `scaledGridHeight()` — текущий размер
       сцены в пикселях с учётом зума. Используется `clampPan` для
       расчёта границ панорамы.
     • `syncViewSize()` — синхронизирует `VIEW.width/height` с
       реальными `clientWidth`/`clientHeight` контейнера `#viewport`.
       Вызывается при init/resize и каждом applyView. Раскладка гибкая —
       поле тянется за окном, зашитые 720×600 не подходят.
     • `applyView()` — применяет текущее состояние камеры к DOM.
       Sync size → clamp → выставляет CSS-переменные `--cell`/`--pan-x`/
       `--pan-y` на `.battlefield` и обновляет индикатор зума.
       Зум реализован как изменение `--cell` (физический размер клетки),
       а не CSS scale всей сцены: даёт чёткие края pixel-art и
       предотвращает «скачки» юнитов с их `transform: translate`.
     • `clampPan()` — зажимает `state.view.panX/Y` так, чтобы края
       сцены не уходили внутрь viewport (нет «пустоты» по краям).
       Если сцена меньше viewport — центрирует.
     • `setZoomAt(newZoom, vpX, vpY)` — зум с сохранением точки под
       курсором. vpX/vpY — координаты курсора внутри viewport
       (в пикселях). Математика: `panX_new = vpX - f*(vpX - panX)`,
       где `f = newZoom / oldZoom`. Зум зажимается в `[minZoom, maxZoom]`.
     • `panBy(dx, dy)` — сдвигает камеру на dx/dy и применяет.
     • `resetView()` — возвращает зум 1.0 и pan 0,0.
     • `setupViewInteractions()` — регистрирует все event-listener-ы
       камеры: window resize, viewport wheel (зум вокруг курсора),
       mousedown/mousemove/mouseup для драга (левая и средняя кнопки —
       обе панорамируют; левая отличает клик от драга по порогу
       `dragThreshold`), capture-фаза click для подавления клика после
       драга, auxclick для блокировки автоскролла средней кнопкой,
       window keydown для камера-стрелок/`+/-/0`, и три кнопки зума
       (#zoomIn/#zoomOut/#zoomReset). Зовётся один раз из `init()`.

   Что НЕ внутри:
     • Режимы прицеливания, клик-обработчики юнитов и панели —
       `ui/input.js` (R18).
     • Горячие клавиши действий (Esc/M/A/F/Enter) — `ui/hotkeys.js`
       (R18). Камера-клавиши (Arrow-клавиши/+/-/0) живут здесь, потому что
       зашиты внутрь `setupViewInteractions` и тесно связаны с зумом/
       панорамой.
     • Старт игры (`init()`) — `core/state.js` (R16).

   Тонкость с keydown. В `setupViewInteractions` зарегистрирован
   window keydown для камера-клавиш (Arrow-клавиши/+/-/0). В `bindHotkeys`
   (`ui/hotkeys.js`) — ещё один window keydown для действий
   (Esc/M/A/F/Enter). Они не пересекаются по ключам, но оба используют
   `e.preventDefault()`. Если ключ обработан камерой — `handled = true`,
   preventDefault блокирует bubbling default; если не обработан —
   `handled = false`, событие распространяется дальше (включая ко
   второму keydown-обработчику hotkeys).

   Где править:
     • Пределы/шаг зума — поля `VIEW`.
     • Чувствительность драга — `VIEW.dragThreshold`.
     • Поведение драга средней кнопкой / горячих клавиш камеры —
       внутри `setupViewInteractions`.

   Внешние имена через script-scope (резолв при вызове):
   `state` (core/state). */

const VIEW = {
  width: 720,            // перекрывается динамически по реальному размеру viewport
  height: 600,           // перекрывается динамически по реальному размеру viewport
  cellPx: 40,            // базовый размер клетки — постоянный
  defaultZoom: 1.0,
  minZoom: 0.5,
  maxZoom: 2.7,
  zoomStep: 0.15,
  panKeyStep: 40,
  dragThreshold: 4       // пикселей — выше этого порога движение при mousedown считается драгом
};

function scaledGridWidth()  { return VIEW.cellPx * state.grid.cols * state.view.zoom; }
function scaledGridHeight() { return VIEW.cellPx * state.grid.rows * state.view.zoom; }

/* Синхронизируем VIEW.width/height с реальными размерами контейнера.
   Раскладка гибкая — поле занимает всё доступное пространство по ширине,
   поэтому фиксированные 720×600 из прошлых сессий больше не подходят:
   если оставить их, clampPan будет считать рамку уже фактической и
   не даст докрутить до края. Вызываем при init, при resize и при каждом
   applyView (дёшево — просто чтение clientWidth/clientHeight). */
function syncViewSize() {
  const vp = document.getElementById('viewport');
  if (!vp) return;
  const w = vp.clientWidth;
  const h = vp.clientHeight;
  if (w > 0) VIEW.width = w;
  if (h > 0) VIEW.height = h;
}

function applyView() {
  const bf = document.getElementById('battlefield');
  if (!bf || !state) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('camera', 'applyView', { view: { ...state.view }, vp: { w: VIEW.width, h: VIEW.height } });
  syncViewSize();
  clampPan();
  // Зум = физический размер клетки. Все размеры и координаты
  // внутри .battlefield завязаны на --cell, поэтому изменение этой
  // переменной пропорционально пересчитывает всё содержимое
  // (включая font-size эмодзи) — никакого битмап-апскейла, края чёткие.
  const cell = VIEW.cellPx * state.view.zoom;
  bf.style.setProperty('--cell', cell + 'px');
  bf.style.setProperty('--pan-x', state.view.panX + 'px');
  bf.style.setProperty('--pan-y', state.view.panY + 'px');
  const ind = document.getElementById('zoomIndicator');
  if (ind) ind.textContent = Math.round(state.view.zoom * 100) + '%';
}

function clampPan() {
  const gridW = scaledGridWidth();
  const gridH = scaledGridHeight();
  // Если сцена меньше viewport — центрируем, иначе зажимаем так, чтобы края сцены
  // не уходили внутрь viewport (не было «пустоты» по краям).
  if (gridW <= VIEW.width) {
    state.view.panX = (VIEW.width - gridW) / 2;
  } else {
    state.view.panX = Math.min(0, Math.max(VIEW.width - gridW, state.view.panX));
  }
  if (gridH <= VIEW.height) {
    state.view.panY = (VIEW.height - gridH) / 2;
  } else {
    state.view.panY = Math.min(0, Math.max(VIEW.height - gridH, state.view.panY));
  }
}

/* Зум с сохранением точки под курсором.
   vpX/vpY — координаты курсора внутри viewport (в пикселях). */
function setZoomAt(newZoom, vpX, vpY) {
  newZoom = Math.max(VIEW.minZoom, Math.min(VIEW.maxZoom, newZoom));
  const old = state.view.zoom;
  if (Math.abs(newZoom - old) < 1e-6) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('camera', 'setZoomAt', { from: old, to: newZoom, vpX, vpY });
  const f = newZoom / old;
  // Точка viewport (vpX, vpY) должна остаться над той же точкой сцены:
  // scene = (vp - pan) / zoom   ⇒   panX_new = vpX - f*(vpX - panX)
  state.view.panX = vpX - f * (vpX - state.view.panX);
  state.view.panY = vpY - f * (vpY - state.view.panY);
  state.view.zoom = newZoom;
  applyView();
}

function panBy(dx, dy) {
  if (typeof DebugLog !== 'undefined') DebugLog.log('camera', 'panBy', { dx, dy });
  state.view.panX += dx;
  state.view.panY += dy;
  applyView();
}

function resetView() {
  if (typeof DebugLog !== 'undefined') DebugLog.log('camera', 'resetView');
  state.view.zoom = VIEW.defaultZoom;
  state.view.panX = 0;
  state.view.panY = 0;
  applyView();
}

function setupViewInteractions() {
  const vp = document.getElementById('viewport');

  // ─── Ресайз окна → пересчитать размеры viewport ───────────
  // Раскладка гибкая: ширина поля тянется за окном. При ресайзе обновляем
  // VIEW.width/height и применяем view, иначе сцена поедет/обрежется по
  // старым границам.
  window.addEventListener('resize', () => {
    syncViewSize();
    applyView();
  });

  // ─── Колесо: зум вокруг курсора ───────────────────────────
  vp.addEventListener('wheel', (e) => {
    // С25: пока открыто окно прокачки — игнорируем зум колесом
    // (overlay перекрывает viewport, но wheel может долететь).
    if (state && state.activeLevelUp) return;
    e.preventDefault();
    const rect = vp.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dir = e.deltaY > 0 ? -1 : 1;
    setZoomAt(state.view.zoom + dir * VIEW.zoomStep, mx, my);
  }, { passive: false });

  // ─── Драг мышью: и левая, и средняя кнопка панорамируют ──
  // Левая: при маленьком смещении считается кликом (селект/деселект),
  //        при большом — панорамой. Клик после драга давим в capture-фазе,
  //        чтобы обработчики юнитов не сработали.
  let dragBtn = null;   // 0 | 1 | null
  let dragMoved = false;
  let dragStart = null;

  vp.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    // С25: пока открыто окно прокачки — драг по vp заблокирован.
    if (state && state.activeLevelUp) return;
    dragBtn = e.button;
    dragMoved = false;
    dragStart = { mx: e.clientX, my: e.clientY, px: state.view.panX, py: state.view.panY };
    if (e.button === 1) e.preventDefault();  // средний клик — сразу гасим автоскролл
  });

  window.addEventListener('mousemove', (e) => {
    if (dragBtn === null) return;
    const dx = e.clientX - dragStart.mx;
    const dy = e.clientY - dragStart.my;
    if (!dragMoved) {
      // Левая кнопка: ждём превышения порога — иначе это клик.
      // Средняя: панорамируем сразу.
      if (dragBtn === 1 || Math.abs(dx) + Math.abs(dy) > VIEW.dragThreshold) {
        dragMoved = true;
        vp.classList.add('panning');
      } else {
        return;
      }
    }
    state.view.panX = dragStart.px + dx;
    state.view.panY = dragStart.py + dy;
    applyView();
  });

  window.addEventListener('mouseup', () => {
    if (dragBtn === null) return;
    dragBtn = null;
    dragStart = null;
    vp.classList.remove('panning');
    // dragMoved сбрасывается в click-хендлере ниже (после подавления клика).
  });

  // Глушим click, если только что был драг (чтобы не сработал select/deselect).
  // Capture-фаза + stopImmediatePropagation — событие до обработчиков не дойдёт.
  vp.addEventListener('click', (e) => {
    if (dragMoved) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dragMoved = false;
    }
  }, true);

  vp.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

  // ─── Клавиатура: стрелки — панорама, +/− — зум, 0 — сброс ─
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // С25: пока открыто окно прокачки — клавиши камеры заблокированы
    // (иначе случайный +/-/стрелка ломали zoom/pan, а сама фокусировка
    // на button внутри overlay могла триггерить keydown с unwanted эффектом).
    if (state && state.activeLevelUp) return;
    let handled = true;
    const s = VIEW.panKeyStep;
    switch (e.key) {
      case 'ArrowUp':    panBy(0, s); break;
      case 'ArrowDown':  panBy(0, -s); break;
      case 'ArrowLeft':  panBy(s, 0); break;
      case 'ArrowRight': panBy(-s, 0); break;
      case '+': case '=':
        setZoomAt(state.view.zoom + VIEW.zoomStep, VIEW.width/2, VIEW.height/2); break;
      case '-': case '_':
        setZoomAt(state.view.zoom - VIEW.zoomStep, VIEW.width/2, VIEW.height/2); break;
      case '0':
        resetView(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  // ─── Кнопки зума ──────────────────────────────────────────
  document.getElementById('zoomIn').addEventListener('click', (e) => {
    e.stopPropagation();
    setZoomAt(state.view.zoom + VIEW.zoomStep, VIEW.width/2, VIEW.height/2);
  });
  document.getElementById('zoomOut').addEventListener('click', (e) => {
    e.stopPropagation();
    setZoomAt(state.view.zoom - VIEW.zoomStep, VIEW.width/2, VIEW.height/2);
  });
  document.getElementById('zoomReset').addEventListener('click', (e) => {
    e.stopPropagation();
    resetView();
  });
}
