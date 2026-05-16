/* mission.js — жизненный цикл миссии. Выделено из core/state.js
   16.05.2026 (расщепление монолита, пункт 5 backlog в DESIGN.md).

   Что внутри:
     • startMission(regionId, heroIds) — основная точка входа в бой:
       помечает участников, размещает их на HERO_SPAWN, спавнит врагов
       через spawnGroupWave, запускает раунд/инициативу.
     • startNextWave() — legacy-обёртка над startMission (первый регион +
       первые HERO_SPAWN.length живых не-отдыхающих).
     • checkVictory() — проверка «нет живых героев → defeat / нет живых
       монстров → victory». Триггерит forceMissionDefeat / forceWaveVictory.
     • forceWaveVictory() — единая точка победного исхода: нестабильность
       регионов −2/+1, генерация награды (item + gold), advanceCalendarWeek,
       startLevelUpQueue.
     • forceMissionDefeat() — единая точка проигрыша: нестабильность +1
       всем, endMissionCleanup, проверка финального gameOver.
     • endMissionCleanup() — пост-миссионная очистка: тик restingTurnsLeft,
       permadeath, очистка поля.
     • skipMission() — пропуск миссии («партия отдыхает»): тик отдыха,
       нестабильность +1 всем, advanceCalendarWeek.
     • closeTrophyPopup() — закрытие попапа трофея (Продолжить → лагерь).
     • closeCampEventsPopup() — закрытие попапа событий месяца.
     • closeMissionWarning(action) — закрытие предупреждения «лёгкая миссия»
       (cancel / send-anyway).

   Что НЕ внутри:
     • Корневой state, HERO_SPAWN — в state.js.
     • makeUnit, getUnit — в units.js.
     • spawnGroupWave — в spawn.js.
     • Camp-экраны (enterCampMain/enterHireScreen/enterMissionSetup/
       toggleMissionHeroSelection/confirmMissionSelection и т.п.) — в camp.js.
     • Camp-экономика (applyMissionReward/applyMonthlySalary/recruit/shop)
       и календарь (advanceCalendarWeek/endOfMonthTick) — в camp.js.
     • Level-up очередь (startLevelUpQueue) — в level-up-queue.js.

   Зависимости (резолвятся в момент вызова — порядок загрузки не критичен):
     • state, HERO_SPAWN — из state.js.
     • getUnitArmor, applyArmored — из data/equipment.js, core/effects.js.
     • maxHpOf, maxManaOf — из core/stats-calc.js.
     • spawnGroupWave, pickRandomThreatId, rollRewardForDifficulty — из spawn.js.
     • generateRewardItem, addToInventory, itemFullName, itemTotalCost —
       из core/loot.js, units.js, data/affixes.js.
     • applyMissionReward, advanceCalendarWeek, enterCampMain,
       _initCampEventsLog, confirmMissionSelection — из camp.js.
     • startLevelUpQueue — из level-up-queue.js.
     • checkAggroForAllNpcs, computeInitiativeOrder, beginTurn — из core/.
     • log, render, saveToLocalStorage, DebugLog — из render/ui/save.

   Файл подключается в index.html ПОСЛЕ units.js и spawn.js. */

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

/* Camp v1.5-popups (12.05.2026): закрытие попапа трофея. Зовётся из
   обработчика клика «Продолжить» в render-modals.

   Bugfix 13.05.2026: до этого функция выходила без render() в ветке
   gameOver=='defeat' и без try/catch — если saveToLocalStorage или
   render внутри enterCampMain падал из-за ошибки, попап «залипал».
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
