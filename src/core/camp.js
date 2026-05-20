/* camp.js — лагерь, экономика, экраны и календарь. Выделено из
   core/state.js 16.05.2026 (расщепление монолита, пункт 5 backlog в
   DESIGN.md).

   Что внутри:
     === Календарь ===
     • advanceCalendarWeek() — +1 неделя, переход в новый месяц/год,
       триггер endOfMonthTick и onWeek/Month/YearTick хуков.
     • endOfMonthTick() — пересчёт сложности регионов из instability,
       зарплата, квартальное событие.

     === Экономика ===
     • applyMissionReward(amount, difficulty) — начислить золото за победу.
     • applyMonthlySalary() — списать зарплату партии, обновить debtMonths.

     === Найм ===
     • generateRecruitPool() — сгенерировать пул из ECONOMY.POOL_SIZE
       кандидатов с минимизацией дублей классов.
     • refreshRecruitPool() — публичная обёртка над generateRecruitPool.
     • hireRecruit(nonce) — нанять кандидата: списать gold, создать героя
       через makeUnit, запустить level-up очередь до целевого уровня.

     === Магазин ===
     • averageRegionDifficulty() — средняя сложность регионов (для генератора).
     • regenerateShopInventory() — обновить ассортимент магазина.
     • buyFromShop(itemId), sellToShop(itemId).
     • enterShopScreen() — экран магазина.

     === События (попапы в лагере) ===
     • _quarterlyStabilizationCheck() — квартальное событие «Стража
       стабилизировала регион» (снижение сложности самого опасного
       региона на 30%).
     • _pushCampEvent(kind, text), _initCampEventsLog() — журнал событий
       месяца (попап «События» при входе в лагерь).

     === Экраны лагеря ===
     • enterCampMain() — главный экран. Cold-start пула найма и магазина.
     • enterHireScreen() — экран найма.
     • enterGlobalMap() — глобальная карта (выбор миссии).
     • enterMissionSetup(regionId) — выбор отряда для региона.
     • toggleMissionHeroSelection(heroId) — переключить выбор героя
       в pendingMissionHeroIds (лимит HERO_SPAWN.length).
     • confirmMissionSelection() — подтвердить отряд и стартовать миссию.

   Что НЕ внутри:
     • Корневой state, HERO_SPAWN — в state.js.
     • makeUnit, addToInventory, removeFromInventory — в units.js.
     • Spawn волн — в spawn.js.
     • Жизненный цикл миссии (startMission/forceWaveVictory/skipMission/
       closeMissionWarning и т.п.) — в mission.js.
     • Level-up очередь (startLevelUpQueue) — в level-up-queue.js.

   Зависимости (резолвятся в момент вызова):
     • state, HERO_SPAWN — из state.js.
     • CLASSES, ECONOMY — из data/classes.js, data/economy.js.
     • makeUnit, addToInventory, removeFromInventory — из units.js.
     • startMission — из mission.js (для confirmMissionSelection).
     • startLevelUpQueue — из level-up-queue.js (для hireRecruit).
     • missionReward, hireCost, rollUpkeepMultiplier, partySalaryTotal,
       maxPartyLevel, itemGoldPrice, itemSellPrice — из data/economy.js
       и render-camp.js (itemGoldPrice/itemSellPrice).
     • rollRewardForDifficulty — из spawn.js.
     • generateRewardItem — из core/loot.js.
     • itemFullName — из data/affixes.js.
     • log, render, saveToLocalStorage, DebugLog — из render/ui/save.

   Файл подключается в index.html ПОСЛЕ mission.js. */

/* ================================================================
   === КАЛЕНДАРЬ ==================================================
   ================================================================ */

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

/* ================================================================
   === ЭКОНОМИКА: НАГРАДА И ЗАРПЛАТА ==============================
   ================================================================
   Camp v2-economy (13.05.2026). Все формулы — в data/economy.js.
   Здесь только применение результата к state и побочные эффекты
   (логи, события, обновление UI). */

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

/* ================================================================
   === НАЙМ =======================================================
   ================================================================ */

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

/* ================================================================
   === МАГАЗИН ====================================================
   ================================================================
   Camp v2-economy/shop (14.05.2026). Каждую неделю генерируется
   ECONOMY.SHOP_SIZE позиций со случайным уровнем в диапазоне
   [средняя сложность × min, × max]. Если уровень слишком низкий —
   используем SHOP_MIN_LEVEL. */

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

/* ================================================================
   === СОБЫТИЯ В ЛАГЕРЕ ===========================================
   ================================================================ */

/* Camp v1.5-popups (12.05.2026): квартальное событие «Стража стабилизировала
   регион». Вызывается ИЗНУТРИ endOfMonthTick после обновления difficulty,
   поэтому r.difficulty уже актуален. */
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

/* ================================================================
   === ЭКРАНЫ ЛАГЕРЯ ==============================================
   ================================================================ */

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
   убираем; иначе добавляем (но не больше HERO_SPAWN.length — лимит
   спавн-позиций). Отдыхающие или мёртвые игнорируются. */
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

/* Camp v2-economy (13.05.2026): открыть экран магазина. Если ассортимент
   пуст — перегенерируем перед показом (cold-start обычно отработал в
   enterCampMain, но это safety net). */
function enterShopScreen() {
  if (!state) return;
  if ((!Array.isArray(state.shopInventory) || state.shopInventory.length === 0)
      && typeof regenerateShopInventory === 'function') {
    regenerateShopInventory();
  }
  state.campScreen = 'shop';
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
