/* render-units.js (render/) — рендер юнитов на поле и анимации,
   привязанные к конкретному юниту (попадание/смерть/движение).

   Что внутри:
     • `renderUnits()` — заново строит содержимое `#unitsLayer`. Для
       каждого юнита из state.units создаёт `.unit`-элемент с правильным
       классом команды, position через CSS-переменные --r/--c, классами
       состояния (`selected`/`acting`), data-* атрибутами для CSS-правок
       по классу (`data-class="archer"` и т.п.) и для click-handlers
       (data-unit-id). Внутри — `.unit-inner` с визуалом класса (через
       `renderClassVisual` из render.js) и полоской HP. Click-handler
       реагирует на текущий `state.mode`: в режиме атаки — `executeAttack`
       по клику на врага в радиусе; в режиме фаербола — `executeFireball`
       по клетке юнита (целиться можно куда угодно); иначе — `selectUnit`.
       Павшие юниты с флагом `isDying` рисуются как `.unit.is-dying`
       (анимация fade+scale), без флага — как `.tombstone` с tooltip-ом
       «кто здесь похоронен».
     • `playHitAnimation(unitId, isCrit, isDying)` — fire-and-forget
       анимация дрожи при попадании. Если `isDying` — ничего не делает
       (анимация смерти и так есть). Иначе ставит класс `is-hit`/`is-crit`
       на `.unit`, через 380/470мс снимает (если элемент не был
       пересоздан render-ом за это время).
     • `playMoveAnimation(unitId, path)` — пошаговая анимация движения.
       После `executeMove` юнит уже в финальной клетке, поэтому смещения
       считаются как `(path[i] - target) * cellPx`. На первом тике без
       транзишена ставит юнита в стартовую клетку (reflow), затем включает
       `.slide` (370мс linear) и сдвигает по одному шагу через setTimeout.
       Длина шага в CSS — `STEP_MS = 370`. Если юнит пересоздан —
       прерывается (проверка `same !== inner`).
     • `scheduleDeathCleanup(unit)` — через 540мс снимает `unit.isDying`
       и ре-рендерит. Юнит превращается из фэйдящегося спрайта в
       надгробие. Вызывается из `applyDamage` (core/damage.js) при
       летальном уроне.

   Что НЕ внутри:
     • Спецэффекты на effects-layer (вспышка фаербола) —
       `render/render-effects.js` (`playFireballBlast`).
     • `renderClassVisual`, `classVisualHtml` — общие хелперы в
       `render/render.js`.
     • Подсветка валидных клеток — `render/render-overlay.js`.

   Где править:
     • Вид/состояния .unit (новые CSS-классы, новые data-*) — `renderUnits`.
     • Длительность shake/crit — `playHitAnimation` (380 / 470мс).
     • Длина шага движения — `STEP_MS` (должна совпадать с CSS-переменной
       transition-duration у `.unit-inner.slide` в `styles/units.css`).
     • Длительность анимации смерти до превращения в надгробие —
       `scheduleDeathCleanup` (540мс) + CSS `@keyframes` в
       `styles/units.css` (.unit.is-dying).

   Внешние имена через script-scope (резолв при вызове):
   `state`, `selectUnit` (core/state); `getActiveUnit` (core/turn);
   `CLASSES` (data/classes); `SKILLS` (data/skills);
   `maxHpOf` (core/stats-calc); `computeAttackTargets`, `executeAttack`,
   `executeFireball` (core/combat); `renderClassVisual`,
   `classVisualHtml` (render/render); `VIEW` (монолит — переедет в R18). */

/* С22: рендер объектов на поле (state.objects). Перерисовывается полностью
   при каждом render(), как и юниты. Слой #objectsLayer лежит ПОД юнитами
   (см. порядок div'ов в index.html); pointer-events: none, чтобы юниты на
   той же клетке оставались кликабельными.

   Источник спрайта — `SKILLS[obj.kind].spriteSrc`, чтобы не плодить второй
   реестр «kind → image». При отсутствии записи в SKILLS — fallback на
   текстовую иконку. Тултип — короткая сводка (тип объекта + payload).
*/
function renderObjects() {
  const layer = document.getElementById('objectsLayer');
  if (!layer) return;
  layer.innerHTML = '';
  if (!Array.isArray(state.objects) || !state.objects.length) return;
  for (const obj of state.objects) {
    const el = document.createElement('div');
    el.className = `field-object ${obj.kind}`;
    el.style.setProperty('--r', obj.row);
    el.style.setProperty('--c', obj.col);
    const skill = (typeof SKILLS !== 'undefined') ? SKILLS[obj.kind] : null;
    const sprite = skill && skill.spriteSrc;
    let title = '';
    if (obj.kind === 'trap') {
      const dmg = (obj.payload && obj.payload.dmg | 0) || 0;
      title = `Капкан\nУрон: ${dmg} физ.\nНаносит «Обездвижен» на 1 ход`;
    } else if (obj.kind === 'lure') {
      const r = (obj.payload && obj.payload.lureRadius | 0) || 0;
      title = `Приманка\nРадиус действия: ${r} кл.\nИсчезает, когда враг завершает на ней ход`;
      if (obj.payload && obj.payload.applyOnPickup && obj.payload.applyOnPickup.id) {
        const onPickup = obj.payload.applyOnPickup;
        const names = { poisoned: 'Отравлен', burning: 'Горит', stunned: 'Оглушён', immobilized: 'Обездвижен' };
        const nm = names[onPickup.id] || onPickup.id;
        title += `\nНа подобравшего: «${nm}» на ${onPickup.duration | 0} ход.`;
      }
    }
    el.title = title;
    if (sprite) {
      const img = document.createElement('img');
      img.src = sprite;
      img.alt = (skill && skill.name) || obj.kind;
      el.appendChild(img);
    } else if (skill && skill.icon) {
      el.textContent = skill.icon;
    }
    // Hover-превью приманки реализовано через делегирование на gridLayer
    // (см. _bindLureHoverDelegation ниже). Прямой mouseenter на самой
    // .field-object не работает: units-layer выше в DOM с
     // pointer-events:auto перехватывает события первым.
    layer.appendChild(el);
  }
  // Гарантируем, что делегированный hover-handler привязан ровно один раз.
  if (typeof _bindLureHoverDelegation === 'function') _bindLureHoverDelegation();
}

/* С07.05.2026: делегированный hover на gridLayer — корректно реагирует
   на наведение мыши на клетку с приманкой. gridLayer лежит в самом низу
   DOM, его .cell-элементы получают mouseover/mouseout (ровно как они
   получают клик в bindFieldClickHandler). По обработке проверяем, нет ли
   на координатах клетки приманки в state.objects — если есть, показываем
   её радиус. Делегирование биндится один раз, переживает render-циклы. */
let _lureHoverBound = false;
let _lureHoverLastCell = null;  // 'r,c' — для генерации mouseenter/leave на клетку
function _bindLureHoverDelegation() {
  if (_lureHoverBound) return;
  const battlefield = document.getElementById('battlefield');
  if (!battlefield) return;
  _lureHoverBound = true;

  // Считаем «над какой клеткой курсор» по pixel-координатам внутри battlefield.
  // Метод устойчив к layer-стэкингу: mouseover/mousemove БУБЛЯТСЯ к battlefield
  // через любой слой выше, независимо от его pointer-events. Нам не важен
  // конкретный e.target — важна позиция курсора. Размер клетки — CSS-переменная
  // --cell на battlefield (см. zoom-pan.js → applyView).
  function cellFromEvent(e) {
    const rect = battlefield.getBoundingClientRect();
    const cssCell = parseFloat(getComputedStyle(battlefield).getPropertyValue('--cell')) || 0;
    if (cssCell <= 0) return null;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0) return null;
    const c = Math.floor(x / cssCell);
    const r = Math.floor(y / cssCell);
    if (!state || !state.grid) return null;
    if (r < 0 || c < 0 || r >= state.grid.rows || c >= state.grid.cols) return null;
    return { r, c };
  }

  battlefield.addEventListener('mousemove', (e) => {
    const cell = cellFromEvent(e);
    const key = cell ? (cell.r + ',' + cell.c) : null;
    if (key === _lureHoverLastCell) return;
    // Перешли в другую клетку — погасить старое превью если было.
    if (_lureHoverLastCell !== null) {
      hideLurePreview();
    }
    _lureHoverLastCell = key;
    if (!cell) return;
    if (state && state.mode) return;
    if (!Array.isArray(state.objects)) return;
    const lure = state.objects.find(o => o && o.kind === 'lure' && o.row === cell.r && o.col === cell.c);
    if (lure && typeof showLurePreview === 'function') showLurePreview(lure);
  });

  battlefield.addEventListener('mouseleave', () => {
    if (_lureHoverLastCell !== null) {
      hideLurePreview();
      _lureHoverLastCell = null;
    }
  });
}

function renderUnits() {
  const layer = document.getElementById('unitsLayer');
  layer.innerHTML = '';

  // Деревья (Сессия травы+, 03.05.2026): статические препятствия на
  // карте, рисуем В САМОМ НАЧАЛЕ — чтобы юниты/надгробия отрисовались
  // ПОВЕРХ. pointer-events: none — клик по дереву пробрасывается к
  // .cell ниже (там bindFieldClickHandler снимает выбор / выходит из
  // режима, как при клике по пустой клетке). Без тултипа: дерево —
  // просто декорация-препятствие. Источник правды — state.trees
  // (массив {row,col}, заполняется в createInitialState).
  if (Array.isArray(state.trees)) {
    for (const t of state.trees) {
      const treeEl = document.createElement('div');
      treeEl.className = 'tree-tile';
      treeEl.style.setProperty('--r', t.row);
      treeEl.style.setProperty('--c', t.col);
      const treeImg = document.createElement('img');
      treeImg.src = 'assets/sprites/tiles/tree.png';
      treeImg.alt = '';  // декорация без подписи
      treeEl.appendChild(treeImg);
      layer.appendChild(treeEl);
    }
  }

  for (const u of state.units) {
    // Павшие. Если у юнита стоит флаг isDying — он ещё играет анимацию
    // смерти, и мы рисуем его как .unit с классом .is-dying (fade+scale).
    // Когда анимация завершится, флаг сбрасывается и при следующем
    // рендере юнит превратится в надгробие.
    if (!u.alive) {
      if (u.isDying) {
        const el = document.createElement('div');
        el.className = 'unit is-dying team-' + u.team.toLowerCase();
        el.style.setProperty('--r', u.row);
        el.style.setProperty('--c', u.col);
        el.dataset.unitId = u.id;
        const inner = document.createElement('div');
        inner.className = 'unit-inner';
        const cls = CLASSES[u.classId];
        // Спрайт/эмодзи едут в общем рендер-хелпере, чтобы анимация
        // смерти (fade+scale) корректно тушила pixel-art image.
        renderClassVisual(inner, cls);
        el.appendChild(inner);
        layer.appendChild(el);
        continue;
      }
      // Надгробие — физический объект (блокирует ходьбу, см. isBlocked).
      // Хранит data-unit-id погибшего, чтобы будущие механики «работы с
      // трупами» могли его найти. При наведении показываем перечёркнутый
      // портрет павшего — это подсказка игроку, кто тут похоронен.
      const cls = CLASSES[u.classId];
      const teamLabel = u.team === 'A' ? 'Команда A · павший' : 'Команда B · павший';
      const visualHtml = classVisualHtml(cls);

      const tomb = document.createElement('div');
      tomb.className = 'tombstone';
      tomb.style.setProperty('--r', u.row);
      tomb.style.setProperty('--c', u.col);
      tomb.dataset.unitId = u.id;

      const tombImg = document.createElement('img');
      tombImg.src = 'assets/sprites/tombstone.png';
      tombImg.alt = 'надгробие';
      tomb.appendChild(tombImg);

      const tip = document.createElement('div');
      tip.className = 'tomb-tooltip';
      tip.innerHTML = `
        <div class="tomb-portrait team-${u.team.toLowerCase()}">${visualHtml}</div>
        <div class="tomb-info">
          <div class="tomb-name">${cls.name}</div>
          <div class="tomb-sub">${teamLabel}</div>
        </div>
      `;
      tomb.appendChild(tip);

      layer.appendChild(tomb);
      continue;
    }

    const el = document.createElement('div');
    el.className = 'unit team-' + u.team.toLowerCase();
    if (u.id === state.selectedUnitId) el.classList.add('selected');
    if (u.id === state.activeUnitId)   el.classList.add('acting');
    // С23: визуальный маркер маскировки — полупрозрачность (CSS-класс
    // `.unit.is-camouflaged` в styles/units.css). Чисто визуальный сигнал
    // игроку «этот юнит сейчас невидим для AI». Не путать с `.is-dying`,
    // которая тоже играет с opacity, но через keyframes.
    if (typeof hasEffect === 'function' && hasEffect(u, 'camouflage')) {
      el.classList.add('is-camouflaged');
    }
    el.style.setProperty('--r', u.row);
    el.style.setProperty('--c', u.col);
    el.dataset.unitId = u.id;
    // classId на корневом элементе юнита — нужен для пер-классовых
    // CSS-правок визуала (например, у лучника спрайт смещён ниже и
    // увеличен сильнее, см. .unit[data-class="archer"] .unit-inner img).
    el.dataset.class = u.classId;

    // Внутренний контейнер для анимаций (shake, slide, fade).
    const inner = document.createElement('div');
    inner.className = 'unit-inner';

    // Визуал из данных класса — emoji или sprite, выбирает helper.
    // Размер/растягивание спрайта задаются CSS (.unit-inner img).
    const cls = CLASSES[u.classId];
    renderClassVisual(inner, cls);

    // Полоска HP внизу иконки — внутри inner, чтобы дрожала вместе с юнитом.
    const hpBar = document.createElement('div');
    hpBar.className = 'hp-bar';
    const fill = document.createElement('div');
    fill.className = 'fill';
    const hpPct = Math.max(0, u.hp / maxHpOf(u)) * 100;
    fill.style.width = hpPct + '%';
    hpBar.appendChild(fill);
    inner.appendChild(hpBar);

    el.appendChild(inner);

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      // В режиме атаки клик по врагу в радиусе — атакует его (вместо select).
      // В режиме фаербола клик по юниту трактуется как клик по его клетке
      // (целиться можно куда угодно, в т.ч. в союзника/самого себя).
      // Клик по не-цели (своему или вне радиуса) — сбрасывает режим
      // и просто выделяет этого юнита.
      const active = getActiveUnit();
      if (state.mode === 'attack' && active) {
        const targets = computeAttackTargets(active);
        if (targets.some(t => t.id === u.id)) {
          executeAttack(u.id);
          return;
        }
      }
      if (state.mode === 'fireball' && active) {
        const range = SKILLS.fireball.range;
        const dist = Math.abs(u.row - active.row) + Math.abs(u.col - active.col);
        if (dist <= range) {
          executeFireball(u.row, u.col);
          return;
        }
      }
      selectUnit(u.id);
    });

    // Aggro-badge (Сессия aggro, 04.05.2026): для NPC с aggroState
    // (zombie + будущие монстры) рисуем маленький значок в правом
    // верхнем углу спрайта. 'Z' = спит, '!' = заметил врага.
    // Аддитивно: герои не имеют aggroState, badge не появляется.
    if (u.aggroState === 'sleeping' || u.aggroState === 'active') {
      const badge = document.createElement('div');
      badge.className = 'aggro-badge aggro-' + u.aggroState;
      badge.textContent = (u.aggroState === 'sleeping') ? 'Z' : '!';
      el.appendChild(badge);
      // Hover-превью зоны показываем для ОБОИХ состояний (правка
      // 06.05.2026): для sleeping — Чебышевский aggroRadius (зона
      // слежения), для active — реальная BFS-зона хода с текущей
      // Скоростью (куда NPC может реально дойти за один ход). Логика
      // выбора режима — внутри showAggroPreview. Привязка к самому
      // .unit, а не к badge — чтобы зона показывалась при наведении
      // куда угодно на спрайт (badge маленький, неудобно в него
      // попасть).
      el.addEventListener('mouseenter', () => {
        if (typeof showAggroPreview === 'function') showAggroPreview(u);
      });
      el.addEventListener('mouseleave', () => {
        if (typeof hideAggroPreview === 'function') hideAggroPreview(u);
      });
    }

    layer.appendChild(el);
  }
}

/* ================================================================
   === АНИМАЦИИ ЮНИТА =============================================
   Анимации живут «fire-and-forget»: запускаем, и они сами
   доживают своё время в DOM. Состояние игры уже обновлено к моменту
   старта анимации — юзер может действовать дальше, не дожидаясь.
   Если до окончания анимации произойдёт render(), элемент пересоздастся,
   и анимация оборвётся — это приемлемо для прототипа.
   ================================================================ */
function playHitAnimation(unitId, isCrit, isDying) {
  // Если юнит умирает — не трясём отдельно, fade+scale сам справляется.
  if (isDying) return;
  const el = document.querySelector(`.unit[data-unit-id="${unitId}"]`);
  if (!el) return;
  const klass = isCrit ? 'is-crit' : 'is-hit';
  el.classList.remove('is-hit', 'is-crit');
  // Рефлоу, чтобы браузер перезапустил keyframe-анимацию.
  void el.offsetWidth;
  el.classList.add(klass);
  // C24: длительность приведена к глобальному --anim-speed-mul.
  // CSS-анимация (unit-shake / unit-shake-hard) уже использует ту же
  // переменную; здесь синхронизируем JS-таймер снятия класса.
  const baseDur = isCrit ? 470 : 380;
  const dur = (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(baseDur) : baseDur;
  setTimeout(() => {
    // Элемент мог быть пересоздан render()'ом — проверяем, что это наш.
    const same = document.querySelector(`.unit[data-unit-id="${unitId}"]`);
    if (same === el) el.classList.remove(klass);
  }, dur);
}

/* Пошаговая анимация движения.
   Принимает массив клеток (path) от стартовой до финальной включительно.
   После render() .unit уже стоит в финальной клетке — поэтому смещения
   считаются относительно неё: offset(i) = (path[i] - target) * cellPx.
   Первый тик ставит юнита в стартовую клетку без транзишена (reflow), далее
   на каждом шаге включаем транзишн и переходим к следующей клетке.
   Длина шага в CSS — 370 мс linear (см. .unit-inner.slide). */
const STEP_MS = 370;
/* Сессия 18: opts.speedMul (default 1) — множитель скорости.
   Для рывка воина передаём 2 — длительность каждого шага и CSS-
   transition сокращаются вдвое (185 мс). Inline transitionDuration
   синхронизирует JS-таймер и CSS-транзишен; иначе при stepMs<370
   следующий шаг ставился бы до окончания предыдущего и анимация
   «скакала» бы. */
function playMoveAnimation(unitId, path, opts) {
  const el = document.querySelector(`.unit[data-unit-id="${unitId}"]`);
  if (!el) return;
  const inner = el.querySelector('.unit-inner');
  if (!inner) return;
  if (!path || path.length < 2) return;
  const speedMul = (opts && Number.isFinite(opts.speedMul) && opts.speedMul > 0) ? opts.speedMul : 1;
  // C24: глобальный множитель скорости (1×/2×/3×/4× через UI) ПЛЮС
  // локальный opts.speedMul (например, 2 для рывка воина) — оба
  // делят базовую длительность шага. Минимум 20 мс, чтобы анимация
  // не выродилась в одно «телепортирование» при экстремальных значениях.
  const globalMul = (typeof AnimSpeed !== 'undefined' && AnimSpeed.mul > 0) ? AnimSpeed.mul : 1;
  const stepMs = Math.max(20, Math.round(STEP_MS / (speedMul * globalMul)));
  const cellPx = VIEW.cellPx * state.view.zoom;
  const target = path[path.length - 1];
  const offsetFor = (cell) => ({
    ox: (cell.col - target.col) * cellPx,
    oy: (cell.row - target.row) * cellPx,
  });
  // 1) Без транзишена ставим юнита в стартовую клетку.
  inner.classList.remove('slide');
  const start = offsetFor(path[0]);
  inner.style.setProperty('--ox', start.ox + 'px');
  inner.style.setProperty('--oy', start.oy + 'px');
  void inner.offsetWidth;  // force reflow
  // 2) Включаем транзишн и inline-длительность под нашу скорость.
  inner.style.transitionDuration = stepMs + 'ms';
  inner.classList.add('slide');
  let i = 1;
  const stepOnce = () => {
    const same = document.querySelector(`.unit[data-unit-id="${unitId}"] .unit-inner`);
    if (same !== inner) return;
    if (i >= path.length) {
      inner.classList.remove('slide');
      // Сбросить inline-стиль, чтобы следующая обычная анимация
      // вернулась к стандартному CSS 370 мс.
      inner.style.transitionDuration = '';
      return;
    }
    const o = offsetFor(path[i]);
    inner.style.setProperty('--ox', o.ox + 'px');
    inner.style.setProperty('--oy', o.oy + 'px');
    i++;
    setTimeout(stepOnce, stepMs);
  };
  requestAnimationFrame(() => requestAnimationFrame(stepOnce));
}

/* Через 520мс после смерти снимаем флаг isDying и ре-рендерим —
   юнит превращается из фэйдящегося спрайта в надгробие. */
function scheduleDeathCleanup(unit) {
  // C24: длительность приведена к --anim-speed-mul. CSS-анимация
  // .unit.is-dying тоже делится на эту переменную — оба идут в ногу.
  const dur = (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(540) : 540;
  setTimeout(() => {
    unit.isDying = false;
    render();
  }, dur);
}
