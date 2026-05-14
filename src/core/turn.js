/* turn.js (core/) — цикл ходов и инициатива.

   Здесь живёт всё, что отвечает на два вопроса: «кто ходит сейчас?»
   и «что произойдёт при смене хода?». До R15 эти куски размазывались
   по inline-блоку: расчёт очерёдности рядом с UI-выбором, фазы хода
   рядом с режимами прицеливания. R15 собрал их в один модуль рядом
   с боем (combat.js) и ИИ (ai.js) — конвенциональный порядок чтения
   получился: «как ходим → как бьём → как ИИ выбирает → как управляется
   ход» (movement → combat → ai → turn).

   Что внутри:
     • computeInitiativeOrder() — массив id живых юнитов в порядке хода
       на текущий раунд. Сортировка по ЭФФЕКТИВНЫМ статам (учёт дебаффов
       Скорости/Удачи через `effectiveStats`): Скорость ↓, Удача ↓,
       `unit.initiativeTiebreak` ↑ (фиксированный на бой случайный
       тай-брейк). Пересчитывается на каждом старте раунда (мог кто-то
       умереть в середине предыдущего).
     • getActiveUnit() — юнит, чей сейчас ход; null, если ещё никто не
       назначен (стартовое состояние до первого beginTurn).
     • beginTurn() — точка входа в собственный ход юнита. Сценарий:
       1) выбрать юнита из state.initiativeOrder[turnIndex]; если он
          мёртв — advanceTurn (был убит до своего хода);
       2) сделать его активным+selected (UI сразу показывает панель);
       3) сбросить per-turn флаги (actionsUsedThisTurn, skillsUsedThisTurn,
          skipTurnThisTurn);
       4) запустить фазу start-of-turn эффектов (DoT, регенерация,
          «разбудить»); если носитель умер на ней — отложенный endTurn,
          чтобы анимация смерти успела сыграться;
       5) если на старте сработал Stun (skipTurnThisTurn=true) — тоже
          отложенный endTurn, без передачи управления;
       6) если юнит ИИ-управляемый — на следующий кадр (setTimeout 280мс)
          запустить runAiTurn, чтобы render успел показать подсветку
          активного юнита и не было рекурсии в одном стеке.
     • endTurn() — завершить собственный ход. Сценарий:
       1) фаза end-of-turn эффектов (поджог, отложенный урон, ауры
          «на конец хода»);
       2) тик длительностей (выдохшиеся эффекты снимаются, статы
          могут вернуться в норму);
       3) advanceTurn (продвинуть turnIndex, при необходимости начать
          новый раунд) и render.
     • advanceTurn() — продвинуть turnIndex. Если очередь раунда
       исчерпана — увеличить round, пересчитать initiativeOrder
       (`computeInitiativeOrder`), сбросить turnIndex в 0. Если бой
       окончен (`checkVictory`) — не запускать новый ход. Иначе —
       beginTurn для следующего юнита.

   Что НЕ внутри:
     • selectUnit / getUnit — это про state-query, остаются в монолите
       до R16 (`core/state.js`). turn.js использует их через script-scope.
     • triggerEffectsAtTurnStart / triggerEffectsAtTurnEnd /
       tickEffectsAtTurnEnd — `core/effects.js` (R12). turn.js только
       зовёт их в нужных местах сценария.
     • runAiTurn — `core/ai.js` (R9). turn.js дёргает его как
       fire-and-forget setTimeout.
     • checkVictory — пока в монолите рядом с фазой смерти/перехода
       волны, не относится к R15. turn.js использует его как глобал.
     • Авто-завершение хода. Сознательно НЕ делается: игроку нужно
       время на обдумывание, плюс остаются активные навыки, не
       учитываемые `actionsUsedThisTurn`. Ход завершается только по
       явной команде (кнопка «Конец хода» или Enter).
     • UI-кнопки «Конец хода», hotkeys (Enter / End) — вызывают
       `endTurn()` отсюда напрямую; сами кнопки/хоткеи — `ui/*` (R18).

   Где править:
     • Порядок инициативы (новые тай-брейки, доп.поля для сортировки) —
       `computeInitiativeOrder`.
     • Сценарий старта/конца хода (новые фазы эффектов, доп.проверки) —
       `beginTurn` / `endTurn`. Помнить про инвариант «если юнит умер
       на старте — отложенный endTurn, иначе анимация смерти не сыграет».
     • Задержка перед ИИ-ходом (сейчас 280мс) — две константы в коде
       (`setTimeout(..., 280)` в beginTurn). При появлении ещё одной
       задержки — выносить в общую константу.

   Тонкость с порядком загрузки. turn.js подключается ПОСЛЕ `core/ai.js`
   (логически: ai.js — это «как принимает решения один юнит», turn.js —
   «как чередуются юниты»; читаемость порядка важнее runtime-резолва).
   Имена runAiTurn / triggerEffectsAtTurn* / state / getUnit / log /
   render / CLASSES / checkVictory / effectiveStats резолвятся в момент
   ВЫЗОВА — к моменту первого beginTurn (через init из inline) inline
   уже выполнен, и все эти глобалы существуют.

   Внешние имена, которые turn.js использует через script-scope
   (резолв при вызове): `state`, `getUnit`, `log`, `render`,
   `checkVictory` (core/state.js); `effectiveStats`, `maxManaOf`
   (core/stats-calc.js); `triggerEffectsAtTurnStart`,
   `triggerEffectsAtTurnEnd`, `tickEffectsAtTurnEnd` (core/effects.js);
   `triggerPassivesAtTurnEnd` (core/skills.js); `runAiTurn` (core/ai.js);
   `CLASSES` (data/classes.js). */

/* ================================================================
   === ИНИЦИАТИВА =================================================
   Порядок: Скорость (убывание) → Удача (убывание) → случайный
   тай-брейк (unit.initiativeTiebreak, фиксированный на бой).
   ================================================================ */
function computeInitiativeOrder() {
  // Порядок считается по ЭФФЕКТИВНЫМ статам — дебаффы скорости/удачи
  // (например, трупный яд) влияют на очередь в текущем раунде.
  return state.units
    .filter(u => u.alive)
    .slice()
    .sort((a, b) => {
      const as = effectiveStats(a), bs = effectiveStats(b);
      if (as.spd !== bs.spd) return bs.spd - as.spd;
      if (as.luk !== bs.luk) return bs.luk - as.luk;
      return a.initiativeTiebreak - b.initiativeTiebreak;
    })
    .map(u => u.id);
}

function getActiveUnit() {
  return state.activeUnitId ? getUnit(state.activeUnitId) : null;
}

/* isPlayerActiveTurn() — true, если СЕЙЧАС ходит юнит, которым
   управляет ИГРОК (не ИИ). Используется UI-слоем, чтобы блокировать
   кнопки/хоткеи/режимы прицеливания во время хода монстра.

   Признак «управляется ИИ» — `CLASSES[u.classId].kind === 'monster'`
   (см. data/classes.js: hero/monster + поле ai с id политики). До
   введения этой функции UI-проверки шли через `state.activeUnitId &&
   !state.gameOver`, что не отсекало случай «ход зомби» — игрок мог
   успеть кликнуть Атака/Движение и приказать чужому юниту, либо
   преждевременно нажать Enter и сорвать ИИ-цикл.

   Возвращает false для:
     • нет активного юнита (стартовое состояние до первого beginTurn);
     • state.gameOver выставлен (победа/поражение);
     • активный юнит — монстр (kind === 'monster'). */
function isPlayerActiveTurn() {
  if (!state || !state.activeUnitId || state.gameOver) return false;
  const u = getUnit(state.activeUnitId);
  if (!u) return false;
  const cls = CLASSES[u.classId];
  return !!cls && cls.kind !== 'monster';
}

/* ================================================================
   === ЦИКЛ ХОДОВ =================================================
   initiativeOrder — список id на текущий раунд.
   turnIndex указывает на того, чей сейчас ход.
   beginTurn() вызывается всегда при смене active-юнита.
   endTurn()   продвигает turnIndex и при необходимости стартует
               следующий раунд (пересчитывает инициативу — на случай
               смертей в середине раунда).
*/
function beginTurn() {
  const uid = state.initiativeOrder[state.turnIndex];
  const u = uid ? getUnit(uid) : null;
  // Если юнит в очереди уже мёртв (убили до его хода) — пропускаем его.
  if (!u || !u.alive) {
    advanceTurn();
    return;
  }
  state.activeUnitId = u.id;
  // Авто-выделение юнита, чей ход только что начался — чтобы игрок
  // сразу видел его панель и мог действовать без лишнего клика.
  state.selectedUnitId = u.id;
  u.actionsUsedThisTurn = { move: false, attack: false };
  u.skillsUsedThisTurn = [];
  // Транзиентный флаг «ход пропущен из-за onTurnStart-хука». Сбрасываем
  // в начале каждого собственного хода, чтобы прошлый Stun не протекал
  // на следующий. Выставляется в SKILLS.stunned.onTurnStart.
  u.skipTurnThisTurn = false;
  state.mode = null;
  // Camp v1.5-priest-B (10.05.2026): воскрешённый священником пропускает
  // СВОЙ ближайший ход. Флаг `skipNextOwnTurn` ставится в executeResurrection;
  // снимается тут после первого попавшего собственного хода. Лог + endTurn
  // отдельным таймером, чтобы успели отыграть фазы render/прогресса.
  if (u.skipNextOwnTurn) {
    u.skipNextOwnTurn = false;
    log(`${CLASSES[u.classId].name} (${u.team}) приходит в себя — ход пропущен`, 'info');
    setTimeout(() => { if (state.activeUnitId === u.id) endTurn(); }, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(600) : 600);
    return;
  }
  log(`Ход #${state.turnIndex + 1} в раунде ${state.round}: ${CLASSES[u.classId].name} (${u.team})`, 'turn');

  // === Глобальное восполнение маны (Сессия 7) =======================
  // Каждый юнит в начале СВОЕГО хода получает +1 маны (если есть мана-
  // pool и не на максимуме). Не пассивный навык — общее правило игры.
  // Накладывается ДО фазы onTurnStart, чтобы хуки эффектов могли
  // увидеть свежий уровень маны (например, отключение каста при пуле).
  // У зомби с int=0 maxMana=5; правило срабатывает, но в логе обычно
  // тихо — фильтруем по реальному приросту.
  const _maxMana = maxManaOf(u);
  if (_maxMana > 0 && u.mana < _maxMana) {
    u.mana = Math.min(_maxMana, u.mana + 1);
    log(`${CLASSES[u.classId].name} (${u.team}): +1 маны (восполнение)`, 'info');
  }

  // С2-предметы: регенерация HP/маны от аффиксов экипировки.
  // Срабатывает ПОСЛЕ глобального восполнения маны (общее правило игры),
  // но ДО фазы статус-эффектов (DoT/Burning/Poisoned). Это даёт
  // согласованный порядок: сначала пассивная подкачка ресурсов из
  // экипировки, потом события эффектов могут кусать или лечить
  // дополнительно. Источник правды — equipmentSpecialSum в stats-calc.js.
  if (typeof triggerEquipmentRegen === 'function') {
    triggerEquipmentRegen(u);
  }

  // Сессия 18: эффекты с `expiresAt:'turnStart'` (Блок щитом, и др.) —
  // снимаются в начале СВОЕГО хода носителя ДО фазы onTurnStart, чтобы
  // юнит вступил в ход уже без устаревших баффов. Источник правды —
  // expireTurnStartEffects в core/effects.js.
  expireTurnStartEffects(u);

  // Сессия волков: пересчёт ауры «Лидер рядом» (pack_leader_aura) для
  // всех юнитов группы 'wolves'. Делается ПЕРЕД onTurnStart-фазой,
  // чтобы DoT/триггеры эффектов (если когда-то будут реагировать на
  // силу) видели актуальный бонус. Затратно только при наличии волков
  // на доске — иначе ранний return.
  if (typeof refreshPackLeaderAuras === 'function') {
    refreshPackLeaderAuras();
  }

  // Camp v1.5-priest-C (11.05.2026): «Исцеляющая аура» — пассивка
  // священника. Если u имеет хотя бы одного соседнего союзника с этой
  // пассивкой, лечится на лучший среди соседних тиров (heal capped
  // maxHp). Зовётся ПОСЛЕ pack_leader (там тоже aura-effect) и ДО
  // onTurnStart-фазы — лечение должно успеть смягчить грядущий DoT-тик.
  if (typeof triggerHealingAuraForUnit === 'function') {
    triggerHealingAuraForUnit(u);
  }

  // === Фаза: начало хода ============================================
  // Эффекты с триггером onTurnStart (DoT, регенерация, «разбудить»)
  // срабатывают ДО того, как юнит получит управление / ДО запуска ИИ.
  // Если фаза убила носителя — ход завершается моментально (см. ответ
  // пользователя: «ход моментально заканчивается»). endTurn прогонит
  // own-end-phase и tick — но эти шаги безвредны для мёртвого носителя.
  const diedOnStart = triggerEffectsAtTurnStart(u);
  // Сессия волков: triggerPassivesAtTurnStart — пассивы с trigger:'onTurnStart'
  // (wolf_howl). Идут ПОСЛЕ статус-эффектов (если стан/яд успел его убить —
  // нет смысла выть) и ДО проверки skipTurnThisTurn (стан не должен заглушать
  // вой по логике, но это можно ужесточить, если потребуется баланс).
  if (u.alive && typeof triggerPassivesAtTurnStart === 'function') {
    triggerPassivesAtTurnStart(u);
  }
  if (diedOnStart || !u.alive) {
    render();
    // Небольшой отложенный endTurn, чтобы отрисовка .is-dying успела
    // проиграться до автоматического перехода — консистентно с тем,
    // как мы уже делаем задержку перед ИИ-ходом (280 мс).
    setTimeout(() => {
      if (state.activeUnitId === u.id && !state.gameOver) endTurn();
    }, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(280) : 280);
    return;
  }

  // Если на фазе старта сработал Stun — юнит не получает управление
  // и не запускает ИИ. Уходим в endTurn отложенно, чтобы успел
  // отрисоваться UI «ход пропущен». Длительность stun'а тикает как
  // у любого эффекта в tickEffectsAtTurnEnd — т.е. Stun на N ходов
  // гарантированно забирает N собственных ходов носителя.
  if (u.skipTurnThisTurn) {
    render();
    setTimeout(() => {
      if (state.activeUnitId === u.id && !state.gameOver) endTurn();
    }, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(280) : 280);
    return;
  }

  // ИИ-юниты ходят сами. Делаем это на следующий кадр, чтобы render успел
  // показать подсветку active-юнита перед началом действий, и чтобы не
  // получить рекурсии beginTurn → endTurn → beginTurn в одном стеке.
  if (CLASSES[u.classId].ai && !state.gameOver) {
    setTimeout(() => runAiTurn(u.id), (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(280) : 280);
  }
}

function endTurn() {
  const u = getActiveUnit();
  if (u) {
    log(`${CLASSES[u.classId].name} (${u.team}) завершает ход`, 'system');
    // === Фаза: конец хода ==========================================
    // Эффекты с триггером onTurnEnd (поджог, отложенный урон,
    // ауры-«на конец хода») срабатывают ДО уменьшения их длительности.
    // Это сохраняет правило «эффект живёт ровно 1 собственный ход»:
    // на своём последнем собственном end-of-turn он успевает сработать,
    // и только потом tick уменьшает remaining в 0.
    // runEffectPhase сам пропустит хуки, если носитель уже мёртв.
    triggerEffectsAtTurnEnd(u);
    // Пассивки с triggerName='onTurnEnd' (Сессия 7: «Восполнение маны»).
    // Идут ПОСЛЕ статус-эффектов и ДО tick — у пассивки своё окно,
    // не пересекающееся с DoT/баффами и не зависящее от их длительности.
    triggerPassivesAtTurnEnd(u);
    // Сессия 17: тик кулдаунов навыков. ПОСЛЕ пассивок и ДО tick'а
    // длительностей эффектов. Так пассивки видят актуальный (ещё не
    // снижённый) cooldown в потенциальных будущих расчётах, а игрок к
    // следующему своему ходу получит обновлённый список доступных навыков.
    tickCooldowns(u);
    tickEffectsAtTurnEnd(u);
    // Сессия 21: эффекты с `expiresAt:'turnEnd'` (Дальний выстрел) —
    // снимаются строго в конце ХОДА носителя, ПОСЛЕ всех остальных фаз.
    // Симметрия к expireTurnStartEffects(u) в beginTurn. Источник правды —
    // expireTurnEndEffects в core/effects.js.
    expireTurnEndEffects(u);
  }
  // Aggro (Сессия aggro): после ВСЕХ end-of-turn фаз проверяем
  // спящих NPC. Если активный юнит был героем — он мог подойти к
  // спящему врагу в свой ход. Если активный был NPC (active) — он
  // мог сдвинуться через территорию спящего собрата (но это его не
  // разбудит, разбудить может только герой). Проверка дешёвая,
  // вызываем безусловно для простоты — see core/aggro.js.
  if (typeof checkAggroForAllNpcs === 'function') {
    checkAggroForAllNpcs(state);
  }
  advanceTurn();
  render();
}

function advanceTurn() {
  state.mode = null;
  state.turnIndex++;
  // Закончился раунд — пересобираем порядок (кто-то мог умереть).
  if (state.turnIndex >= state.initiativeOrder.length) {
    state.round++;
    state.initiativeOrder = computeInitiativeOrder();
    state.turnIndex = 0;
    log(`── Раунд ${state.round} ──`, 'turn');
  }
  // Если бой окончен (победа волны или поражение) — не начинаем новый ход.
  if (checkVictory()) return;
  beginTurn();
}

/* Авто-завершение хода намеренно не делаем: игроку может понадобиться
   время на обдумывание, плюс у некоторых классов остаются активные
   способности, которые не учитываются базовыми actionsUsedThisTurn.
   Ход завершается только по явной команде (кнопка «Конец хода» или Enter). */
