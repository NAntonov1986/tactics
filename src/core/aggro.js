/* aggro.js (core/) — система aggro-радиуса для NPC.
   Сессия aggro (04.05.2026): временное решение вместо полноценного LOS.

   Каждый NPC имеет два состояния:
     • aggroState === 'sleeping' — не видит героев, бродит по карте
       по своему idleBehavior (см. ai.js → AI_POLICIES → idle-ветка).
     • aggroState === 'active' — видит героев, действует по основной
       AI-политике (атака + движение к цели).

   Метрика расстояния — Чебышев (max(|dr|,|dc|)). Через стены/деревья
   НЕ блокируется (зомби «слышит/чует» сквозь препятствия). Это
   осознанный компромисс: полноценный LOS — отдельная большая задача
   уровня V2.0+.

   Триггеры перехода sleeping → active:
     • После своего хода (idle-ветка в ai.js): зомби сделал шаг и в
       результате враг оказался в радиусе. Движение в этот ход НЕ
       возвращается (намеренно, по спеке: «затраченное движение
       не возвращается»).
     • После хода игрока (turn.js → endTurn → checkAggroForAllNpcs):
       герой подошёл к спящему NPC в свой ход.
     • При спавне новой волны: новые зомби могут заспавниться рядом
       с героем (на старте startNextWave — pickRandomFreeCellTopHalf
       не учитывает aggroRadius). Вызывается из startNextWave явно.

   Возврат active → sleeping ОТСУТСТВУЕТ. Раз увидел — погнался; LOS-
   потери объекта мы намеренно не моделируем (иначе превратится в LOS,
   который мы как раз НЕ делаем).

   Внешние имена: state, CLASSES, log, getUnit (через script-scope).
   Резолв в момент вызова. */

/* Главная проверка: если у спящего NPC `unit` есть в радиусе Чебышева
   <= unit.aggroRadius хотя бы один живой враг — переключает aggroState
   в 'active', пишет лог. Возвращает true, если было переключение.

   Игнорирует юнитов БЕЗ aggroState (т.е. героев) и юнитов, уже active.
   Безопасно вызывать на мёртвых/несуществующих юнитах — ранний return. */
function checkAggro(state, unit) {
  if (!unit || !unit.alive) return false;
  if (unit.aggroState !== 'sleeping') return false;
  const radius = unit.aggroRadius | 0;
  if (radius <= 0) return false;
  // Ищем хотя бы одного живого врага в радиусе Чебышева.
  for (const other of state.units) {
    if (!other.alive) continue;
    if (other.team === unit.team) continue;
    // Героям-противникам aggroState не задан — они всегда «видны»
    // (если на них не наложен stealth-эффект).
    // С23: Маскировка скрывает героя от вражеского AI на уровне «вижу
    // или нет». Спящий зомби рядом с замаскированным лучником НЕ просыпается.
    // wakeOnDamage (отдельный канал, через applyDamage) при этом
    // продолжает работать: если замаскированный успел нанести урон,
    // жертва проснётся «от боли», независимо от видимости источника.
    if (typeof hasEffect === 'function' && hasEffect(other, 'camouflage')) continue;
    const dr = Math.abs(other.row - unit.row);
    const dc = Math.abs(other.col - unit.col);
    if (Math.max(dr, dc) <= radius) {
      unit.aggroState = 'active';
      const cls = (typeof CLASSES !== 'undefined' && CLASSES[unit.classId]) || { name: unit.classId };
      if (typeof log === 'function') {
        log(`${cls.name} (${unit.team}) [${unit.row},${unit.col}] заметил врага — стал агрессивным`, 'info');
      }
      return true;
    }
  }
  return false;
}

/* Прогон по всем спящим NPC. Вызывается из turn.js → endTurn после
   tick-фаз (когда герой только что закончил ход и мог подойти к
   спящему врагу) и из state.js → startNextWave (когда новые зомби
   спавнятся и могут оказаться рядом с героями).

   Не возвращает значение (число переключений сейчас не нужно). Логи
   делает сам checkAggro. */
function checkAggroForAllNpcs(state) {
  if (!state || !Array.isArray(state.units)) return;
  for (const u of state.units) {
    if (u.alive && u.aggroState === 'sleeping') {
      checkAggro(state, u);
    }
  }
}

/* Сессия 21+: третий триггер sleeping → active.
   Спящий NPC, получивший урон от живого вражеского источника, мгновенно
   просыпается — даже если источник вне радиуса aggro. Закрывает дыру:
   с прибавкой дальности от «Дальнего выстрела» лучник может выстрелить
   из-за пределов aggroRadius, и без этой ветки враг продолжал бы стоять
   в idle, что нелогично.

   Условия пробуждения:
   - target жив и в состоянии sleeping;
   - source задан, жив, и принадлежит другой команде.

   НЕ пробуждает:
   - DoT-тики (poisoned/burning) — у них source=null. Логика: яд/поджог
     был наложен ранее, и тогдашний удар уже разбудил NPC. Если же тик
     приходит на спящего (например, в будущем — некий аоу-эффект,
     наложенный на клетку без атакующего), — это всё равно «безличный»
     источник, и не должен будить (по решению пользователя).
   - Ответка fire_shield (источник=null специально — см. combat.js).
   - Союзный урон (других NPC одной команды; сейчас не используется,
     но логично симметрично игнорировать).

   Возвращает true, если состояние было переключено. */
function wakeOnDamage(target, source) {
  if (!target || !target.alive) return false;
  if (target.aggroState !== 'sleeping') return false;
  if (!source || !source.alive) return false;
  if (source.team === target.team) return false;
  target.aggroState = 'active';
  const cls = (typeof CLASSES !== 'undefined' && CLASSES[target.classId]) || { name: target.classId };
  if (typeof log === 'function') {
    log(`${cls.name} (${target.team}) [${target.row},${target.col}] получил урон — стал агрессивным`, 'info');
  }
  return true;
}
