/* movement.js (core/) — движение юнитов и BFS-инфраструктура по сетке.

   Здесь живут все «грид-примитивы» (что лежит на клетке, что её блокирует,
   границы поля) и три BFS-обхода:
     • computeReachableCells — все клетки, куда юнит МОЖЕТ дойти за ход
       (диамант радиуса = moveRangeOf(unit) с учётом блокеров). Используется
       режимом движения для подсветки.
     • computeMovePath — конкретный путь от юнита к целевой клетке (с учётом
       facing — «вперёд» предпочтительнее «вбок»), для пошаговой анимации.
     • bfsFrom — generic BFS от произвольной клетки, возвращает обе мапы
       (dist + parent). Используется AI-хелперами (`aiReachToward` и др.)
       для оценки дистанции «сквозь» конкретных врагов.

   Что внутри:
     • unitAt(row, col) — живой юнит на клетке или null.
     • graveAt(row, col) — павший юнит (надгробие) на клетке или null.
       Надгробие — физический объект, блокирует ходьбу так же, как живой
       юнит. Состояние isDying — это ещё «доигрывающее тело», не надгробие;
       блокирует так же, но отличаем явно для будущих механик
       (подобрать, воскресить и т.д.).
     • isBlocked(row, col) — клетка непроходима? Живой юнит ИЛИ надгробие.
     • inBounds(row, col) — клетка внутри поля? Опирается на state.grid.
     • computeReachableCells(unit) — массив { row, col } всех достижимых
       клеток. Стартовую клетку юнита НЕ возвращает.
     • computeMovePath(unit, targetRow, targetCol) — массив клеток
       { row, col } от стартовой до целевой (включая обе) или null,
       если цель недостижима. Порядок перебора соседей зависит от facing.
     • executeMove(row, col) — выполнить ход активным юнитом в (row, col).
       Меняет state, ставит mode в null, пишет в лог, дёргает render
       и анимацию. Защищён от повторного хода (`actionsUsedThisTurn.move`)
       и от «Обездвижен» (`canUnitMove`) — проверяется на входе ещё раз,
       даже если UI уже не пустит.
     • bfsFrom(startR, startC, { excludeIds } = {}) — generic BFS,
       возвращает { dist, parent }. Параметр excludeIds (Set<id>) — список
       юнитов, которых BFS не считает блокерами (используется для
       «видеть сквозь» конкретного врага при оценке дистанции до него).

   Что НЕ внутри:
     • computeAttackTargets, computeAttackArea — про оружие/атаку,
       живут в `core/combat.js` (R14).
     • playMoveAnimation, movement-анимации — пока в монолите, переедут
       в render-кластер (R17).
     • AI-обходы (aiReachToward, aiZombieStepMove) — `core/ai.js` (R9);
       они вызывают `bfsFrom` и `unitAt`/`graveAt`/`inBounds` отсюда.
     • moveRangeOf, canUnitMove — в `core/stats-calc.js` (R10) и
       `core/effects.js` (R12) соответственно. Здесь читаются как глобалы.
     • Состояние `state` и `PreviewState.movePath` — `let`-переменные
       в монолите. movement.js обращается к ним через script-scope
       (`<script>`-теги делят lexical-окружение для top-level let/const).

   Где править: правила «что блокирует клетку» — `isBlocked` (если
     появятся, например, ловушки или огненные поля). Порядок перебора
     соседей при движении — `computeMovePath` (массив `steps`). Радиус
     достижимости считается в `moveRangeOf` (stats-calc.js), не здесь.
     Блокировки на ход (стан/обездвижен) — `canUnitMove` (effects.js).

   Тонкость с порядком загрузки. movement.js ссылается в коде:
     - на `state` (монолит, let), `moveRangeOf` (stats-calc.js),
       `canUnitMove` (effects.js), `getActiveUnit` (монолит),
       `playMoveAnimation` (монолит, render-кластер), `render` (монолит),
       `log` (монолит), `CLASSES` (data/classes.js),
       `PreviewState.movePath` (монолит, let).
     Все имена резолвятся в момент ВЫЗОВА, а не загрузки — к моменту
     первого хода inline уже выполнен, все глобалы существуют. Поэтому
     этот script подключается среди core/* в любой удобной позиции
     (после data/* и stats-calc.js — на всякий случай, чтобы статический
     анализатор не ругался при чтении), но runtime-зависимостей по
     порядку нет. */

function unitAt(row, col) {
  return state.units.find(u => u.alive && u.row === row && u.col === col) || null;
}

/* Надгробие как физический объект: возвращаем павшего юнита, чья могила
   стоит на этой клетке. Пока юнит в состоянии isDying — это ещё
   «доигрывающее тело», а не надгробие; на ходьбе пусть блокирует так же,
   но отличаем явно на случай будущих механик (подобрать, воскресить и т.д.). */
function graveAt(row, col) {
  return state.units.find(u => !u.alive && u.row === row && u.col === col) || null;
}

/* Дерево на клетке? Возвращает true/false (объект {row,col} в state.trees,
   но наружу нам нужен только факт наличия). Деревья — статические
   декорации поля, ставятся один раз в createInitialState. Не блокируют
   стрельбу/фаербол (атаки считаются по манхэттену и не смотрят на
   блокеры) — только движение через isBlocked ниже. */
function treeAt(row, col) {
  if (!Array.isArray(state.trees)) return false;
  for (const t of state.trees) {
    if (t.row === row && t.col === col) return true;
  }
  return false;
}

/* Сессия 17 (задел Сессии 22): объект на клетке (капкан, приманка, ...).
   Возвращает первый объект на клетке или null. Один объект на клетку —
   гарантирует addObject (когда появится). state.objects живёт в
   core/state.js; на новой волне массив очищается. */
function objectAt(row, col) {
  if (!Array.isArray(state.objects)) return null;
  for (const obj of state.objects) {
    if (obj.row === row && obj.col === col) return obj;
  }
  return null;
}

/* Сессия 22: два разных хука по объектам, разные семантики срабатывания.

   triggerObjectsOnPathStep(unit, r, c) — на КАЖДОМ шаге пути в executeMove.
     Используется для срабатывания капканов (trap.kind): жертва шагнула
     на клетку → урон + immobilize → объект удаляется. Вызывается ДО
     проверки canUnitMove, потому что immobilize, наложенный капканом,
     должен прервать дальнейшее движение в этом же ходу.

   triggerObjectsOnMoveEnd(unit, r, c) — ровно ОДИН раз в самом конце
     executeMove (на финальной клетке полного пути). Используется для
     срабатывания приманок (lure.kind): враг ДОЛЖЕН ЗАВЕРШИТЬ ход на
     клетке lure, чтобы она исчезла. Если враг прошёл сквозь клетку
     (например, у lure-target движение продолжалось после останова) —
     приманка НЕ срабатывает.

   Диспатч по `kind` происходит здесь же — чтобы вся логика «что делает
   объект при срабатывании» жила в одном месте. handle*-функции — рядом. */
function triggerObjectsOnPathStep(unit, row, col) {
  if (!unit || !unit.alive || !Array.isArray(state.objects)) return;
  // Снимок: handle*-функции мутируют state.objects (удаляют сработавший).
  const here = state.objects.filter(o => o.row === row && o.col === col);
  for (const obj of here) {
    if (obj.kind === 'trap') handleTrapTrigger(obj, unit);
  }
}

function triggerObjectsOnMoveEnd(unit, row, col) {
  if (!unit || !unit.alive || !Array.isArray(state.objects)) return;
  const here = state.objects.filter(o => o.row === row && o.col === col);
  for (const obj of here) {
    if (obj.kind === 'lure') handleLureTrigger(obj, unit);
  }
}

/* Капкан срабатывает: наносит payload.dmg физического урона через единый
   путь computeIncomingDamage + applyDamage (source=null — безличный
   объект, не запускает onDealDamage-пассивок). Применяет immobilized на
   2 хода (балансная правка 05.05.2026 — чтобы жертва гарантированно
   пропустила движение на свой следующий ход). Объект удаляется.
   Срабатывает на ЛЮБОГО юнита (свой/чужой), по правилу пользователя
   22.05.2026. */
function handleTrapTrigger(obj, victim) {
  const cls = CLASSES[victim.classId];
  const who = cls ? `${cls.name} (${victim.team})` : victim.id;
  const dmg = (obj.payload && obj.payload.dmg | 0) || 0;
  log(`${who} попал в капкан на (${obj.row},${obj.col}) — ${dmg} физ. урона`, 'damage');
  // Через единый pipeline (3 фазы), чтобы armored/иммунитет к физическому
  // (если когда-нибудь появится) тоже работал корректно.
  if (dmg > 0 && typeof computeIncomingDamage === 'function' && typeof applyDamage === 'function') {
    const adj = computeIncomingDamage(victim, dmg, 'physical');
    if (adj.note) log(`  ${adj.note}`, 'info');
    applyDamage(victim, adj.dmg, null);
  }
  if (victim.alive && typeof applyImmobilized === 'function') {
    applyImmobilized(victim, 2);
  }
  removeObject(obj.id);
}

/* Приманка срабатывает: применяет applyOnPickup (если есть) к завершившему
   ход на её клетке. Объект удаляется (одноразовый). Эффект: сейчас
   применяется ТОЛЬКО на враждебной к ownerTeam цели — приманка лучника не
   должна травить случайно зашедшего союзника. На своей клетке она и так
   не срабатывает у хозяина (lure ловит того, кто сюда движется через AI;
   герой-хозяин обычно не идёт к своей же приманке). Но фильтр по команде
   зеркалит безопасное поведение consumeNextAttackEffects — стрелы яда
   тоже не накладываются на союзников. */
function handleLureTrigger(obj, victim) {
  const cls = CLASSES[victim.classId];
  const who = cls ? `${cls.name} (${victim.team})` : victim.id;
  log(`${who} достиг приманки на (${obj.row},${obj.col}) — приманка исчезает`, 'info');
  const onPickup = obj.payload && obj.payload.applyOnPickup;
  if (onPickup && onPickup.id && obj.ownerTeam !== victim.team) {
    const dur = (onPickup.duration | 0) || 0;
    if (dur > 0) {
      if (onPickup.id === 'poisoned'    && typeof applyPoisoned    === 'function') applyPoisoned(victim, dur);
      if (onPickup.id === 'burning'     && typeof applyBurning     === 'function') applyBurning(victim, dur);
      if (onPickup.id === 'stunned'     && typeof applyStunned     === 'function') applyStunned(victim, dur);
      if (onPickup.id === 'immobilized' && typeof applyImmobilized === 'function') applyImmobilized(victim, dur);
    }
  }
  removeObject(obj.id);
}

/* Клетка непроходима? Живой юнит ИЛИ надгробие ИЛИ дерево. */
function isBlocked(row, col) {
  return !!unitAt(row, col) || !!graveAt(row, col) || treeAt(row, col);
}

function inBounds(row, col) {
  return row >= 0 && row < state.grid.rows && col >= 0 && col < state.grid.cols;
}

/* С24-рефактор: единая точка манхэттенской проверки дальности.
   Раньше копипастилось в 5+ мест — `Math.abs(a.row-b.row) + Math.abs(a.col-b.col) <= range`.
   Семантика: «цель в пределах range от атакующего по манхэттену»,
   range >= 0 целое. Equality (==) включена в диапазон.

   Метрика: МАНХЭТТЕН (`|dr| + |dc|`). Это согласуется с дальностью
   оружия и большинства AoE-навыков. Чебышев (max(|dr|,|dc|)) пока
   нужен только в aggro-радиусе и через эту функцию НЕ резолвится —
   там осознанно отдельный inline-вычислитель в core/aggro.js.

   Параметры: a и b могут быть юнитами (u, target) или клетками
   ({row, col}). Любой объект с .row/.col подойдёт; никакой проверки
   alive/team тут нет — фильтр живых/чужих остаётся за вызывающим. */
function isTargetInRange(a, b, range) {
  if (!a || !b || !Number.isFinite(range)) return false;
  return (Math.abs(a.row - b.row) + Math.abs(a.col - b.col)) <= range;
}

/* Манхэттенская дистанция между двумя точками. Используется там, где
   нужно само число (для сортировки кандидатов, описания в логе и т.п.),
   а не just-bounded check. См. также isTargetInRange выше. */
function manhattan(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/* ================================================================
   === ДВИЖЕНИЕ ===================================================
   BFS по ортогональной сетке, радиус = moveRangeOf(unit).
   Через других юнитов и надгробия проходить нельзя — это физические
   препятствия. Стрельба (computeAttackTargets) на них не смотрит:
   манхэттенская дальность по определению «через всё».
*/
function computeReachableCells(unit) {
  const max = moveRangeOf(unit);
  const dist = new Map();
  const key = (r, c) => r + ',' + c;
  const queue = [{ r: unit.row, c: unit.col, d: 0 }];
  dist.set(key(unit.row, unit.col), 0);
  const results = [];
  while (queue.length) {
    const { r, c, d } = queue.shift();
    if (d >= max) continue;
    const steps = [[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dr, dc] of steps) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const k = key(nr, nc);
      if (dist.has(k)) continue;
      // Блокируют и живые юниты, и надгробия.
      if (isBlocked(nr, nc)) continue;
      dist.set(k, d + 1);
      results.push({ row: nr, col: nc });
      queue.push({ r: nr, c: nc, d: d + 1 });
    }
  }
  return results;
}

/* Возвращает путь (массив клеток от стартовой до целевой включительно)
   или null, если цель недостижима в пределах радиуса хода. Используется
   для пошаговой анимации — чтобы юнит шёл по клеткам, а не скользил
   наискосок к финалу.

   Порядок перебора соседей зависит от facing юнита: «вперёд» идёт
   первым, потом стороны, потом «назад». BFS отдаёт первому
   достигающему предку приоритет → диагональный путь получается
   «сначала вперёд, потом в сторону», как просит дизайн. */
function computeMovePath(unit, targetRow, targetCol) {
  const max = moveRangeOf(unit);
  const key = (r, c) => r + ',' + c;
  const steps = unit.facing === 'up'
    ? [[-1,0], [0,-1], [0,1], [1,0]]    // вверх, влево, вправо, вниз
    : [[ 1,0], [0,-1], [0,1], [-1,0]];  // вниз,  влево, вправо, вверх
  const dist = new Map();
  const parent = new Map();
  const startK = key(unit.row, unit.col);
  dist.set(startK, 0);
  parent.set(startK, null);
  const queue = [{ r: unit.row, c: unit.col, d: 0 }];
  while (queue.length) {
    const { r, c, d } = queue.shift();
    if (d >= max) continue;
    for (const [dr, dc] of steps) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const k = key(nr, nc);
      if (dist.has(k)) continue;
      if (isBlocked(nr, nc)) continue;  // живые юниты и надгробия
      dist.set(k, d + 1);
      parent.set(k, { r, c });
      queue.push({ r: nr, c: nc, d: d + 1 });
    }
  }
  const targetK = key(targetRow, targetCol);
  if (!dist.has(targetK)) return null;
  const path = [];
  let cur = { r: targetRow, c: targetCol };
  while (cur) {
    path.unshift({ row: cur.r, col: cur.c });
    cur = parent.get(key(cur.r, cur.c));
  }
  return path;
}

function executeMove(row, col) {
  const u = getActiveUnit();
  if (!u) return;
  if (u.actionsUsedThisTurn.move) return;
  // Финальная защита от движения под «Обездвижен». UI/режим уже
  // блокируют ход в эту функцию (enterMode не пустит, кнопка disabled),
  // но если эффект встал прямо во время режима — проверим ещё раз здесь.
  if (!canUnitMove(u)) return;
  // Строим полный запрошенный путь (BFS с учётом фасинга). Если не
  // строится — цель недостижима за ходовой бюджет, выходим.
  const requestedPath = computeMovePath(u, row, col);
  if (!requestedPath || requestedPath.length < 2) return;

  const fromR = u.row, fromC = u.col;
  // Сессия 22: пошаговое движение с триггером объектов после каждого
  // шага. Если по пути сработал капкан (urd + immobilize) или юнит
  // погиб — прерываем оставшиеся шаги. actualPath — реально пройденная
  // последовательность клеток, передаётся в playMoveAnimation, чтобы
  // анимация совпадала с фактическим движением (не «доезжала» до
  // запрошенной клетки, если жертва остановилась раньше).
  const actualPath = [requestedPath[0]];
  let lastR = fromR, lastC = fromC;
  for (let i = 1; i < requestedPath.length; i++) {
    const step = requestedPath[i];
    u.row = step.row;
    u.col = step.col;
    lastR = step.row;
    lastC = step.col;
    actualPath.push(step);
    // Триггер объектов «по шагу» — сейчас это капкан (см. handleTrapTrigger
    // в этом же файле). Он удаляет себя из state.objects, накладывает
    // damage + immobilized на жертву.
    triggerObjectsOnPathStep(u, step.row, step.col);
    // Прерывание: жертва погибла или обездвижена. canUnitMove читает
    // свежий immobilized, поставленный handleTrapTrigger выше.
    if (!u.alive || !canUnitMove(u)) break;
  }

  u.actionsUsedThisTurn.move = true;
  state.mode = null;
  PreviewState.movePath = null;
  log(`${CLASSES[u.classId].name} (${u.team}) идёт (${fromR},${fromC}) → (${lastR},${lastC})`, 'info');
  // С23: «Маскировка» снимается при ЛЮБОМ движении носителя — добровольном
  // или принудительном (lure / cover). Унификация: один безусловный вызов
  // здесь покрывает все источники движения (player click, AI step, charge,
  // teleport, lure-driven, cover-driven). Если эффекта нет — no-op.
  // Снятие происходит ПОСЛЕ обновления позиции и trap-триггеров, но ДО
  // triggerObjectsOnMoveEnd ниже (lure-pickup) — по логике «движение
  // завершено, скрытность утрачена». Технически порядок не важен (lure
  // не зависит от camouflage), но сохраняем временной порядок.
  if (typeof removeCamouflage === 'function') {
    removeCamouflage(u, 'движение');
  }
  // Триггер «завершил полный ход на этой клетке» — для приманок (lure).
  // Срабатывает ТОЛЬКО на финальной фактической клетке (не на промежуточных).
  triggerObjectsOnMoveEnd(u, lastR, lastC);
  render();
  // Пошаговая анимация запускается после render — к этому моменту
  // .unit уже в фактической финальной клетке (lastR, lastC). Анимация
  // «отматывается» до стартовой клетки и проигрывается по actualPath.
  playMoveAnimation(u.id, actualPath);
}

/* Принудительное движение под эффектом «Напуган» (см. SKILLS.frightened
   в data/skills.js → onTurnStart). Вызывается из фазы start-of-turn для
   носителя эффекта. Поведение:

     1) Если ход уже начался без движения (actionsUsedThisTurn.move уже
        true — например, на этом ходу раньше отработал другой принудитель)
        либо движение запрещено (canUnitMove=false из-за «Обездвижен»/
        «Напуган» в одном пакете) — пропускаем тихо.

     2) Считаем reachable клетки через computeReachableCells (тот же BFS,
        что у обычного movement-режима). Если пусто — отбегать некуда,
        пропускаем (ход НЕ теряется: атаки/навыки доступны как обычно —
        выбор пользователя «Остаётся, ход не теряет»).

     3) Считаем «текущую безопасность» — min Manhattan до ближайшего
        враждебного живого юнита от текущей клетки. Если врагов на
        карте нет (например, все умерли в начале хода до этого хука) —
        пропускаем: убегать не от кого.

     4) Для каждой reachable клетки считаем тот же min Manhattan и
        фильтруем по правилу «строго дальше, чем сейчас». Если ни одна
        клетка не улучшает безопасность — стоим (текущая позиция уже
        самая безопасная среди достижимых). Это согласуется с фразой
        «отодвинуться максимально далеко»: смысла «случайно прыгнуть в
        равноудалённую» нет.

     5) Среди улучшающих клеток берём максимум по min-distance, при
        равенстве — случайный выбор. Затем выполняем шаги ровно как
        executeMove (пошагово, с триггерами объектов и анимацией).

   Метрика: МАНХЭТТЕН. Совпадает с дальностью оружий и большинства AoE,
   т.е. отражает реальную «дотягиваемость» противников. Чебышев в этом
   файле используется только в aggro-радиусе и здесь не подходит
   (диагональное удаление в одной плоскости ничего бы не давало против
   Manhattan-стрельбы). */
function executeFrightenedMove(unit, _eff) {
  if (!unit || !unit.alive) return;
  if (unit.actionsUsedThisTurn && unit.actionsUsedThisTurn.move) return;
  if (!canUnitMove(unit)) return;
  const enemies = state.units.filter(o => o && o.alive && o.team !== unit.team);
  if (!enemies.length) return;
  const minDistFrom = (r, c) => {
    let best = Infinity;
    for (const e of enemies) {
      const d = Math.abs(r - e.row) + Math.abs(c - e.col);
      if (d < best) best = d;
    }
    return best;
  };
  const currentSafety = minDistFrom(unit.row, unit.col);
  const reachable = computeReachableCells(unit);
  if (!reachable.length) return;
  // Выбираем только клетки, которые СТРОГО улучшают min-distance.
  let bestSafety = currentSafety;
  let candidates = [];
  for (const cell of reachable) {
    const d = minDistFrom(cell.row, cell.col);
    if (d > bestSafety) { bestSafety = d; candidates = [cell]; }
    else if (d === bestSafety && bestSafety > currentSafety) { candidates.push(cell); }
  }
  if (!candidates.length) {
    const cls = CLASSES[unit.classId];
    log(`${cls ? cls.name : unit.id} (${unit.team}) — Напуган: отступать некуда, остаётся на месте`, 'info');
    return;
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  // Реюзаем pipeline executeMove, но напрямую (а не через getActiveUnit) —
  // на старте хода ИИ ещё не запущен, и нам нужно двинуть носителя
  // эффекта, кем бы он ни был. Скопирована логика пошагового движения
  // с триггерами объектов и анимацией (см. executeMove выше).
  const requestedPath = computeMovePath(unit, pick.row, pick.col);
  if (!requestedPath || requestedPath.length < 2) return;
  const fromR = unit.row, fromC = unit.col;
  const actualPath = [requestedPath[0]];
  let lastR = fromR, lastC = fromC;
  for (let i = 1; i < requestedPath.length; i++) {
    const step = requestedPath[i];
    unit.row = step.row;
    unit.col = step.col;
    lastR = step.row;
    lastC = step.col;
    actualPath.push(step);
    triggerObjectsOnPathStep(unit, step.row, step.col);
    if (!unit.alive || !canUnitMove(unit)) break;
  }
  if (!unit.actionsUsedThisTurn) unit.actionsUsedThisTurn = { move: false, attack: false };
  unit.actionsUsedThisTurn.move = true;
  const cls = CLASSES[unit.classId];
  log(`${cls ? cls.name : unit.id} (${unit.team}) — Напуган: бежит (${fromR},${fromC}) → (${lastR},${lastC})`, 'info');
  if (typeof removeCamouflage === 'function') {
    removeCamouflage(unit, 'принудительное движение (страх)');
  }
  triggerObjectsOnMoveEnd(unit, lastR, lastC);
  if (typeof render === 'function') render();
  if (typeof playMoveAnimation === 'function') {
    playMoveAnimation(unit.id, actualPath);
  }
}

/* BFS от стартовой клетки по всему полю — возвращает мапу «клетка → дистанция»
   и мапу «клетка → родительская клетка» для восстановления пути.
   Блокеры (живые юниты + надгробия) учитываются, НО стартовая клетка
   и клетки, на которых стоят враги-цели, сами по себе не добавляются как
   проходимые — цели находятся «рядом с» ними: BFS должен остановиться на
   ближайшей клетке, примыкающей к цели. Для этого мы передаём в isBlocker
   коллбэк, который не считает блокерами стартового юнита и опциональные
   исключения (например, если нужно «не считать» какого-то конкретного врага). */
function bfsFrom(startR, startC, { excludeIds } = {}) {
  const dist = new Map();
  const parent = new Map();
  const key = (r, c) => r + ',' + c;
  dist.set(key(startR, startC), 0);
  parent.set(key(startR, startC), null);
  const queue = [{ r: startR, c: startC, d: 0 }];
  while (queue.length) {
    const { r, c, d } = queue.shift();
    const steps = [[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dr, dc] of steps) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const k = key(nr, nc);
      if (dist.has(k)) continue;
      // Блокеры: другие юниты, надгробия и ДЕРЕВЬЯ. Исключения — старт
      // и excludeIds (позволяет «видеть сквозь» конкретного врага для
      // вычисления дистанции до НЕГО; целевая клетка при этом всё равно
      // помечается, а путь до неё восстанавливается).
      // ВАЖНО: bfsFrom использует СОБСТВЕННУЮ inline-проверку (а не
      // isBlocked), потому что нужна семантика excludeIds. Поэтому
      // КАЖДЫЙ новый тип статического препятствия надо добавлять и
      // в isBlocked, и сюда. Забывание привело к багу 03.05.2026:
      // AI планировал маршрут через дерево, executeMove отказывал
      // (computeMovePath использует isBlocked корректно), зомби
      // молча пропускал ход.
      const uHere = unitAt(nr, nc);
      const gHere = graveAt(nr, nc);
      const tHere = treeAt(nr, nc);
      const isBlockedHere = (uHere && !(excludeIds && excludeIds.has(uHere.id))) || gHere || tHere;
      if (isBlockedHere) continue;
      dist.set(k, d + 1);
      parent.set(k, { r, c });
      queue.push({ r: nr, c: nc, d: d + 1 });
    }
  }
  return { dist, parent };
}
