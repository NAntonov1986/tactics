/* units.js — фабрика юнитов, инвентарь отряда, объекты на поле, генерация
   деревьев. Выделено из core/state.js 16.05.2026 в рамках расщепления
   монолита (пункт 5 backlog в DESIGN.md).

   Что внутри:
     • makeUnit(spec) — единая фабрика юнита (heroes/monsters). spec:
       { classId, team, row, col, level?, facing? }. Заполняет stats,
       hp/mana, slot экипировки, aggro-поля, paidLevel/upkeepMultiplier
       для героев.
     • addObject(spec) / removeObject(id) — объекты на поле (трапы, лур,
       вехи). state.objects: { id, kind, row, col, ownerTeam, payload }.
     • selectUnit(unitId) — выделение юнита для UI (сбрасывает mode).
     • getUnit(id) — поиск юнита по id (сначала state.units, затем state.party).
     • Инвентарь отряда — addToInventory, removeFromInventory,
       swapInventoryCells, findInventoryCellOf.
     • Деревья — pickTreeCells (с гарантией связности карты) и хелперы
       _pickTreeCellsRaw / _isMapConnectedExcludingTrees.
     • pickRandomFreeCellTopHalf() — случайная свободная клетка в верхней
       половине поля (для спавна монстров).

   Что НЕ внутри:
     • Корневой объект state, HERO_SPAWN, PARTY_INVENTORY_SIZE, WAVE_GROUPS,
       createInitialState, restartGame, init — в state.js.
     • Спавн волн врагов (spawnGroupWave и т.п.) — в spawn.js.
     • Жизненный цикл миссии (startMission, forceWaveVictory и т.п.) —
       в mission.js.
     • Camp-экономика и переходы между экранами — в camp.js.
     • Level-up очередь — в level-up-queue.js.

   Зависимости:
     • state, nextUnitId, nextObjectId — глобальные let-переменные из
       state.js (доступны через общий Script scope браузера для всех
       <script src> без модулей).
     • CLASSES, statsForLevel, maxHpOf, maxManaOf — из data/classes.js и
       core/stats-calc.js (подключаются до units.js).
     • rollUpkeepMultiplier — из data/economy.js (для героев в makeUnit).
     • isBlocked — из core/movement.js (для pickRandomFreeCellTopHalf).
     • exitMode, render — из render-слоя (вызываются в selectUnit).

   Файл подключается в index.html ПОСЛЕ state.js (state и счётчики
   должны существовать) и ПОСЛЕ data/* + stats-calc.js + movement.js
   (хелперы и реестры). */

/* ================================================================
   === ОБЪЕКТЫ НА ПОЛЕ ============================================
   ================================================================ */

/* Сессия 22: добавить объект на поле. spec — `{ kind, row, col, ownerTeam, payload }`.
   Возвращает id созданного объекта. Уникальность клетки гарантирует caller
   (сейчас — executeTrap/executeLure через проверку objectAt + unitAt + graveAt). */
function addObject(spec) {
  if (!Array.isArray(state.objects)) state.objects = [];
  const obj = {
    id: 'o' + (nextObjectId++),
    kind: spec.kind,
    row: spec.row,
    col: spec.col,
    ownerTeam: spec.ownerTeam,
    payload: spec.payload || {}
  };
  state.objects.push(obj);
  return obj.id;
}

/* Сессия 22: удалить объект по id. Возвращает удалённый объект или null. */
function removeObject(objectId) {
  if (!Array.isArray(state.objects)) return null;
  const idx = state.objects.findIndex(o => o.id === objectId);
  if (idx < 0) return null;
  const [removed] = state.objects.splice(idx, 1);
  return removed;
}

/* ================================================================
   === ФАБРИКА ЮНИТА ==============================================
   ================================================================ */

/* Единая фабрика юнита. spec: { classId, team, row, col, level?, facing? }.
   Уровень влияет на финальные статы (через CLASS_PROGRESSIONS) и на тиры
   пассивок (через passiveSkillTiers). */
function makeUnit(spec) {
  const cls = CLASSES[spec.classId];
  // Используем ??, не || — иначе level:0 (стартовые герои до initial
  // level-up'а) превращается в 1, и стартовая ветка startNextWave
  // не срабатывает (баг 06.05.2026, найден через DebugLog).
  const level = (spec.level != null) ? spec.level : 1;
  const stats = statsForLevel(spec.classId, level);
  const facing = spec.facing || (spec.team === 'A' ? 'down' : 'up');
  const unit = {
    id: 'u' + (nextUnitId++),
    classId: spec.classId,
    team: spec.team,
    row: spec.row,
    col: spec.col,
    facing,
    level,
    stats,
    hp: 0,           // ниже: подгоняем под maxHpOf(unit), когда unit уже сформирован
    mana: 0,
    effects: [],
    /* Экипировка (правка С1-предметы 07.05.2026): шлем убран, добавлен
       `consumable` слот. Состав: weapon/armor/amulet/ring/consumable.
       weapon — id из WEAPONS (либо defaultWeapon класса), остальные —
       либо null (пусто), либо инстанс предмета (см. core/loot.js, появится
       в будущих сессиях). На моменте С1 кроме weapon все слоты заполняются
       только через DevTools или будущий UI инвентаря. */
    equipment: {
      weapon: cls.defaultWeapon || null,
      armor: null, amulet: null, ring: null, consumable: null
    },
    skillsUsedThisTurn: [],
    actionsUsedThisTurn: { move: false, attack: false },
    skills: (cls.activeSkills || []).map(id => ({
      id,
      tier: (cls.activeSkillTiers && cls.activeSkillTiers[id]) || 'basic'
    })),
    /* cooldowns (Сессия 17): per-skill счётчики «осталось ходов отдыха».
       Тикают в endTurn (см. tickCooldowns в core/skills.js). При успешном
       касте навыка с tierData.cooldown > 0 — applyCooldown(u, sid, params)
       ставит число; UI рисует слот серым с тултипом «Откат: N ход(ов)»;
       canActivateSkill блокирует повторный каст. На startNextWave —
       cooldowns обнуляются (как и любые транзиентные счётчики). */
    cooldowns: {},
    /* usedThisWave (Сессия 19): per-skill флаг «использован один раз
       за волну» — параллельный счётчик к cooldowns, для скиллов с
       полем onceWave:true (Второе дыхание). canActivateSkill блокирует
       повторный каст до startNextWave. */
    usedThisWave: {},
    /* Aggro-поля (Сессия aggro, 04.05.2026). Только для NPC (monster).
       Героям не нужны — они «всегда активны» (логика aggro их игнорит).
       Источник правды: core/aggro.js → checkAggro/checkAggroForAllNpcs.
       Если у класса не задан aggroRadius — поле остаётся undefined и
       NPC по умолчанию НЕ имеет aggro-механики (старое поведение). */
    aggroRadius: cls.aggroRadius,
    idleBehavior: cls.idleBehavior || 'wander',
    aggroState: (cls.kind === 'monster' && (cls.aggroRadius | 0) > 0) ? 'sleeping' : undefined,
    alive: true,
    isDying: false,
    initiativeTiebreak: Math.random()
  };
  // Camp v1.5-skeletons (09.05.2026): для скелетов активные навыки тоже
  // прокачиваются по уровню юнита (10 → продвинутый, 20 → элитный).
  // Симметрично passiveSkillTiers для bony в core/skills.js. Делаем
  // здесь, потому что unit.skills[i].tier — источник правды для активов
  // (см. getActiveSkillTier). Дефолт basic уже выставлен выше.
  if ((spec.classId === 'skeleton_warrior' || spec.classId === 'skeleton_archer') && Array.isArray(unit.skills)) {
    let bumpTier = null;
    if (level >= 20) bumpTier = 'elite';
    else if (level >= 10) bumpTier = 'advanced';
    if (bumpTier) {
      for (const s of unit.skills) {
        if (s) s.tier = bumpTier;
      }
    }
  }
  unit.hp   = maxHpOf(unit);
  unit.mana = maxManaOf(unit);
  // Camp v2-economy (13.05.2026): персональный множитель содержания
  // (жадность героя). Только для героев — у монстров поле undefined.
  // Стартовая партия и герои-наследники до v4-миграции имеют 1.0 (legacy
  // совместимость в save.js); свежие через makeUnit получают рандом
  // [1-VAR..1+VAR]. На монстрах НЕ устанавливаем — heroMonthlyUpkeep
  // фильтрует по hero.alive, монстры не в state.party.
  if (cls && cls.kind === 'hero') {
    unit.upkeepMultiplier = (typeof rollUpkeepMultiplier === 'function')
      ? rollUpkeepMultiplier()
      : 1.0;
    /* Camp v2-economy (13.05.2026): paidLevel — уровень для расчёта зарплаты,
       зафиксированный при найме / последнем пересмотре (начало месяца).
       Между пересмотрами текущий hero.level может вырасти от миссий, но
       оклад остаётся прежним. applyMonthlySalary синхронизирует paidLevel
       с актуальным level ПОСЛЕ списания (т.е. ставка обновляется к
       следующему месяцу). На свежем герое paidLevel = его стартовый
       level; hireRecruit перетирает на recruit.level. */
    unit.paidLevel = level;
  }
  return unit;
}

/* ================================================================
   === ВЫБОР ЮНИТА / ПОИСК ========================================
   ================================================================ */

function selectUnit(unitId) {
  // Смена выбора всегда сбрасывает режим прицеливания — иначе получится
  // рассинхрон: панель показывает юнита X, а подсветка висит от юнита Y.
  if (state.mode) exitMode();
  state.selectedUnitId = unitId;
  render();
}

function getUnit(id) {
  // Camp v1.5: ищем сначала на поле (state.units), затем в партии
  // (state.party). Между миссиями state.units пуст, а level-up очередь
  // или сейв могут содержать ссылки на героев из party. Боевая логика
  // дёргает getUnit на ID живых юнитов поля — для них state.units всегда
  // первый и быстрее (короткий список). В лагере state.units пуст —
  // фолбэк на party.
  let u = (Array.isArray(state.units)) ? state.units.find(x => x && x.id === id) : null;
  if (u) return u;
  if (Array.isArray(state.party)) {
    u = state.party.find(x => x && x.id === id);
    if (u) return u;
  }
  return null;
}

/* ================================================================
   === ИНВЕНТАРЬ ОТРЯДА ===========================================
   ================================================================ */

/* Положить инстанс предмета в первую свободную ячейку partyInventory.
   Если массива нет — создаст. Если все ячейки заняты — добавит в конец
   (массив вырастет; UI отрисует все, в том числе сверх PARTY_INVENTORY_SIZE).
   Возвращает индекс, в который положили, или -1 при ошибке. */
function addToInventory(item) {
  if (!item) return -1;
  if (!Array.isArray(state.partyInventory)) {
    state.partyInventory = new Array(PARTY_INVENTORY_SIZE).fill(null);
  }
  for (let i = 0; i < state.partyInventory.length; i++) {
    if (state.partyInventory[i] == null) {
      state.partyInventory[i] = item;
      return i;
    }
  }
  // Все ячейки заняты — растим массив.
  state.partyInventory.push(item);
  return state.partyInventory.length - 1;
}

/* Удалить предмет по id из инвентаря (ставит null в его ячейке —
   позиция «освобождается», другие предметы НЕ сдвигаются). Возвращает
   удалённый предмет или null. */
function removeFromInventory(itemId) {
  if (!state || !Array.isArray(state.partyInventory)) return null;
  for (let i = 0; i < state.partyInventory.length; i++) {
    const it = state.partyInventory[i];
    if (it && it.id === itemId) {
      state.partyInventory[i] = null;
      return it;
    }
  }
  return null;
}

/* Поменять местами два предмета в ячейках инвентаря. Если в одной из
   ячеек null — это просто перенос (а не swap). Индексы могут быть за
   пределами текущей длины массива — массив расширится null'ами. */
function swapInventoryCells(idxA, idxB) {
  if (!Array.isArray(state.partyInventory)) return;
  if (idxA === idxB) return;
  // Расширяем массив, если индекс за пределами.
  while (state.partyInventory.length <= Math.max(idxA, idxB)) {
    state.partyInventory.push(null);
  }
  const a = state.partyInventory[idxA];
  const b = state.partyInventory[idxB];
  state.partyInventory[idxA] = b;
  state.partyInventory[idxB] = a;
}

/* Найти ячейку по id предмета. Возвращает индекс или -1. */
function findInventoryCellOf(itemId) {
  if (!state || !Array.isArray(state.partyInventory)) return -1;
  for (let i = 0; i < state.partyInventory.length; i++) {
    const it = state.partyInventory[i];
    if (it && it.id === itemId) return i;
  }
  return -1;
}

/* ================================================================
   === ДЕРЕВЬЯ / СВОБОДНЫЕ КЛЕТКИ =================================
   ================================================================
   Деревья — непроходимые объекты на карте (Сессия травы+, 03.05.2026).
   Спавнятся ровно ОДИН РАЗ при createInitialState (на всё сражение,
   не перегенерируются между волнами — ландшафт постоянный). 12-16
   случайных клеток на поле, исключая HERO_SPAWN-клетки (чтобы герои
   могли нормально стартовать). При спавне зомби `pickRandomFreeCellTopHalf`
   уже использует `isBlocked`, который теперь учитывает и деревья.

   pickTreeCells — обёртка с гарантией СВЯЗНОСТИ карты: после
   расстановки все свободные клетки должны принадлежать одному
   компоненту связности (BFS от любой свободной достигает всех
   остальных). Без этого случается: дерево заблокировало угол с
   единственным выходом → зомби спавнится в клетке-кармане и не
   может никуда пойти, а игрок не может его атаковать.

   Алгоритм: сгенерировать случайный набор → проверить isMapConnected →
   если не связно, retry до 20 раз. Если 20 попыток не дали связной
   карты — рекурсивно уменьшаем count на 1 (до минимума 4). Это
   гарантирует завершимость даже на патологическом RNG. */
function _pickTreeCellsRaw(rows, cols, count, occupiedSet) {
  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (occupiedSet.has(r + ',' + c)) continue;
      candidates.push({ row: r, col: c });
    }
  }
  // Шафл (Fisher-Yates) и берём первые count.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = candidates[i]; candidates[i] = candidates[j]; candidates[j] = t;
  }
  return candidates.slice(0, Math.min(count, candidates.length));
}

/* Все ли свободные клетки (не-деревья) образуют ОДИН связный компонент?
   BFS от первой свободной клетки, считаем посещённых. Если их меньше
   общего числа свободных — есть изолированные «карманы». */
function _isMapConnectedExcludingTrees(rows, cols, treeSet) {
  // Находим первую свободную клетку (не дерево).
  let startR = -1, startC = -1;
  outer: for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!treeSet.has(r + ',' + c)) { startR = r; startC = c; break outer; }
    }
  }
  if (startR < 0) return true; // нет свободных клеток вообще
  const totalFree = rows * cols - treeSet.size;
  const visited = new Set();
  const startKey = startR + ',' + startC;
  visited.add(startKey);
  const queue = [[startR, startC]];
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  while (queue.length) {
    const [r, c] = queue.shift();
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const k = nr + ',' + nc;
      if (visited.has(k)) continue;
      if (treeSet.has(k)) continue;
      visited.add(k);
      queue.push([nr, nc]);
    }
  }
  return visited.size === totalFree;
}

function pickTreeCells(rows, cols, count, occupiedSet) {
  // 20 попыток найти связный набор. Для 12-16 деревьев на 20×20 (400
  // клеток) изоляция крайне маловероятна — обычно срабатывает первая
  // же попытка. Retry-планка нужна как страховка от patологического RNG
  // (дерево пересекло коридор у границы).
  for (let attempt = 0; attempt < 20; attempt++) {
    const trees = _pickTreeCellsRaw(rows, cols, count, occupiedSet);
    const treeSet = new Set(trees.map(t => t.row + ',' + t.col));
    if (_isMapConnectedExcludingTrees(rows, cols, treeSet)) return trees;
  }
  // Fallback: 20 попыток подряд дали изоляцию — слишком много деревьев
  // для текущего расклада. Уменьшаем count на 1 и пробуем снова.
  // Минимум 4 (ниже не имеет смысла для разнообразия карты).
  if (count > 4) return pickTreeCells(rows, cols, count - 1, occupiedSet);
  return [];
}

/* Случайная свободная клетка в верхней половине поля (ряды 0..9).
   Используется для спавна монстров (см. spawn.js → spawnGroupWave). */
function pickRandomFreeCellTopHalf() {
  const maxRow = Math.floor(state.grid.rows / 2) - 1; // ряды 0..9
  const candidates = [];
  for (let r = 0; r <= maxRow; r++) {
    for (let c = 0; c < state.grid.cols; c++) {
      if (!isBlocked(r, c)) candidates.push({ row: r, col: c });
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
