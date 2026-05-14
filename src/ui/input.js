/* input.js (ui/) — режимы прицеливания и клик-обработчики игрока.

   Что внутри:
     • `let PreviewState.fireball` / `let PreviewState.movePath` —
       клетки под курсором в режимах фаербола и движения. Читаются
       рендером (`renderFireballPreview`, `renderMovePathPreview`)
       при наведении мыши. Сбрасываются при входе/выходе из режима
       и при выборе другого юнита.
     • `enterMode(mode)` — включает режим прицеливания
       ('move'/'attack'/'fireball'/...). Жёсткие проверки:
       юнит должен быть active и selected; для 'move' — не было
       движения в этом ходу + `canUnitMove`; для 'attack' — не была
       использована атака; для 'fireball' — класс знает скилл,
       не было других активных навыков, хватает маны, не обездвижен
       (для скиллов с `movesUser`). Повторный клик по той же кнопке —
       выход из режима. Сбрасывает `PreviewState.fireball`/
       `PreviewState.movePath` и дёргает render().
     • `exitMode()` — снимает любой текущий режим, очищает превью,
       ререндерит. Используется при клике по фону, при `selectUnit`
       другого юнита, при ручном повторном `enterMode(samesame)`.
     • `bindFieldClickHandler()` — клик по фону viewport (пустая
       клетка): в режиме прицеливания — отмена режима без сброса
       выбора; иначе — `selectUnit(null)` (снимаем выбор). Делегирование
       по target.classList: только если кликнули на `.cell` или
       `.viewport` (юниты делают `stopPropagation` у себя).
     • `bindActionPanelHandler()` — клик по нижней панели: кнопки
       действий (`data-action="move"|"attack"|"end"`) → `enterMode`/
       `endTurn`; слоты активных навыков (`data-skill-id`) → `enterMode`
       с id скилла. Делегирование на `#bottomPanel`, потому что
       панель перерисовывается целиком и точечные обработчики
       не выживут.

   Что НЕ внутри:
     • Камера/зум/пан — `ui/zoom-pan.js` (R18).
     • Горячие клавиши действий (Esc/M/A/F/Enter) — `ui/hotkeys.js`
       (R18).
     • Хоткеи камеры (Arrow-клавиши/+/-/0) — внутри `setupViewInteractions`
       в `ui/zoom-pan.js` (R18).
     • Обработчики клика по юниту (атака/фаербол/select по юниту) —
       `render-units.js` (R17, внутри `renderUnits` каждый юнит
       получает свой listener при создании).
     • Обработчик клика по подсветке клеток (executeMove/executeAttack/
       executeFireball) — `render-overlay.js` (R17).

   Зачем mode-state в `ui/input.js`, а не в `core/state.js`?
   `state.mode` (строка) живёт в state-объекте — это часть состояния.
   Но `PreviewState.fireball`/`PreviewState.movePath` — это эфемерное
   состояние «где курсор прямо сейчас», нужное только для отрисовки
   превью; в state.* оно не лежит, чтобы render-цикл не дёргался
   на каждое движение мыши через store. Логически эти let-переменные —
   часть UI-input-кластера, поэтому здесь.

   Где править:
     • Новый режим прицеливания (например, «телепорт»): добавить
       ветку в `enterMode` (валидация maна/доступности) и тонкий
       `renderXxxPreview` в render-overlay.js + handler в
       `renderOverlay` для нового `state.mode`.
     • Поведение клика по фону viewport — `bindFieldClickHandler`.
     • Новая кнопка действия (например, «Защита») — добавить ветку
       `else if (action === 'defend')` в `bindActionPanelHandler` +
       соответствующую функцию в core (или прямо здесь, если действие
       чисто-UI).

   Тонкость с порядком загрузки. `bindFieldClickHandler` /
   `bindActionPanelHandler` зовутся из `init()` в `core/state.js`.
   К моменту вызова DOM уже есть (`#viewport`/`#bottomPanel`) —
   inline `<script>` с `init();` стоит в самом конце `<body>`.

   Внешние имена через script-scope (резолв при вызове):
   `state`, `selectUnit` (core/state); `getActiveUnit`, `endTurn`
   (core/turn); `CLASSES` (data/classes); `getUnitSkillParams`
   (core/skills); `canUnitMove` (core/effects); `render` (render/render). */

/* ================================================================
   === РЕЖИМЫ ПРИЦЕЛИВАНИЯ ========================================
   state.mode = null | 'move' | 'attack' | 'fireball'.
   PreviewState.fireball — клетка под курсором в режиме фаербола,
   вокруг неё рисуется превью AoE 3×3.
   PreviewState.movePath — клетка под курсором в режиме движения,
   до неё рисуется пошаговый путь (см. renderMovePathPreview).
*/
/* С24-рефактор: три переменные превью прицеливания — PreviewState.movePath,
   PreviewState.fireball, PreviewState.lightning — собраны в один объект
   PreviewState. Это нужно для общего helper'а bindPreviewTarget(el, row,
   col, key, renderFn) в render-overlay.js: ему передаётся ключ-строка,
   и он читает/пишет PreviewState[key]. Раньше каждая переменная имела
   отдельную mouseenter/mouseleave-копипасту. Если когда-нибудь появится
   четвёртое прицеливание — нужно будет лишь добавить ключ в этот объект.

   Старые имена остаются как живые getter-aliases (через свойства), на
   случай если внешний код по ним обращается для отладки в DevTools-
   консоли. Внутри проекта все ссылки заменены на PreviewState[key]. */
const PreviewState = {
  movePath: null,    // bывш. PreviewState.movePath
  fireball: null,    // бывш. PreviewState.fireball
  lightning: null    // бывш. PreviewState.lightning (Сессия 10: anchor молнии)
};

function enterMode(mode, slotIdx) {
  // slotIdx (опционально) — индекс слота активного скилла. Передаётся
  // из bindActionPanelHandler при клике по slot[data-skill-slot].
  // Сохраняется в state.modeSlotIdx и используется combat.js при
  // касте: тир читается ИЗ слота, а не общим getActiveSkillTier.
  const u = getActiveUnit();
  if (!u) return;
  // Во время хода монстра игрок не должен мочь войти в режим
  // прицеливания (через кнопки или хоткеи M/A/F). Если активный юнит
  // под управлением ИИ — игнорируем нажатие.
  if (!isPlayerActiveTurn()) return;
  if (state.selectedUnitId !== u.id) {
    // Действия доступны только если выбран тот же юнит, что и ходит.
    // Автоматически переключаем выбор на него.
    state.selectedUnitId = u.id;
  }
  // Повторный клик по той же кнопке — отмена.
  if (state.mode === mode) { exitMode(); return; }
  if (mode === 'move' && u.actionsUsedThisTurn.move) return;
  if (mode === 'move' && !canUnitMove(u)) return; // «Обездвижен» / будущие блокировки
  if (mode === 'attack' && u.actionsUsedThisTurn.attack) return;
  // Универсальный путь для любого активного скилла (включая фаербол).
  // Все проверки — за canActivateSkill (core/skills.js): kind=active,
  // в активном списке (override либо CLASSES.activeSkills), активка не
  // использовалась в этом ходу, хватает маны, не обездвижен (для
  // movesUser). До Сессии 9 здесь была отдельная ветка для 'fireball';
  // сейчас фаербол, ice_arrow, magic_arrow и будущие активки идут через
  // одну точку (см. DESIGN.md, выбор архитектуры в Сессии 9).
  if (SKILLS[mode] && SKILLS[mode].kind === 'active') {
    if (!canActivateSkill(u, mode, slotIdx)) return;
  }
  state.mode = mode;
  state.modeSlotIdx = (typeof slotIdx === 'number') ? slotIdx : null;
  PreviewState.fireball = null;
  PreviewState.movePath = null;
  PreviewState.lightning = null;
  render();
}

function exitMode() {
  state.mode = null;
  state.modeSlotIdx = null;
  PreviewState.fireball = null;
  PreviewState.movePath = null;
  PreviewState.lightning = null;
  render();
}

/* ================================================================
   === КЛИК-ОБРАБОТЧИКИ ===========================================
   Регистрируются один раз из init() в core/state.js. Делегирование
   на корневые контейнеры (#viewport, #bottomPanel) — потому что
   панель и поле перерисовываются целиком, точечные listener-ы
   не выживут.
   ================================================================ */

/* Клик по пустой клетке поля — снимает выбор/режим (событие ловим на viewport,
   чтобы работало и после пана/зума; юниты делают stopPropagation у себя).
   В режиме прицеливания: клик по фону = отмена режима (без сброса выбора). */
function bindFieldClickHandler() {
  document.getElementById('viewport').addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList.contains('cell') || t.classList.contains('viewport')) {
      if (state.mode) {
        exitMode();
      } else {
        selectUnit(null);
      }
    }
  });
}

/* Делегирование кликов с кнопок действий и слотов активных навыков.
   Панель перерисовывается целиком, поэтому вешаем один обработчик на контейнер. */
function bindActionPanelHandler() {
  document.getElementById('bottomPanel').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      if (btn.disabled) return;
      const action = btn.dataset.action;
      if (action === 'move')     enterMode('move');
      else if (action === 'attack') enterMode('attack');
      else if (action === 'end')    { if (isPlayerActiveTurn()) endTurn(); }
      return;
    }
    const skillSlot = e.target.closest('[data-skill-id]');
    if (skillSlot && skillSlot.classList.contains('skill-active')) {
      // data-skill-slot — индекс слота (0..3); если атрибут отсутствует
      // (legacy-разметка) — передаём undefined, fallback на «первый
    // совпадающий тир» в getUnitSkillParams.
      const rawSlot = skillSlot.dataset.skillSlot;
      const slotIdx = (rawSlot != null && rawSlot !== '') ? parseInt(rawSlot, 10) : undefined;
      enterMode(skillSlot.dataset.skillId, slotIdx);
    }
  });
}
