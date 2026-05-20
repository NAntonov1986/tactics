/* level-up-queue.js — очередь повышения уровня героев. Выделено из
   core/state.js 16.05.2026 (расщепление монолита, пункт 5 backlog в
   DESIGN.md, финальный шаг).

   Что внутри:
     • startLevelUpQueue(sourceList?, explicitMissionDifficulty?) — собрать
       очередь по списку героев (или state.units, если sourceList не
       передан), применить правило «слишком лёгкая миссия не даёт уровень»
       (heroLevel − missionDifficulty ≥ 3 → skip), запустить первую итерацию.
     • advanceLevelUpQueue() — продвинуть очередь на одного героя:
       applyLevelBump (level+1 + ролл стата), сформировать варианты выбора
       (stats / skills-new / skills-upgrade-basic / advanced / stat-bonus
       по getLevelUpKind), записать в state.activeLevelUp и зарендерить
       окно прокачки. Когда очередь пуста — переход в лагерь (или показ
       трофея / остаться в окне найма).
     • finishCurrentLevelUp() — вызывается из UI после клика игрока
       («выбрал стату/навык»), сдвигает очередь, зовёт следующую итерацию.

   Что НЕ внутри:
     • Реализация выбора и применения скиллов/стат — в core/level-up.js
       (applyLevelBump, getLevelUpKind, applyStatChoice, learnNewSkill,
       upgradeSkillTier, pickRandomUnlearnedSkills, pickRandomUpgradeCandidates).
     • Жизненный цикл миссии и переход в лагерь — в mission.js и camp.js
       (endMissionCleanup, enterCampMain).

   Зависимости (резолвятся в момент вызова — позднее связывание):
     • state — глобальная переменная из state.js.
     • CLASSES, STAT_ORDER, STAT_LABELS — из data/.
     • getUnit — из core/units.js.
     • applyLevelBump, getLevelUpKind, pickRandomUnlearnedSkills,
       pickRandomUpgradeCandidates — из core/level-up.js.
     • endMissionCleanup — из core/mission.js.
     • enterCampMain — из core/camp.js.
     • render, renderLevelUp, log, AnimSpeed, DebugLog, saveToLocalStorage —
       из render/ui/save.

   Файл подключается в index.html ПОСЛЕ camp.js. */

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
