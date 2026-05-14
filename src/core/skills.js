/* skills.js (core/) — скилл-тир-хелперы: чтение и слияние параметров
   активов и пассивов с учётом текущего тира.

   Не путать с `src/data/skills.js` — там реестр SKILLS как данные
   (что вообще есть в игре). Здесь — функции, которые этим реестром
   пользуются: «какой тир сейчас у юнита», «слить верхний уровень
   с тиром», «применить applyEffect-описание тира». Кросс-доменные:
   читают и SKILLS (data), и CLASSES (data), и сам unit.

   Что внутри:
     • passiveSkillTiers(classId, level) — таблица «уровень → тир»
       для всех passiveSkills класса. Сейчас задана явной мапой
       (zombie/corpse_poison: ≥20 elite, ≥10 advanced, иначе basic);
       универсальной формулы пока нет.
     • getPassiveSkillTier(unit, sid) — тир пассивки для конкретного юнита.
       Источник правды: сначала `unit.passiveSkillTiersOverride[sid]`
       (выдача через DevTools или будущая прокачка), иначе таблица по
       уровню (passiveSkillTiers), иначе 'basic'. Используется всеми
       читателями: collectPassivesByTrigger ниже, critChanceOf в
       core/stats-calc.js.
     • getActiveSkillTier(unit, skillId) — текущий тир активного
       навыка у конкретного юнита. Источник правды — `unit.skills`
       (массив `{ id, tier }`, заполняется в makeUnit при создании).
       Если ничего не найдено — 'basic'.
     • effectiveSkillParams(skill, tier) — слить top-level поля скилла
       с tier-полями (`tiers[tier]` перекрывает одноимённые сверху).
       Если тира в `skill.tiers` нет — возвращает копию верхнего уровня
       (защита от опечаток в данных).
     • getUnitSkillParams(unit, skillId) — обёртка над двумя выше:
       читает тир из юнита и возвращает merged-параметры нужного скилла.
       Используется тултипами слота, executeFireball, режимами прицеливания.
     • applySkillEffectDef(target, def) — диспатчер
       `applyEffect: { id, duration, strength?, percent?, chance? }` тира
       скилла. По `def.id` выбирает правильный apply-хелпер из effects.js
       (applyBurning / applyPoisoned / applyStunned / applyImmobilized /
       applySlowed / applyFrightened). Поле `strength` — фикс. сила (для slowed-фикс. и
       будущих chilled-вариантов). Поле `percent` — процент от базового
       стата цели (сейчас только slowed: процент от target.stats.spd с
       округлением вверх; считается ЗДЕСЬ, в момент применения, и далее
       идёт в applySlowed как готовый strength). Поле `chance` —
       независимый ролл шанса в %. Возвращает true/false (факт
       срабатывания) — пока нигде не используется, оставлено для будущих
       AoE/AI-логик.

   Что НЕ внутри:
     • Реестр SKILLS — `data/skills.js` (R7).
     • applyCorpsePoison и сами apply*-хелперы статус-эффектов —
       `core/effects.js` (R12). applySkillEffectDef ниже их вызывает.
     • Таблица CLASSES — `data/classes.js` (R8).
     • Логика выполнения активных навыков (executeFireball) живёт
       в монолите, переедет в `core/combat.js` (R14).

   Где править: правила «уровень → тир пассивки» — в `passiveSkillTiers`
     (новая ветка по classId+sid). Новый тип `applyEffect`-описания —
     добавить case в switch `applySkillEffectDef` + соответствующий
     apply-хелпер в `core/effects.js`. Изменить, какие поля тира
     перекрывают верхний уровень, — `effectiveSkillParams` (сейчас простой
     spread, при необходимости заменить на глубокое слияние).

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   Все объявления попадают в глобальный scope window.

   Тонкость с порядком загрузки. `applySkillEffectDef` вызывает
   apply*-хелперы из `core/effects.js`. По порядку script-тегов effects.js
   загружается ДО core/skills.js (логичная последовательность: эффекты
   как «слой ниже», скилл-обвязка как «слой выше»). Соответственно,
   apply*-хелперы существуют как глобалы к моменту вызова. CLASSES и
   SKILLS — тоже загружены раньше (data → core).
*/

/* Тир пассивки в зависимости от уровня. Универсальной схемы пока нет —
   делаем явной мапой по классу. Возвращает { skillId → tier } для всех
   passiveSkills класса на этом уровне. */
function passiveSkillTiers(classId, level) {
  const out = {};
  const cls = CLASSES[classId];
  if (!cls || !cls.passiveSkills) return out;
  for (const sid of cls.passiveSkills) {
    if (classId === 'zombie' && sid === 'corpse_poison') {
      if (level >= 20)      out[sid] = 'elite';
      else if (level >= 10) out[sid] = 'advanced';
      else                  out[sid] = 'basic';
    } else if ((classId === 'wolf' || classId === 'wolf_alpha')
               && (sid === 'joint_hunt' || sid === 'wolf_howl' || sid === 'pack_leader')) {
      // Пассивки волков растут синхронно: 10 → продвинутый, 20 → элитный.
      // pack_leader относится только к wolf_alpha; для wolf он не назначен,
      // но условие включаем для симметрии (если когда-то выдадим — сразу
      // получит ту же прогрессию).
      if (level >= 20)      out[sid] = 'elite';
      else if (level >= 10) out[sid] = 'advanced';
      else                  out[sid] = 'basic';
    } else if ((classId === 'skeleton_warrior' || classId === 'skeleton_archer') && sid === 'bony') {
      // Camp v1.5-skeletons (09.05.2026): «Костлявый» прокачивается так
      // же, как пассивки волков и зомби: 10 → продвинутый, 20 → элитный.
      // Симметрично applyXxxProgression в data/classes.js, где статы
      // тоже растут плавно по уровням.
      if (level >= 20)      out[sid] = 'elite';
      else if (level >= 10) out[sid] = 'advanced';
      else                  out[sid] = 'basic';
    } else if (classId === 'priest' && (sid === 'evil_slayer' || sid === 'healing_aura')) {
      // Camp v1.5-priest-B (10.05.2026) + Camp v1.5-priest-C (11.05.2026):
      // пассивки священника. Прокачиваются симметрично остальным:
      // 10 → продвинутый, 20 → элитный.
      if (level >= 20)      out[sid] = 'elite';
      else if (level >= 10) out[sid] = 'advanced';
      else                  out[sid] = 'basic';
    } else {
      out[sid] = 'basic';  // дефолтный тир для остальных
    }
  }
  return out;
}

/* Тир пассивки для конкретного юнита. Слои чтения (от приоритетного):
   1) `unit.passiveSkillTiersOverride[sid]` — точечный override на инстансе.
      Записывается DevTools-ом (см. ui/dev-tools.js) и в будущем — системой
      прокачки конкретного юнита. Перекрывает таблицу по уровню.
   2) `passiveSkillTiers(classId, level)[sid]` — таблица «уровень → тир» класса.
   3) 'basic' — дефолт, если ни override, ни таблица не выдали значение.
   Это единый читатель тира для всех мест: триггеры пассивок
   (collectPassivesByTrigger), модификаторы (critChanceOf в stats-calc),
   тултипы DevTools. Когда появится прокачка героев — добавится 4-й слой
   («выученные тиры в сейве героя») здесь же, не трогая читателей. */
function getPassiveSkillTier(unit, sid) {
  if (!unit || !sid) return 'basic';
  if (unit.passiveSkillTiersOverride && unit.passiveSkillTiersOverride[sid]) {
    return unit.passiveSkillTiersOverride[sid];
  }
  const tiers = passiveSkillTiers(unit.classId, unit.level || 1);
  return tiers[sid] || 'basic';
}

/* Тир активного навыка для конкретного юнита. Источник правды —
   `unit.skills` (массив `{ id, tier }`), который заполняется при
   создании юнита из `CLASSES[classId].activeSkills` (все на 'basic').
   Когда появится прокачка героев, конкретный экземпляр мага сможет
   ходить с фаерболом продвинутого/элитного тира — менять придётся
   только содержимое `unit.skills[i].tier`, а все читатели уже на
   месте.

   Для отладочного апа тира — `unit.skills.find(s=>s.id==='fireball').tier
   = 'elite'` через консоль и `render()`. */
function getActiveSkillTier(unit, skillId) {
  if (!unit || !Array.isArray(unit.skills)) return 'basic';
  const entry = unit.skills.find(s => s && s.id === skillId);
  return (entry && entry.tier) || 'basic';
}

/* Слить параметры скилла с тир-зависимыми полями. Поля тира
   перекрывают одноимённые поля верхнего уровня. Если тира нет в
   `skill.tiers` — возвращаем как есть (защита от опечаток в данных).

   Используется во всех читателях параметров активного навыка
   (executeFireball, enterMode, тултип слота). Поля, которые сейчас
   могут жить в тире: `manaCost`, `formula`, `applyEffect`. Список
   будет расширяться по мере появления навыков с тир-зависимой
   стоимостью маны / зоной / эффектами. */
function effectiveSkillParams(skill, tier) {
  if (!skill) return {};
  const tierData = (skill.tiers && skill.tiers[tier]) || null;
  return tierData ? { ...skill, ...tierData } : { ...skill };
}

/* Удобная обёртка: читает тир из юнита и возвращает merged-параметры
   нужного скилла. Кэшировать ничего не нужно — функция вызывается
   точечно (один раз за каст / одно открытие тултипа).

   slotIdx — опциональный индекс слота в unit.skills. Если задан и
   `unit.skills[slotIdx].id === skillId`, тир читается ИЗ ЭТОГО СЛОТА.
   Это нужно для случая, когда один и тот же скилл выдан в разные
   слоты с разными тирами (DevTools-выдача basic + elite одного и
   того же навыка): без slotIdx getActiveSkillTier вернёт тир ПЕРВОГО
   совпадения, и все слоты покажут одинаковые параметры — это баг,
   зафиксированный 03.05.2026 после Сессии 11. С slotIdx параметры
   совпадают со слотом, на который игрок кликнул. */
function getUnitSkillParams(unit, skillId, slotIdx) {
  const skill = SKILLS[skillId];
  if (!skill) return {};
  let tier;
  if (typeof slotIdx === 'number' && Array.isArray(unit && unit.skills)
      && unit.skills[slotIdx] && unit.skills[slotIdx].id === skillId
      && unit.skills[slotIdx].tier) {
    tier = unit.skills[slotIdx].tier;
  } else {
    tier = getActiveSkillTier(unit, skillId);
  }
  return effectiveSkillParams(skill, tier);
}

/* Применить эффект, описанный в `applyEffect: { id, duration }`
   тира скилла. Диспатчер по id — выбирает правильный apply-хелпер.
   Apply-хелперы сами проверяют, жив ли target, и иммунитеты по типу.
   Возвращает true, если эффект реально сел; false — если был
   проигнорирован (мёртвый/иммунный/некорректный id). Сейчас
   возвращаемое значение нигде не используется, но оставлено для
   будущих ИИ/AoE-логик, где может понадобиться знать факт срабатывания. */
function applySkillEffectDef(target, def) {
  if (!def || !def.id || !(def.duration > 0)) return false;
  // Опциональный независимый ролл шанса (Сессия 10: elite-Молния даёт
  // stunned/1 с шансом 15% на каждого пораженного независимо). Если
  // chance не указан — считается 100% (старое поведение burning/slowed
  // и пр. сохранено). Ролл — Math.random()*100, FAIL → возврат false
  // ДО списания/применения, чтобы вызывающие могли отличить «не сел из-
  // за шанса» от «сел успешно».
  //
  // DevTools-байпас: если state.dev.forceChance включен — ролл пропускается,
  // эффект применяется всегда. Нужен для тестирования низковероятных
  // эффектов (15% stunned от elite-Молнии и т.п.). Чекбокс — в DevTools
  // popover («Все шанс-эффекты — 100%»). Видимый только при открытом
  // DevTools, в state хранится через ленивую инициализацию (без правок
  // createInitialState, без миграции старых сейвов).
  const devBypass = !!(typeof state !== 'undefined' && state && state.dev && state.dev.forceChance);
  if (!devBypass && typeof def.chance === 'number' && Math.random() * 100 >= def.chance) return false;
  switch (def.id) {
    case 'burning':     applyBurning(target, def.duration);     return true;
    case 'poisoned':    applyPoisoned(target, def.duration);    return true;
    case 'stunned':     applyStunned(target, def.duration);     return true;
    case 'immobilized': applyImmobilized(target, def.duration); return true;
    case 'slowed': {
      // slowed поддерживает два формата силы дебаффа:
      //   • strength: N        — фиксированная сила (старый режим, если
      //                          где-то ещё пригодится; ice_arrow с него
      //                          ушла на percent с правки 06.05.2026).
      //   • percent: N         — процент от БАЗОВОЙ Spd цели (target.stats.spd),
      //                          округление вверх. Считается ЗДЕСЬ, в момент
      //                          применения; применённый strength фиксируется
      //                          в эффекте как абсолютное число (statMods.spd).
      // Почему от базовой, а не от эффективной: иначе при стаке (уже висит
      // slowed → эффективная spd ниже) новый каст процент посчитает по
      // уменьшенной spd, и не сможет сменить strength наверх. От базовой —
      // стабильное число для одной цели вне зависимости от истории.
      let strength = def.strength;
      if (typeof def.percent === 'number') {
        const baseSpd = Math.max(0, (target.stats && target.stats.spd) || 0);
        strength = Math.ceil(baseSpd * def.percent / 100);
      }
      applySlowed(target, strength, def.duration);
      return true;
    }
    case 'frightened': applyFrightened(target, def.duration); return true;
    default:
      console.warn('applySkillEffectDef: unknown effect id', def.id);
      return false;
  }
}

/* canActivateSkill(unit, skillId) — единая валидация «может ли юнит
   прямо сейчас активировать этот скилл». Возвращает boolean. Источник
   правды для:
     • enterMode(skillId) в ui/input.js — впускает в режим прицеливания
       только активки, проходящие проверку (без хардкода id);
     • executeSingleTargetSkill в core/combat.js — страховка от прямых
       вызовов (в т.ч. из будущих хоткеев / ИИ);
     • будущих DevTools-валидаторов и тултипов «почему серое».

   Что проверяется (порядок — по приоритету выхода):
     1. skill зарегистрирован и kind === 'active';
     2. skill в `activeSkillsOverride` юнита, либо в `CLASSES[id].activeSkills`;
     3. в этом ходу юнит ещё НЕ применял НИ ОДНОГО активного навыка
        (общее правило «один активный навык за ход»);
     4. хватает маны (manaCost тира);
     5. если у скилла `movesUser: true` — не висит «Обездвижен» (через
        canUnitMove из core/effects.js).

   manaCost берётся через getUnitSkillParams — учитывает тир юнита,
   тот же путь, что и у читателей в combat/render. Это важно: если у
   юнита advanced-тир скилла дешевле/дороже, чем basic, проверка по
   тиру совпадает с фактическим списанием при касте. */
function canActivateSkill(unit, skillId, slotIdx) {
  if (!unit || !skillId) return false;
  const skill = SKILLS[skillId];
  if (!skill || skill.kind !== 'active') return false;
  const list = Array.isArray(unit.activeSkillsOverride)
    ? unit.activeSkillsOverride
    : ((CLASSES[unit.classId] && CLASSES[unit.classId].activeSkills) || []);
  if (!list.includes(skillId)) return false;
  if (Array.isArray(unit.skillsUsedThisTurn) && unit.skillsUsedThisTurn.length > 0) return false;
  // Сессия 17: кулдаун. Если у юнита `cooldowns[skillId] > 0` — каст
  // блокируется (UI покажет слот серым с тултипом «Откат: N ход(ов)»).
  if (unit.cooldowns && (unit.cooldowns[skillId] | 0) > 0) return false;
  // Сессия 19: onceWave-флаг. Скилл с polem onceWave:true может быть
  // использован ровно один раз за волну (Второе дыхание). UI покажет
  // слот серым с тултипом «Использовано в этой волне».
  if (skill.onceWave && unit.usedThisWave && unit.usedThisWave[skillId]) return false;
  const params = getUnitSkillParams(unit, skillId, slotIdx);
  if (typeof params.manaCost === 'number' && unit.mana < params.manaCost) return false;
  if (params.movesUser && !canUnitMove(unit)) return false;
  // Сессия 17: requireUnusedAttack/Move — для скиллов, которые ТРЕБУЮТ
  // не-использованного действия в этом ходу (задел; в C18+ Рывок/Блок
  // могут использовать это поле). Сейчас ни один скилл не выставляет
  // эти флаги, ветки no-op.
  if (params.requireUnusedAttack && unit.actionsUsedThisTurn && unit.actionsUsedThisTurn.attack) return false;
  if (params.requireUnusedMove   && unit.actionsUsedThisTurn && unit.actionsUsedThisTurn.move)   return false;
  // Сессия 20: requireUsedAttack — для «Второй атаки» воина. Зеркало
  // requireUnusedAttack: блокирует каст ПОКА игрок не сделал обычную
  // атаку. После атаки слот становится активным.
  if (params.requireUsedAttack && (!unit.actionsUsedThisTurn || !unit.actionsUsedThisTurn.attack)) return false;
  return true;
}

/* Сессия 17: ставит кулдаун после успешного каста. Зовётся в каждом
   executeXxx сразу после `u.skillsUsedThisTurn.push(skillId)`. Если у
   тира скилла `cooldown` не задан (или 0) — ничего не делает. Источник
   правды по числу ходов отдыха — `tierData.cooldown` (читается через
   `params = getUnitSkillParams(unit, skillId, slotIdx)`).

   Семантика «CD=N»: ход касто → след. N ходов недоступен → ход N+1
   снова доступен. tickCooldowns в endTurn уменьшает на 1 каждый. */
function applyCooldown(unit, skillId, params) {
  if (!unit || !skillId || !params) return;
  const cd = (params.cooldown | 0) || 0;
  if (cd <= 0) return;
  if (!unit.cooldowns) unit.cooldowns = {};
  unit.cooldowns[skillId] = cd;
}

/* Сессия 23 (баланс 06.05.2026): хук «активный навык применён».
   Зовётся из каждого executeXxx ПОСЛЕ applyCooldown (т.е. после того,
   как валидация прошла, ресурсы списаны и кулдаун проставлен — каст
   фактически состоялся). Принимает unit + skillId.

   Сейчас единственная задача — снять «Маскировку» с кастера, если
   он только что применил ЛЮБОЙ активный навык, кроме самой Маскировки
   (исключение защищает только что наложенный эффект от мгновенного
   слетания). Логика: маскировка — это бездействие, и любая активная
   способность нарушает условие.

   Точка роста для будущих кросс-навыковых пост-каст триггеров (новые
   пассивки, ауры реактирующие на каст, и т.п.) — добавлять сюда. */
function onActiveSkillCast(unit, skillId) {
  if (!unit || !skillId) return;
  if (skillId !== 'camouflage' && typeof removeCamouflage === 'function') {
    removeCamouflage(unit, 'активный навык');
  }
}

/* Сессия 17: вызывается из endTurn ПОСЛЕ triggerPassivesAtTurnEnd и
   ДО tickEffectsAtTurnEnd (отдельное окно: пассивки/кулдауны не
   пересекаются со статусами). Уменьшает все cooldowns на 1; при 0
   удаляет ключ для краткости (canActivateSkill читает «> 0»). */
function tickCooldowns(unit) {
  if (!unit || !unit.cooldowns) return;
  for (const sid of Object.keys(unit.cooldowns)) {
    unit.cooldowns[sid] = Math.max(0, (unit.cooldowns[sid] | 0) - 1);
    if (unit.cooldowns[sid] === 0) delete unit.cooldowns[sid];
  }
}

/* ================================================================
   === ТРИГГЕРЫ ПАССИВОК ПО СОБЫТИЮ ===============================
   ================================================================
   Симметрично с `triggerOnDealDamagePassives` из `core/damage.js`,
   но для событий не-боевых: «конец собственного хода», «потратил ману».
   Унифицированный обходчик `runPassiveEvent(unit, triggerName, fn)`
   проходит по `CLASSES[unit.classId].passiveSkills`, фильтрует по
   `skill.trigger === triggerName` и зовёт `fn(skill, tier, tierData)`.

   На Сессии 7 пассивки никому не выданы (см. CODEX.md → «Расширение
   игры → Новый пассивный навык»: привязка к классу — это `passiveSkills`
   у CLASSES, плюс правило в `passiveSkillTiers`). Поэтому эти функции
   срабатывают только если пассивка вручную добавлена через консоль
   (`u.passiveSkillsOverride = ['mana_regen']`) или после привязки
   в Сессии выдачи навыков. До тех пор это «мёртвый код, который
   проверяется тестами в Сессии 8+».
   ================================================================ */

/* Проход по пассивкам носителя с заданным триггером. Возвращает
   массив [{ skill, sid, tier, tierData }] для тех, что подошли —
   вызовам надо только применить эффект. Источник правды для списка
   — `passiveSkillsOf(unit)` (учитывает override на инстансе). */
function passiveSkillsOf(unit) {
  if (!unit) return [];
  // Override на инстансе (для отладки и для будущей механики «выученные
  // навыки конкретного юнита» — отдельные от списка класса). Если
  // override задан как массив — он ПОЛНОСТЬЮ заменяет список класса.
  if (Array.isArray(unit.passiveSkillsOverride)) return unit.passiveSkillsOverride;
  const cls = CLASSES[unit.classId];
  return (cls && Array.isArray(cls.passiveSkills)) ? cls.passiveSkills : [];
}

function collectPassivesByTrigger(unit, triggerName) {
  const out = [];
  const sids = passiveSkillsOf(unit);
  if (!sids.length) return out;
  for (const sid of sids) {
    const skill = SKILLS[sid];
    if (!skill || skill.trigger !== triggerName) continue;
    // Тир читаем через единый getPassiveSkillTier — он сам учитывает
    // unit.passiveSkillTiersOverride (DevTools/будущая прокачка) и
    // фоллбек по таблице класса.
    const tier = getPassiveSkillTier(unit, sid);
    const tierData = (skill.tiers && skill.tiers[tier]) || null;
    if (!tierData) continue;
    out.push({ skill, sid, tier, tierData });
  }
  return out;
}

/* «Восполнение маны» и любые будущие пассивки с trigger='onTurnEnd'.
   Вызывается из `endTurn()` ПОСЛЕ triggerEffectsAtTurnEnd и ДО
   tickEffectsAtTurnEnd — пассивки тикают в собственное окно, не
   сливаясь со статус-эффектами. */
function triggerPassivesAtTurnEnd(unit) {
  if (!unit || !unit.alive) return;
  const list = collectPassivesByTrigger(unit, 'onTurnEnd');
  if (!list.length) return;
  for (const { sid, tierData } of list) {
    if (sid === 'mana_regen') {
      // Лимит за волну: суммарное восстановленное за волну не больше
      // capPerWave. Счётчик хранится per-unit (см. план Сессии 7),
      // ленивая инициализация — чтобы не трогать makeUnit.
      if (!unit.passives) unit.passives = {};
      if (!unit.passives.manaRegen) unit.passives.manaRegen = { restored: 0 };
      const room = tierData.capPerWave - unit.passives.manaRegen.restored;
      if (room <= 0) continue;
      const max = maxManaOf(unit);
      if (unit.mana >= max) continue;
      const add = Math.min(tierData.amount, room, max - unit.mana);
      if (add <= 0) continue;
      unit.mana += add;
      unit.passives.manaRegen.restored += add;
      const cls = CLASSES[unit.classId];
      log(`${cls.name} (${unit.team}) — Восполнение маны: +${add} маны (${unit.passives.manaRegen.restored}/${tierData.capPerWave} за битву)`, 'info');
    }
    // Будущие пассивки с onTurnEnd добавляются switch-веткой здесь.
  }
}

/* «Поглощение маны» и любые будущие пассивки с trigger='onManaSpent'.
   Вызывается исполнителем активного навыка СРАЗУ после фактического
   `unit.mana -= cost`. Если cost === 0 — `spent` нулевой, ничего не
   делаем (ленивая защита от «бесплатных» кастов). */
function triggerOnManaSpent(unit, spent) {
  if (!unit || !unit.alive) return;
  if (!Number.isFinite(spent) || spent <= 0) return;
  const list = collectPassivesByTrigger(unit, 'onManaSpent');
  if (!list.length) return;
  for (const { sid, tierData } of list) {
    if (sid === 'mana_absorb') {
      const max = maxHpOf(unit);
      if (unit.hp >= max) continue;
      const heal = Math.min(tierData.heal, max - unit.hp);
      if (heal <= 0) continue;
      unit.hp += heal;
      const cls = CLASSES[unit.classId];
      log(`${cls.name} (${unit.team}) — Поглощение маны: +${heal} HP (потрачено ${spent} маны)`, 'info');
    }
    // Будущие пассивки с onManaSpent добавляются switch-веткой здесь.
  }
}


/* Сессия 19: ставит флаг «использован в этой волне» для onceWave-скиллов.
   Зовётся в executeSecondWind (и в любом будущем onceWave executor)
   сразу после `u.skillsUsedThisTurn.push`. Сбрасывается в startNextWave. */
function applyUsedThisWave(unit, skillId) {
  if (!unit || !skillId) return;
  if (!unit.usedThisWave) unit.usedThisWave = {};
  unit.usedThisWave[skillId] = true;
}

/* Сессия 19: триггер «получен урон» — для пассивки «Укрепление».
   Зовётся в applyDamage (core/damage.js) ПОСЛЕ computeIncomingDamage и
   ДО target.hp -= dmg, ТОЛЬКО если dmg > 0. Перебирает passiveSkillsOf
   жертвы, фильтрует по trigger:'onTakeDamage', применяет соответствующий
   apply-хелпер.

   Сейчас единственный обработчик — reinforcement: добавляет gainPerHit
   стака к эффекту через applyReinforcementStack. */
function triggerOnTakeDamagePassives(target, source) {
  if (!target || !target.alive) return;
  const list = (typeof collectPassivesByTrigger === 'function')
    ? collectPassivesByTrigger(target, 'onTakeDamage')
    : [];
  if (!list.length) return;
  for (const { sid, tierData } of list) {
    if (sid === 'reinforcement') {
      const gain = (tierData && (tierData.gainPerHit | 0)) || 0;
      if (gain > 0 && typeof applyReinforcementStack === 'function') {
        applyReinforcementStack(target, gain);
      }
    }
    // Будущие onTakeDamage-пассивки — switch-ветки здесь.
  }
}

/* Сессия волков: pre-attack бонус «Совместной охоты». Возвращает
   неотрицательное число — сумма bonus damage, добавляемая к dmg в
   executeAttack ПОСЛЕ крита и ДО computeIncomingDamage.

   Условия: атакующий имеет пассивку joint_hunt; на цели висит эффект
   joint_hunt_marks с stacks > 0. Бонус = stacks (фиксировано +1 за стак).
   Тир пассивки на величину прибавки за стак НЕ влияет (тиры меняют
   только число НАЛАГАЕМЫХ стаков после удара, не множитель чтения). */
function getJointHuntDamageBonus(attacker, target) {
  if (!attacker || !target) return 0;
  const cls = CLASSES[attacker.classId];
  if (!cls || !Array.isArray(cls.passiveSkills)) return 0;
  if (!cls.passiveSkills.includes('joint_hunt')) return 0;
  if (!Array.isArray(target.effects)) return 0;
  const eff = target.effects.find(e => e && e.id === 'joint_hunt_marks');
  if (!eff) return 0;
  return Math.max(0, eff.stacks | 0);
}

/* Сессия волков: триггер «начало хода» для пассивок. Симметричен
   triggerPassivesAtTurnEnd. Зовётся из beginTurn (core/turn.js) ПОСЛЕ
   triggerEffectsAtTurnStart и ДО проверки skipTurnThisTurn — пассивы
   могут изменить состояние других юнитов (вой пробуждает стаю), но
   не должны ломать собственный пропуск хода (стан).

   Сейчас единственный обработчик — wolf_howl: пробуждает спящих
   сородичей и (на advanced/elite) даёт им +2/+4 spd до конца их
   следующего хода с пересчётом инициативы. */
function triggerPassivesAtTurnStart(unit) {
  if (!unit || !unit.alive) return;
  const list = (typeof collectPassivesByTrigger === 'function')
    ? collectPassivesByTrigger(unit, 'onTurnStart')
    : [];
  if (!list.length) return;
  let initiativeNeedsRefresh = false;
  for (const { sid, tierData } of list) {
    if (sid === 'wolf_howl') {
      // Триггер срабатывает только если носитель в режиме aggro.
      // Спящий волк, заметив героя, СНАЧАЛА переходит в active по
      // checkAggro (это делает не сам пассив), и только на следующем
      // своём ходу сработает Вой. Это согласуется с описанием:
      // «при условии что волк находится в режиме агро».
      if (unit.aggroState !== 'active') continue;
      const myCls = CLASSES[unit.classId];
      const myGroup = myCls && myCls.group;
      const myTeam = unit.team;
      const spdBuff = (tierData && (tierData.spdBuff | 0)) || 0;
      const woke = [];
      for (const o of state.units) {
        if (!o || !o.alive || o.id === unit.id) continue;
        if (o.team !== myTeam) continue;
        const oCls = CLASSES[o.classId];
        if (!oCls || oCls.group !== myGroup) continue;
        if (o.aggroState !== 'sleeping') continue;
        o.aggroState = 'active';
        woke.push(o);
        const oWho = `${oCls.name} (${o.team})`;
        log(`${oWho} — пробуждён «Волчьим воем»`, 'info');
      }
      if (spdBuff > 0 && woke.length) {
        for (const o of woke) {
          if (!o.effects) o.effects = [];
          // Перезаписываем существующий эффект, если уже висит — обычное
          // поведение «новый рык подкрепил старый» (не суммируем).
          o.effects = o.effects.filter(e => !(e && e.id === 'wolf_howl_buff'));
          o.effects.push({
            id: 'wolf_howl_buff',
            name: 'Волчий вой',
            expiresAt: 'turnEnd',
            statMods: { spd: spdBuff }
          });
          const oWho = `${CLASSES[o.classId].name} (${o.team})`;
          log(`${oWho} — «Волчий вой»: +${spdBuff} к Скорости до конца следующего хода`, 'info');
        }
        initiativeNeedsRefresh = true;
      }
    }
    // Будущие onTurnStart-пассивы — switch-ветки здесь.
  }
  if (initiativeNeedsRefresh && typeof refreshInitiativeAfterCurrent === 'function') {
    refreshInitiativeAfterCurrent();
  }
}

/* Сессия волков: пересчитать порядок инициативы для остатка ТЕКУЩЕГО
   раунда. Уже отыгранные позиции (от 0 до state.turnIndex включительно)
   не трогаем — иначе юнит, уже походивший в этом раунде, мог бы
   получить второй ход. Все живые юниты, ещё не вошедшие в очередь,
   пересортировываются по эффективным статам по тем же правилам, что и
   computeInitiativeOrder.

   Используется wolf_howl при выдаче spd-баффа советам, чтобы
   ускорившиеся волки могли «обогнать» по очереди тех, кто шёл позже.
   После вызова render() в beginTurn покажет обновлённую инициативную
   полоску (источник правды — state.initiativeOrder). */
function refreshInitiativeAfterCurrent() {
  if (!state || !Array.isArray(state.initiativeOrder)) return;
  const ti = state.turnIndex | 0;
  const cutoff = Math.max(0, Math.min(ti + 1, state.initiativeOrder.length));
  const acted = new Set(state.initiativeOrder.slice(0, cutoff));
  const remaining = state.units
    .filter(u => u && u.alive && !acted.has(u.id))
    .slice()
    .sort((a, b) => {
      const as = effectiveStats(a), bs = effectiveStats(b);
      if (as.spd !== bs.spd) return bs.spd - as.spd;
      if (as.luk !== bs.luk) return bs.luk - as.luk;
      return a.initiativeTiebreak - b.initiativeTiebreak;
    })
    .map(u => u.id);
  state.initiativeOrder = state.initiativeOrder.slice(0, cutoff).concat(remaining);
}

/* Сессия волков: пересчёт ауры «Лидер рядом» (pack_leader_aura) на
   всех юнитах группы 'wolves'. Для каждого волка проверяем, есть ли
   живой лидер той же команды и группы с пассивкой pack_leader в
   радиусе Чебышева 5. Если есть — обеспечиваем эффект pack_leader_aura
   с правильной величиной statMods.str (ceil(базовая Сила цели * 0.30)).
   Если нет — снимаем эффект.

   ВАЖНО: бонус считается от unit.stats.str (базовое значение), не от
   эффективного. Это убирает двойное взаимодействие с другими str-баффами
   и делает результат стабильным (например, +30% к Силе 9 → +3, а не
   +30% к временно усиленной до 12 → +4).

   Уточнение от заказчика: вожак НЕ получает собственную ауру —
   баф усиливает только подчинённых волков, не самого лидера. Поэтому
   в цикле ниже волки с isLeader=true пропускаются (отдельно: на
   таком юните ауры не будет вовсе, даже если рядом другой лидер
   стаи; это согласуется с трактовкой «лидер усиливает свою стаю,
   а не другого лидера»). Если в будущем понадобится «лидер баффит
   ДРУГОГО лидера, но не себя» — фильтр заменить на `wolf.id === L.id`.

   Зовётся из beginTurn (core/turn.js) перед expireTurnStartEffects.
   Лаг между смертью лидера и снятием ауры с остатков стаи — один ход
   (приемлемо: смерть редко происходит без события на доске). */
function refreshPackLeaderAuras() {
  if (!state || !Array.isArray(state.units)) return;
  const wolves = state.units.filter(u => {
    if (!u || !u.alive) return false;
    const cls = CLASSES[u.classId];
    if (!cls || cls.group !== 'wolves') return false;
    // Лидеров исключаем из получателей ауры — баф «Лидер рядом» не
    // распространяется на самого вожака (правка по запросу заказчика).
    if (cls.isLeader) return false;
    return true;
  });
  if (!wolves.length) return;
  // Список живых лидеров с пассивкой pack_leader, по командам и группам.
  const leaders = state.units.filter(u => {
    if (!u || !u.alive) return false;
    const cls = CLASSES[u.classId];
    if (!cls || !cls.isLeader || cls.group !== 'wolves') return false;
    return Array.isArray(cls.passiveSkills) && cls.passiveSkills.includes('pack_leader');
  });
  for (const wolf of wolves) {
    let leaderInRange = null;
    for (const L of leaders) {
      if (L.team !== wolf.team) continue;
      const dr = Math.abs(L.row - wolf.row);
      const dc = Math.abs(L.col - wolf.col);
      if (Math.max(dr, dc) <= 5) { leaderInRange = L; break; }
    }
    const baseStr = (wolf.stats && Number.isFinite(wolf.stats.str)) ? wolf.stats.str : 0;
    const bonus = Math.ceil(baseStr * 0.30);
    if (!Array.isArray(wolf.effects)) wolf.effects = [];
    const existing = wolf.effects.find(e => e && e.id === 'pack_leader_aura');
    if (leaderInRange && bonus > 0) {
      if (!existing) {
        wolf.effects.push({
          id: 'pack_leader_aura',
          name: 'Лидер рядом',
          statMods: { str: bonus }
        });
        const who = `${CLASSES[wolf.classId].name} (${wolf.team})`;
        log(`${who} — «Лидер рядом»: +${bonus} к Силе`, 'info');
      } else {
        // Только если bonus реально изменился — переписываем (избегаем
        // лишних строк в логе на каждом ходе).
        if (existing.statMods.str !== bonus) {
          existing.statMods.str = bonus;
        }
      }
    } else if (existing) {
      wolf.effects = wolf.effects.filter(e => e !== existing);
      const who = `${CLASSES[wolf.classId].name} (${wolf.team})`;
      log(`${who} — «Лидер рядом» спадает (лидер далеко или погиб)`, 'info');
    }
  }
  // Подчистка: если на лидере группы 'wolves' каким-то образом висит
  // pack_leader_aura (например, остался от старой логики до правки или
  // был выдан внешним кодом) — снимаем. Лидер по дизайну ауру на себе
  // НЕ носит. Защита идемпотентная: если эффекта нет, изменений нет.
  for (const u of state.units) {
    if (!u || !u.alive || !Array.isArray(u.effects)) continue;
    const cls = CLASSES[u.classId];
    if (!cls || cls.group !== 'wolves' || !cls.isLeader) continue;
    const idx = u.effects.findIndex(e => e && e.id === 'pack_leader_aura');
    if (idx < 0) continue;
    u.effects.splice(idx, 1);
    log(`${cls.name} (${u.team}) — «Лидер рядом» снят (вожак не баффит сам себя)`, 'info');
  }
}
