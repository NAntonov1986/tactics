/* ai.js — искусственный интеллект монстров.
   Что внутри:
     • runAiTurn(unitId) — точка входа: вызывается из beginTurn-сценария,
       когда активный юнит управляется ИИ (CLASSES[id].ai задан). Подбирает
       политику из AI_POLICIES по ключу CLASSES[u.classId].ai и запускает её.
     • AI_POLICIES — реестр всех ИИ-политик. Сейчас определены: zombie, wolf,
       wolf_alpha, skeleton_warrior, skeleton_archer, ghost (плюс idle-политика
       wander). Каждая политика — функция (unit) → последовательность
       setTimeout-шагов (атака, движение, ещё атака, конец хода) с одинаковой
       задержкой.
     • AI_STEP_DELAY_MS — единственное «магическое число» этого блока;
       пауза между шагами политики, чтобы зрителю был понятен порядок.
     • Хелперы выбора цели атаки:
         aiBaseDamage(source, target)  — урон без крита/сопротивлений (для
                                          оценки «добиваю ли с одного удара»),
         aiAttackableTargets(u)        — все враги в пределах range оружия,
         aiPickAttackTarget(u)         — выбор по приоритету: добиваемые →
                                          мин HP → мин Удача → случайный,
         aiPickByLuckThenRandom(list)  — финальный тай-брейк.
     • Хелперы движения:
         aiReachToward(u, target)      — BFS-дистанция до соседней клетки цели
                                          + восстановленный путь,
         aiZombieStepMove(u)           — фаза движения зомби (включая выбор
                                          оптимальной клетки приземления по
                                          лексикографическому скору
                                          [hd, maxAxis, manhattan, d]),
         lexLess(a, b)                 — лексикографическое сравнение чисел.

   Что НЕ внутри:
     • bfsFrom(startR, startC, opts) — шаренная BFS-инфраструктура; используется
       и AI (aiReachToward, aiZombieStepMove), и движением игрока
       (computeMovePath). Переехала в `src/core/movement.js` (R13) вместе с
       computeMovePath/computeReachableCells/executeMove/isBlocked/unitAt/
       graveAt/inBounds. Хелперы выше вызывают её во время выполнения —
       script-тег movement.js подключён до ai.js, имена резолвятся в момент
       вызова в любом случае.
     • executeMove — переехала в `src/core/movement.js` (R13).
       executeAttack / endTurn — вызываются политиками, остаются в монолите
       до R14/R15.
     • canUnitMove — фильтр иммобилизации, остаётся в монолите (effects.js).
     • getUnit / getActiveUnit / state — глобалы из core/state.js (R16).

   Где править параметры существующего ИИ: тут, в нужной политике
     AI_POLICIES (порядок шагов, выбор цели, задержки).
   Где добавить нового монстра с новым поведением: добавить новую политику
     в AI_POLICIES под ключом, который проставлен в CLASSES[id].ai, и
     специфичные ai*-хелперы рядом. См. CODEX.md → «Расширение игры → Новый монстр / ИИ-политика».
   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   Все объявления попадают в глобальный scope window.

   Тонкость с порядком загрузки. Тела всех функций обращаются к глобалам:
   из movement.js (bfsFrom, executeMove, unitAt, graveAt, inBounds),
   из stats-calc.js / weapons.js / classes.js (effectiveStats, moveRangeOf,
   getUnitWeapon, weaponDamage, CLASSES), из effects.js (canUnitMove)
   и из inline (executeAttack, endTurn, state, log, getUnit, getActiveUnit).
   Имена резолвятся в момент ВЫЗОВА, а не определения. К моменту первого
   ИИ-хода inline-блок уже выполнен и все эти глобалы существуют.
*/

/* ================================================================
   === ИИ =========================================================
   Каждому классу с полем ai: 'xxx' соответствует политика в AI_POLICIES.
   Политика — функция (unit) → серия шагов (атака, движение, конец хода),
   которые выполняет сам ИИ и сам завершает ход через endTurn().

   ИИ использует общие функции executeMove/executeAttack (те же, что
   нажимает игрок), чтобы не дублировать логику урона/триггеров. Всё
   это безопасно, потому что executeAttack/executeMove проверяют
   getActiveUnit() внутри — а активным в момент ИИ-хода как раз
   выступает управляемый ИИ юнит.

   Задержки между шагами — чтобы зрителю был понятен порядок: пауза,
   атака, пауза, движение, пауза, атака, конец хода. Константы ниже —
   единственные «магические числа» в этом блоке.
   ================================================================ */
const AI_STEP_DELAY_MS = 420;

function runAiTurn(unitId) {
  const u = getUnit(unitId);
  if (!u || !u.alive) return;
  if (typeof DebugLog !== 'undefined') DebugLog.log('ai', 'runAiTurn', { unitId, classId: u.classId, aggroState: u.aggroState });
  // Юнит перестал быть активным (например, игра закончилась за время
  // setTimeout) — ничего не делаем.
  if (state.activeUnitId !== u.id) return;
  // Aggro-routing (Сессия aggro): если NPC ещё не заметил героев,
  // запускаем idle-policy (бродит по своему idleBehavior). Активный
  // NPC идёт по основной AI_POLICIES-политике как раньше. Если у
  // класса нет специальной idle-политики — спокойно проваливаемся
  // в активную (пусть лучше делает что-то осмысленное, чем стоит).
  if (u.aggroState === 'sleeping') {
    const idleKey = u.idleBehavior || 'wander';
    const idle = IDLE_POLICIES[idleKey];
    if (idle) { idle(u); return; }
  }
  const policy = AI_POLICIES[CLASSES[u.classId].ai];
  if (!policy) {
    endTurn();
    return;
  }
  policy(u);
}

/* Цель для шага «убить за один удар» — берём базовый урон без крита,
   без учёта возможных сопротивлений (их пока нет). Это позволяет ИИ
   надёжно планировать «добивание». Если цель получит эффекты, которые
   могли снизить её HP (например, истечение Vit-дебаффа уже посчитано в
   target.hp — см. clampResourcesAfterStatsChange), расчёт остаётся
   актуальным. */
function aiBaseDamage(source, target) {
  const w = getUnitWeapon(source);
  if (!w) return 0;
  // С2-предметы: третий параметр — source, чтобы weaponDamage добавил
  // damage-бонус с аффиксов экипировки (если у носителя есть).
  return weaponDamage(w, effectiveStats(source), source);
}

/* С23: «Маскировка» — носитель невидим для враждебного AI.
   isHiddenFromAI(unit, ai) — true, если юнит замаскирован и AI ему враждебен.
   Используется для двух фильтров: (1) выбор цели атаки (aiAttackableTargets),
   (2) выбор цели движения (aiZombieStepMove → heroes). НЕ используется для
   AoE-урона — взрывы попадают по геометрии клетки, замаскированный юнит
   физически в зоне (см. шапку SKILLS.camouflage). НЕ используется для
   провокации: forcedTarget уже зафиксирован в прошлом ходу, маскировка
   после этого не отменяет приказ.

   Замаскированная клетка ВСЁ ЕЩЁ проходима как препятствие в bfsFrom —
   та сама по себе считает любого живого юнита блокером (нам не нужно
   делать «AI проходит сквозь замаскированного»: спека прямо говорит
   «считает клетку непроходимой», и это уже верное поведение). */
function isHiddenFromAI(unit, ai) {
  if (!unit || !ai) return false;
  if (unit.team === ai.team) return false;
  return (typeof hasEffect === 'function') && hasEffect(unit, 'camouflage');
}

/* Возвращает список врагов-целей, до которых зомби сейчас может
   дотянуться для атаки (манхэттенская дальность ≤ range оружия). */
function aiAttackableTargets(u) {
  const w = getUnitWeapon(u);
  if (!w) return [];
  // С21: дальность через weaponRangeOf (учёт weaponRangeBonus от Дальнего
  // выстрела и пр.). У текущих NPC бонусов нет, но единый путь проще.
  const range = weaponRangeOf(u);
  return state.units.filter(t =>
    t.alive && t.team !== u.team &&
    !isHiddenFromAI(t, u) &&  // С23: не атаковать замаскированного
    isTargetInRange(u, t, range)  // С24: единый хелпер манхэттена
  );
}

/* Выбор цели атаки по приоритетам зомби:
   1) Если есть те, кого добивает одним ударом (baseDmg ≥ hp) — среди них мин. Удача → случайный.
   2) Иначе среди всех — мин. HP → мин. Удача → случайный.
   Возвращает юнит или null. */
function aiPickAttackTarget(u) {
  // Сессия 20: provoked. Если на юните висит provoked с живым forcedTarget,
  // и тот в радиусе атаки — выбираем именно его, игнорируя обычные
  // эвристики (мин HP/Удача). Если forcedTarget вне радиуса — вернётся
  // null, и обычный шаг попробует подойти ближе (см. aiZombieStepMove).
  if (Array.isArray(u.effects)) {
    const prov = u.effects.find(e => e && e.id === 'provoked');
    if (prov && prov.forcedTarget) {
      const ft = (typeof getUnit === 'function') ? getUnit(prov.forcedTarget) : null;
      if (ft && ft.alive) {
        const w = (typeof getUnitWeapon === 'function') ? getUnitWeapon(u) : null;
        // С21: единая точка вычисления дальности атаки — weaponRangeOf.
        const range = w
          ? ((typeof weaponRangeOf === 'function') ? weaponRangeOf(u) : w.range)
          : 1;
        if (isTargetInRange(u, ft, range)) {
          return ft;
        }
        return null;  // forced цель вне радиуса — пусть AI пытается шагать к ней
      }
    }
  }
  const pool = aiAttackableTargets(u);
  if (!pool.length) return null;
  const killable = pool.filter(t => aiBaseDamage(u, t) >= t.hp);
  const bucket = killable.length ? killable : pool;
  if (!killable.length) {
    // Сортировка по HP возр.
    const minHp = Math.min(...bucket.map(t => t.hp));
    const byHp  = bucket.filter(t => t.hp === minHp);
    return aiPickByLuckThenRandom(byHp);
  }
  return aiPickByLuckThenRandom(bucket);
}

function aiPickByLuckThenRandom(list) {
  if (!list.length) return null;
  const minLuk = Math.min(...list.map(t => effectiveStats(t).luk));
  const byLuk  = list.filter(t => effectiveStats(t).luk === minLuk);
  return byLuk[Math.floor(Math.random() * byLuk.length)];
}

/* Дистанция до врага = мин. длина BFS-пути до одной из его соседних клеток.
   Если все соседи враждебной клетки заблокированы — считаем врага
   недостижимым (дистанция Infinity). Возвращает { dist, path } — путь
   содержит ТОЛЬКО промежуточные клетки, на которых зомби может стоять
   (без самой клетки врага). */
function aiReachToward(u, target) {
  const { dist, parent } = bfsFrom(u.row, u.col);
  const key = (r, c) => r + ',' + c;
  // Ищем адъяцентную клетку цели с минимальной дистанцией.
  let bestK = null, bestD = Infinity;
  const neighbors = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const [dr, dc] of neighbors) {
    const nr = target.row + dr, nc = target.col + dc;
    if (!inBounds(nr, nc)) continue;
    const k = key(nr, nc);
    if (!dist.has(k)) continue;
    if (dist.get(k) < bestD) { bestD = dist.get(k); bestK = k; }
  }
  if (bestK === null) return { dist: Infinity, path: null };
  // Восстанавливаем путь.
  const parts = bestK.split(',');
  let cur = { r: +parts[0], c: +parts[1] };
  const path = [];
  while (cur) {
    path.unshift({ row: cur.r, col: cur.c });
    cur = parent.get(key(cur.r, cur.c));
  }
  return { dist: bestD, path };
}

/* С24-рефактор: единый сборщик force-эффектов AI.
   Раньше zombie-policy step B был каскадом if hasProvoked → aiZombieStepMove;
   elif lure → aiMoveTowardCell; else → aiZombieStepMove. При добавлении
   паники станет 3 ветки, при четвёртом — четыре, при перестановке
   приоритетов — поиск всех мест каскада.

   getForcedMoveDirective(u) собирает в ОДНУ структуру все активные
   force-эффекты на юните и его окружении, сортирует по приоритету и
   возвращает один топ-директив (или null, если ничего не висит).

   Схема возвращаемого объекта:
     {
       source:   'provoked' | 'lure' | <будущее: 'panicked' и т.п.>,
       priority: число (см. таблицу ниже),
       target:   { row, col } или { row, col, unitId } — куда идти.
     }

   Таблица приоритетов (см. DESIGN.md → «Архитектурные инварианты →
   Принудительные движения AI» — invariant: paniked > provoked > lure):
     provoked  = 100
     panicked  =  80   (задел: реализуется отдельной сессией)
     lure      =  50

   dispatchForcedMove(u, directive) — потребитель: переводит directive
   в конкретный executeXxx-вызов. provoked использует aiZombieStepMove
   (там внутри уже читается forcedTarget), остальные — aiMoveTowardCell. */
function getForcedMoveDirective(u) {
  if (!u || !u.alive) return null;
  const candidates = [];

  // provoked (С20). forcedTarget — id вражеского юнита.
  if (Array.isArray(u.effects)) {
    const prov = u.effects.find(e => e && e.id === 'provoked' && e.forcedTarget);
    if (prov && typeof getUnit === 'function') {
      const ft = getUnit(prov.forcedTarget);
      if (ft && ft.alive) {
        candidates.push({
          source: 'provoked',
          priority: 100,
          target: { row: ft.row, col: ft.col, unitId: ft.id }
        });
      }
    }
  }

  // lure (С22). Ближайшая вражеская приманка в радиусе её действия.
  // Действует и на active, и на sleeping NPC (см. findAttractingLure).
  if (typeof findAttractingLure === 'function') {
    const lure = findAttractingLure(u);
    if (lure) {
      candidates.push({
        source: 'lure',
        priority: 50,
        target: { row: lure.row, col: lure.col }
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates[0];
}

/* dispatchForcedMove(u, directive) — переводит directive в конкретный
   ход ИИ. Возвращает true, если директива была применена (т.е. AI
   что-то сделал в рамках force-эффекта); false — если directive=null
   и нужна стандартная политика. Caller проверяет return для решения
   «продолжать ли обычным путём». */
function dispatchForcedMove(u, directive) {
  if (!directive) return false;
  if (directive.source === 'provoked') {
    // aiZombieStepMove внутри сам читает provoked.forcedTarget и идёт
    // к нему в обход обычных эвристик (см. функцию).
    aiZombieStepMove(u);
    return true;
  }
  // lure (и любые будущие cell-target директивы): идём к клетке.
  if (directive.target && typeof aiMoveTowardCell === 'function') {
    aiMoveTowardCell(u, directive.target.row, directive.target.col);
    return true;
  }
  return false;
}

/* Политика зомби (см. CODEX.md → ИИ → Зомби). */
const AI_POLICIES = {
  zombie(u) {
    const steps = [];
    // Шаг A: атака с места.
    const t1 = aiPickAttackTarget(u);
    if (t1) {
      steps.push(() => {
        // Проверяем ещё раз на случай, если за время задержки что-то изменилось.
        const again = aiPickAttackTarget(u);
        if (again) executeAttack(again.id);
      });
    }
    // Шаг B: движение. Сначала спрашиваем единый сборщик force-директив
    // (С24-рефактор: getForcedMoveDirective + dispatchForcedMove); если
    // что-то форсирует — применяем. Иначе обычная политика
    // (aiZombieStepMove → ближайший герой). См. DESIGN.md →
    // «Принудительные движения AI» для таблицы приоритетов.
    steps.push(() => {
      if (!u.alive) return;
      const directive = getForcedMoveDirective(u);
      if (dispatchForcedMove(u, directive)) return;
      aiZombieStepMove(u);
    });
    // Шаг C: если атака не была потрачена, попробовать атаковать снова
    // (новую позицию зомби).
    steps.push(() => {
      if (!u.alive) return;
      if (u.actionsUsedThisTurn.attack) return;
      const t2 = aiPickAttackTarget(u);
      if (t2) executeAttack(t2.id);
    });
    // Финал: завершить ход. ВАЖНО — НЕ выходим по `!u.alive`. Зомби
    // мог умереть прямо в свой ход (Сессия 14: ответка fire_shield;
    // в будущем — любые reflect/thorn-эффекты). Если в этом случае
    // не позвать endTurn, state.activeUnitId останется на мёртвом
    // зомби, очередь не продвинется, и игра «зависнет». endTurn
    // безопасен для мёртвого активного юнита: triggerEffectsAtTurnEnd
    // и triggerPassivesAtTurnEnd проверяют alive внутри, а advanceTurn
    // всё равно продвинет turnIndex.
    steps.push(() => {
      if (state.gameOver) return;
      // Сессия 20: после всех действий хода снимаем эффекты с
      // expiresAt:'forcedMove' (provoked). По спеке: «один шаг или
      // атака — и эффект слетает». На практике мы снимаем после
      // ВСЕГО хода, потому что зомби успевает сделать и шаг, и атаку
      // (это компромисс — иначе пришлось бы вызывать после каждой
      // подфазы политики, что ломает читаемость).
      if (typeof consumeForcedMoveEffects === 'function') {
        consumeForcedMoveEffects(u);
      }
      // Защита от двойного endTurn: вдруг beginTurn уже стартанул
      // следующего юнита (через быстрый таймер на фазе onTurnStart) —
      // тогда наш финал бесполезен и должен молча выйти.
      if (state.activeUnitId !== u.id) return;
      endTurn();
    });
    // Очерёдность с задержками — последовательно.
    let i = 0;
    const next = () => {
      if (i >= steps.length) return;
      const fn = steps[i++];
      try { fn(); } catch (err) { console.error('[AI zombie]', err); }
      // C24: пауза между шагами AI делится на --anim-speed-mul.
      setTimeout(next, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(AI_STEP_DELAY_MS) : AI_STEP_DELAY_MS);
    };
    next();
  }
};

/* ================================================================
   === Волчьи AI-политики =========================================
   wolf и wolf_alpha используют общий шаблон (атака → движение →
   доп.атака → endTurn), но с двумя отличиями от zombie:
     1) Приоритет цели: KILL → MAX joint_hunt_stacks → MIN hp →
        MIN luck → random. (У зомби — KILL → MIN hp → MIN luck.)
     2) wolf-only: фаза движения сначала проверяет, есть ли в зоне
        видимости (на доске) живой лидер группы 'wolves' той же
        команды. Если расстояние Манхэттен > 5 — движемся к лидеру,
        иначе обычная политика «к ближайшему врагу». wolf_alpha
        этой проверки не делает (он сам лидер, ему не за кем идти).
   ================================================================ */

/* Стаки joint_hunt на цели — централизованный читатель.
   Возвращает 0, если эффекта нет. */
function getJointHuntStacks(target) {
  if (!target || !Array.isArray(target.effects)) return 0;
  const eff = target.effects.find(e => e && e.id === 'joint_hunt_marks');
  return eff ? Math.max(0, eff.stacks | 0) : 0;
}

/* Прогноз урона волка по цели с учётом стаков «Совместной охоты»
   (если у самого волка эта пассивка). Используется для определения
   «убью одним ударом». Не учитывает крит — оценка консервативная,
   по образцу aiBaseDamage. */
function aiBaseDamageWolf(source, target) {
  const base = aiBaseDamage(source, target);
  const cls = CLASSES[source.classId];
  if (!cls || !Array.isArray(cls.passiveSkills)) return base;
  if (!cls.passiveSkills.includes('joint_hunt')) return base;
  return base + getJointHuntStacks(target);
}

/* Выбор цели атаки для волка:
   1) Provoked форс — цель = forcedTarget, если он в радиусе атаки.
   2) Можно убить с одного удара (с учётом jointHunt-бонуса) → среди
      них мин. Удача → случайный.
   3) Иначе среди всех досягаемых: цель с MAX joint_hunt_marks стаков.
   4) Иначе цель с MIN HP.
   5) Тай-брейки — мин. Удача, затем случайный. */
function aiPickAttackTargetWolf(u) {
  if (Array.isArray(u.effects)) {
    const prov = u.effects.find(e => e && e.id === 'provoked');
    if (prov && prov.forcedTarget) {
      const ft = (typeof getUnit === 'function') ? getUnit(prov.forcedTarget) : null;
      if (ft && ft.alive) {
        const w = (typeof getUnitWeapon === 'function') ? getUnitWeapon(u) : null;
        const range = w
          ? ((typeof weaponRangeOf === 'function') ? weaponRangeOf(u) : w.range)
          : 1;
        if (isTargetInRange(u, ft, range)) return ft;
        return null;
      }
    }
  }
  const pool = aiAttackableTargets(u);
  if (!pool.length) return null;
  // 1) one-shot kill (с учётом joint_hunt стаков на цели)
  const killable = pool.filter(t => aiBaseDamageWolf(u, t) >= t.hp);
  if (killable.length) return aiPickByLuckThenRandom(killable);
  // 2) MAX joint_hunt_marks
  const maxStacks = Math.max.apply(null, pool.map(getJointHuntStacks));
  let bucket = (maxStacks > 0)
    ? pool.filter(t => getJointHuntStacks(t) === maxStacks)
    : pool.slice();
  // 3) MIN HP среди оставшихся
  const minHp = Math.min.apply(null, bucket.map(t => t.hp));
  bucket = bucket.filter(t => t.hp === minHp);
  // 4) тай-брейк по Удаче и случайно
  return aiPickByLuckThenRandom(bucket);
}

/* Найти лидера группы 'wolves' той же команды для wolf-юнита.
   Источник правды: первый живой юнит с CLASSES[id].isLeader === true
   и group === 'wolves'. Если несколько лидеров на одной команде —
   возвращает ближайшего по Манхэттену (на случай будущих сценариев
   с несколькими альфами). */
function findPackLeader(u) {
  if (!u) return null;
  const candidates = state.units.filter(o => {
    if (!o || !o.alive || o.id === u.id) return false;
    if (o.team !== u.team) return false;
    const cls = CLASSES[o.classId];
    return cls && cls.group === 'wolves' && cls.isLeader === true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const da = Math.abs(a.row - u.row) + Math.abs(a.col - u.col);
    const db = Math.abs(b.row - u.row) + Math.abs(b.col - u.col);
    return da - db;
  });
  return candidates[0];
}

/* Шаг движения волка к врагу — копия aiZombieStepMove, но цель
   выбирается по wolf-правилам: KILL → MAX joint_hunt → MIN hp →
   MIN luk → random. Сама механика BFS/landing-cell идентична.

   ВАЖНО (правка 07.05.2026 по фидбэку): двухэтажная фильтрация. Сначала
   отбираем тех, до кого волк может ДОБЕЖАТЬ И АТАКОВАТЬ В ЭТОТ ЖЕ ХОД
   (BFS-дистанция до соседней клетки врага ≤ moveRange — для оружия
   range=1; для будущих ranged-атак критерий нужно расширить). Только
   среди таких применяем приоритеты (1-shot → MAX стаков → MIN HP →
   MIN luk → random). Если же НИКОГО нельзя достать в этот ход —
   fallback: берём всех достижимых (включая дальних) и применяем те же
   приоритеты, дополнительно отдавая предпочтение БЛИЖАЙШЕМУ по BFS
   (иначе волк побежал бы через всю карту к 1-HP цели мимо более
   близких). Это согласуется с исходной формулировкой «движется к
   ближайшему противнику; если несколько — приоритеты». */
function aiWolfStepMove(u) {
  if (!u.alive) return;
  if (u.actionsUsedThisTurn.move) return;
  if (!canUnitMove(u)) {
    log(`${CLASSES[u.classId].name} (${u.team}) — Обездвижен: движение пропущено`, 'info');
    return;
  }
  let provokedTarget = null;
  if (Array.isArray(u.effects)) {
    const prov = u.effects.find(e => e && e.id === 'provoked');
    if (prov && prov.forcedTarget && typeof getUnit === 'function') {
      const ft = getUnit(prov.forcedTarget);
      if (ft && ft.alive && ft.team !== u.team) provokedTarget = ft;
    }
  }
  const heroes = provokedTarget
    ? [provokedTarget]
    : state.units.filter(h => h.alive && h.team !== u.team && !isHiddenFromAI(h, u));
  if (!heroes.length) return;
  const mr = moveRangeOf(u);
  const withDist = heroes.map(h => ({ hero: h, info: aiReachToward(u, h) }))
                         .filter(x => x.info.dist !== Infinity);
  if (!withDist.length) return;

  // Этап 1: отделяем «можно дойти и атаковать в этот ход» от «слишком
  // далеко». Для weapon.range=1 (Клыки волка) критерий — BFS-дистанция
  // до соседней клетки цели ≤ moveRange. Если в будущем у волков будет
  // ranged-атака, этот критерий надо расширить до «≤ moveRange + (range-1)»
  // или через прямой BFS до клетки-в-радиусе-атаки.
  const reachableThisTurn = withDist.filter(x => x.info.dist <= mr);
  const provokedFallback = !!provokedTarget;  // provoked — единственная цель
  const usePool = (reachableThisTurn.length > 0 && !provokedFallback)
    ? reachableThisTurn
    : withDist;

  // Этап 2: приоритеты.
  let bucket = usePool.map(x => x.hero);
  const oneShots = bucket.filter(t => aiBaseDamageWolf(u, t) >= t.hp);
  if (oneShots.length) {
    bucket = oneShots;
  } else {
    const maxStacks = Math.max.apply(null, bucket.map(getJointHuntStacks));
    if (maxStacks > 0) bucket = bucket.filter(t => getJointHuntStacks(t) === maxStacks);
    const minHp = Math.min.apply(null, bucket.map(t => t.hp));
    bucket = bucket.filter(t => t.hp === minHp);
  }
  // Если pool — fallback (никого нельзя достать в этот ход), среди
  // оставшихся берём БЛИЖАЙШЕГО (минимум BFS-дистанции из withDist).
  // Это сохраняет смысл «к ближайшему» из исходной спеки. Когда
  // pool=reachableThisTurn — все они одинаково «достижимы», и
  // расстояние не используется как тай-брейкер (любой подходит, выбор
  // отдаётся на mid HP/luk шаги выше и финальный random).
  if (usePool === withDist && bucket.length > 1) {
    const distOf = (h) => {
      const r = withDist.find(x => x.hero.id === h.id);
      return r ? r.info.dist : Infinity;
    };
    const minDist = Math.min.apply(null, bucket.map(distOf));
    bucket = bucket.filter(h => distOf(h) === minDist);
  }
  const chosen = aiPickByLuckThenRandom(bucket);
  if (!chosen) return;
  // Этап 3: лучшая клетка для приближения (тот же лекс. порядок, что у zombie).
  // mr уже посчитан выше (используется в фильтре reachableThisTurn).
  const { dist: distFromZ } = bfsFrom(u.row, u.col);
  const { dist: distFromH } = bfsFrom(chosen.row, chosen.col, {
    excludeIds: new Set([u.id])
  });
  let bestCell = null, bestScore = null;
  for (const [k, d] of distFromZ) {
    if (d === 0 || d > mr) continue;
    if (!distFromH.has(k)) continue;
    const comma = k.indexOf(',');
    const r = +k.slice(0, comma);
    const c = +k.slice(comma + 1);
    const hd = distFromH.get(k);
    const dr = Math.abs(r - chosen.row);
    const dc = Math.abs(c - chosen.col);
    const score = [hd, Math.max(dr, dc), dr + dc, d];
    if (!bestScore || lexLess(score, bestScore)) {
      bestScore = score;
      bestCell = { row: r, col: c };
    }
  }
  if (!bestCell) return;
  if (bestCell.row === u.row && bestCell.col === u.col) return;
  executeMove(bestCell.row, bestCell.col);
}

/* Общий шаблон политики волков — фабрика, которая делает фактическую
   функцию ИИ. followLeader=true для рядового волка (фаза движения
   сначала проверяет, не далеко ли вожак); false для wolf_alpha. */
function makeWolfPolicy(followLeader) {
  return function(u) {
    const steps = [];
    // Шаг A: атака с места по wolf-приоритетам.
    const t1 = aiPickAttackTargetWolf(u);
    if (t1) {
      steps.push(() => {
        const again = aiPickAttackTargetWolf(u);
        if (again) executeAttack(again.id);
      });
    }
    // Шаг B: движение.
    steps.push(() => {
      if (!u.alive) return;
      // 1) форс-директивы (provoked/lure) — общий приоритет.
      const directive = getForcedMoveDirective(u);
      if (dispatchForcedMove(u, directive)) return;
      // 2) wolf-only: при наличии лидера группы и расстоянии Manhattan>5
      //    — идём к лидеру (стая собирается). У wolf_alpha этот шаг
      //    отключён.
      if (followLeader) {
        const leader = findPackLeader(u);
        if (leader) {
          const md = Math.abs(leader.row - u.row) + Math.abs(leader.col - u.col);
          if (md > 5) {
            aiMoveTowardCell(u, leader.row, leader.col);
            return;
          }
        }
      }
      // 3) обычное движение к ближайшему противнику по wolf-приоритетам.
      aiWolfStepMove(u);
    });
    // Шаг C: вторая атака, если она ещё не была потрачена.
    steps.push(() => {
      if (!u.alive) return;
      if (u.actionsUsedThisTurn.attack) return;
      const t2 = aiPickAttackTargetWolf(u);
      if (t2) executeAttack(t2.id);
    });
    // Финал: см. AI_POLICIES.zombie — endTurn НЕ выходит по !u.alive.
    steps.push(() => {
      if (state.gameOver) return;
      if (typeof consumeForcedMoveEffects === 'function') {
        consumeForcedMoveEffects(u);
      }
      if (state.activeUnitId !== u.id) return;
      endTurn();
    });
    let i = 0;
    const next = () => {
      if (i >= steps.length) return;
      const fn = steps[i++];
      try { fn(); } catch (err) { console.error('[AI wolf]', err); }
      setTimeout(next, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(AI_STEP_DELAY_MS) : AI_STEP_DELAY_MS);
    };
    next();
  };
}
AI_POLICIES.wolf = makeWolfPolicy(true);
AI_POLICIES.wolf_alpha = makeWolfPolicy(false);

/* ================================================================
   === Скелеты (09.05.2026) =======================================
   Две политики: skeleton_warrior и skeleton_archer.

   skeleton_warrior — рукопашный, как zombie, плюс попытка применить
   «Вторая атака» (second_attack) после первого удара, если рядом ещё
   есть цель. Приоритет цели — стандартный zombie: kill → MIN HP →
   MIN luk → random.

   skeleton_archer — kiter. Перед атакой подкидывает себе бафф
   «Отравленная стрела» (poison_arrow), если ещё не висит. Атака — с
   тех же приоритетов. Движение — двухрежимное: если врагов в радиусе
   атаки нет, подходит ровно на дистанцию обстрела; если есть, отступает,
   сохраняя хотя бы одного врага в радиусе атаки. Лидера у группы
   нет, follower-логика не нужна.

   Используют шаренные хелперы aiPickAttackTarget / aiAttackableTargets
   (приоритет kill→minHP→minLuk идентичен zombie). Для движения лучника
   — собственный хелпер aiSkeletonArcherStepMove ниже.
   ================================================================ */

/* Хелпер: список ВСЕХ живых вражеских юнитов на поле (без camouflage-фильтра
   на этапе подсчёта дистанции — фильтр применяется в выборе цели). */
function aiAllEnemies(u) {
  return state.units.filter(t => t && t.alive && t.team !== u.team && !isHiddenFromAI(t, u));
}

/* Подсчёт, сколько врагов в манхэттенском радиусе attackRange от клетки (r,c).
   Используется лучником-kiter'ом для оценки кандидат-клеток. */
function aiCountEnemiesInRangeFromCell(u, r, c, attackRange, enemies) {
  let n = 0;
  for (const e of enemies) {
    const md = Math.abs(e.row - r) + Math.abs(e.col - c);
    if (md <= attackRange) n++;
  }
  return n;
}

/* Минимальная манхэттенская дистанция от клетки (r,c) до любого врага. */
function aiMinDistToEnemy(r, c, enemies) {
  let min = Infinity;
  for (const e of enemies) {
    const md = Math.abs(e.row - r) + Math.abs(e.col - c);
    if (md < min) min = md;
  }
  return min;
}

/* Движение лучника-скелета (kiter):
     1) Если хотя бы один враг УЖЕ в радиусе атаки от текущей клетки —
        ОТСТУПЛЕНИЕ: ищем достижимую клетку, где (а) хотя бы 1 враг
        остаётся в радиусе атаки, (б) минимальная дистанция до врагов
        максимальна. При равенстве — клетка с большим числом врагов в
        радиусе (можно выбирать цель), затем меньше шагов.
     2) Иначе ПРИБЛИЖЕНИЕ: выбираем цель по wolf-style приоритетам
        (kill → MIN HP → MIN luk → random) среди достижимых, ищем клетку,
        где манхэттенская дистанция до этой цели == weapon.range
        (или как можно ближе к этому значению, не превышая его). */
function aiSkeletonArcherStepMove(u) {
  if (!u.alive) return;
  if (u.actionsUsedThisTurn.move) return;
  if (!canUnitMove(u)) {
    log(`${CLASSES[u.classId].name} (${u.team}) — Обездвижен: движение пропущено`, 'info');
    return;
  }
  const enemies = aiAllEnemies(u);
  if (!enemies.length) return;
  const w = getUnitWeapon(u);
  const attackRange = w ? ((typeof weaponRangeOf === 'function') ? weaponRangeOf(u) : w.range) : 1;
  const mr = moveRangeOf(u);
  const { dist: distFromU } = bfsFrom(u.row, u.col);

  // Текущее «есть ли враг в радиусе атаки прямо сейчас».
  const enemiesInRangeNow = aiCountEnemiesInRangeFromCell(u, u.row, u.col, attackRange, enemies);

  // Собираем все достижимые клетки + текущую.
  const cells = [];
  for (const [k, d] of distFromU) {
    if (d > mr) continue;
    const comma = k.indexOf(',');
    const r = +k.slice(0, comma);
    const c = +k.slice(comma + 1);
    cells.push({ r, c, steps: d });
  }
  if (!cells.length) return;

  let bestCell = null;
  let bestScore = null;

  if (enemiesInRangeNow > 0) {
    // === РЕЖИМ ОТСТУПЛЕНИЯ ===
    // Условие валидности: хотя бы 1 враг в attackRange.
    // Скор: [-minDist, -enemiesInRange, steps] — лексикографически меньше = лучше.
    //   minDist максимизируем (отсюда минус),
    //   enemiesInRange максимизируем (минус, чтобы тай-брейкер выбирал
    //     клетку, откуда можно бить кого-то — больше выбора цели),
    //   steps минимизируем (экономим движение при равенстве).
    for (const cell of cells) {
      const inRange = aiCountEnemiesInRangeFromCell(u, cell.r, cell.c, attackRange, enemies);
      if (inRange < 1) continue;
      const minDist = aiMinDistToEnemy(cell.r, cell.c, enemies);
      const score = [-minDist, -inRange, cell.steps];
      if (!bestScore || lexLess(score, bestScore)) {
        bestScore = score;
        bestCell = cell;
      }
    }
    // Если ни одна клетка не позволяет сохранить врага в радиусе — не
    // двигаемся (лучше остаться, отстрел из текущей клетки уже сорвался,
    // но движение «в лоб» только подставит под удар).
  } else {
    // === РЕЖИМ ПРИБЛИЖЕНИЯ ===
    // Выбираем цель по приоритетам (kill → MIN HP → MIN luk → random)
    // среди тех, до кого вообще можно дойти.
    const withDist = enemies.map(e => ({ hero: e, info: aiReachToward(u, e) }))
                            .filter(x => x.info.dist !== Infinity);
    if (!withDist.length) return;
    let bucket = withDist.map(x => x.hero);
    const oneShots = bucket.filter(t => aiBaseDamage(u, t) >= t.hp);
    if (oneShots.length) {
      bucket = oneShots;
    } else {
      const minHp = Math.min.apply(null, bucket.map(t => t.hp));
      bucket = bucket.filter(t => t.hp === minHp);
    }
    const chosen = aiPickByLuckThenRandom(bucket);
    if (!chosen) return;
    // Цель: подойти на дистанцию ровно attackRange (если возможно),
    // иначе максимально близко.
    // Скор клетки: [|md(target) - attackRange|, md(target), steps]
    //   первая компонента: насколько мы УЖЕ в радиусе или близко к нему
    //     (0 = идеально на радиусе, иначе удаление от него),
    //   вторая: меньше — лучше (если оба варианта вне радиуса, стремимся ближе),
    //   третья: меньше шагов — экономия движения.
    for (const cell of cells) {
      const md = Math.abs(chosen.row - cell.r) + Math.abs(chosen.col - cell.c);
      // Если в радиусе атаки — деградация считается как 0 (мы хотим быть в радиусе).
      const offRange = (md <= attackRange) ? 0 : (md - attackRange);
      // Внутри радиуса предпочитаем КАК МОЖНО ДАЛЬШЕ (kiter), но всё ещё в радиусе.
      // Используем (-md) для тай-брейка внутри радиуса: больше md = лучше (но <= attackRange).
      const distInRange = (md <= attackRange) ? -md : 0;
      const score = [offRange, distInRange, cell.steps];
      if (!bestScore || lexLess(score, bestScore)) {
        bestScore = score;
        bestCell = cell;
      }
    }
  }
  if (!bestCell) return;
  if (bestCell.r === u.row && bestCell.c === u.col) return;
  executeMove(bestCell.r, bestCell.c);
}

/* Политика skeleton_warrior — расширение zombie. Шаги:
     A) Атака с места.
     A.5) Если атаковал и в радиусе ещё враг + Вторая атака доступна — каст.
     A.6) Вторая атака (новый удар).
     B) Движение (force-директивы или к ближайшему врагу, как zombie).
     C) Если атака так и не была потрачена в фазе A — атака после движения.
     D) Финал: consumeForcedMoveEffects + endTurn. */
AI_POLICIES.skeleton_warrior = function (u) {
  const steps = [];
  steps.push(() => {
    if (!u.alive) return;
    const t = aiPickAttackTarget(u);
    if (t) executeAttack(t.id);
  });
  steps.push(() => {
    if (!u.alive) return;
    if (!u.actionsUsedThisTurn.attack) return;
    if (typeof canActivateSkill !== 'function') return;
    if (!canActivateSkill(u, 'second_attack', undefined)) return;
    const stillTargets = aiAttackableTargets(u);
    if (!stillTargets.length) return;
    if (typeof executeSecondAttack === 'function') {
      executeSecondAttack(u.id);
    }
  });
  steps.push(() => {
    if (!u.alive) return;
    if (u.actionsUsedThisTurn.attack) return;
    const t = aiPickAttackTarget(u);
    if (t) executeAttack(t.id);
  });
  steps.push(() => {
    if (!u.alive) return;
    const directive = getForcedMoveDirective(u);
    if (dispatchForcedMove(u, directive)) return;
    aiZombieStepMove(u);
  });
  steps.push(() => {
    if (!u.alive) return;
    if (u.actionsUsedThisTurn.attack) return;
    const t = aiPickAttackTarget(u);
    if (t) executeAttack(t.id);
  });
  steps.push(() => {
    if (state.gameOver) return;
    if (typeof consumeForcedMoveEffects === 'function') consumeForcedMoveEffects(u);
    if (state.activeUnitId !== u.id) return;
    endTurn();
  });
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const fn = steps[i++];
    try { fn(); } catch (err) { console.error('[AI skeleton_warrior]', err); }
    setTimeout(next, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(AI_STEP_DELAY_MS) : AI_STEP_DELAY_MS);
  };
  next();
};

/* Политика skeleton_archer — kiter. Шаги:
     0) Подготовка: повесить poison_arrow_buff на себя, если ещё не висит и
        canActivateSkill (мана/CD/usedThisWave/usedThisTurn для активов).
     A) Атака с места по приоритетам.
     B) Движение (force / kite-логика aiSkeletonArcherStepMove).
     C) Если атака не была потрачена — атака с новой клетки.
     D) Финал: consumeForcedMoveEffects + endTurn. */
AI_POLICIES.skeleton_archer = function (u) {
  const steps = [];
  // Шаг 0: подготовка poison_arrow.
  steps.push(() => {
    if (!u.alive) return;
    if (typeof hasEffect === 'function' && hasEffect(u, 'poison_arrow_buff')) return;
    if (typeof canActivateSkill !== 'function') return;
    if (!canActivateSkill(u, 'poison_arrow', undefined)) return;
    if (typeof executePoisonArrow === 'function') {
      executePoisonArrow(u.id);
    }
  });
  // Шаг A: атака с места.
  steps.push(() => {
    if (!u.alive) return;
    const t = aiPickAttackTarget(u);
    if (t) executeAttack(t.id);
  });
  // Шаг B: движение (kiter).
  steps.push(() => {
    if (!u.alive) return;
    const directive = getForcedMoveDirective(u);
    if (dispatchForcedMove(u, directive)) return;
    aiSkeletonArcherStepMove(u);
  });
  // Шаг C: повторная атака с новой клетки, если ещё не атаковал.
  steps.push(() => {
    if (!u.alive) return;
    if (u.actionsUsedThisTurn.attack) return;
    const t = aiPickAttackTarget(u);
    if (t) executeAttack(t.id);
  });
  // Финал.
  steps.push(() => {
    if (state.gameOver) return;
    if (typeof consumeForcedMoveEffects === 'function') consumeForcedMoveEffects(u);
    if (state.activeUnitId !== u.id) return;
    endTurn();
  });
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const fn = steps[i++];
    try { fn(); } catch (err) { console.error('[AI skeleton_archer]', err); }
    setTimeout(next, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(AI_STEP_DELAY_MS) : AI_STEP_DELAY_MS);
  };
  next();
};


/* ================================================================
   === Призрак (12.05.2026) =======================================
   ИИ-политика лидера группы «нежить». Шаги:
     0) Активация ghostly_scream, если ещё не применялся в этом бою.
        canActivateSkill уже учитывает onceWave-флаг (см. SKILLS.ghostly_scream
        и applyUsedThisWave). Применяется ДО атаки — крик оглушает героев
        на 1 ход и будит всю нежить, после чего сам Призрак спокойно
        бьёт в свою фазу.
     A) Атака с места. Приоритет цели — zombie-style: kill → low HP →
        low luk → random (aiPickAttackTarget).
     B) Движение. Если у Призрака висит provoked/lure (force-директивы) —
        идём по ним; иначе aiGhostStepMove: ближайший противник, среди
        равно-близких — kill → low HP → low luk → random.
     C) Доп-фаза атаки, если атака не была потрачена в фазе A. Те же
        приоритеты, что и в A.
     D) Финал: consumeForcedMoveEffects + endTurn (см. zombie-policy).

   Особенности относительно zombie:
     • Шаг 0 (крик) — уникален для Призрака.
     • Шаг B использует aiGhostStepMove, который при выборе цели среди
       равно-близких берёт one-shot-able раньше, чем low-HP.
       У zombie такого kill-фильтра в движении нет — мы намеренно его
       добавили по спеке. */

/* Шаг движения Призрака к врагу. Копия aiZombieStepMove с расширенным
   тай-брейкером целей: BFS-минимум дистанции → kill-able с одного удара →
   min HP → min luk → random. Шаг 2 (выбор клетки приземления) идентичен
   zombie (лекс. порядок [hd, maxAxis, manhattan, d]). */
function aiGhostStepMove(u) {
  if (!u.alive) return;
  if (u.actionsUsedThisTurn.move) return;
  if (!canUnitMove(u)) {
    log(`${CLASSES[u.classId].name} (${u.team}) — Обездвижен: движение пропущено`, 'info');
    return;
  }
  // provoked-форс — единственная цель, как и у zombie.
  let provokedTarget = null;
  if (Array.isArray(u.effects)) {
    const prov = u.effects.find(e => e && e.id === 'provoked');
    if (prov && prov.forcedTarget && typeof getUnit === 'function') {
      const ft = getUnit(prov.forcedTarget);
      if (ft && ft.alive && ft.team !== u.team) provokedTarget = ft;
    }
  }
  const heroes = provokedTarget
    ? [provokedTarget]
    : state.units.filter(h => h.alive && h.team !== u.team && !isHiddenFromAI(h, u));
  if (!heroes.length) return;

  // Этап 1: выбор цели.
  const withDist = heroes.map(h => ({ hero: h, info: aiReachToward(u, h) }))
                         .filter(x => x.info.dist !== Infinity);
  if (!withDist.length) return;
  // Шаг 1.1: минимум BFS-дистанции (ближайшие).
  const minD = Math.min.apply(null, withDist.map(x => x.info.dist));
  let bucket = withDist.filter(x => x.info.dist === minD).map(x => x.hero);
  // Шаг 1.2: среди ближайших — те, кого можно убить одним ударом
  // (если такие есть). aiBaseDamage не учитывает крит, но учитывает
  // damage-аффиксы оружия — это согласуется с aiPickAttackTarget.
  if (bucket.length > 1) {
    const oneShots = bucket.filter(t => aiBaseDamage(u, t) >= t.hp);
    if (oneShots.length) bucket = oneShots;
  }
  // Шаг 1.3: среди оставшихся — минимум HP.
  if (bucket.length > 1) {
    const minHp = Math.min.apply(null, bucket.map(h => h.hp));
    bucket = bucket.filter(h => h.hp === minHp);
  }
  // Шаг 1.4: тай-брейк по Удаче и случайно (aiPickByLuckThenRandom).
  const chosen = aiPickByLuckThenRandom(bucket);
  if (!chosen) return;

  // Этап 2: лучшая клетка приземления (идентично zombie).
  const mr = moveRangeOf(u);
  const { dist: distFromZ } = bfsFrom(u.row, u.col);
  const { dist: distFromH } = bfsFrom(chosen.row, chosen.col, {
    excludeIds: new Set([u.id])
  });
  let bestCell  = null;
  let bestScore = null;
  for (const [k, d] of distFromZ) {
    if (d === 0 || d > mr) continue;
    if (!distFromH.has(k)) continue;
    const comma = k.indexOf(',');
    const r = +k.slice(0, comma);
    const c = +k.slice(comma + 1);
    const hd        = distFromH.get(k);
    const dr        = Math.abs(r - chosen.row);
    const dc        = Math.abs(c - chosen.col);
    const maxAxis   = Math.max(dr, dc);
    const manhattan = dr + dc;
    const score = [hd, maxAxis, manhattan, d];
    if (!bestScore || lexLess(score, bestScore)) {
      bestScore = score;
      bestCell = { row: r, col: c };
    }
  }
  if (!bestCell) return;
  if (bestCell.row === u.row && bestCell.col === u.col) return;
  executeMove(bestCell.row, bestCell.col);
}

AI_POLICIES.ghost = function (u) {
  const steps = [];
  // Шаг 0: Призрачный крик (если ещё не применялся в этом бою).
  steps.push(() => {
    if (!u.alive) return;
    if (typeof canActivateSkill !== 'function') return;
    if (!canActivateSkill(u, 'ghostly_scream', undefined)) return;
    if (typeof executeGhostlyScream === 'function') {
      executeGhostlyScream(u.id);
    }
  });
  // Шаг A: атака с места.
  steps.push(() => {
    if (!u.alive) return;
    const t = aiPickAttackTarget(u);
    if (t) executeAttack(t.id);
  });
  // Шаг B: движение (force-директивы > обычное движение к ближайшему).
  steps.push(() => {
    if (!u.alive) return;
    const directive = getForcedMoveDirective(u);
    if (dispatchForcedMove(u, directive)) return;
    aiGhostStepMove(u);
  });
  // Шаг C: доп-атака, если атака не была потрачена в шаге A.
  steps.push(() => {
    if (!u.alive) return;
    if (u.actionsUsedThisTurn.attack) return;
    const t = aiPickAttackTarget(u);
    if (t) executeAttack(t.id);
  });
  // Финал: см. AI_POLICIES.zombie — endTurn НЕ выходит по !u.alive.
  steps.push(() => {
    if (state.gameOver) return;
    if (typeof consumeForcedMoveEffects === 'function') {
      consumeForcedMoveEffects(u);
    }
    if (state.activeUnitId !== u.id) return;
    endTurn();
  });
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const fn = steps[i++];
    try { fn(); } catch (err) { console.error('[AI ghost]', err); }
    setTimeout(next, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(AI_STEP_DELAY_MS) : AI_STEP_DELAY_MS);
  };
  next();
};


/* IDLE_POLICIES (Сессия aggro, 04.05.2026) — реестр поведений
   спящих NPC. Ключ — `unit.idleBehavior` (обычно из CLASSES[id]).
   Каждая функция (unit) сама себя завершает endTurn-ом. Активным
   юнитом в момент запуска является `u` — все executeXxx это
   проверяют через getActiveUnit() и работают корректно.

   Контракт idle-политики:
     1) Сделать действие (или ничего).
     2) После действия — checkAggro(state, u). Если враг попал в
        радиус — переключение в active. Движение в этот ход НЕ
        возвращается (по спеке).
     3) endTurn.

   Сейчас единственная политика — wander (случайная клетка в
   радиусе движения через computeReachableCells, либо стоит на
   месте если все клетки заняты). В будущем добавятся 'patrol'
   (хождение между двумя точками), 'sleep' (полностью статичный),
   'feed' (взаимодействие с трупами) и т.п. */
const IDLE_POLICIES = {
  wander(u) {
    const steps = [];
    // Шаг A: случайный шаг в пределах радиуса движения. Список
    // достижимых клеток считает computeReachableCells (учитывает
    // блокеры и деревья). Включаем «остаться на месте» как валидный
    // исход — иначе зомби каждый ход обязательно мечется. По спеке
    // пользователя сейчас разрешено мечется, но если все клетки
    // заняты, мы корректно остаёмся на месте.
    steps.push(() => {
      if (!u.alive) return;
      // Иммобилизованный или с уже потраченным движением (теоретически
      // в idle-фазе невозможно, но defensive check) — пропускаем шаг.
      if (u.actionsUsedThisTurn && u.actionsUsedThisTurn.move) return;
      if (typeof canUnitMove === 'function' && !canUnitMove(u)) {
        // Молча: для idle-зомби «обездвижен» — норма, не нужно
        // спамить лог каждый ход.
        return;
      }
      // С22+С24: force-директивы действуют и на спящих NPC (lure
      // привлекает независимо от aggroState; provoked на спящих
      // теоретически тоже возможен, если у будущих эффектов появится
      // канал применения на sleeping). Спящий не «просыпается» от
      // самой директивы (aggroState остаётся sleeping); checkAggro
      // ниже проверит, не оказался ли герой в радиусе после шага.
      const directive = getForcedMoveDirective(u);
      if (dispatchForcedMove(u, directive)) return;
      const reachable = (typeof computeReachableCells === 'function')
        ? computeReachableCells(u) : [];
      if (!reachable.length) return;  // полностью окружён — стоит на месте
      const pick = reachable[Math.floor(Math.random() * reachable.length)];
      executeMove(pick.row, pick.col);
    });
    // Шаг B: после хода — проверка aggro. Если зомби сдвинулся в
    // зону, где уже виден герой — переключение в 'active'. По спеке
    // пользователя ходовое движение не возвращается (зомби сначала
    // походил, потом «вдруг» заметил — «упустил момент»).
    steps.push(() => {
      if (!u.alive) return;
      if (typeof checkAggro === 'function') {
        checkAggro(state, u);
      }
    });
    // Финал: завершить ход. По тем же причинам, что и в zombie-policy:
    // НЕ выходим по `!u.alive` без endTurn (защита от зависания
    // на мёртвом активном юните).
    steps.push(() => {
      if (state.gameOver) return;
      if (state.activeUnitId !== u.id) return;
      endTurn();
    });
    let i = 0;
    const next = () => {
      if (i >= steps.length) return;
      const fn = steps[i++];
      try { fn(); } catch (err) { console.error('[AI idle:wander]', err); }
      // C24: пауза между шагами AI делится на --anim-speed-mul.
      setTimeout(next, (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(AI_STEP_DELAY_MS) : AI_STEP_DELAY_MS);
    };
    next();
  }
};

/* Лексикографическое сравнение массивов чисел. Возвращает true, если a < b. */
function lexLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length < b.length;
}

/* Движение зомби.
   Этап 1 — выбрать цель (героя): мин BFS-путь до его смежной клетки, далее
            мин HP, мин Удача, случайный.
   Этап 2 — выбрать клетку, куда встать за этот ход. Раньше брали первый
            BFS-путь и делали .slice(0, mr+1); это давало L-образную
            лестницу «сначала всё вниз, потом всё в бок» — BFS-парент
            коллапсировал выбор по порядку обхода соседей, даже когда
            боковой шаг сокращал дистанцию ровно так же. Теперь
            перебираем ВСЕ клетки, достижимые за ≤ mr шагов, и выбираем
            оптимальную по скору:
              1) BFS-дистанция до героя из клетки-приземления (меньше — лучше);
              2) max(|dr|,|dc|) — балансируем оси, чтобы идти по диагонали,
                 когда оба направления равно эффективны;
              3) манхэттен до героя — запасной критерий;
              4) число использованных шагов — при равенстве предпочитаем
                 меньше (экономим движение, если от него нет выгоды).
            BFS от героя считаем с `excludeIds = {u.id}`: клетку самого
            зомби считаем проходимой для hero-BFS, чтобы клетки «перед
            зомби со стороны героя» не получили фантомный детур вокруг
            самого зомби (иначе они бы казались дальше, чем станут после
            шага). */
function aiZombieStepMove(u) {
  if (!u.alive) return;
  if (u.actionsUsedThisTurn.move) return;
  // Иммобилизованный зомби пропускает фазу движения и переходит к
  // следующей фазе своей политики (повторная проверка атаки). Лог
  // пишем один раз — иначе при цепочке ходов «иммобилизованный →
  // ничего не делает» лог быстро забивается.
  if (!canUnitMove(u)) {
    log(`${CLASSES[u.classId].name} (${u.team}) — Обездвижен: движение пропущено`, 'info');
    return;
  }
  // Сессия 20: provoked. Если висит, цель движения = forcedTarget
  // (а не выбор по обычным эвристикам). Если forcedTarget мёртв или
  // недостижим — снимаем эффект ниже автоматически (consumeForcedMoveEffects
  // зовётся в финале zombie-policy после атаки/шага).
  let provokedTarget = null;
  if (Array.isArray(u.effects)) {
    const prov = u.effects.find(e => e && e.id === 'provoked');
    if (prov && prov.forcedTarget && typeof getUnit === 'function') {
      const ft = getUnit(prov.forcedTarget);
      if (ft && ft.alive && ft.team !== u.team) {
        provokedTarget = ft;
      }
    }
  }
  // С23: фильтр по camouflage — замаскированные не выбираются как цель
  // движения. Провокация — исключение: provokedTarget уже зафиксирован
  // в прошлом ходу, маскировка после факта не отменяет приказ.
  const heroes = provokedTarget
    ? [provokedTarget]
    : state.units.filter(h => h.alive && h.team !== u.team && !isHiddenFromAI(h, u));
  if (!heroes.length) return;
  // Этап 1: выбор цели.
  const withDist = heroes.map(h => ({ hero: h, info: aiReachToward(u, h) }))
                         .filter(x => x.info.dist !== Infinity);
  if (!withDist.length) return;
  const minD = Math.min(...withDist.map(x => x.info.dist));
  let bucket = withDist.filter(x => x.info.dist === minD).map(x => x.hero);
  const minHp = Math.min(...bucket.map(h => h.hp));
  bucket = bucket.filter(h => h.hp === minHp);
  const chosen = aiPickByLuckThenRandom(bucket);
  if (!chosen) return;
  // Этап 2: перебираем достижимые клетки и выбираем лучшую.
  const mr = moveRangeOf(u);
  const { dist: distFromZ } = bfsFrom(u.row, u.col);
  const { dist: distFromH } = bfsFrom(chosen.row, chosen.col, {
    excludeIds: new Set([u.id])
  });
  let bestCell  = null;
  let bestScore = null;
  for (const [k, d] of distFromZ) {
    if (d === 0 || d > mr) continue;
    if (!distFromH.has(k)) continue;
    const comma = k.indexOf(',');
    const r = +k.slice(0, comma);
    const c = +k.slice(comma + 1);
    const hd        = distFromH.get(k);
    const dr        = Math.abs(r - chosen.row);
    const dc        = Math.abs(c - chosen.col);
    const maxAxis   = Math.max(dr, dc);
    const manhattan = dr + dc;
    const score = [hd, maxAxis, manhattan, d];
    if (!bestScore || lexLess(score, bestScore)) {
      bestScore = score;
      bestCell = { row: r, col: c };
    }
  }
  if (!bestCell) return;
  if (bestCell.row === u.row && bestCell.col === u.col) return;
  executeMove(bestCell.row, bestCell.col);
}

/* С22: ищет вражескую приманку, в радиусе которой сейчас находится `u`,
   и возвращает её. Несколько приманок в радиусе — берём ближайшую по
   манхэттену, при равенстве — по id для стабильности. Приманка на той
   же клетке, что и `u`, не считается «привлекающей» (мы уже там; если
   так — это значит юнит финиширует на ней этим ходом, и handleLureTrigger
   уже сработает). Только лурe с `ownerTeam !== u.team` — приманка лучника
   не должна притягивать самого лучника (защита от случайных конфликтов
   в будущем при появлении лур у других классов/команд). */
function findAttractingLure(u) {
  if (!Array.isArray(state.objects)) return null;
  const candidates = [];
  for (const obj of state.objects) {
    if (obj.kind !== 'lure') continue;
    if (obj.ownerTeam === u.team) continue;
    const lureRadius = (obj.payload && (obj.payload.lureRadius | 0)) || 0;
    if (lureRadius <= 0) continue;
    const md = Math.abs(obj.row - u.row) + Math.abs(obj.col - u.col);
    if (md === 0) continue;     // уже на клетке — не «привлекает» (срабатывает handleLureTrigger)
    if (md > lureRadius) continue;
    candidates.push({ obj, md });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.md !== b.md) return a.md - b.md;
    return a.obj.id < b.obj.id ? -1 : 1;
  });
  return candidates[0].obj;
}

/* С22: движение к произвольной клетке (не к юниту). Используется
   lure-логикой: цель — клетка приманки. Алгоритм зеркалит aiZombieStepMove,
   но вместо «соседней клетки врага» целью BFS становится сама клетка
   destination — потому что приманка ловит на собственной клетке, а не
   рядом. Возвращает без движения, если destination недостижима за
   moveRangeOf шагов или путь не строится. */
function aiMoveTowardCell(u, destR, destC) {
  if (!u.alive) return;
  if (u.actionsUsedThisTurn.move) return;
  if (!canUnitMove(u)) {
    log(`${CLASSES[u.classId].name} (${u.team}) — Обездвижен: движение пропущено`, 'info');
    return;
  }
  const mr = moveRangeOf(u);
  const { dist: distFromZ } = bfsFrom(u.row, u.col);
  // BFS из destination с исключением самого юнита (его клетка не
  // считается блокером для destination-BFS — иначе клетки рядом с
  // зомби казались бы дальше до приманки, чем будут после шага).
  const { dist: distFromD } = bfsFrom(destR, destC, { excludeIds: new Set([u.id]) });
  let bestCell = null;
  let bestScore = null;
  for (const [k, d] of distFromZ) {
    if (d === 0 || d > mr) continue;
    if (!distFromD.has(k)) continue;
    const comma = k.indexOf(',');
    const r = +k.slice(0, comma);
    const c = +k.slice(comma + 1);
    const dd = distFromD.get(k);
    // Скор: ближе к destination > меньше шагов.
    const score = [dd, d];
    if (!bestScore || lexLess(score, bestScore)) {
      bestScore = score;
      bestCell = { row: r, col: c };
    }
  }
  if (!bestCell) return;
  if (bestCell.row === u.row && bestCell.col === u.col) return;
  executeMove(bestCell.row, bestCell.col);
}
