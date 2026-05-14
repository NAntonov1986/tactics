/* hotkeys.js (ui/) — горячие клавиши действий игрока.

   Что внутри:
     • `bindHotkeys()` — регистрирует window keydown:
         - `Esc` — снять текущий режим прицеливания (если есть).
         - `M` / `m` / `ь` (русская раскладка) — `enterMode('move')`.
         - `A` / `a` / `ф` — `enterMode('attack')`.
         - `F` / `f` / `а` — `enterMode('fireball')`, но ТОЛЬКО если
           у активного юнита он есть. Если у текущего active не маг —
           клавиша игнорируется.
         - `Enter` — `endTurn()`, если есть active-юнит и игра не
           окончена.
       Игнорирует, если фокус во вводе (`<input>`/`<textarea>`).
       На обработанный ключ зовёт `e.preventDefault()`, чтобы
       не сработал default-браузер (например, F — поиск, Enter —
       submit формы).

   Что НЕ внутри:
     • Хоткеи камеры (Arrow-клавиши/+/-/0) — внутри `setupViewInteractions`
       в `ui/zoom-pan.js` (R18). Они зашиты туда вместе с зумом и
       панорамой, потому что тесно с ними связаны.
     • Хоткей для restartGame — пока нет (есть только клик по кнопке
       «Новый бой» в `renderGameOver`).

   Зачем русская раскладка? Удобство для пользователя на русской
   клавиатуре: клавиша M физически — это «ь», A — «ф», F — «а».
   Раскладка влияет только на `e.key`; `e.code` (KeyA и т.п.) не
   используется, чтобы не зависеть от физической клавиши, если
   пользователь переназначил.

   Тонкость с двумя keydown-handler-ами. Одно окно слушает два:
   первый — внутри `setupViewInteractions` (камера-клавиши), второй —
   `bindHotkeys` (действия). Они не пересекаются по ключам:
   камера = Arrow-клавиши/+/-/0, действия = Esc/M/A/F/Enter. Если один
   обработчик не обработал ключ (`handled = false`), событие идёт
   ко второму. preventDefault внутри одного не мешает другому.

   Где править:
     • Новый хоткей действия (например, B для Block) — добавить
       ветку `else if (e.key === 'b')` со своей логикой.
     • Хоткей для скилла, отличного от фаербола: добавить ветку
       с проверкой `CLASSES[u.classId].activeSkills.includes('skillId')`.

   Внешние имена через script-scope (резолв при вызове):
   `state`, `CLASSES` (data/classes); `getActiveUnit`, `endTurn`
   (core/turn); `enterMode`, `exitMode` (ui/input). */

function bindHotkeys() {
  // Горячие клавиши — ESC снимает режим, M/A включают.
  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      // Camp v2-economy (13.05.2026): ESC закрывает закреплённую панель
      // информации о герое (в лагере), если она открыта. Имеет приоритет
      // над exitMode, потому что в лагере state.mode == null и иначе
      // ESC ничего бы не делал.
      if (state && state.selectedUnitId && state.campScreen) {
        state.selectedUnitId = null;
        state.hoveredHeroId = null;
        if (typeof render === 'function') render();
        e.preventDefault();
        return;
      }
      if (state.mode) { exitMode(); e.preventDefault(); }
    } else if (e.key === 'm' || e.key === 'M' || e.key === 'ь') {
      enterMode('move'); e.preventDefault();
    } else if (e.key === 'a' || e.key === 'A' || e.key === 'ф') {
      enterMode('attack'); e.preventDefault();
    } else if (e.key === 'f' || e.key === 'F' || e.key === 'а') {
      // Фаербол — только если у активного юнита он есть.
      // Источник списка: либо классовый CLASSES[id].activeSkills, либо
      // override на инстансе (DevTools-выдача — см. ui/dev-tools.js).
      const u = getActiveUnit();
      if (u) {
        const list = Array.isArray(u.activeSkillsOverride)
          ? u.activeSkillsOverride
          : ((CLASSES[u.classId] && CLASSES[u.classId].activeSkills) || []);
        if (list.includes('fireball')) {
          enterMode('fireball'); e.preventDefault();
        }
      }
    } else if (e.key === 'Enter') {
      // Enter завершает ход только когда ходит игрок. Во время хода
      // монстра ИИ сам зовёт endTurn() по завершении своих действий —
      // вмешательство Enter сорвало бы цикл.
      if (isPlayerActiveTurn()) { endTurn(); e.preventDefault(); }
    } else if (e.key === 'i' || e.key === 'I' || e.key === 'ш') {
      // С1-предметы (07.05.2026): открыть/закрыть «Снаряжение отряда».
      // Доступен в любое время — не блокирует ход (UI инвентаря — read/equip,
      // не делает игровых действий, требующих хода). Между волнами в S7
      // экран будет открываться автоматически после победы; до тех пор
      // только по этой клавише.
      if (typeof toggleInventoryOverlay === 'function') {
        toggleInventoryOverlay();
        e.preventDefault();
      }
    }
  });
}
