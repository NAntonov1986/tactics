/* state.js (core/) — корневое состояние игры, фабрики юнитов, циклы волн
   и точка входа `init()`. До R16 всё это было размазано по inline-блоку:
   `let state` рядом с константами CSS-камеры, `init()` в самом конце файла,
   `checkVictory` где-то в середине. R16 собрал их в один модуль —
   фундамент, на котором стоят все остальные core-модули.

   Что внутри:
     • `let state = null` — корневой объект состояния. Инициализируется
       внутри `init()` через `createInitialState()`. Все остальные модули
       читают/мутируют `state.*` через script-scope (резолв при вызове).
     • `var nextUnitId = 1` — глобальный счётчик id юнитов (уникален между
       волнами, удобно для логов и отладки).
     • `makeUnit(spec)` — единая фабрика юнита. Принимает
       `{ classId, team, row, col, level?, facing? }`, считает статы по
       уровню (`statsForLevel`), назначает дефолтное оружие класса
       (`CLASSES[id].defaultWeapon`), стартовые тиры активов
       (через `class.activeSkillTiers`), полный HP/ману. Возвращает unit.
     • `HERO_SPAWN` — массив стартовых позиций героев (warrior/mage/archer
       на ряду 19, столбцы 8/9/10). Используется и в `createInitialState`,
       и в `startNextWave` (возврат выживших на исходные клетки).
     • `createInitialState()` — собирает свежий `state`-объект с тремя
       героями и пустым state.units для зомби. Сбрасывает `nextUnitId`
       в 1, чтобы id новой игры начинались с u1. Возвращает s.
     • `pickRandomFreeCellTopHalf()` — случайная свободная клетка в
       верхней половине поля (ряды 0..9), не перекрывающая живых юнитов
       и надгробия. null, если свободных клеток вообще нет.
     • `spawnZombieWave(count, level)` — спавнит N зомби `level`-уровня
       в случайных свободных клетках верхней половины. При нехватке
       клеток пишет в лог и возвращает уже размещённых. ОСТАВЛЕНА для
       DevTools/тестов; в startNextWave больше не используется.
     • `WAVE_GROUPS`, `pickWaveGroup`, `spawnGroupWave(waveNumber, group?)` —
       новая логика волн (см. шапку spawnGroupWave): случайный выбор
       группы (undead/wolves), размер `5 + floor(diff/5)`, добавление
       лидера группы в зачёт count при достижении его baseDifficulty.
     • `startNextWave()` — переход к следующей волне:
       1) убрать все надгробия (`state.units.filter(alive)`);
       2) вернуть выживших героев на стартовые клетки, сбросить эффекты,
          действия, восстановить HP/ману;
       3) инкрементировать `state.wave.number`, спавнить через
          `spawnGroupWave(wave.number)` (выбор группы и personal level
          считаются внутри по cls.baseDifficulty);
       4) сбросить раунд/инициативу, дёрнуть `beginTurn()` и `render()`.
     • `selectUnit(unitId)` — UI-выбор юнита. Сбрасывает режим
       прицеливания (через `exitMode`) — иначе панель показывала бы
       юнита X, а подсветка висела от Y.
     • `getUnit(id)` — поиск юнита в `state.units` по id; null, если нет.
     • `checkVictory()` — проверка конца волны/боя:
       — нет живых героев → `state.gameOver = 'defeat'`, лог, true;
       — нет живых зомби → лог «Волна N пройдена», `setTimeout(900мс,
         startNextWave)`, true;
       — иначе — false (бой продолжается). Используется боем (после
         каждого `applyDamage`) и циклом ходов (`advanceTurn` стопает
         цикл, если true).
     • `restartGame()` — полный перезапуск: новый state + первая волна
       через `startNextWave` + `applyView` (стартовые значения камеры).
     • `init()` — точка входа игры. Сценарий:
       1) `state = createInitialState()` + `startNextWave()` — поле
          и инициатива готовы;
       2) bind-обработчики: клик по фону viewport (снимает выбор/режим),
          делегирование кликов с кнопок действий и слотов навыков,
          горячие клавиши (Esc/M/A/F/Enter);
       3) `setupViewInteractions()` (камера-зум-пан),
          `render()` + `applyView()` — первая отрисовка.

   Что НЕ внутри:
     • Камера: `VIEW`, `applyView`, `setZoomAt`, `panBy`, `clampPan`,
       `setupViewInteractions`, `resetView`, `syncViewSize` — пока в
       монолите, переедут в `ui/zoom-pan.js` (R18).
     • Режимы прицеливания (`enterMode`/`exitMode`,
       `PreviewState.fireball`/`PreviewState.movePath`) — пока в монолите,
       переедут в `ui/input.js` (R18). state.js использует `exitMode`
       внутри `selectUnit` через script-scope.
     • Лог (`log`, `LOG_KEEP`) — пока в монолите, переедет вместе с
       рендер-логом (R17) или в отдельный модуль.
     • Рендер (`render`, `renderXxx`) — пока в монолите, переедет
       в `render/*` (R17). state.js дёргает `render` после волны и в init.
     • Анимации (`scheduleDeathCleanup`, `playHitAnimation`,
       `playFireballBlast`, `playMoveAnimation`) — render-кластер (R17).
     • Hotkey/клик-обработчики внутри `init()` — переедут в
       `ui/input.js`/`ui/hotkeys.js` (R18) при дальнейшей разборке init().

   Где править:
     • Стартовая расстановка героев — `HERO_SPAWN`. Поменять на 4 героев
       или другие классы — добавить запись.
     • Размер волны / уровень монстров — `spawnGroupWave` (формула
       count = 5 + floor(waveNumber/5)). Состав групп — `WAVE_GROUPS`.
       Personal level каждого монстра вычисляется в spawn-функции из
       его CLASSES[id].baseDifficulty. Когда состав волн станет смешанным
       (разные группы монстров на одной волне) — выносить в таблицу
       `WAVE_RULES`.
     • Условие победы/поражения — `checkVictory`. Появятся «выжить N
       раундов», «убить босса» и т.п. — добавить ветки сюда.
     • Шаг бутстрапа (что делать на старте) — `init()`. Добавить новую
       секцию (например, «прелоад спрайтов») — здесь же.

   Тонкость с порядком загрузки. state.js подключается ПЕРВЫМ среди
   core-файлов (после data, перед stats-calc) — он владеет переменной
   `state`, которую читают все остальные. Это безопасно потому, что:
   1) data-файлы — чистые декларации (никто не дёргает state на старте);
   2) другие core-файлы обращаются к `state.*` только из тел функций,
      резолв в момент ВЫЗОВА, не загрузки;
   3) сам state.js на старте только объявляет переменные и функции,
      реальная инициализация (`state = createInitialState()`) происходит
      внутри `init()`, который вызывается из inline после загрузки
      ВСЕХ внешних script-ов.
   `init();` — единственная строка в inline, которая фактически запускает
   игру. Её мы в монолите оставляем намеренно: в state.js невозможно
   позвать её на загрузке (тогда `setupViewInteractions`/`render`/
   `applyView`/`enterMode`/`exitMode`/etc., живущие в inline, ещё не
   определены). После R17/R18, когда вся UI-обвязка переедет, `init();`
   можно будет тоже втянуть в state.js (или в `main.js` финала R19).

   Внешние имена, которые state.js использует через script-scope
   (резолв при вызове): `CLASSES` (data/classes.js); `statsForLevel`,
   `maxHpOf`, `maxManaOf` (core/stats-calc.js); `isBlocked`
   (core/movement.js); `computeInitiativeOrder`, `beginTurn`, `endTurn`
   (core/turn.js); `getActiveUnit` (core/turn.js); `enterMode`,
   `exitMode`, `setupViewInteractions`, `applyView`, `render`, `log`,
   `VIEW` (монолит — переедут в R17/R18); `triggerEffectsAtTurn*` /
   `tickEffectsAtTurnEnd` не зовутся отсюда напрямую. */

/* ================================================================
   === СОСТОЯНИЕ ==================================================
   ================================================================
   Всё состояние хранится в одном объекте state — чистые данные,
   легко сериализуются в JSON для отладки и сохранений.
   ================================================================ */
let state = null;

/* Счётчик id юнитов. Делаем глобальным, чтобы id были уникальны не только
   внутри одной волны, но и между волнами — удобно для логов и отладки.

   ВАЖНО: var, не let. Причина (16.05.2026): top-level `let` в браузере
   НЕ создаёт свойство window. Save.js пишет `window.nextUnitId = N` при
   восстановлении сейва — с `let` это создавало бы ОТДЕЛЬНОЕ свойство,
   а внутренний `nextUnitId++` в makeUnit (units.js) продолжал бы
   использовать lexical-binding со стартовым значением 1. Результат:
   новый нанятый герой получал id `u1`, уже занятый старым героем; при
   level-up `getUnit('u1')` находил первого попавшегося → уровни шли
   старому герою, а новый оставался с level 0.
   С `var` top-level переменная синонимична window.<имя>: запись через
   window.nextUnitId = N и чтение через nextUnitId++ ссылаются на одно
   и то же. См. также src/core/save.js (applySaveSnapshot). */
var nextUnitId = 1;

/* Сессия 22: счётчик id объектов на поле (state.objects). Уникален между
   волнами по той же причине, что и nextUnitId. Тоже var — симметрично. */
var nextObjectId = 1;

/* addObject, removeObject, makeUnit — переехали в core/units.js
   (расщепление монолита 16.05.2026, пункт 5 backlog). */

/* Стартовые позиции героев — снизу поля, ряд 19. Camp v1.5-squad4
   (09.05.2026): 4 позиции (столбцы 8/9/10/11) для отряда из 4 героев.
   classId в записях — рекомендация (legacy startNextWave-обёртка) и
   подсказка для будущего UI; реальный класс берётся у героя при
   размещении (startMission ставит выбранных в HERO_SPAWN[i] по индексу,
   независимо от того, кто там «прописан»). */
const HERO_SPAWN = [
  { classId: 'warrior', team: 'B', row: 19, col: 8  },
  { classId: 'archer',  team: 'B', row: 19, col: 9  },
  { classId: 'mage',    team: 'B', row: 19, col: 10 },
  { classId: 'warrior', team: 'B', row: 19, col: 11 }
];

/* С8-предметы (08.05.2026): размер инвентаря отряда по умолчанию.
   Инвентарь — фиксированный grid; позиции предметов сохраняются между
   перерисовками. addToInventory() ниже находит первую null-ячейку;
   если все заняты — массив растёт за этот предел (graceful degradation,
   но в норме игроки сами управляют объёмом через выбрасывание).
   Размер 24 = 4 ряда × 6 колонок в UI. */
const PARTY_INVENTORY_SIZE = 24;

/* addToInventory, removeFromInventory, swapInventoryCells, findInventoryCellOf,
   pickTreeCells (+ хелперы _pickTreeCellsRaw / _isMapConnectedExcludingTrees)
   — переехали в core/units.js. */

function createInitialState() {
  nextUnitId = 1;
  nextObjectId = 1;  // С22: симметрично — id объектов уникальны от старта боя.
  // 1) Сначала деревья. По спеке — ставим ДО героев, чтобы исключить
  //    HERO_SPAWN-клетки из пула (иначе герой мог бы стартовать
  //    «внутри дерева»). HERO_SPAWN — фиксированные позиции, поэтому
  //    достаточно собрать их в Set ключей "r,c" и передать в
  //    pickTreeCells как занятые.
  const ROWS = 20, COLS = 20;
  const occupied = new Set(HERO_SPAWN.map(s => s.row + ',' + s.col));
  // Случайное число деревьев в диапазоне [12..16] включительно.
  const treeCount = 12 + Math.floor(Math.random() * 5);
  const trees = pickTreeCells(ROWS, COLS, treeCount, occupied);

  // 2) Стартовые герои — нижняя команда (B). Верхняя команда — зомби-
  //    волны (см. spawnZombieWave). HERO_SPAWN не пересекается с
  //    деревьями (исключены выше).
  //
  //    Camp v1.5 (08.05.2026): партия из 6 героев (по 2 каждого класса).
  //    Только 3 идут на миссию (выбор в UI лагеря). HERO_SPAWN остаётся
  //    3 позициями — они используются при размещении выбранной тройки
  //    в startMission. Героев в state.party создаём с временными row=-1,
  //    col=-1 (вне поля); при отправке на миссию каждому проставляются
  //    HERO_SPAWN-координаты по индексу.
  //
  //    Уровень 0, без скиллов (как было до v1.5). Initial level-up
  //    запускается init() для всех 6 героев — игрок выбирает стартовые
  //    скиллы каждому до выхода в первую миссию.
  //
  //    Поля Camp v1.5 на каждом герое:
  //      • restingTurnsLeft — 0 (готов к миссии), >0 (отдыхает N миссий).
  //        Тикает в forceWaveVictory; участникам по возвращении ставится 1.
  //      • participatedThisMission — true пока герой в текущей миссии,
  //        очищается forceWaveVictory.
  /* Camp v2-economy (13.05.2026): стартовая партия теперь ПУСТАЯ.
     Раньше (Camp v1.5-priest) выдавали 8 героев бесплатно (2 каждого
     класса), но с введением экономики это потеряло смысл — игрок
     получает стартовый капитал (ECONOMY.START_CAPITAL = 1600 g, хватает
     ровно на 8 героев 1-го уровня) и должен сам нанять команду через
     палатку найма. Освобождает онбординг от «вот тебе готовое, теперь
     иди в бой» в пользу осознанного формирования отряда из пула.

     Что это значит для бутстрапа:
       • init() видит пустой state.party → needsInitialLevelUp=false →
         сразу в лагерь (enterCampMain). Стартовый level-up 0→1 при
         старте новой игры больше не запускается (некому давать).
       • enterCampMain сам генерирует пул найма (если он пуст) — 6
         кандидатов 1-го уровня (max партии = 1 при пустой партии).
       • Игрок кликает «Найм наёмников», нанимает первых героев — каждому
         запускается N=1 level-up (выбор первого скилла), как раньше.
       • Глобальная карта показывает «Партия пуста — миссии недоступны»
         до тех пор, пока не нанято хотя бы одного героя. */
  const partyHeroes = [];

  const s = {
    grid: { rows: ROWS, cols: COLS },
    /* Camp v1.5 (08.05.2026): state.party — канонический список ВСЕХ
       нанятых героев (refs). Источник правды для UI лагеря, hero-list,
       сейва. Между миссиями state.units может быть пустым; во время
       миссии state.units = выбранные герои из party + спавненные монстры.
       После победы forceWaveVictory фильтрует state.party по alive
       (мёртвые героев из party навсегда). */
    party: partyHeroes,
    /* state.units во время боя содержит участников миссии + монстров.
       В лагере (state.campScreen != null) — пуст или содержит остаточных
       персонажей с прошлого боя; UI лагеря берёт героев из state.party. */
    units: [],
    trees,
    selectedUnitId: null,
    activeUnitId: null,
    initiativeOrder: [],
    turnIndex: 0,
    round: 1,
    mode: null,
    gameOver: null,
    /* state.wave.number — текущая «сложность игры»: номер пройденной +1.
       Поле раньше содержало ещё `zombieLevel`, но оно было дубликатом
       wave.number; правка 06.05.2026 убрала его, потому что разные
       монстры в одной волне могут иметь разный personal level
       (зависит от их CLASSES[id].baseDifficulty). */
    wave: { number: 0 },
    /* state.objects (Сессия 17, задел Сессии 22): слой объектов на поле
       (капканы, приманки, вехи). Каждый объект — `{id, kind, row, col,
       ownerTeam, payload}`. Один объект на клетку. Юнит и объект могут
       стоять на одной клетке (объект НЕ блокирует движение в общем
       случае; конкретные правила — у объектов через payload).
       На переходе к новой волне — очищается. Реакция на вход юнита в
       клетку — через triggerObjectsOnPathStep + triggerObjectsOnMoveEnd
       в movement.js (Сессия 22). */
    objects: [],
    /* state.partyInventory (С1-предметы, переработан в С8 08.05.2026):
       массив ячеек FIXED-размера PARTY_INVENTORY_SIZE. Каждая ячейка —
       либо null (пусто), либо инстанс предмета с полями
         { id, slotKind, baseId, prefix, suffix, ... }
       Каждый предмет имеет фиксированную позицию (= индекс в массиве),
       сохраняемую между перерисовками. Drag-and-drop меняет позиции.
       При переполнении массив МОЖЕТ расти (см. addToInventory). */
    partyInventory: new Array(PARTY_INVENTORY_SIZE).fill(null),
    /* Camp v1 (08.05.2026): экран лагеря между миссиями.
       Возможные значения:
         'main'      — главный экран лагеря (список героев, кнопки).
         'globalMap' — глобальная карта (выбор миссии).
         null        — игрок в бою.
       Стартовое значение null: после init() startNextWave запускает
       initial level-up queue, по её завершению advanceLevelUpQueue
       переводит campScreen='main'. */
    campScreen: null,
    /* Camp v1.5 (08.05.2026): регионы для тестирования прогрессии
       сложности. Каждый регион: { id, name, difficulty }. На старте все
       difficulty=1. После победы в регионе: его difficulty -=3 (clamp 1),
       все остальные +=1 (без верхнего предела). Это даёт net +1
       к общему уровню сложности за миссию (X-COM-style давление). */
    /* Camp v1.5-threats (09.05.2026): каждый регион хранит `currentThreat`.
       Camp v1.5-calendar (11.05.2026): + поле `instability`. Сложность
       (`difficulty`) теперь меняется ТОЛЬКО в начале нового месяца,
       пересчётом через накопленную нестабильность. Стартовая нестабильность = 1
       (решение пользователя — не упрощаем первый месяц). См.
       DESIGN.md → «Перепроектирование прогрессии сложности через календарь». */
    regions: [
      { id: 'r1', name: 'Регион 1', difficulty: 1, instability: 0, currentThreat: pickRandomThreatId(), rewardOffer: rollRewardForDifficulty(1) },
      { id: 'r2', name: 'Регион 2', difficulty: 1, instability: 0, currentThreat: pickRandomThreatId(), rewardOffer: rollRewardForDifficulty(1) },
      { id: 'r3', name: 'Регион 3', difficulty: 1, instability: 0, currentThreat: pickRandomThreatId(), rewardOffer: rollRewardForDifficulty(1) },
      { id: 'r4', name: 'Регион 4', difficulty: 1, instability: 0, currentThreat: pickRandomThreatId(), rewardOffer: rollRewardForDifficulty(1) },
      { id: 'r5', name: 'Регион 5', difficulty: 1, instability: 0, currentThreat: pickRandomThreatId(), rewardOffer: rollRewardForDifficulty(1) }
    ],
    /* Camp v1.5-calendar (11.05.2026): игровая дата. 4 недели в месяце,
       12 месяцев в году. Каждая миссия (победа/провал/пропуск) тратит
       +1 неделю. На переходе недели → месяца запускается endOfMonthTick
       (пересчёт difficulty по instability и модалка). */
    calendar: { week: 1, month: 1, year: 1 },
    /* Camp v1.5-calendar: данные для модалки «начало месяца». null если
       месяц не только что закончился; объект `{ month, year, deltas: [...] }`
       если показывается экран итогов. */
    monthEndSummary: null,
    /* id региона текущей миссии. Устанавливается startMission, очищается
       enterCampMain. Используется forceWaveVictory чтобы знать, в каком
       регионе была победа (для расчёта обновления regions). */
    currentMissionRegionId: null,
    /* Camp v1.5-UI (09.05.2026): экран выбора отряда. Когда игрок
       нажимает «На миссию» на карточке региона, мы НЕ запускаем
       миссию сразу — переводим campScreen='missionSetup' и фиксируем
       id региона в pendingMissionRegionId. Игрок выбирает 1-3 героев
       (state.pendingMissionHeroIds), нажимает «Отправить отряд», и
       тогда вызывается startMission(pendingMissionRegionId, pendingMissionHeroIds).
       На «Назад» — обнуляем оба поля и campScreen='globalMap'. */
    pendingMissionRegionId: null,
    pendingMissionHeroIds: [],
    /* Camp v1.5-popups (12.05.2026): отложенные модалки между миссией и
       лагерем. pendingTrophyPopup — { itemRef } если в этой миссии
       упал предмет; показывается на поле после level-up очереди.
       pendingCampEvents — список { kind, text } событий миссии;
       показывается ОДНИМ списком на входе в лагерь. null если ещё
       не инициализирован, [] — нет событий, но попап всё равно
       нужно показать («Ничего примечательного не произошло.»). */
    pendingTrophyPopup: null,
    pendingCampEvents: null,
    /* Camp v1.5-popups (12.05.2026): попап-предупреждение «лёгкая миссия».
       Когда игрок жмёт «Отправить отряд», но среди выбранных есть герои,
       которые по правилу не получат уровень (heroLevel-md>=3). Структура:
       { regionId, missionDifficulty, heroes:[{id,name,level}], confirmed }.
       confirmed выставляется при «Отправить всё равно». */
    pendingMissionWarning: null,
    /* Camp v2-economy (13.05.2026): валюта, пул найма, долговая система.
       gold — текущее золото. Стартовое значение = ECONOMY.START_CAPITAL
       (по дизайну 1600g на 8 героев lvl 1). Может быть отрицательным
       (долг); долговая система реагирует при переходе через 0.
       recruitPool — список из ECONOMY.POOL_SIZE кандидатов с
       сгенерированными уровнями и ценами; обновляется в refreshRecruitPool
       после каждой миссии. Каждый элемент: { classId, level, hireCost,
       upkeepMultiplier }. nextRecruitNonce — счётчик id для DOM-биндингов.
       debtMonths — последовательных месяцев в минусе; tick на
       endOfMonthTick. 0 если казна в плюсе. Используется долговой системой
       (см. DESIGN.md → «Черновик экономики»). */
    gold: (typeof ECONOMY !== 'undefined') ? ECONOMY.START_CAPITAL : 1600,
    recruitPool: [],
    nextRecruitNonce: 1,
    debtMonths: 0,
    /* Camp v2-economy/shop (14.05.2026): магазин. shopInventory — массив
       до ECONOMY.SHOP_SIZE предметов (Array<Item|null>). Обновляется в
       advanceCalendarWeek (после каждой миссии = недели). Покупка
       перемещает предмет в state.partyInventory (если хватает золота).
       Продажа — обратно, минус 35% (см. ECONOMY.SELL_MULT). */
    shopInventory: [],
    view: { zoom: VIEW.defaultZoom, panX: 0, panY: 0 },
    log: []
  };
  return s;
}

/* Случайная свободная клетка в верхней половине карты (ряды 0..9),
   не перекрывающая живых юнитов и надгробия. Возвращает {row, col}
   или null, если свободных клеток вообще не осталось. */
/* pickRandomFreeCellTopHalf — переехал в core/units.js. */

/* spawnZombieWave, WAVE_GROUPS, pickWaveGroup, pickRandomThreatId,
   rollRewardForDifficulty, spawnGroupWave — переехали в core/spawn.js. */

/* startMission, startNextWave, checkVictory, forceWaveVictory,
   forceMissionDefeat, endMissionCleanup, skipMission, closeTrophyPopup,
   closeCampEventsPopup, closeMissionWarning — переехали в core/mission.js. */


function restartGame() {
  state = createInitialState();
  // Camp v1: «Новый забег» — стираем сейв и начинаем чисто.
  if (typeof clearSave === 'function') clearSave();
  // Camp v1.5: новый забег — те же шаги, что свежий init: initial
  // level-up queue по партии → enterCampMain. Игрок сам выбирает
  // первую миссию из лагеря.
  const needsInitialLevelUp = (state.party || []).some(h => h && h.alive && (h.level | 0) === 0);
  if (needsInitialLevelUp) {
    startLevelUpQueue(state.party);
  } else {
    enterCampMain();
  }
  applyView();
}

/* ================================================================
   === ИНИЦИАЛИЗАЦИЯ ==============================================
   ================================================================ */
function init() {
  state = createInitialState();
  // Camp v1: попытка восстановить сейв из localStorage. Если есть —
  // применяем snapshot к state и сразу идём в лагерь (или туда, где
  // игрок был при последнем сохранении). Если сейва нет — стартует
  // initial level-up queue для всех 6 героев партии.
  let restored = false;
  if (typeof loadFromLocalStorage === 'function' && typeof applySaveSnapshot === 'function') {
    const snap = loadFromLocalStorage();
    if (snap) {
      restored = applySaveSnapshot(snap);
    }
  }
  // Camp v1.5: единая ветка проверки initial level-up. Срабатывает в трёх
  // случаях:
  //   1) свежий старт (без сейва) — все 6 героев level=0;
  //   2) свежий старт после restartGame (см. там) — то же самое;
  //   3) restored=true ПОСЛЕ миграции v1→v2: миграция дополнила партию
  //      свежими героями level=0, а старые сохранили свои уровни.
  //      Очередь запустится только для новых.
  // Если все герои уже level>=1 (типичный путь свежего v2-сейва) — сразу
  // в лагерь (либо в campScreen, который восстановили из сейва).
  const needsInitialLevelUp = (state.party || []).some(h => h && h.alive && (h.level | 0) === 0);
  if (needsInitialLevelUp) {
    startLevelUpQueue(state.party);
  } else if (!restored) {
    enterCampMain();
  } else {
    // Восстановили сейв и доводить героев не нужно. Сразу render —
    // UI откроет сохранённый campScreen.
    if (typeof render === 'function') render();
  }

  // R18: bind UI-обработчики тонкими вызовами в их модули.
  // Конкретные тела (viewport-click → cell/режим-фон, bottomPanel-click →
  // делегирование на data-action и data-skill-id) живут в `ui/input.js`,
  // hotkey keydown с Esc/M/A/F/Enter — в `ui/hotkeys.js`,
  // setupViewInteractions (resize+wheel+drag+camera-keydown+кнопки зума) —
  // в `ui/zoom-pan.js`. Порядок неважен: все listener-ы window-уровня
  // независимы между собой.
  bindFieldClickHandler();
  bindActionPanelHandler();
  bindHotkeys();
  // DevTools — отладочная панель «Выдача навыков». Подключение модуля
  // опционально (вырезается одной парой <link>/<script> в index.html);
  // если bindDevTools отсутствует — init спокойно идёт дальше.
  if (typeof bindDevTools === 'function') bindDevTools();
  setupViewInteractions();
  render();
  applyView();  // применяем стартовые значения камеры
}

/* ================================================================
   === DEVTOOLS-КОНСОЛЬ (Camp v1.5) ================================
   Лёгкие хелперы для тестирования прогрессии регионов и состава
   партии БЕЗ нового UI. Дёргать прямо из консоли браузера.
   ================================================================ */
if (typeof window !== 'undefined') {
  /* Список героев в партии: id, класс, уровень, hp/mana, отдых,
     участвует ли в текущей миссии. */
  window.__listParty = function () {
    if (!state || !Array.isArray(state.party)) return [];
    return state.party.map(h => ({
      id: h.id,
      classId: h.classId,
      name: (CLASSES[h.classId] || {}).name || h.classId,
      level: h.level | 0,
      hp: h.hp + '/' + (typeof maxHpOf === 'function' ? maxHpOf(h) : h.hp),
      mana: h.mana + '/' + (typeof maxManaOf === 'function' ? maxManaOf(h) : h.mana),
      alive: !!h.alive,
      restingTurnsLeft: h.restingTurnsLeft | 0,
      onMission: !!h.participatedThisMission
    }));
  };
  /* Список регионов с текущими сложностями. */
  window.__listRegions = function () {
    if (!state || !Array.isArray(state.regions)) return [];
    return state.regions.map(r => ({ id: r.id, name: r.name, difficulty: r.difficulty }));
  };
  /* Запуск миссии напрямую (минуя UI лагеря).
     __startMission(regionId, [heroId1, heroId2, heroId3])
     или без аргументов: __startMission() — берёт первый регион и первых
     3 живых не-отдыхающих героев из party. */
  window.__startMission = function (regionId, heroIds) {
    if (!state) return;
    if (!regionId) {
      regionId = (state.regions && state.regions[0] && state.regions[0].id) || null;
    }
    if (!Array.isArray(heroIds) || heroIds.length === 0) {
      heroIds = (state.party || [])
        .filter(h => h && h.alive && (h.restingTurnsLeft | 0) === 0)
        .slice(0, 3)
        .map(h => h.id);
    }
    startMission(regionId, heroIds);
  };
  /* Принудительно завершить миссию победой (DevTools). Имеет смысл
     только во время миссии. */
  window.__forceWin = function () { forceWaveVictory(); };
  /* Принудительно завершить миссию проигрышем (DevTools). */
  window.__forceLose = function () { forceMissionDefeat(); };
}
