/* spawn.js — спавн монстров на поле. Выделено из core/state.js
   16.05.2026 в рамках расщепления монолита (пункт 5 backlog в DESIGN.md).

   Что внутри:
     • WAVE_GROUPS — реестр групп врагов (undead/wolves) с рядовыми и
       лидером. Источник правды о составе волны.
     • pickWaveGroup() — случайная группа из WAVE_GROUPS.
     • pickRandomThreatId() — id случайной группы (для region.currentThreat).
     • rollRewardForDifficulty(difficulty) — свежий ролл награды миссии
       (используется при инициализации регионов и пересчёте после
       победы / endOfMonthTick).
     • spawnGroupWave(waveNumber, groupOverride) — спавнит волну выбранной
       группы (или случайной): фиксированный размер 5, лидер по
       baseDifficulty, рядовые равновероятно из group.regulars.
     • spawnZombieWave(count, waveNumber) — legacy (только для DevTools/
       тестов; основной путь миссий идёт через spawnGroupWave).

   Что НЕ внутри:
     • Корневой state и базовые декларации — в state.js.
     • Фабрика юнита (makeUnit), pickRandomFreeCellTopHalf — в units.js.
     • Жизненный цикл миссии (startMission и т.п.) — в mission.js.

   Зависимости:
     • state — глобальная переменная из state.js.
     • CLASSES — из data/classes.js.
     • makeUnit, pickRandomFreeCellTopHalf — из core/units.js.
     • missionReward — из data/economy.js (опционально, fallback в
       rollRewardForDifficulty).
     • log — из render-log.js (для системных сообщений «нет клетки»).
     • DebugLog — из ui/debug-log.js (опционально, для диагностики).

   Файл подключается в index.html ПОСЛЕ units.js и data/economy.js. */

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
   startNextWave вызывает spawnGroupWave (см. выше), а не эту функцию. */
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
