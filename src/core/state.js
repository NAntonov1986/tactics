/* state.js (core/) — корневое состояние игры, фабрики юнитов, циклы волн
   и точка входа `init()`. До R16 всё это было размазано по inline-блоку:
   `let state` рядом с константами CSS-камеры, `init()` в самом конце файла,
   `checkVictory` где-то в середине. R16 собрал их в один модуль —
   фундамент, на котором стоят все остальные core-модули.

   Что внутри:
     • `let state = null` — корневой объект состояния. Инициализируется
       внутри `init()` через `createInitialState()`. Все остальные модули
       читают/мутируют `state.*` через script-scope (резолв при вызове).
     • `let nextUnitId = 1` — глобальный счётчик id юнитов (уникален между
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
   внутри одной волны, но и между волнами — удобно для логов и отладки. */
let nextUnitId = 1;

/* Сессия 22: счётчик id объектов на поле (state.objects). Уникален между
   волнами по той же причине, что и nextUnitId. */
let nextObjectId = 1;

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

/* Спавнит N зомби в случайных свободных клетках верхней половины.
   Personal level каждого зомби считается из class.baseDifficulty:
     personalLevel = max(1, waveNumber - cls.baseDifficulty + 1)
   То есть монстр на «своей первой» волне (=baseDifficulty) получает
   уровень 1, а на каждой последующей — растёт линейно.
   Если waveNumber < baseDifficulty (теоретический safeguard — монстр
   не должен попадать на волну ниже своей базовой сложности) — упираемся
   в 1. Решение пользователя 06.05.2026.
   Возвращает массив id спавненных зомби.

   ОСТАВЛЕНО для возможных DevTools/тестов. На текущий момент
   startNextWave вызывает spawnGroupWave (см. ниже), а не эту функцию. */
function spawnZombieWave(count, waveNumber) {
  const spawned = [];
  const cls = CLASSES['zombie'] || {};
  const baseDiff = (cls.baseDifficulty | 0) || 1;
  const personalLevel = Math.max(1, (waveNumber | 0) - baseDiff + 1);
  for (let i = 0; i < count; i++) {
    const cell = pickRandomFreeCellTopHalf();
    if (!cell) {
      log(`Нет свободной клетки для спавна зомби (${i}/${count} размещены)`, 'system');
      break;
    }
    const z = makeUnit({
      classId: 'zombie', team: 'A',
      row: cell.row, col: cell.col,
      level: personalLevel, facing: 'down'
    });
    state.units.push(z);
    spawned.push(z.id);
  }
  return spawned;
}

/* === Сессия волн (новая логика, заменяет spawnZombieWave в startNextWave) ===
   Источник правды о составе волны: WAVE_GROUPS — список доступных групп
   врагов, для каждой указан рядовой класс и (если есть) лидер.

   Размер волны фиксированный: 5 юнитов, включая лидера. Лидер группы
   добавляется в волну, если waveNumber >= leader.baseDifficulty; он
   идёт в зачёт count, т.е. на 5-й волне нежити получим 4 рядовых + 1
   Призрак (5 юнитов); до 5-й волны лидера нет — 5 рядовых. Если у
   выбранной группы нет лидера вообще (или условие не выполнено) — 5
   рядовых на любой волне.

   Баланс 12.05.2026 (по запросу заказчика): рост сложности на поздних
   волнах обеспечивается ТОЛЬКО ростом personalLevel юнитов и
   появлением лидера. Раньше формула давала count = 5 + floor(w/5):
   на 10-й волне 7, на 20-й 9 и т. д. — отменено, теперь стабильно 5.

   Personal level считается ровно как в spawnZombieWave:
     personalLevel = max(1, waveNumber - cls.baseDifficulty + 1).
   Так монстр на своей «первой» волне начинает с уровня 1 и растёт
   линейно вместе с heightening of waveNumber.

   Расширение реестра групп: добавить запись в WAVE_GROUPS с rank/leader.
   Новые классы должны быть зарегистрированы в CLASSES до этого. */
/* Camp v1.5-skeletons (09.05.2026): группа `undead` теперь смешанная —
   зомби + скелет воин + скелет лучник в случайной пропорции (по слоту
   рядового кидается равновероятный random из массива regulars). Группа
   `wolves` пока с одним рядовым типом (но та же схема). Поле `regular`
   (singular) НЕ удалено — оставлено как fallback на случай legacy-вызовов
   spawnGroupWave с groupOverride={regular:'...'}; новые группы пишите
   через `regulars`. */
const WAVE_GROUPS = [
  // Сессия Призрак (12.05.2026): группе нежити выдан лидер — Призрак.
  // У него CLASSES.ghost.baseDifficulty=5 → начиная с 5-й волны
  // spawnGroupWave подсаживает ровно 1 Призрака в зачёт count.
  // На волнах 1..4 лидера нет (баланс: ранние волны нежити остаются
  // мягкими, лидерская версия — поздняя угроза).
  { id: 'undead', regulars: ['zombie', 'skeleton_warrior', 'skeleton_archer'], leader: 'ghost' },
  { id: 'wolves', regulars: ['wolf'], leader: 'wolf_alpha' }
];

function pickWaveGroup() {
  // Универсальный random — без всяких весовых коэффициентов. Если в
  // будущем понадобится «волки реже», ввести веса в самом WAVE_GROUPS.
  if (!WAVE_GROUPS.length) return null;
  return WAVE_GROUPS[Math.floor(Math.random() * WAVE_GROUPS.length)];
}

/* Camp v1.5-threats (09.05.2026): id случайной группы врагов из WAVE_GROUPS.
   Используется для инициализации region.currentThreat и реролла после
   завершения миссии. null, если WAVE_GROUPS пуст (defensive). */
function pickRandomThreatId() {
  const g = pickWaveGroup();
  return g ? g.id : null;
}

/* Camp v2-economy (13.05.2026): свежий ролл награды для региона данной
   сложности. Используется при инициализации регионов, после победы (для
   зачищенного региона) и в endOfMonthTick (для всех регионов, у которых
   сложность поменялась). Делает один бросок ±VARIATION и фиксирует число
   в region.rewardOffer — игрок видит конкретную сумму до выхода на миссию. */
function rollRewardForDifficulty(difficulty) {
  if (typeof missionReward === 'function') return missionReward(difficulty);
  const d = Math.max(1, (difficulty | 0));
  return 400 * d;
}

/* Спавнит волну выбранной группы (или случайной, если group не передан).
   Возвращает { groupId, regularsSpawned, leaderId } для лога/тестов. */
function spawnGroupWave(waveNumber, groupOverride) {
  // Camp v1.5-threats (09.05.2026): groupOverride может быть либо
  // объектом (legacy: пробрасываем как есть), либо id-string (новое:
  // ищем в WAVE_GROUPS). Это позволяет startMission передавать
  // region.currentThreat — заранее известный игроку id угрозы.
  let group = null;
  if (typeof groupOverride === 'string') {
    group = WAVE_GROUPS.find(g => g && g.id === groupOverride) || null;
  } else if (groupOverride && typeof groupOverride === 'object') {
    group = groupOverride;
  }
  if (!group) group = pickWaveGroup();
  if (!group) {
    log('Нет зарегистрированных групп для спавна битвы', 'system');
    return { groupId: null, regularsSpawned: 0, leaderId: null };
  }
  // Баланс 12.05.2026: размер волны фиксирован = 5 юнитов (включая лидера,
  // если он добавляется по baseDifficulty). До этого было `5 + floor(w/5)`
  // — рост числа врагов с волной отменён по запросу заказчика. Сложность
  // теперь идёт через personalLevel и появление лидера, а не через массу.
  const totalCount = 5;
  // Решаем, ставится ли лидер: класс должен существовать и его baseDifficulty
  // должна быть достижимой текущим waveNumber. Лидер идёт в зачёт count.
  let leaderClsId = null;
  let leaderRejectReason = null;
  if (!group.leader) {
    leaderRejectReason = 'у группы нет лидера';
  } else if (!CLASSES[group.leader]) {
    leaderRejectReason = 'нет CLASSES[' + group.leader + ']';
  } else {
    const lcls = CLASSES[group.leader];
    const lbd = (lcls.baseDifficulty | 0) || 1;
    if ((waveNumber | 0) >= lbd) {
      leaderClsId = group.leader;
    } else {
      leaderRejectReason = 'waveNumber ' + (waveNumber | 0) + ' < baseDifficulty ' + lbd;
    }
  }
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'spawnGroupWave decisions', {
      waveNumber: waveNumber | 0, groupId: group.id, totalCount,
      leaderAssigned: !!leaderClsId, leaderRejectReason
    });
  }
  const regulars = leaderClsId ? Math.max(0, totalCount - 1) : totalCount;
  // Camp v1.5-skeletons (09.05.2026): группа может иметь массив regulars
  // (несколько рядовых классов, выбор равновероятным random per-slot) либо
  // legacy-поле regular (singular). Нормализуем в массив, fallback на zombie
  // только при полностью пустом списке (defensive). Personal level каждого
  // рядового считается ИНДИВИДУАЛЬНО по его cls.baseDifficulty —
  // у разных классов в одной группе baseDifficulty могут различаться.
  const regularPool = Array.isArray(group.regulars) && group.regulars.length > 0
    ? group.regulars.slice()
    : (group.regular ? [group.regular] : []);
  const regularIds = [];
  const regularsByClass = {};  // для лога: { zombie: { count, level } }
  for (let i = 0; i < regulars; i++) {
    const cell = pickRandomFreeCellTopHalf();
    if (!cell) {
      log(`Нет свободной клетки для спавна (${group.id}: ${i}/${regulars} размещены)`, 'system');
      break;
    }
    if (!regularPool.length) break;
    const pickedClsId = regularPool[Math.floor(Math.random() * regularPool.length)];
    const pickedCls = CLASSES[pickedClsId] || {};
    const pickedBaseDiff = (pickedCls.baseDifficulty | 0) || 1;
    const pickedLevel = Math.max(1, (waveNumber | 0) - pickedBaseDiff + 1);
    const u = makeUnit({
      classId: pickedClsId, team: 'A',
      row: cell.row, col: cell.col,
      level: pickedLevel, facing: 'down'
    });
    state.units.push(u);
    regularIds.push(u.id);
    if (!regularsByClass[pickedClsId]) regularsByClass[pickedClsId] = { count: 0, level: pickedLevel };
    regularsByClass[pickedClsId].count++;
  }
  let leaderId = null;
  let leaderLevel = null;
  if (leaderClsId) {
    const cell = pickRandomFreeCellTopHalf();
    if (cell) {
      const lcls = CLASSES[leaderClsId];
      const lbd = (lcls.baseDifficulty | 0) || 1;
      leaderLevel = Math.max(1, (waveNumber | 0) - lbd + 1);
      const u = makeUnit({
        classId: leaderClsId, team: 'A',
        row: cell.row, col: cell.col,
        level: leaderLevel, facing: 'down'
      });
      state.units.push(u);
      leaderId = u.id;
    } else {
      log(`Нет свободной клетки для лидера (${leaderClsId})`, 'system');
    }
  }
  return {
    groupId: group.id,
    // Camp v1.5-skeletons (09.05.2026): теперь рядовые могут быть разных
    // классов (см. group.regulars). Поле regularClsId оставлено для
    // совместимости, но равно ПЕРВОМУ ID из пула (его берёт legacy лог).
    // Полный разбор по классам — в regularsByClass: { [classId]: { count, level } }.
    regularClsId: regularPool[0] || null,
    regularLevel: regulars > 0 ? Math.max(1, (waveNumber | 0)) : null,
    regularsSpawned: regularIds.length,
    regularsByClass,
    leaderClsId,
    leaderLevel,
    leaderId
  };
}

/* Camp v1.5 (08.05.2026): startMission(regionId, heroIds) — основная
   точка входа в бой из лагеря. Принимает id региона и массив id героев
   из state.party. Если героев нет — миссия не стартует.

   Что делает:
     1. Валидация: регион существует, есть хотя бы 1 герой.
     2. Помечает выбранных героев participatedThisMission=true.
     3. Размещает их на HERO_SPAWN (по индексу), сбрасывает per-mission
        состояние (HP/mana/effects/cooldowns).
     4. Очищает state.objects (капканы/приманки прошлой миссии).
     5. Инкрементирует state.wave.number (cumulative счётчик миссий).
     6. Запоминает state.currentMissionRegionId — нужно forceWaveVictory.
     7. Спавнит монстров через spawnGroupWave с difficulty региона.
     8. Перезапускает раунд/инициативу, вызывает beginTurn. */
function startMission(regionId, heroIds) {
  if (!state) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'startMission', { regionId, heroIds });
  const region = (state.regions || []).find(r => r.id === regionId);
  if (!region) {
    console.warn('startMission: неизвестный regionId', regionId);
    return;
  }
  if (!Array.isArray(heroIds) || heroIds.length === 0) {
    console.warn('startMission: пустой список героев');
    return;
  }
  // Найти героев в party по id, отфильтровать живых и не-отдыхающих.
  const selected = [];
  for (const id of heroIds) {
    const h = (state.party || []).find(p => p && p.id === id && p.alive);
    if (!h) continue;
    if ((h.restingTurnsLeft | 0) > 0) continue;
    selected.push(h);
  }
  if (!selected.length) {
    console.warn('startMission: ни одного валидного героя из выбранных');
    return;
  }

  // Пометка участников.
  for (const h of selected) h.participatedThisMission = true;

  // Размещение по HERO_SPAWN-позициям (по индексу 0..2).
  const spawns = HERO_SPAWN.slice(0, selected.length);
  for (let i = 0; i < selected.length; i++) {
    const hero = selected[i];
    const sp = spawns[i] || HERO_SPAWN[i % HERO_SPAWN.length];
    hero.row = sp.row;
    hero.col = sp.col;
    // facing задаём по команде ГЕРОЯ, не spawn-записи. Все стартовые
    // герои — team B, смотрят вверх (на врага сверху). Если в будущем
    // появятся смешанные стороны, проверка останется корректной.
    hero.facing = (hero.team === 'A') ? 'down' : 'up';
    hero.effects = [];
    hero.actionsUsedThisTurn = { move: false, attack: false };
    hero.skillsUsedThisTurn = [];
    if (hero.passives) hero.passives = {};
    hero.cooldowns = {};
    hero.usedThisWave = {};
    hero.hp = maxHpOf(hero);
    hero.mana = maxManaOf(hero);
    // На случай если предыдущий бой оставил alive=false как gameOver-side-effect.
    hero.alive = true;
    hero.isDying = false;
    // Балансная правка 14.05.2026: heavy_armor (надетый тяжёлый
    // доспех) даёт `armoredOnSpawn` зарядов эффекта armored в начале
    // каждой миссии. Между миссиями стэк не переносится — броня
    // «перезаряжается» в лагере. Источник числа — поле на инстансе
    // или базовой записи ARMORS (см. data/equipment.js). getUnitArmor
    // резолвит id-строку через ARMORS, поэтому базовая надетая броня
    // тоже учитывается (fix 15.05.2026, раньше пропускалась).
    const armorRecord = (typeof getUnitArmor === 'function') ? getUnitArmor(hero) : null;
    if (armorRecord
        && typeof armorRecord.armoredOnSpawn === 'number'
        && armorRecord.armoredOnSpawn > 0
        && typeof applyArmored === 'function') {
      applyArmored(hero, armorRecord.armoredOnSpawn);
    }
  }

  // state.units заново: только участники + спавненные монстры.
  state.units = selected.slice();
  state.objects = [];
  state.gameOver = null;
  state.mode = null;
  state.selectedUnitId = null;
  state.activeUnitId = null;
  state.campScreen = null;
  state.currentMissionRegionId = regionId;

  // Инкремент счётчика миссий + спавн врагов с difficulty региона.
  // Camp v1.5-threats (09.05.2026): группа врагов фиксирована заранее
  // через region.currentThreat (выставлена при createInitialState и/или
  // последующих рероллах). Передаём id как groupOverride; spawnGroupWave
  // его резолвит в объект из WAVE_GROUPS. Если currentThreat почему-то
  // null (legacy сейв до threats) — spawnGroupWave спокойно фолбэкается
  // на pickWaveGroup() (random).
  state.wave.number = (state.wave.number | 0) + 1;
  const result = spawnGroupWave(region.difficulty, region.currentThreat);
  // Camp v1.5-skeletons: разбираем regularsByClass — может быть несколько
  // классов в смешанной волне («3 Зомби (ур. 5) + 2 Скелет воин (ур. 5) +
  // 1 Скелет лучник (ур. 5)»). Сортируем по убыванию count для предсказуемости.
  const partsRegular = [];
  const byClass = result.regularsByClass || {};
  const entries = Object.keys(byClass).map(k => ({
    classId: k, count: byClass[k].count | 0, level: byClass[k].level | 0
  })).sort((a, b) => b.count - a.count);
  for (const e of entries) {
    const nm = (CLASSES[e.classId] || {}).name || e.classId;
    partsRegular.push(`${e.count} ${nm} (ур. ${e.level || 1})`);
  }
  const partLeader = result.leaderClsId
    ? `${(CLASSES[result.leaderClsId] || {}).name || result.leaderClsId} (ур. ${result.leaderLevel || 1})`
    : '';
  const composition = partsRegular.concat(partLeader ? [partLeader] : []).filter(Boolean).join(' + ');
  log(`── ${region.name} (сложность ${region.difficulty}): ${composition} ──`, 'turn');

  if (typeof checkAggroForAllNpcs === 'function') {
    checkAggroForAllNpcs(state);
  }

  state.round = 1;
  state.initiativeOrder = computeInitiativeOrder();
  state.turnIndex = 0;
  beginTurn();
  render();
}

/* Camp v1.5: legacy-обёртка над startMission. Используется существующим
   UI «На миссию» в render-camp до второй сессии (UI). Берёт первый
   регион (state.regions[0]) и первых 3 живых не-отдыхающих героев из
   party. Когда появится UI выбора отряда (сессия Camp v1.5-UI),
   startNextWave удаляется. */
function startNextWave() {
  if (!state) return;
  const region = state.regions && state.regions[0];
  if (!region) return;
  const heroes = (state.party || [])
    .filter(h => h && h.alive && (h.restingTurnsLeft | 0) === 0)
    .slice(0, HERO_SPAWN.length);
  if (heroes.length === 0) {
    log('Нет доступных героев для миссии (все мёртвы или отдыхают)', 'system');
    return;
  }
  startMission(region.id, heroes.map(h => h.id));
}

/* selectUnit, getUnit — переехали в core/units.js. */

/* ================================================================
   === ПОБЕДА И ПОРАЖЕНИЕ =========================================
   PvE-волны:
   — нет живых зомби → волна пройдена, стартует следующая;
   — нет живых героев → экран поражения.
   Возвращает true, если бой дальше не идёт (победа волны запустила
   паузу/следующую волну, или наступило поражение). Если есть и герои,
   и зомби — возвращает false и бой продолжается.
   ================================================================ */
function checkVictory() {
  const aliveHeroes   = state.units.some(u => u.alive && CLASSES[u.classId].kind === 'hero');
  const aliveMonsters = state.units.some(u => u.alive && CLASSES[u.classId].kind === 'monster');
  if (!aliveHeroes) {
    // Camp v1.5: миссия провалена. forceMissionDefeat сделает permadeath
    // мёртвых участников, обновит регионы (+1 всем), вернёт в лагерь —
    // ИЛИ объявит финальный gameOver, если партия пуста.
    forceMissionDefeat();
    return true;
  }
  if (!aliveMonsters) {
    // Волна пройдена. С25: ветка вынесена в forceWaveVictory(), чтобы
    // одна и та же логика «миссия выиграна» работала и при чистом
    // убийстве зомби, и при ручном вызове из DevTools/будущих
    // условных типов миссий (защита каравана, выживание N раундов,
    // и т.п. — где «победа» не равна «нет живых монстров»).
    forceWaveVictory();
    return true;
  }
  return false;
}

/* С25: «волна пройдена» — единая точка победного исхода миссии.
   Зовётся:
     • из checkVictory, когда нет живых монстров (классическое условие);
     • из DevTools (кнопка «Победа волны») — для отладки прокачки
       без необходимости фактически зачищать карту.

   Что делает:
     1. Замораживает текущий ход (activeUnitId=null, mode=null).
     2. Лог «Миссия пройдена».
     3. Camp v1.5 (08.05.2026): обновляет regions — целевой регион -3
        (clamp 1), остальные +1 (чистый +1 к суммарной сложности мира).
        Целевой регион берётся из state.currentMissionRegionId.
     4. Генерирует награду по difficulty целевого региона
        (не по state.wave.number — теперь сложность миссии не равна
        номеру миссии, она зависит от выбранного региона).
     5. Запускает очередь апов героев — выживших УЧАСТНИКОВ миссии
        (state.units alive heroes — там только участники после startMission).
        Когда очередь пуста — endMissionCleanup() + enterCampMain().
     6. Если state.gameOver === 'defeat' — ничего (защита от race-
        condition: вдруг герои погибли в ту же миллисекунду).

   Идемпотентность: повторный вызов не создаёт второй очереди — если
   state.levelUpQueue не пуст, считаем что апы уже идут. */
function advanceCalendarWeek() {
  if (!state || !state.calendar) return;
  state.calendar.week = (state.calendar.week | 0) + 1;
  if (typeof onWeekTick === 'function') onWeekTick(state);
  if (state.calendar.week > 4) {
    state.calendar.week = 1;
    state.calendar.month = (state.calendar.month | 0) + 1;
    endOfMonthTick();
    if (typeof onMonthTick === 'function') onMonthTick(state);
    if (state.calendar.month > 12) {
      state.calendar.month = 1;
      state.calendar.year = (state.calendar.year | 0) + 1;
      if (typeof onYearTick === 'function') onYearTick(state);
    }
  }
  // Camp v2-economy (13.05.2026): refresh пула найма после каждой миссии/
  // пропуска. Невостребованные кандидаты пропадают — FOMO как стимул
  // (DESIGN п.7). Делаем ПОСЛЕ всех календарных тиков, чтобы max уровень
  // партии уже учитывал свежие апы текущей миссии.
  if (typeof refreshRecruitPool === 'function') refreshRecruitPool();
  // Camp v2-economy/shop (14.05.2026): ассортимент магазина обновляется
  // каждую неделю. Делаем после endOfMonthTick, чтобы новые сложности
  // регионов уже учитывались в среднем уровне для генератора.
  if (typeof regenerateShopInventory === 'function') regenerateShopInventory();
}

function endOfMonthTick() {
  if (!state || !Array.isArray(state.regions)) return;
  const deltas = [];
  for (const r of state.regions) {
    if (!r) continue;
    const before = r.difficulty | 0;
    const inst = r.instability | 0;
    const after = Math.max(1, before + inst);
    deltas.push({ id: r.id, name: r.name, before, after, delta: after - before, instability: inst });
    r.difficulty = after;
    // Camp v1.5-calendar (11.05.2026, балансная правка): базовая
    // нестабильность в начале нового месяца — 0 (раньше 1).
    r.instability = 0;
    // Camp v2-economy (13.05.2026): на новой сложности — свежий офёр
    // награды. Игрок увидит обновлённое число на глобальной карте.
    if (typeof rollRewardForDifficulty === 'function') {
      r.rewardOffer = rollRewardForDifficulty(r.difficulty);
    }
  }
  state.monthEndSummary = {
    month: state.calendar.month | 0,
    year: state.calendar.year | 0,
    deltas
  };
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'endOfMonthTick', { month: state.calendar.month, deltas });
  }
  log('Наступил месяц ' + state.calendar.month + ' (год ' + state.calendar.year + ') - сложности пересчитаны', 'turn');
  // Camp v2-economy (13.05.2026): зарплата на начало месяца. Списываем
  // сумму содержания всей живой партии (включая отдыхающих) с state.gold.
  // Если ушли в минус — обновляем debtMonths (тик долговой системы).
  applyMonthlySalary();
  // Camp v1.5-popups (12.05.2026): квартальное событие. В начале месяцев
  // 1/4/7/10 (стандартные кварталы), кроме самого первого игрового
  // месяца (year=1, month=1 — этот случай в endOfMonthTick не попадает,
  // потому что первый тик переводит в month=2). Выбираем случайный
  // регион из тех у кого максимальная текущая сложность и снижаем её
  // на 2 (не ниже 1). Текст события — в pendingCampEvents (отдельный
  // попап в лагере).
  _quarterlyStabilizationCheck();
}

/* Camp v1.5-popups (12.05.2026): квартальное событие «Стража стабилизировала
   регион». Вызывается ИЗНУТРИ endOfMonthTick после обновления difficulty,
   поэтому r.difficulty уже актуален. */
/* === Camp v2-economy (13.05.2026) ===
   Экономика: применение награды миссии, ежемесячная зарплата, пул найма,
   найм героев. Все формулы — в data/economy.js. Здесь только применение
   результата к state и побочные эффекты (логи, события, обновление UI). */

/* Начислить золото за победу миссии. Принимает явную сумму (rewardOffer
   региона, зафиксированный при выдаче заказа). Если по какой-то причине
   amount не передан или нулевой — fallback на свежий ролл по difficulty
   (defensive, для legacy путей вроде DevTools __forceWin). */
function applyMissionReward(amount, difficulty) {
  if (!state) return 0;
  let reward = (typeof amount === 'number' && amount > 0) ? (amount | 0) : 0;
  if (reward <= 0) {
    const d = Math.max(1, (difficulty | 0) || 1);
    reward = (typeof missionReward === 'function') ? missionReward(d) : (400 * d);
  }
  state.gold = (state.gold | 0) + reward;
  log('Награда за миссию: ' + reward + ' g (казна: ' + state.gold + ')', 'victory');
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'applyMissionReward', { reward, gold: state.gold });
  }
  return reward;
}

/* Списать зарплату со всей живой партии в начале месяца. Если казна
   уходит в минус — поднимаем debtMonths (последовательный счётчик
   месяцев в долгу). Если казна снова в плюсе — сбрасываем в 0. */
function applyMonthlySalary() {
  if (!state || !Array.isArray(state.party)) return 0;
  // Списываем по СТАРОМУ paidLevel — это «закрытие» прошедшего месяца
  // по ставке, на которой герой работал.
  const total = (typeof partySalaryTotal === 'function')
    ? partySalaryTotal(state.party)
    : 0;
  state.gold = (state.gold | 0) - total;
  // Пересмотр оклада на новый месяц: paidLevel = текущий hero.level.
  // Если герой вырос с момента последнего пересмотра — следующий тик
  // спишет уже больше. Если уровень тот же — ничего не меняется.
  for (const h of state.party) {
    if (!h || !h.alive) continue;
    h.paidLevel = h.level | 0;
  }
  if (state.gold < 0) {
    state.debtMonths = ((state.debtMonths | 0) + 1);
    log('Выплачено жалование: ' + total + ' g. Казна в минусе: ' + state.gold + ' g (месяц долга: ' + state.debtMonths + ')', 'turn');
    // Событие в журнал лагеря — игрок узнает из попапа «События».
    if (typeof _pushCampEvent === 'function') {
      _pushCampEvent('salary-debt',
        'Жалование выплачено (' + total + ' g), но казна ушла в минус: ' + state.gold + ' g. Месяц долга: ' + state.debtMonths + '.');
    }
  } else {
    state.debtMonths = 0;
    log('Выплачено жалование: ' + total + ' g (казна: ' + state.gold + ')', 'turn');
    if (typeof _pushCampEvent === 'function') {
      _pushCampEvent('salary-paid',
        'Жалование наёмникам выплачено: ' + total + ' g. Казна: ' + state.gold + ' g.');
    }
  }
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'applyMonthlySalary', { total, gold: state.gold, debtMonths: state.debtMonths });
  }
  return total;
}

/* Сгенерировать новый пул найма. Размер ECONOMY.POOL_SIZE кандидатов
   (по умолчанию 6). Уровень каждого — random в диапазоне
   [maxPartyLevel × POOL_LVL_MIN_FACTOR .. × POOL_LVL_MAX_FACTOR],
   минимум 1. Класс — случайный из доступных hero-классов. Стоимость
   найма генерируется через hireCost (с variation). upkeepMultiplier —
   через rollUpkeepMultiplier; запоминается, чтобы при найме перенести
   на инстанс героя. Вызывается из refreshRecruitPool. */
function generateRecruitPool() {
  if (!state) return [];
  const size = (typeof ECONOMY !== 'undefined') ? ECONOMY.POOL_SIZE : 6;
  const factorMin = (typeof ECONOMY !== 'undefined') ? ECONOMY.POOL_LVL_MIN_FACTOR : 0.60;
  const factorMax = (typeof ECONOMY !== 'undefined') ? ECONOMY.POOL_LVL_MAX_FACTOR : 0.80;
  const maxLvl = (typeof maxPartyLevel === 'function') ? maxPartyLevel(state.party) : 1;
  // Список доступных классов героев (kind === 'hero'), исключая монстров.
  const heroClassIds = [];
  for (const id in CLASSES) {
    if (CLASSES[id] && CLASSES[id].kind === 'hero') heroClassIds.push(id);
  }
  if (heroClassIds.length === 0) return [];
  // Camp v2-economy (13.05.2026): минимизация дублирования классов в пуле.
  // На каждом шаге выбираем класс с наименьшим текущим количеством в пуле
  // (тай-брейк случайный среди равных). Это даёт максимально равномерное
  // распределение: при 4 классах и пуле 6 получится 2/2/1/1 — каждый класс
  // встречается, никакого класса больше двух. При пуле 4 — по одному
  // каждого. При пуле 8 — по два каждого. Раньше был чистый random на
  // каждом шаге, и регулярно выпадали пулы вроде [warrior, warrior, warrior,
  // mage, archer, mage], где половины классов нет вообще.
  const classCounts = {};
  for (const id of heroClassIds) classCounts[id] = 0;
  const pool = [];
  for (let i = 0; i < size; i++) {
    // Минимальный текущий count среди всех классов.
    let minCount = Infinity;
    for (const id of heroClassIds) {
      if (classCounts[id] < minCount) minCount = classCounts[id];
    }
    // Все классы с минимальным count'ом — кандидаты на этот слот.
    const candidates = heroClassIds.filter(id => classCounts[id] === minCount);
    const classId = candidates[Math.floor(Math.random() * candidates.length)];
    classCounts[classId]++;
    // Уровень кандидата: random integer в [round(maxLvl×min), round(maxLvl×max)],
    // не ниже 1.
    const lo = Math.max(1, Math.round(maxLvl * factorMin));
    const hi = Math.max(lo, Math.round(maxLvl * factorMax));
    const level = lo + Math.floor(Math.random() * (hi - lo + 1));
    const cost = (typeof hireCost === 'function') ? hireCost(level) : (200 * level);
    const mult = (typeof rollUpkeepMultiplier === 'function') ? rollUpkeepMultiplier() : 1.0;
    pool.push({
      nonce: state.nextRecruitNonce++,
      classId,
      level,
      hireCost: cost,
      upkeepMultiplier: mult
    });
  }
  return pool;
}

/* Обновить пул найма (вызывается после миссии и из enterCampMain при
   старте, если пул пуст). Перезаписывает state.recruitPool. */
function refreshRecruitPool() {
  if (!state) return;
  state.recruitPool = generateRecruitPool();
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'refreshRecruitPool', { size: state.recruitPool.length });
  }
}

/* === Camp v2-economy/shop (14.05.2026) ===
   Магазин предметов. Каждую неделю генерируется ECONOMY.SHOP_SIZE
   позиций со случайным уровнем в диапазоне [средняя сложность × min,
   × max]. Если уровень слишком низкий — используем SHOP_MIN_LEVEL. */

/* Вычислить среднюю сложность по всем регионам. */
function averageRegionDifficulty() {
  if (!state || !Array.isArray(state.regions) || !state.regions.length) return 1;
  let sum = 0, n = 0;
  for (const r of state.regions) {
    if (!r) continue;
    sum += (r.difficulty | 0);
    n++;
  }
  return n > 0 ? (sum / n) : 1;
}

/* Перегенерация ассортимента магазина. Вызывается из advanceCalendarWeek
   (каждую миссию/пропуск) и при cold-start в enterCampMain. */
function regenerateShopInventory() {
  if (!state) return;
  const size = (typeof ECONOMY !== 'undefined') ? ECONOMY.SHOP_SIZE : 6;
  const minF = (typeof ECONOMY !== 'undefined') ? ECONOMY.SHOP_LVL_MIN_FACTOR : 0.80;
  const maxF = (typeof ECONOMY !== 'undefined') ? ECONOMY.SHOP_LVL_MAX_FACTOR : 1.20;
  const minLevel = (typeof ECONOMY !== 'undefined') ? ECONOMY.SHOP_MIN_LEVEL : 2;
  const avg = averageRegionDifficulty();
  const lo = Math.max(minLevel, Math.round(avg * minF));
  const hi = Math.max(lo, Math.round(avg * maxF));
  const items = [];
  for (let i = 0; i < size; i++) {
    const lvl = lo + Math.floor(Math.random() * (hi - lo + 1));
    let item = null;
    if (typeof generateRewardItem === 'function') {
      // Несколько попыток — некоторые комбинации сложность/тип могут не
      // дать валидной комбо. Пробуем до 5 раз.
      for (let t = 0; t < 5 && !item; t++) {
        item = generateRewardItem(lvl);
      }
    }
    items.push(item);  // null допустим — слот будет показан как пустой
  }
  state.shopInventory = items;
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'regenerateShopInventory', { avg, lo, hi, count: items.filter(Boolean).length });
  }
}

/* Купить предмет из магазина по его уникальному id. Списывает золото,
   перемещает предмет в state.partyInventory. Покупки в долг запрещены
   (DESIGN): если денег не хватает — действие отклоняется. Возвращает
   true при успехе. */
function buyFromShop(itemId) {
  if (!state || !Array.isArray(state.shopInventory)) return false;
  const idx = state.shopInventory.findIndex(it => it && it.id === itemId);
  if (idx < 0) return false;
  const item = state.shopInventory[idx];
  const price = (typeof itemGoldPrice === 'function') ? itemGoldPrice(item) : 0;
  if (price <= 0) return false;
  if ((state.gold | 0) < price) {
    log('Недостаточно золота для покупки (' + price + ' g)', 'system');
    return false;
  }
  state.gold = (state.gold | 0) - price;
  state.shopInventory[idx] = null;
  // Добавляем в общий инвентарь отряда.
  if (typeof addToInventory === 'function') addToInventory(item);
  const name = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || 'предмет');
  log('Куплено: «' + name + '» за ' + price + ' g (казна: ' + state.gold + ')', 'info');
  if (typeof saveToLocalStorage === 'function') {
    try { saveToLocalStorage(); } catch (e) {}
  }
  return true;
}

/* Продать предмет из инвентаря отряда. 35% от его рыночной стоимости.
   Возвращает true при успехе. */
function sellToShop(itemId) {
  if (!state || !Array.isArray(state.partyInventory)) return false;
  const item = (typeof removeFromInventory === 'function')
    ? removeFromInventory(itemId)
    : null;
  if (!item) return false;
  const price = (typeof itemSellPrice === 'function') ? itemSellPrice(item) : 0;
  state.gold = (state.gold | 0) + price;
  const name = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || 'предмет');
  log('Продано: «' + name + '» за ' + price + ' g (казна: ' + state.gold + ')', 'info');
  if (typeof saveToLocalStorage === 'function') {
    try { saveToLocalStorage(); } catch (e) {}
  }
  return true;
}

/* Открыть экран магазина. Cold-start: если пусто — перегенерируем. */
function enterShopScreen() {
  if (!state) return;
  if ((!Array.isArray(state.shopInventory) || state.shopInventory.length === 0)
      && typeof regenerateShopInventory === 'function') {
    regenerateShopInventory();
  }
  state.campScreen = 'shop';
  if (typeof render === 'function') render();
}

/* Нанять кандидата по nonce. Списывает hireCost (даже если уходит в долг),
   создаёт героя через makeUnit с level=0, ставит upkeepMultiplier из кандидата,
   добавляет в state.party. Запускает level-up очередь из N апов (N = желаемый
   уровень кандидата). Игрок выберет скиллы/статы прямо сейчас.
   Возвращает true при успехе. */
function hireRecruit(nonce) {
  if (!state || !Array.isArray(state.recruitPool)) return false;
  const idx = state.recruitPool.findIndex(r => r && r.nonce === nonce);
  if (idx < 0) return false;
  const recruit = state.recruitPool[idx];
  // Списываем стоимость (может уйти в долг).
  state.gold = (state.gold | 0) - (recruit.hireCost | 0);
  // Создаём героя level=0 (как стартовые — initial level-up queue
  // выдаст N апов до целевого уровня).
  if (typeof makeUnit !== 'function') return false;
  const hero = makeUnit({
    classId: recruit.classId, team: 'B', row: -1, col: -1, level: 0
  });
  // Camp v2-economy (13.05.2026, defensive): жёстко обнуляем уровень,
  // чтобы level-up очередь точно стартовала с 0 → recruit.level. Если
  // makeUnit когда-нибудь начнёт ставить дефолт 1 при level:0 — этот
  // overrride защищает от off-by-one в бампах.
  hero.level = 0;
  hero.activeSkillsOverride = [];
  hero.passiveSkillsOverride = [];
  hero.skills = [];
  hero.restingTurnsLeft = 0;
  hero.participatedThisMission = false;
  hero.upkeepMultiplier = recruit.upkeepMultiplier;
  // Camp v2-economy (13.05.2026): зафиксировать оклад на уровне найма.
  // Будет пересмотрен на ближайшем endOfMonthTick (если к тому моменту
  // hero.level окажется выше за счёт миссий).
  hero.paidLevel = recruit.level | 0;
  state.party.push(hero);
  // Убрать кандидата из пула.
  state.recruitPool.splice(idx, 1);
  const cls = CLASSES[recruit.classId] || {};
  log('Нанят: ' + (cls.name || recruit.classId) + ' (уровень ' + recruit.level + ', найм ' + recruit.hireCost + ' g, содержание ' + Math.round(ECONOMY.U_BASE * recruit.level * recruit.upkeepMultiplier) + ' g/мес)', 'info');
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'hireRecruit', { classId: recruit.classId, level: recruit.level, gold: state.gold });
  }
  // Запускаем level-up очередь для этого героя. N апов = recruit.level.
  // Используем стандартный startLevelUpQueue, передавая список из N
  // повторов одного и того же героя — каждая итерация поднимет ему уровень.
  if (typeof startLevelUpQueue === 'function') {
    const sourceList = [];
    for (let i = 0; i < recruit.level; i++) sourceList.push(hero);
    startLevelUpQueue(sourceList);
  }
  // Автосохранение, чтобы изменение партии не потерялось.
  if (typeof saveToLocalStorage === 'function') {
    try { saveToLocalStorage(); } catch (e) { /* ignore */ }
  }
  return true;
}

function _quarterlyStabilizationCheck() {
  if (!state || !state.calendar) return;
  // advanceCalendarWeek временно делает month=13 перед year rollover,
  // поэтому нормализуем месяц по модулю 12 (13→1).
  const raw = state.calendar.month | 0;
  const m = ((raw - 1) % 12 + 12) % 12 + 1;
  if (m !== 1 && m !== 4 && m !== 7 && m !== 10) return;
  if (!Array.isArray(state.regions) || state.regions.length === 0) return;
  let maxDiff = 0;
  for (const r of state.regions) {
    if (!r) continue;
    if ((r.difficulty | 0) > maxDiff) maxDiff = r.difficulty | 0;
  }
  if (maxDiff <= 1) return; // нет регионов выше 1 — снижать нечего
  const tied = state.regions.filter(r => r && (r.difficulty | 0) === maxDiff);
  const target = tied[Math.floor(Math.random() * tied.length)];
  if (!target) return;
  const before = target.difficulty | 0;
  // Camp v1.5-popups (12.05.2026, балансная правка №3): снижение на 30% с
  // округлением ВВЕРХ результата. Новая сложность = ceil(before * 0.70).
  // Не ниже 1. Примеры: 10→7, 9→7, 8→6, 7→5, 6→5, 5→4, 4→3, 3→3 (нет
  // эффекта), 2→2 (нет эффекта). По сравнению с предыдущим «-35%» эффект
  // ещё мягче: верхние регионы (8-10) проседают на 2-3, средние (4-6) —
  // на 1, низкие (≤3) не трогаются. Прогрессия в средне-низком диапазоне
  // не сбрасывается, игрок вынужден работать руками.
  target.difficulty = Math.max(1, Math.ceil(before * 0.70));
  const text = 'Стража региона ' + (target.name || target.id) +
    ' провела военную операцию и стабилизировала ситуацию в стране. ' +
    'Сложность снизилась: ' + before + ' → ' + target.difficulty + '.';
  _pushCampEvent('quarterly-stabilization', text);
  log(text, 'info');
  if (typeof DebugLog !== 'undefined') {
    DebugLog.log('wave', 'quarterly stabilization', { region: target.id, before, after: target.difficulty });
  }
}

/* Camp v1.5-popups (12.05.2026): дописать событие в журнал миссии.
   Журнал инициализируется _initCampEventsLog() в начале каждого результата
   миссии (force*Victory/Defeat/skipMission) и потребляется попапом
   «События» при входе в лагерь. */
function _pushCampEvent(kind, text) {
  if (!state) return;
  if (!Array.isArray(state.pendingCampEvents)) state.pendingCampEvents = [];
  state.pendingCampEvents.push({ kind: kind, text: text });
}
function _initCampEventsLog() {
  if (!state) return;
  state.pendingCampEvents = [];
}

/* Camp v1.5-popups (12.05.2026): закрытие попапа трофея. Вызывается
   из обработчика клика «Продолжить». Очищает поле, выполняет отложенный
   endMissionCleanup и переход в лагерь.

   Bugfix 12.05.2026: ВСЕГДА вызываем render() в финале, даже на ранних
   возвратах — иначе оверлей трофея остаётся на экране (state-поле
   обнулилось, но DOM не перерисовался). Раньше при state.gameOver==='defeat'
   функция возвращалась без render() и попап «залипал», блокируя весь UI.
   Дополнительно: try/catch вокруг всей цепочки — любая ошибка в
   endMissionCleanup/enterCampMain логируется, но не оставляет попап
   на экране. */
function closeTrophyPopup() {
  if (!state) return;
  state.pendingTrophyPopup = null;
  try {
    if (state.gameOver !== 'defeat') {
      if (state.currentMissionRegionId) endMissionCleanup();
      enterCampMain();
    }
  } catch (e) {
    console.error('[closeTrophyPopup] ошибка в цепочке перехода в лагерь:', e);
  }
  // Финальный render — гарантия скрытия оверлея. enterCampMain уже зовёт
  // render, но если мы попали в ветку gameOver==='defeat' или в catch —
  // render внутри не вызывался. Идемпотентно: лишний render безвреден.
  if (typeof render === 'function') {
    try { render(); } catch (e) { console.error('[closeTrophyPopup] render failed:', e); }
  }
}

/* Camp v1.5-popups (12.05.2026): закрытие попапа событий. Вызывается
   из обработчика клика «Продолжить» в render-modals.

   Bugfix 12.05.2026: try/catch и финальный render аналогично
   closeTrophyPopup — на случай если saveToLocalStorage или render
   падают. */
function closeCampEventsPopup() {
  if (!state) return;
  state.pendingCampEvents = null;
  try {
    if (typeof saveToLocalStorage === 'function') saveToLocalStorage();
  } catch (e) {
    console.warn('[closeCampEventsPopup] autosave failed:', e);
  }
  if (typeof render === 'function') {
    try { render(); } catch (e) { console.error('[closeCampEventsPopup] render failed:', e); }
  }
}

function skipMission() {
  if (!state) return;
  // Camp v1.5-popups (12.05.2026): свежий журнал событий — попап
  // «События» покажется поверх лагеря (где игрок уже находится).
  _initCampEventsLog();
  if (Array.isArray(state.party)) {
    for (const h of state.party) {
      if (!h || !h.alive) continue;
      h.restingTurnsLeft = Math.max(0, ((h.restingTurnsLeft | 0)) - 1);
    }
  }
  if (Array.isArray(state.regions)) {
    for (const r of state.regions) {
      if (!r) continue;
      r.instability = (r.instability | 0) + 1;
    }
  }
  log('Партия отдыхает - миссия пропущена. Нестабильность во всех регионах выросла.', 'info');
  advanceCalendarWeek();
  if (typeof saveToLocalStorage === 'function') {
    try { saveToLocalStorage(); } catch (e) { console.warn('autosave failed', e); }
  }
  if (typeof render === 'function') render();
}

function forceWaveVictory() {
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'forceWaveVictory called', { wave: state && state.wave ? state.wave.number : null, region: state && state.currentMissionRegionId });
  if (!state || state.gameOver === 'defeat') return;
  if (Array.isArray(state.levelUpQueue) && state.levelUpQueue.length > 0) return;
  state.activeUnitId = null;
  state.mode = null;
  // Camp v1.5-popups (12.05.2026): свежий журнал событий — попап
  // «События» в лагере покажет либо «Ничего примечательного…», либо
  // накопленные события (в т.ч. квартальное из endOfMonthTick).
  _initCampEventsLog();

  // Camp v1.5: целевой регион зачищенной миссии. Может быть null, если
  // forceWaveVictory вызван из DevTools без startMission (legacy путь).
  const missionRegion = (state.regions || []).find(r => r && r.id === state.currentMissionRegionId);
  const missionDifficulty = missionRegion ? (missionRegion.difficulty | 0) || 1 : (state.wave && state.wave.number) | 0 || 1;

  if (state.wave && Number.isFinite(state.wave.number)) {
    if (missionRegion) {
      log(`Миссия ${state.wave.number} пройдена («${missionRegion.name}», сложность ${missionDifficulty})`, 'victory');
    } else {
      log(`Битва ${state.wave.number} пройдена`, 'victory');
    }
  } else {
    log('Миссия пройдена', 'victory');
  }

  // Camp v2-economy (13.05.2026): денежная награда за миссию. Используем
  // зафиксированный rewardOffer региона (показанный игроку до выхода на
  // миссию). Если поля нет (legacy/defensive путь) — applyMissionReward
  // сам ролит по сложности.
  const offeredReward = missionRegion ? (missionRegion.rewardOffer | 0) : 0;
  applyMissionReward(offeredReward, missionDifficulty);

  // С7-предметы: награда после победы — один сгенерированный предмет в
  // общий пул отряда. Camp v1.5: сложность для cost-fitting генератора =
  // difficulty целевого региона (а не номер миссии).
  if (typeof generateRewardItem === 'function') {
    const reward = generateRewardItem(missionDifficulty);
    if (reward) {
      addToInventory(reward);
      const fullName = (typeof itemFullName === 'function') ? itemFullName(reward) : (reward.name || reward.id);
      const cost = (typeof itemTotalCost === 'function') ? itemTotalCost(reward) : (reward.costPoints | 0);
      log(`Получена: «${fullName}» (стоимость ${cost})`, 'victory');
      // Camp v1.5-popups (12.05.2026): запомнить трофей, чтобы попап
      // «Вы получили трофей!» появился между level-up очередью и
      // переходом в лагерь. Поле очистится в closeTrophyPopup().
      state.pendingTrophyPopup = { itemRef: reward };
    } else {
      // На раннем этапе (диф 1) валидных комбинаций нет. Это согласуется
      // с дизайном: minimum drop cost = 2. Тихо без награды.
      log(`Награда: ничего не выпало (сложность ${missionDifficulty} ниже минимума дропа)`, 'system');
    }
  }

  // Camp v1.5-calendar (11.05.2026): сложность регионов БОЛЬШЕ НЕ
  // меняется напрямую. Вместо этого правим нестабильность; пересчёт
  // сложности произойдёт в endOfMonthTick на переходе месяца.
  // Победа: target.instability -= 2 (clamp вниз НЕ применяется —
  // может стать отрицательной по дизайну); others.instability += 1.
  // (11.05.2026 балансная правка: -3 → -2, базовая нестабильность 0.)
  if (missionRegion && Array.isArray(state.regions)) {
    const before = state.regions.map(r => r.id + ':d' + r.difficulty + '/i' + r.instability).join(' ');
    for (const r of state.regions) {
      if (!r) continue;
      if (r.id === missionRegion.id) {
        r.instability = (r.instability | 0) - 2;
      } else {
        r.instability = (r.instability | 0) + 1;
      }
    }
    const after = state.regions.map(r => r.id + ':d' + r.difficulty + '/i' + r.instability).join(' ');
    if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'instability updated (victory)', { before, after, target: missionRegion.id });
    // Camp v1.5-threats: реролл угрозы в зачищенном регионе.
    missionRegion.currentThreat = pickRandomThreatId();
    // Camp v2-economy (13.05.2026): свежий офёр награды для зачищенного
    // региона. Игрок увидит новую сумму при следующем заходе на карту.
    if (typeof rollRewardForDifficulty === 'function') {
      missionRegion.rewardOffer = rollRewardForDifficulty(missionRegion.difficulty);
    }
  }
  // Camp v1.5-calendar: +1 неделя (может вызвать endOfMonthTick).
  advanceCalendarWeek();

  // Camp v1.5-fix (14.05.2026): передаём missionDifficulty явно — на
  // момент вызова advanceCalendarWeek уже мог сдвинуть difficulty
  // региона через endOfMonthTick.
  startLevelUpQueue(undefined, missionDifficulty);
}

/* Camp v1.5 (08.05.2026): «миссия провалена» — единая точка проигрыша
   миссии (все участники мертвы, но партия в целом ещё жива).
   Зовётся из checkVictory, когда aliveHeroes=false на поле.

   Что делает:
     1. Замораживает ход.
     2. Лог «Миссия провалена».
     3. Обновляет регионы: ВСЕ +1 (включая целевой). Провал = весь мир
        стал хуже, прогресса по целевому нет. Целевой не обнуляется.
     4. endMissionCleanup() — permadeath дохлых, тик отдыха, очистка поля.
     5. Если после permadeath партия пуста → state.gameOver='defeat'.
        Иначе → enterCampMain().
   Никакой награды и level-up'а (некому давать). */
function forceMissionDefeat() {
  // Camp v1.5-popups (12.05.2026): свежий журнал событий.
  _initCampEventsLog();
  if (!state) return;
  // Идемпотентность: уже в лагере (campScreen!=null) или финальный gameOver —
  // ничего не делаем. Защита от двойного триггера через checkVictory,
  // когда AoE-атака убивает нескольких героев в один тик и applyDamage
  // зовётся последовательно для каждого с проверкой checkVictory между.
  if (state.gameOver === 'defeat') return;
  if (state.campScreen) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'forceMissionDefeat called', { region: state.currentMissionRegionId });
  state.activeUnitId = null;
  state.mode = null;

  const missionRegion = (state.regions || []).find(r => r && r.id === state.currentMissionRegionId);
  if (state.wave && Number.isFinite(state.wave.number)) {
    if (missionRegion) {
      log(`Миссия ${state.wave.number} провалена («${missionRegion.name}»)`, 'victory');
    } else {
      log(`Миссия ${state.wave.number} провалена`, 'victory');
    }
  } else {
    log('Миссия провалена', 'victory');
  }

  // Camp v1.5-calendar (11.05.2026): при провале миссии target.instability +=1
  // (как «не ходили в регион»). Никакого штрафа за провал по линии
  // нестабильности нет — потеря недели и permadeath участников уже цена.
  if (Array.isArray(state.regions)) {
    const before = state.regions.map(r => r.id + ':d' + r.difficulty + '/i' + r.instability).join(' ');
    for (const r of state.regions) {
      if (!r) continue;
      r.instability = (r.instability | 0) + 1;
    }
    const after = state.regions.map(r => r.id + ':d' + r.difficulty + '/i' + r.instability).join(' ');
    if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'instability updated (defeat)', { before, after });
  }
  // Camp v1.5-threats: реролл угрозы в провальном регионе.
  if (missionRegion) {
    missionRegion.currentThreat = pickRandomThreatId();
    // Camp v2-economy (13.05.2026): свежий офёр награды и после провала —
    // регион выставляет новый заказ.
    if (typeof rollRewardForDifficulty === 'function') {
      missionRegion.rewardOffer = rollRewardForDifficulty(missionRegion.difficulty);
    }
  }
  // Camp v1.5-calendar: +1 неделя.
  advanceCalendarWeek();

  endMissionCleanup();

  // Проверка «полное поражение»: если в party не осталось живых —
  // game over. В будущем (v3 найм) условие усложнится: «и нет золота
  // на найм». Пока — простая проверка.
  if (!Array.isArray(state.party) || state.party.length === 0) {
    state.gameOver = 'defeat';
    log('Все герои погибли — конец игры', 'victory');
    if (typeof render === 'function') render();
    return;
  }
  enterCampMain();
}

/* Camp v1.5 (08.05.2026): пост-миссионная очистка состояния партии.
   Зовётся:
     • из advanceLevelUpQueue после исчерпания очереди апов (победный путь);
     • из forceMissionDefeat (проигрышный путь).
   Что делает:
     1. Тикает restingTurnsLeft у всех живых party-героев (decrement
        clamp 0). Те, кто отдыхал прошлую миссию, становятся доступны.
     2. Для участников этой миссии (participatedThisMission=true):
        ставит restingTurnsLeft=1 и сбрасывает флаг participatedThisMission.
        Тик уже прошёл, поэтому ставим строго ПОСЛЕ.
     3. Permadeath: фильтрует state.party — живые остаются, мёртвые
        удаляются ссылкой (мутация массива через replace).
     4. Очищает поле боя: state.units=[], state.objects=[]. На экране
        лагеря поле всё равно скрыто оверлеем, но чистый units нужен,
        чтобы render-units не пытался рисовать «висящих» юнитов с прошлой
        миссии (и чтобы DevTools-селектор юнитов был пуст в лагере). */
function endMissionCleanup() {
  if (!state) return;
  if (typeof DebugLog !== 'undefined') {
    const stat = Array.isArray(state.party) ? {
      total: state.party.length,
      alive: state.party.filter(h => h && h.alive).length,
      participants: state.party.filter(h => h && h.participatedThisMission).length
    } : null;
    DebugLog.log('wave', 'endMissionCleanup', stat);
  }
  if (Array.isArray(state.party)) {
    // 1) Тик отдыха у всех живых.
    for (const h of state.party) {
      if (!h || !h.alive) continue;
      h.restingTurnsLeft = Math.max(0, ((h.restingTurnsLeft | 0)) - 1);
    }
    // 2) Участникам — отдых 1 миссию, флаг сброс.
    for (const h of state.party) {
      if (!h || !h.alive) continue;
      if (h.participatedThisMission) {
        h.restingTurnsLeft = 1;
        h.participatedThisMission = false;
      }
    }
    // 3) Permadeath. Живые сохраняются, мёртвые исчезают навсегда.
    const before = state.party.length;
    state.party = state.party.filter(h => h && h.alive);
    const lost = before - state.party.length;
    if (lost > 0) {
      log(`Потеряно героев: ${lost} (permadeath)`, 'victory');
    }
  }
  // 4) Очистка поля.
  state.units = [];
  state.objects = [];
  state.currentMissionRegionId = null;
  // На всякий случай — сброс боевых UI-флагов.
  state.activeUnitId = null;
  state.selectedUnitId = null;
  state.mode = null;
}

/* Camp v1 (08.05.2026): переход в главный экран лагеря между миссиями.
   Зовётся:
     • из advanceLevelUpQueue, когда очередь апов исчерпана (после
       initial level-up или после победы волны);
     • из startMission/глобальной карты — НЕ зовётся, наоборот:
       enterCampMain делает игру «в лагере», startMission делает
       «в бою».

   Что делает:
     1. Сбрасывает боевые UI-флаги (activeUnitId, mode, selectedUnitId).
     2. Выставляет campScreen='main'.
     3. Вызывает saveToLocalStorage (если функция есть) — автосейв на
        каждый вход в лагерь.
     4. render() — отрисовывает камп.

   Героев на доске оставляем как есть (после startNextWave они стоят
   на спавн-позициях с полным HP/маной). Это не идеально для
   «концептуально все в лагере» (на самом деле они визуально на поле
   между миссиями), но для MVP пойдёт — поле скрывается camp-overlay
   за счёт z-index и фонового затемнения. В будущих v эту визуальную
   нестыковку можно поправить. */
function enterCampMain() {
  if (!state) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'enterCampMain', { wave: state.wave && state.wave.number });
  state.campScreen = 'main';
  state.activeUnitId = null;
  state.mode = null;
  state.selectedUnitId = null;
  // Camp v2-economy: cold-start пул найма (если ещё пуст). После миссий
  // refreshRecruitPool делает advanceCalendarWeek; этот блок ловит самый
  // первый вход в лагерь после нового забега или загрузки старого сейва.
  if ((!Array.isArray(state.recruitPool) || state.recruitPool.length === 0)
      && typeof refreshRecruitPool === 'function') {
    refreshRecruitPool();
  }
  // Camp v2-economy/shop (14.05.2026): cold-start ассортимента магазина.
  if ((!Array.isArray(state.shopInventory) || state.shopInventory.length === 0)
      && typeof regenerateShopInventory === 'function') {
    regenerateShopInventory();
  }
  if (typeof saveToLocalStorage === 'function') {
    try { saveToLocalStorage(); } catch (e) { console.warn('autosave failed', e); }
  }
  if (typeof render === 'function') render();
}

/* Camp v2-economy (13.05.2026): открыть экран найма. Если пул пуст,
   refreshRecruitPool сгенерирует его прямо сейчас (обычно cold-start
   уже отработал в enterCampMain, но это safety net). */
function enterHireScreen() {
  if (!state) return;
  if ((!Array.isArray(state.recruitPool) || state.recruitPool.length === 0)
      && typeof refreshRecruitPool === 'function') {
    refreshRecruitPool();
  }
  state.campScreen = 'hire';
  if (typeof render === 'function') render();
}

/* Camp v1: открыть глобальную карту (выбор миссии). Зовётся из
   главного экрана лагеря по кнопке «Глобальная карта». */
function enterGlobalMap() {
  if (!state) return;
  state.campScreen = 'globalMap';
  // Сбрасываем pending-выбор, если игрок вернулся из missionSetup
  // через какой-то не-стандартный путь.
  state.pendingMissionRegionId = null;
  state.pendingMissionHeroIds = [];
  if (typeof render === 'function') render();
}

/* Camp v1.5-UI (09.05.2026): открыть экран выбора отряда для региона. */
function enterMissionSetup(regionId) {
  if (!state) return;
  const region = (state.regions || []).find(r => r && r.id === regionId);
  if (!region) {
    console.warn('enterMissionSetup: неизвестный regionId', regionId);
    return;
  }
  state.pendingMissionRegionId = regionId;
  state.pendingMissionHeroIds = [];
  state.campScreen = 'missionSetup';
  if (typeof render === 'function') render();
}

/* Camp v1.5-UI: переключить выбор героя для миссии. Если уже выбран —
   убираем; иначе добавляем (но не больше 3 — лимит спавн-позиций
   HERO_SPAWN). Отдыхающие или мёртвые игнорируются. */
function toggleMissionHeroSelection(heroId) {
  if (!state || !Array.isArray(state.pendingMissionHeroIds)) return;
  const hero = (state.party || []).find(h => h && h.id === heroId);
  if (!hero || !hero.alive) return;
  if ((hero.restingTurnsLeft | 0) > 0) return;
  const idx = state.pendingMissionHeroIds.indexOf(heroId);
  if (idx >= 0) {
    state.pendingMissionHeroIds.splice(idx, 1);
  } else {
    // Лимит = HERO_SPAWN.length (Camp v1.5-squad4: 4). Источник правды —
    // массив позиций; если меняем размер отряда, правим только HERO_SPAWN.
    if (state.pendingMissionHeroIds.length >= HERO_SPAWN.length) return;
    state.pendingMissionHeroIds.push(heroId);
  }
  if (typeof render === 'function') render();
}

/* Camp v1.5-UI: подтвердить отряд и стартовать миссию. Если отряд
   пуст — no-op (UI должен disable'ить кнопку). */
function confirmMissionSelection() {
  if (!state) return;
  const regionId = state.pendingMissionRegionId;
  const heroIds = Array.isArray(state.pendingMissionHeroIds) ? state.pendingMissionHeroIds.slice() : [];
  if (!regionId || heroIds.length === 0) return;
  // Camp v1.5-popups (12.05.2026): правило «лёгкая миссия». Перед стартом
  // проверяем, не отправляет ли игрок героев, которые на этой миссии не
  // получат уровень. Если да — показываем попап-предупреждение через
  // state.pendingMissionWarning. Игрок подтверждает или отменяет.
  // Если попап уже стоит и игрок нажал «Отправить всё равно» — поле
  // state.pendingMissionWarning.confirmed=true, минуем проверку.
  const region = (state.regions || []).find(r => r && r.id === regionId);
  if (region && !(state.pendingMissionWarning && state.pendingMissionWarning.confirmed)) {
    const md = region.difficulty | 0;
    const heroes = (state.party || []).filter(h => h && heroIds.indexOf(h.id) >= 0);
    const noLevel = heroes
      .filter(h => ((h.level | 0) - md) >= 3)
      .map(h => {
        const cls = (CLASSES && CLASSES[h.classId]) || {};
        return { id: h.id, name: cls.name || h.classId, level: h.level | 0 };
      });
    if (noLevel.length > 0) {
      state.pendingMissionWarning = {
        regionId: regionId,
        missionDifficulty: md,
        heroes: noLevel,
        confirmed: false
      };
      if (typeof render === 'function') render();
      return; // не стартуем — ждём ответа игрока
    }
  }
  // Сбросить pending-поля ДО startMission (он установит campScreen=null
  // и заполнит state.units; pending-поля больше не нужны).
  state.pendingMissionRegionId = null;
  state.pendingMissionHeroIds = [];
  state.pendingMissionWarning = null;
  startMission(regionId, heroIds);
}

/* Camp v1.5-popups (12.05.2026): закрыть попап-предупреждение «лёгкая
   миссия». action — 'cancel' (остаться на экране подготовки) или
   'send-anyway' (подтвердить и отправить отряд). */
function closeMissionWarning(action) {
  if (!state) return;
  if (action === 'send-anyway') {
    // Помечаем подтверждение и перевызываем confirmMissionSelection,
    // на этот раз проверка пропустится.
    if (state.pendingMissionWarning) state.pendingMissionWarning.confirmed = true;
    confirmMissionSelection();
    return;
  }
  // 'cancel' (или любое другое) — просто закрываем попап.
  state.pendingMissionWarning = null;
  if (typeof render === 'function') render();
}

/* Camp v1.5: legacy-обёртка `startMission()` УДАЛЕНА (было: startMission
   без параметров → startNextWave). Каноническая `startMission(regionId,
   heroIds)` определена выше. UI лагеря дёргает либо новый startMission
   с параметрами (когда придёт UI выбора региона/отряда — Camp v1.5-UI),
   либо `startNextWave()` (текущая legacy-обёртка). */

/* С25: построить очередь апов и запустить первую. Если героев нет —
   сразу следующая волна (degenerate case при очень странных миссиях).
   Порядок: тот же, что инициатива (стабильный, предсказуемый).

   Camp v1.5 (08.05.2026): принимает опциональный sourceList. По умолчанию —
   state.units (так после миссии в очередь попадают ровно её участники,
   потому что state.units после startMission содержит только их + монстров).
   Передача state.party используется в init() для инициального level-up
   0→1 всех 6 героев партии (миссии ещё не было). */
function startLevelUpQueue(sourceList, explicitMissionDifficulty) {
  const list = Array.isArray(sourceList) ? sourceList : (Array.isArray(state.units) ? state.units : []);
  let heroes = list.filter(u => u && u.alive && CLASSES[u.classId] && CLASSES[u.classId].kind === 'hero');
  // Camp v1.5-popups (12.05.2026): правило «лёгкая миссия не даёт уровень».
  // Если heroLevel - missionDifficulty >= 3, герой пропускает level-up.
  // Применяется только когда мы знаем сложность текущей миссии (после
  // победы — state.currentMissionRegionId ещё не очищен; в initial level-up
  // при старте игры currentMissionRegionId === null → правило не действует).
  const missionRegion = (state && state.currentMissionRegionId && Array.isArray(state.regions))
    ? state.regions.find(r => r && r.id === state.currentMissionRegionId)
    : null;
  if (missionRegion) {
    // Camp v1.5-fix (14.05.2026): если вызывающий передал
    // explicitMissionDifficulty — используем его. Нужно потому, что
    // forceWaveVictory зовёт advanceCalendarWeek ДО startLevelUpQueue,
    // и endOfMonthTick (если миссия закрыла месяц) уже пересчитал
    // missionRegion.difficulty. А правило «слишком лёгкая миссия»
    // должно сравнивать с фактической сложностью миссии, а не с новой.
    const md = (typeof explicitMissionDifficulty === 'number' && explicitMissionDifficulty > 0)
      ? (explicitMissionDifficulty | 0)
      : (missionRegion.difficulty | 0);
    const skipped = [];
    heroes = heroes.filter(u => {
      const diff = (u.level | 0) - md;
      if (diff >= 3) {
        skipped.push({ id: u.id, classId: u.classId, level: u.level | 0, missionDifficulty: md });
        return false;
      }
      return true;
    });
    if (skipped.length > 0) {
      if (typeof DebugLog !== 'undefined') {
        DebugLog.log('level-up', 'skip level-up by easy-mission rule', { missionDifficulty: md, skipped });
      }
      // Событие в журнал лагеря — игрок увидит, кто из героев не прокачался.
      if (typeof _pushCampEvent === 'function') {
        for (const s of skipped) {
          const cls = (CLASSES && CLASSES[s.classId]) || {};
          const cname = cls.name || s.classId;
          _pushCampEvent('skip-levelup-easy',
            cname + ' (ур. ' + s.level + ') не получает уровень: миссия слишком лёгкая (сложность ' + md + ').');
        }
      }
    }
  }
  heroes.sort((a, b) => (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
  state.levelUpQueue = heroes.map(u => u.id);
  advanceLevelUpQueue();
}

/* С25: продвинуть очередь апов на одного героя.
   1) Если очередь пуста — снимаем оверлей и запускаем следующую волну.
   2) Иначе — берём первого, инкрементируем уровень + ролл стата
      (applyLevelBump), запоминаем в state.activeLevelUp = { unitId,
      level, autoStat, kind } и зовём UI для отрисовки окна.
   После выбора игрока render-level-up.js зовёт finishCurrentLevelUp,
   которая повторно вызывает advanceLevelUpQueue. */
function advanceLevelUpQueue() {
  if (!state) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('level-up', 'advanceLevelUpQueue', { queueLen: Array.isArray(state.levelUpQueue) ? state.levelUpQueue.length : 0 });
  if (!Array.isArray(state.levelUpQueue) || state.levelUpQueue.length === 0) {
    state.activeLevelUp = null;
    state.levelUpQueue = null;
    if (typeof renderLevelUp === 'function') renderLevelUp();
    // Camp v1 (08.05.2026): по завершении level-up queue — переход в
    // лагерь вместо автоматической следующей волны. Выход на миссию —
    // явный шаг игрока через UI лагеря (кнопка «На миссию» на
    // глобальной карте), который вызывает startMission().
    //
    // Camp v1.5 (08.05.2026): перед переходом — endMissionCleanup
    // (permadeath, тик отдыха, очистка поля). НО только если только что
    // завершилась миссия (state.currentMissionRegionId != null). Если
    // это инициальный level-up при старте игры (никакой миссии не было) —
    // cleanup не нужен и его пропускаем.
    setTimeout(() => {
      if (state.gameOver === 'defeat') return;
      // Camp v1.5-popups (12.05.2026): если по итогам миссии получен трофей —
      // показываем модалку «Вы получили трофей!» прямо на поле, перед
      // лагерем. Игрок жмёт «Продолжить» → closeTrophyPopup() → endMission
      // + enterCampMain. Если трофея нет — сразу в лагерь, как раньше.
      if (state.pendingTrophyPopup) {
        if (typeof render === 'function') render();
        return;
      }
      if (state.currentMissionRegionId) {
        // Обычный пост-миссионный путь: cleanup + переход в главный экран лагеря.
        endMissionCleanup();
        enterCampMain();
      } else if (state.campScreen === 'hire') {
        // Camp v2-economy (13.05.2026): level-up'ы запущены из окна найма.
        // Не выкидываем игрока в главный экран лагеря — он может захотеть
        // нанять ещё. Просто сохраняемся и перерисовываем.
        if (typeof saveToLocalStorage === 'function') {
          try { saveToLocalStorage(); } catch (e) {}
        }
        if (typeof render === 'function') render();
      } else {
        // Initial level-up при старте игры и прочие пути — в главный экран.
        enterCampMain();
      }
    }, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(900) : 900);
    return;
  }
  const unitId = state.levelUpQueue[0];
  const u = getUnit(unitId);
  // Если герой каким-то образом исчез/мёртв до своей очереди (race-
  // edge с DoT-тиками между апами; теоретически невозможно, но
  // defensive) — пропускаем.
  if (!u || !u.alive) {
    state.levelUpQueue.shift();
    advanceLevelUpQueue();
    return;
  }
  // Инкремент уровня + автоматический +1 к ролл-стате.
  const bump = applyLevelBump(u);  // { level, stat }
  // Сформировать список кандидатов на выбор. Правка 06.05.2026:
  // getLevelUpKind теперь возвращает один из 5 kind'ов в зависимости
  // от состава скиллов героя (см. core/level-up.js):
  //   'stats'                    — чётный, +2 к стату из 7;
  //   'skills-new'               — нечёт, изучение нового (фаза 1);
  //   'skills-upgrade-basic'     — нечёт, basic→advanced (фаза 2);
  //   'skills-upgrade-advanced'  — нечёт, advanced→elite (фаза 3);
  //   'stat-bonus'               — нечёт, full-elite (фаза 4): +2 к стату.
  const kind = (typeof getLevelUpKind === 'function')
    ? getLevelUpKind(u, bump.level)
    : null;
  let choices = null;
  const STAT_KEYS = (typeof STAT_ORDER !== 'undefined' && Array.isArray(STAT_ORDER))
    ? STAT_ORDER.slice()
    : ['str', 'vit', 'dex', 'spd', 'wis', 'int', 'luk'];
  if (kind === 'stats' || kind === 'stat-bonus') {
    // Оба stat-режима используют один и тот же набор кнопок. Различие —
    // только в подписи окна (см. render-level-up.js).
    choices = STAT_KEYS;
  } else if (kind === 'skills-new') {
    const newIds = (typeof pickRandomUnlearnedSkills === 'function')
      ? pickRandomUnlearnedSkills(u, 4) : [];
    choices = newIds.map(sid => ({ kind: 'new', skillId: sid }));
  } else if (kind === 'skills-upgrade-basic' || kind === 'skills-upgrade-advanced') {
    const fromTier = (kind === 'skills-upgrade-basic') ? 'basic' : 'advanced';
    const cands = (typeof pickRandomUpgradeCandidates === 'function')
      ? pickRandomUpgradeCandidates(u, fromTier, 4) : [];
    choices = cands.map(s => ({ kind: 'upgrade', skillId: s.id, fromTier: s.tier }));
  }
  state.activeLevelUp = {
    unitId,
    level: bump.level,
    autoStat: bump.stat,
    kind,           // см. список выше
    choices         // формат зависит от kind
  };
  // Camp v1.5 (09.05.2026): синхронизируем выделение юнита с тем, кому
  // сейчас поднимаем уровень — нижняя панель и портрет покажут его статы
  // и навыки, чтобы игрок мог осознанно выбирать +2 стат / новый скилл /
  // апгрейд. До этой правки selectedUnitId оставался от предыдущего
  // выбора (или вообще null между миссиями), и панель показывала пустоту
  // или чужого героя — было неясно, кому именно прокачка.
  state.selectedUnitId = unitId;
  if (typeof log === 'function') {
    const cls = CLASSES[u.classId];
    const statLabel = (typeof STAT_LABELS === 'object' && STAT_LABELS && STAT_LABELS[bump.stat]) || bump.stat;
    log(`${cls.name} (${u.team}) — уровень ${bump.level}! ${statLabel} +1`, 'info');
  }
  // Сначала render() — обновит портрет/нижнюю панель/подсветку
  // активного юнита на поле под нового selectedUnitId. Затем
  // renderLevelUp() — отдельный оверлей, НЕ входит в общий render-цикл
  // (он управляется только из advanceLevelUpQueue/finishCurrentLevelUp).
  // Без второго вызова окно прокачки не появляется (баг 09.05.2026:
  // когда после первой правки заменил renderLevelUp на render, queue
  // тихо зависал — состояние есть, окна нет).
  if (typeof render === 'function') render();
  if (typeof renderLevelUp === 'function') renderLevelUp();
}

/* С25: вызывается из UI после клика игрока «выбрал стату/навык». UI
   уже применил соответствующую мутацию (applyStatChoice / learnNewSkill /
   upgradeSkillTier). Здесь — только сдвиг очереди.

   ВАЖНО: вызывать строго после применения мутации, иначе следующий
   герой получит ап до того, как этот зафиксирует свой выбор. */
function finishCurrentLevelUp() {
  if (!state || !state.levelUpQueue) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('level-up', 'finishCurrentLevelUp', { remaining: state.levelUpQueue.length - 1 });
  state.levelUpQueue.shift();
  state.activeLevelUp = null;
  // Перерисовать панель — выученный навык / повышенный тир должен
  // быть виден сразу (до показа окна следующего героя).
  if (typeof render === 'function') render();
  advanceLevelUpQueue();
}

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
