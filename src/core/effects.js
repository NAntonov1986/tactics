/* effects.js — статус-эффекты: наложение, фазы, истечение.
   Что внутри:
     • Apply*-хелперы — точки наложения эффектов на цель:
         applyCorpsePoison(target, tier)        — пассивка зомби, с тирами и
                                                   правилами стакинга по тиру
                                                   (см. POISON_TIER_RANK ниже),
         applyBurning(target, duration)         — огонь, DoT по `remaining`,
         applyPoisoned(target, duration)        — яд, DoT по `remaining`
                                                   (с фильтром иммунитета —
                                                   через isImmuneToPoison),
         applyStunned(target, duration)         — пропуск своих ходов,
         applyImmobilized(target, duration)     — запрет движения (атака и
                                                   остальные скиллы разрешены),
         applyDurationEffect(target, id, name, duration) — общий код
            наложения «duration-only» эффектов (без тиров и statMod);
            используется пятёркой Burning/Poisoned/Stunned/Immobilized/Frightened.
         POISON_TIER_RANK — таблица «basic < advanced < elite» для апгрейда
            трупного яда при повторном наложении.
     • Утилиты по эффектам:
         hasEffect(unit, effectId)              — есть ли такой эффект.
         canUnitMove(unit)                      — единая точка проверки
                                                   «может ли юнит сейчас
                                                   двигаться» (на сейчас —
                                                   только фильтр Обездвижен).
     • Изменение статов → ресурсов:
         clampResourcesAfterStatsChange(unit, prevStats) — после изменения
            эффектов пересчитать maxHp/maxMana и обрезать текущие; повышение
            НЕ восстанавливает (усиление = пустой резерв). Может добить юнита
            в 0, если Vit-дебафф опустил maxHp ниже current.
     • Фазы эффектов на ходе носителя:
         triggerEffectsAtTurnStart(unit)        — onTurnStart-хуки,
         triggerEffectsAtTurnEnd(unit)          — onTurnEnd-хуки,
         runEffectPhase(unit, hookName)         — общий обходчик с
                                                   защитой от исключений
                                                   и от смерти носителя
                                                   во время фазы,
         resolveEffectHook(eff, hookName)       — порядок поиска хука:
                                                   eff[hookName] → SKILLS[eff.id][hookName]
                                                   → SKILLS[eff.id].tiers[eff.tier][hookName].
         tickEffectsAtTurnEnd(unit)             — уменьшение remaining,
                                                   удаление выдохшихся, пересчёт ресурсов.

   Что НЕ внутри:
     • applyDamage / computeIncomingDamage / isImmuneToPoison —
       `core/damage.js` (R11). Apply-хелперы яда выше используют
       `isImmuneToPoison` из damage.js — резолв в момент вызова.
     • Хелперы доступа к параметрам тира (`effectiveSkillParams`/
       `getActiveSkillTier`/`getUnitSkillParams`/`applySkillEffectDef`),
       а также `passiveSkillTiers` — пока в монолите. Кросс-доменные:
       читают и SKILLS, и CLASSES, и unit. Переедут в `core/skills.js`
       отдельным шагом (или останутся в монолите до R19, см. план).
     • scheduleDeathCleanup — анимации/таймеры превращения в надгробие,
       пока в монолите (переедет в render-units / movement).
     • Сами хуки эффектов (`burning.onTurnStart`, `poisoned.onTurnStart`,
       `stunned.onTurnStart`) — данные в `data/skills.js`. Тут только
       инфраструктура их вызова.

   Где править: правила стакинга нового эффекта — добавить специализированную
     apply-функцию (как applyCorpsePoison) или использовать
     applyDurationEffect, если нет тиров и statMod. Новый общий триггер
     по фазе хода (например, onUnitDamaged) — добавить функцию
     triggerEffectsOnXxx, делегирующую runEffectPhase с нужным hookName.

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   Все объявления попадают в глобальный scope window.

   Тонкость с порядком загрузки. apply*-хелперы и tickEffectsAtTurnEnd
   обращаются к `log`, `CLASSES`, `SKILLS`, `SKILL_TIER_LABELS`,
   `effectiveStats`, `getBaseHp`, `maxHpOf`, `maxManaOf`, `scheduleDeathCleanup`,
   `isImmuneToPoison` — часть из них в data/* (загружены раньше),
   часть в core/stats-calc.js / core/damage.js (тоже раньше),
   часть в inline (`log`, `scheduleDeathCleanup`). Резолв — в момент вызова,
   к моменту первого хода inline уже выполнен.
*/

/* Накладывает/продлевает «Трупный яд» на цель.
   Правила стакинга (см. CODEX.md, раздел «Эффекты»):
   — если эффекта нет — ставим с параметрами тира;
   — если уже висит ТАКОЙ ЖЕ или более низкий тир — НЕ заменяем параметры,
     а просто добавляем базовую длительность нового применения к счётчику;
   — если висит ВЫШЕ тир — новый низкий не перезаписывает параметры,
     но продлевает длительность.
   Порядок тиров: basic < advanced < elite.

   Балансная правка (07.05.2026): тиры теперь хранят statPercent (10/20/30),
   а не плоский statMod. На наложении/апгрейде яд считает дельты от
   БАЗОВЫХ статов цели (`target.stats`, не от effectiveStats — иначе при
   стаке других дебаффов процент гонялся бы по уже урезанным числам и
   результат становился бы непредсказуемым) и кладёт их в
   `eff.statMods` per-key, ИСКЛЮЧАЯ Удачу. Округление вверх по модулю —
   `delta = -ceil(base * pct / 100)`. Для базы 0 это даёт 0 (дебаффу
   нечего отнимать) — пишем 0 не пишем (см. ниже фильтр).

   Источник чтения мода — статья `eff.statMods` в statBreakdown
   (core/stats-calc.js). Старая ветка `eff.id === 'corpse_poison' && eff.statMod`
   остаётся как fallback для совместимости со старыми инстансами эффекта,
   но новые накладывания идут только через statMods. */
const POISON_TIER_RANK = { basic: 1, advanced: 2, elite: 3 };
const CORPSE_POISON_STAT_KEYS = ['str', 'vit', 'dex', 'spd', 'wis', 'int'];
function _computeCorpsePoisonMods(target, statPercent) {
  const out = {};
  if (!target || !target.stats) return out;
  if (!Number.isFinite(statPercent) || statPercent <= 0) return out;
  for (const k of CORPSE_POISON_STAT_KEYS) {
    const base = target.stats[k] | 0;
    if (base <= 0) continue;  // от 0 нечего отнимать
    const delta = -Math.ceil((base * statPercent) / 100);
    if (delta < 0) out[k] = delta;
  }
  return out;
}
function applyCorpsePoison(target, tier) {
  if (_blockedByPurifyImmunity(target, 'Трупный яд')) return;
  if (!target || !target.alive) return;
  const def = SKILLS.corpse_poison.tiers[tier];
  if (!def) return;
  // Иммунные типы (механизмы/нежить/элементали) не могут быть отравлены
  // ни одной разновидностью «Трупного яда» — не накладываем эффект совсем,
  // чтобы в панели не висел декоративный статус без последствий.
  if (isImmuneToPoison(target)) {
    const cls = CLASSES[target.classId];
    log(`${cls.name} (${target.team}) невосприимчив к яду — Трупный яд (${SKILL_TIER_LABELS[tier]}) не действует`, 'info');
    return;
  }
  const statPercent = (typeof def.statPercent === 'number') ? def.statPercent : 0;
  const existing = target.effects.find(e => e.id === 'corpse_poison');
  if (!existing) {
    const newStats = effectiveStats(target);  // до наложения
    const mods = _computeCorpsePoisonMods(target, statPercent);
    target.effects.push({
      id: 'corpse_poison',
      polarity: 'debuff',
      name: `Трупный яд (${SKILL_TIER_LABELS[tier]})`,
      tier,
      statPercent,                // справочно: текущий процент по тиру
      statMods: mods,             // фактические дельты per-key (без luk)
      duration: def.duration,     // базовая длительность
      remaining: def.duration,    // текущая
      sourceTeam: null            // не привязываем к конкретному зомби
    });
    // Пересчёт HP/маны после изменения статов (Vit/Int могли уменьшиться).
    clampResourcesAfterStatsChange(target, newStats);
    log(`${CLASSES[target.classId].name} (${target.team}) отравлен: Трупный яд (${SKILL_TIER_LABELS[tier]}, −${statPercent}%), ${def.remaining || def.duration} ход.`, 'info');
    return;
  }
  // Если новый тир выше висящего — апгрейдим.
  const prevStats = effectiveStats(target);
  const existingRank = POISON_TIER_RANK[existing.tier] || 1;
  const incomingRank = POISON_TIER_RANK[tier] || 1;
  if (incomingRank > existingRank) {
    existing.tier = tier;
    existing.name = `Трупный яд (${SKILL_TIER_LABELS[tier]})`;
    existing.statPercent = statPercent;
    existing.statMods = _computeCorpsePoisonMods(target, statPercent);
    // Очистим унаследованный legacy-флаг, если он был.
    if ('statMod' in existing) delete existing.statMod;
    existing.duration = def.duration;
    existing.remaining = Math.max(existing.remaining, def.duration);
    log(`${CLASSES[target.classId].name} (${target.team}) яд усилен до ${SKILL_TIER_LABELS[tier]} (−${statPercent}%)`, 'info');
  } else {
    // Равный или младший тир — не меняем параметры, но продлеваем
    // на базовую длительность нового применения.
    existing.remaining += def.duration;
    log(`${CLASSES[target.classId].name} (${target.team}) яд продлён (${SKILL_TIER_LABELS[tier]} даёт +${def.duration} ход.)`, 'info');
  }
  clampResourcesAfterStatsChange(target, prevStats);
}

/* --- Apply-хелперы для базовых статус-эффектов --------------------
   Вешают на цель «Горит» / «Отравлен» / «Оглушён» с явной длительностью.
   Дефолтов нет — источник, который накладывает эффект, всегда знает,
   на сколько ходов он его ставит (решение пользователя). Правило
   стакинга: существующая длительность складывается с новой
   (`existing.remaining += duration`). Для DoT это означает, что урон
   следующих тиков будет больше (т.к. урон = remaining), для стана —
   что количество пропущенных ходов растёт.

   Возвращаемого значения нет: сам факт наложения пишется в лог,
   источник может дальше решать, что с этим делать (анимация/звук). */
function applyBurning(target, duration) {
  return applyDurationEffect(target, 'burning', 'Горит', duration);
}
function applyPoisoned(target, duration) {
  // Симметрично с applyCorpsePoison: иммунные типы статус не получают.
  // Эффект «Отравлен» наносит poison-урон, который всё равно был бы
  // обнулён в computeIncomingDamage — но висящий декоративно эффект
  // мешал бы UI и сбивал ожидания игрока.
  if (isImmuneToPoison(target)) {
    const cls = CLASSES[target.classId];
    if (cls) log(`${cls.name} (${target.team}) невосприимчив к яду — «Отравлен» не накладывается`, 'info');
    return;
  }
  return applyDurationEffect(target, 'poisoned', 'Отравлен', duration);
}
function applyStunned(target, duration) {
  return applyDurationEffect(target, 'stunned', 'Оглушён', duration);
}
function applyImmobilized(target, duration) {
  return applyDurationEffect(target, 'immobilized', 'Обездвижен', duration);
}

/* «Огненный щит» — buff с двумя числами на экземпляре эффекта
   (Сессия 14). Не подходит applyDurationEffect, потому что хранит
   зафиксированные при наложении retaliateDmg + damageReduction.

   Стак: НЕ суммируем длительность (как у burning/slowed) и НЕ
   максимизируем (как у poisoned-тиров) — переписываем эффект полностью.
   Семантика «новый щит сменяет старый», даже если новый слабее. Это
   осознанный выбор: для buff-эффекта прозрачнее, чем накопление, и
   позволяет «обновить» щит, чтобы продлить ровно на свой тир-duration.

   apply* возвращаемого значения нет — факт наложения уходит в лог,
   исполнитель сам решает, что дальше (анимация щита и т. п.). */
function applyFireShield(target, duration, retaliateDmg, damageReduction) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const existing = target.effects.find(e => e.id === 'fire_shield');
  const fields = {
    id: 'fire_shield',
    polarity: 'buff',
    name: 'Огненный щит',
    duration,
    remaining: duration,
    retaliateDmg: Math.max(0, retaliateDmg | 0),
    damageReduction: Math.max(0, damageReduction | 0)
  };
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Огненный щит» обновлён (ответка ${fields.retaliateDmg}, снижение ${fields.damageReduction}, ${fields.duration} ход.)`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — наложен «Огненный щит» (ответка ${fields.retaliateDmg}, снижение ${fields.damageReduction}, ${fields.duration} ход.)`, 'info');
}

/* «Концентрация маны» — self-buff на самого мага (Сессия 15). Кладёт
   на инстанс эффекта `statMods: { wis: +wisBonus }` — общая ветка
   effectiveStats / statBreakdown в core/stats-calc.js подхватит. Тик
   длительности — стандартный (tickEffectsAtTurnEnd).

   Стак: повторное наложение ПЕРЕПИСЫВАЕТ поля целиком, как у
   fire_shield. Семантика «новая концентрация перезапускает» — даже если
   новый bonus слабее. Это согласуется с буффами от экипировки/зелий
   («перепил зелье — новый эффект полностью заменяет старый»).

   clampResourcesAfterStatsChange зовём для безопасности — wis сейчас
   не входит в maxHpOf/maxManaOf, так что фактически ничего не
   изменится; но если в будущем появится вис-зависимый maxMana, эта
   точка останется корректной. */
function applyManaFocus(target, duration, wisBonus) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!Number.isFinite(wisBonus) || wisBonus <= 0) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const prevStats = effectiveStats(target);
  const existing = target.effects.find(e => e.id === 'mana_focus');
  const fields = {
    id: 'mana_focus',
    polarity: 'buff',
    name: 'Концентрация маны',
    duration,
    remaining: duration,
    statMods: { wis: wisBonus }
  };
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Концентрация маны» обновлена (Мудрость +${wisBonus}, ${duration} ход.)`, 'info');
  } else {
    target.effects.push(fields);
    log(`${who} — наложена «Концентрация маны» (Мудрость +${wisBonus}, ${duration} ход.)`, 'info');
  }
  clampResourcesAfterStatsChange(target, prevStats);
}

/* Сессия 23: applyCamouflage(target, duration?) — накладывает «Маскировку».
   Способ истечения зависит от тира (см. SKILLS.camouflage):
     • БЕЗ duration (или duration<=0): эффект получает expiresAt:turnStart —
       снимается стандартно через expireTurnStartEffects в начале
       СЛЕДУЮЩЕГО собственного хода (basic-тир, покрывает ровно один
       AI-раунд после каста).
     • С duration > 0: эффект получает remaining:N — тикает в конце
       каждого своего хода через tickEffectsAtTurnEnd; снимается при 0
       (advanced/elite, 3 или 5 «своих» тиков соответственно).

   Стакинг: повторное наложение перезаписывает существующий эффект
   (как mana_focus / fire_shield). При перезаписи мы намеренно ОБНУЛЯЕМ
   обе формы истечения (delete e.expiresAt + delete e.remaining), а
   затем выставляем нужную для нового вызова — чтобы при «basic поверх
   elite» (или наоборот) старые поля не вмешивались.

   Снятие извне (см. шапку SKILLS.camouflage):
     • executeAttack → после фактического удара снимает с атакующего.
     • executeMove → в конце снимает с двигающегося.
     • onActiveSkillCast → снимает при использовании ЛЮБОГО активного
       навыка (кроме самой Маскировки).
     • clearAllEffects (purify) → снимает наряду с прочими.
     • expireTurnStartEffects / tickEffectsAtTurnEnd → плановое истечение. */
function applyCamouflage(target, duration) {
  if (!target || !target.alive) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const useDuration = Number.isFinite(duration) && duration > 0;
  const existing = target.effects.find(e => e.id === 'camouflage');
  const fields = useDuration
    ? { id: 'camouflage', polarity: 'buff', name: 'Маскировка', duration, remaining: duration }
    : { id: 'camouflage', polarity: 'buff', name: 'Маскировка', expiresAt: 'turnStart' };
  if (existing) {
    // Сбросить обе формы истечения, чтобы старые поля не вмешивались.
    delete existing.expiresAt;
    delete existing.remaining;
    delete existing.duration;
    Object.assign(existing, fields);
    const tail = useDuration ? ` (${duration} ход.)` : '';
    log(`${who} — «Маскировка» обновлена${tail}`, 'info');
  } else {
    target.effects.push(fields);
    const tail = useDuration ? ` (${duration} ход.)` : '';
    log(`${who} — наложена «Маскировка»${tail}`, 'info');
  }
}

/* Сессия 23: removeCamouflage(unit, reason) — точечное снятие
   «Маскировки» при разоблачающих событиях (атака носителя, движение
   носителя). Не для plain истечения (его обрабатывает
   expireTurnStartEffects). Не для cleanse (он использует clearAllEffects).

   reason — короткая строка для лога (атака / движение / etc).
   Если эффекта нет — тихий no-op (вызывается безусловно из
   executeAttack/executeMove, чтобы не нагромождать if hasEffect). */
function removeCamouflage(unit, reason) {
  if (!unit || !Array.isArray(unit.effects) || !unit.effects.length) return;
  const idx = unit.effects.findIndex(e => e.id === 'camouflage');
  if (idx < 0) return;
  unit.effects.splice(idx, 1);
  const cls = CLASSES[unit.classId];
  const who = cls ? `${cls.name} (${unit.team})` : unit.id;
  const tail = reason ? ` (${reason})` : '';
  log(`${who} — «Маскировка» снята${tail}`, 'info');
}

/* «Очищение» — universal removal-хелпер (Сессия 15). Снимает ВСЕ
   эффекты с цели (баффы и дебаффы одинаково), затем зовёт
   clampResourcesAfterStatsChange — на случай, если снятие vit/int-
   дебаффа подняло максимумы (clamp работает только в downward,
   так что hp/mana вверх не поднимется — это правильно: лечение
   снятием статуса было бы бесплатной хилкой).

   Используется executeCleanse в core/combat.js. Возвращает количество
   снятых эффектов — пригодится для лога caster-стороны («N эффектов
   снято» / «снимать нечего»). */
function clearAllEffects(unit) {
  if (!unit || !Array.isArray(unit.effects) || !unit.effects.length) return 0;
  const prevStats = effectiveStats(unit);
  const cls = CLASSES[unit.classId];
  const who = cls ? `${cls.name} (${unit.team})` : unit.id;
  const removed = unit.effects.slice();
  unit.effects = [];
  for (const eff of removed) {
    log(`${who} — снят эффект «${eff.name}»`, 'info');
  }
  clampResourcesAfterStatsChange(unit, prevStats);
  return removed.length;
}

/* Сессия 17: «Бронирован» — расходуемый щит. На экземпляре эффекта
   хранятся `charges` (текущие) и `maxCharges` (для UI/лога; пока то
   же значение, в будущем может различаться при апгрейдах). Длительности
   нет — НЕ тикает в onTurnEnd, спадает только когда charges <= 0
   (см. computeIncomingDamage → фаза 2: расход 1-в-1 с входящим уроном).

   Стак: повторное наложение НЕ суммирует, а БЕРЁТ МАКСИМУМ.
   «Лучшая броня вытесняет худшую» — если новое значение выше, заряды
   и maxCharges перезаписываются. Если ниже или равно — игнорируем
   (защита от случайного «слабого» апгрейда).

   apply* возвращаемого значения нет — факт наложения уходит в лог. */
/* Сессия 18: «Блок щитом» воина. Self-buff БЕЗ длительности по
   `remaining` — снимается в начале СЛЕДУЮЩЕГО хода носителя через
   общий механизм `expiresAt:'turnStart'` (см. expireTurnStartEffects
   ниже). Поле `damageReduction` фиксируется в момент наложения и
   читается в фазе 1 computeIncomingDamage для ЛЮБОГО damageType
   (физика, стихии). damageType:'special' игнорирует фазу 1 — щит
   не блокирует спец-урон.

   Стак: повторное наложение переписывает поля. Если уже висит щит
   с reduction=5 и наложили reduction=3 — берём новые числа (это
   «новая стойка сменяет старую», прозрачнее накопления). */
function applyShieldBlock(target, damageReduction) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(damageReduction) || damageReduction < 1) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const fields = {
    id: 'shield_block',
    polarity: 'buff',
    name: 'Блок щитом',
    expiresAt: 'turnStart',
    damageReduction
  };
  const existing = target.effects.find(e => e.id === 'shield_block');
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Блок щитом» обновлён (снижение −${damageReduction})`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — «Блок щитом» (следующий получаемый урон −${damageReduction})`, 'info');
}

/* Сессия 18: снимает с юнита все эффекты с `expiresAt:'turnStart'`.
   Вызывается из beginTurn ДО triggerEffectsAtTurnStart — чтобы
   у пришедшего хода юнит вступал уже без «истёкших» баффов. Это
   общий механизм для будущих эффектов с такой семантикой
   (second_attack_buff из C20, и т.п.).

   На itterate over snapshot, потому что filter мутирует unit.effects
   за один проход — безопаснее. Возвращает количество снятых эффектов
   (для отладки / лога caller-стороны). */
function expireTurnStartEffects(unit) {
  if (!unit || !Array.isArray(unit.effects) || !unit.effects.length) return 0;
  const expired = unit.effects.filter(e => e && e.expiresAt === 'turnStart');
  if (!expired.length) return 0;
  unit.effects = unit.effects.filter(e => !(e && e.expiresAt === 'turnStart'));
  const cls = CLASSES[unit.classId];
  const who = cls ? `${cls.name} (${unit.team})` : unit.id;
  for (const eff of expired) {
    log(`${who} — эффект «${eff.name}» истёк`, 'info');
  }
  return expired.length;
}

/* Сессия 21: симметричный механизм для `expiresAt:'turnEnd'`.
   Снимает с юнита все эффекты с этим маркером — вызывается из endTurn
   ПОСЛЕ всех остальных фаз (triggerEffectsAtTurnEnd / passive ticks /
   tickEffectsAtTurnEnd / tickCooldowns), чтобы бафф был активен на
   протяжении всего собственного хода. Сейчас единственный потребитель —
   long_shot_buff («Дальний выстрел»), но механизм общий. */
function expireTurnEndEffects(unit) {
  if (!unit || !Array.isArray(unit.effects) || !unit.effects.length) return 0;
  const expired = unit.effects.filter(e => e && e.expiresAt === 'turnEnd');
  if (!expired.length) return 0;
  unit.effects = unit.effects.filter(e => !(e && e.expiresAt === 'turnEnd'));
  const cls = CLASSES[unit.classId];
  const who = cls ? `${cls.name} (${unit.team})` : unit.id;
  for (const eff of expired) {
    log(`${who} — эффект «${eff.name}» истёк`, 'info');
  }
  return expired.length;
}

/* Сессия 19: «Укрепление» воина — стакающийся защитный эффект,
   нарастающий за получение урона. Висит до начала следующего хода
   носителя (через общий механизм expiresAt:'turnStart' — см.
   expireTurnStartEffects в этом же файле и beginTurn в core/turn.js).

   Стак: при первом срабатывании создаём эффект со stacks=gain. При
   повторном — увеличиваем stacks на gain. Длительности нет — снимется
   автоматически в начале следующего своего хода. Каждый стак снижает
   входящий урон на 1 в фазе 1 computeIncomingDamage (см. damage.js
   1.3) — может полностью обнулить (особое правило «нарастающая
   упругость плоти», max(0, incoming - stacks)). */
function applyReinforcementStack(target, gain) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(gain) || gain <= 0) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const existing = target.effects.find(e => e.id === 'reinforcement');
  if (existing) {
    existing.stacks = (existing.stacks | 0) + gain;
    log(`${who} — «Укрепление»: +${gain} стак (всего ${existing.stacks})`, 'info');
    return;
  }
  target.effects.push({
    id: 'reinforcement',
    polarity: 'buff',
    name: 'Укрепление',
    expiresAt: 'turnStart',
    stacks: gain
  });
  log(`${who} — «Укрепление»: +${gain} стак`, 'info');
}

/* Сессия 20: «Провокация». Накладывает на врага эффект `provoked`
   с forcedTarget=ID воина и expiresAt:'forcedMove'. Снимается AI после
   одного действия (атака/шаг) — см. consumeForcedMoveEffects ниже и
   ai.js → AI_POLICIES.zombie. Перезапись полностью заменяет предыдущий
   эффект (новый источник провокации перебивает старого). */
function applyProvoked(target, sourceId) {
  if (_blockedByPurifyImmunity(target, 'Спровоцирован')) return;
  if (!target || !target.alive || !sourceId) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const fields = {
    id: 'provoked',
    name: 'Спровоцирован',
    expiresAt: 'forcedMove',
    forcedTarget: sourceId
  };
  const existing = target.effects.find(e => e.id === 'provoked');
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Провокация» обновлена (новый источник)`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — спровоцирован`, 'info');
}

/* Сессия 20: бафф элитной «Второй атаки» — statMods на str/luk до
   начала следующего хода носителя. Реюзает механизм expiresAt:'turnStart'
   (С18 expireTurnStartEffects). Стак: переписываем поля. */
function applySecondAttackBuff(target) {
  if (!target || !target.alive) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  // С24: expiresAt:'nextAttack' — бафф спадает на первой же атаке
  // носителя (через consumeNextAttackEffects из executeAttack).
  // statMods читаются общим путём в effectiveStats до момента снятия.
  const fields = {
    id: 'second_attack_buff',
    name: 'Подъём (Вторая атака)',
    expiresAt: 'nextAttack',
    statMods: { str: 6, luk: 6 }
  };
  const existing = target.effects.find(e => e.id === 'second_attack_buff');
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Подъём» обновлён (Сила +6, Удача +6 на следующую атаку)`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — «Подъём» (Сила +6, Удача +6) на следующую атаку`, 'info');
}

/* Сессия 21: бафф «Дальнего выстрела» — `statMods.weaponRangeBonus` со
   значением по тиру (2/3/4). expiresAt:'turnEnd' — эффект живёт ровно
   до конца текущего хода носителя. Стак: переписываем поле bonus
   (повторный каст обновляет величину прибавки). */
function applyLongShotBuff(target, bonus) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(bonus) || bonus <= 0) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const fields = {
    id: 'long_shot_buff',
    name: 'Дальний выстрел',
    expiresAt: 'turnEnd',
    statMods: { weaponRangeBonus: bonus }
  };
  const existing = target.effects.find(e => e && e.id === 'long_shot_buff');
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Дальний выстрел» обновлён (+${bonus} к дальности до конца хода)`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — «Дальний выстрел»: +${bonus} к дальности атаки до конца хода`, 'info');
}

/* Сессия 21: бафф элитного «Второго выстрела». Зеркало
   applySecondAttackBuff: statMods на dex/luk, expiresAt:'nextAttack'
   (снимается на первой же атаке через consumeNextAttackEffects). */
function applySecondShotBuff(target) {
  if (!target || !target.alive) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const fields = {
    id: 'second_shot_buff',
    name: 'Подъём (Второй выстрел)',
    expiresAt: 'nextAttack',
    statMods: { dex: 6, luk: 6 }
  };
  const existing = target.effects.find(e => e && e.id === 'second_shot_buff');
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Подъём» обновлён (Ловкость +6, Удача +6 на следующую атаку)`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — «Подъём» (Ловкость +6, Удача +6) на следующую атаку`, 'info');
}

/* Сессия 24: «Отравленная стрела» лучника. Self-buff, expiresAt:
   'nextAttack' — спадает после первой же атаки носителя. На атаке
   через applyOnHit накладывает на цель `poisoned` с duration. По ходам
   не тикает.

   Стак: повторное наложение переписывает duration (новая концентрация
   яда на наконечнике перебивает старую). */
function applyPoisonArrowBuff(target, duration) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  // Правка С24-bis: эффекты группы 'arrow' (poison/fire arrow buff)
  // взаимоисключающие — стрела не может быть одновременно отравлена И
  // подожжена. Снимаем все ДРУГИЕ arrow-эффекты перед наложением.
  // second_attack_buff (без группы) — не трогаем; он висит параллельно.
  if (Array.isArray(target.effects) && target.effects.length) {
    const removed = target.effects.filter(e => e && e.attackBuffGroup === 'arrow' && e.id !== 'poison_arrow_buff');
    if (removed.length) {
      target.effects = target.effects.filter(e => !(e && e.attackBuffGroup === 'arrow' && e.id !== 'poison_arrow_buff'));
      for (const r of removed) log(`${who} — «${r.name}» снята (заменена на «Отравленную стрелу»)`, 'info');
    }
  }
  const fields = {
    id: 'poison_arrow_buff',
    name: 'Отравленная стрела готова',
    expiresAt: 'nextAttack',
    attackBuffGroup: 'arrow',
    applyOnHit: { id: 'poisoned', duration }
  };
  const existing = target.effects.find(e => e.id === 'poison_arrow_buff');
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Отравленная стрела» обновлена (duration ${duration})`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — «Отравленная стрела» готова (на следующей атаке: «Отравлен» ${duration} ход.)`, 'info');
}

/* Сессия 24: «Горящая стрела». Зеркало applyPoisonArrowBuff. */
function applyFireArrowBuff(target, duration) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  // Правка С24-bis: см. applyPoisonArrowBuff — те же правила группы 'arrow'.
  if (Array.isArray(target.effects) && target.effects.length) {
    const removed = target.effects.filter(e => e && e.attackBuffGroup === 'arrow' && e.id !== 'fire_arrow_buff');
    if (removed.length) {
      target.effects = target.effects.filter(e => !(e && e.attackBuffGroup === 'arrow' && e.id !== 'fire_arrow_buff'));
      for (const r of removed) log(`${who} — «${r.name}» снята (заменена на «Горящую стрелу»)`, 'info');
    }
  }
  const fields = {
    id: 'fire_arrow_buff',
    name: 'Горящая стрела готова',
    expiresAt: 'nextAttack',
    attackBuffGroup: 'arrow',
    applyOnHit: { id: 'burning', duration }
  };
  const existing = target.effects.find(e => e.id === 'fire_arrow_buff');
  if (existing) {
    Object.assign(existing, fields);
    log(`${who} — «Горящая стрела» обновлена (duration ${duration})`, 'info');
    return;
  }
  target.effects.push(fields);
  log(`${who} — «Горящая стрела» готова (на следующей атаке: «Горит» ${duration} ход.)`, 'info');
}

/* Сессия 24: снимает с юнита все эффекты с expiresAt:'nextAttack'.
   Зовётся из core/combat.js → executeAttack ПОСЛЕ applyDamage и
   логирования удара. Для каждого снятого эффекта:
   - Если есть `applyOnHit:{id, duration, strength?}` И target цели
     жив И это враг (target.team !== source.team — иначе на союзника
     на которого мы случайно бьём через friendly-fire не стоит вешать),
     — применяет соответствующий apply*-хелпер.
   - statMods, fields эффекта в `applyOnHit` отсутствуют — спадает
     просто как «бафф истёк» (как у second_attack_buff: его statMods
     прочитались через effectiveStats во время атаки, после снятия
     перестают влиять).

   Возвращает количество снятых эффектов. */
function consumeNextAttackEffects(unit, target) {
  if (!unit || !Array.isArray(unit.effects) || !unit.effects.length) return 0;
  const expired = unit.effects.filter(e => e && e.expiresAt === 'nextAttack');
  if (!expired.length) return 0;
  // Удаляем эффекты ДО применения applyOnHit, чтобы возможные побочки
  // (рендер, лог) не успевали увидеть «висящий» эффект на втором кадре.
  unit.effects = unit.effects.filter(e => !(e && e.expiresAt === 'nextAttack'));
  const cls = CLASSES[unit.classId];
  const who = cls ? `${cls.name} (${unit.team})` : unit.id;
  for (const eff of expired) {
    log(`${who} — «${eff.name}» применён и спадает`, 'info');
    // applyOnHit — наложение статус-эффекта на цель.
    if (eff.applyOnHit && eff.applyOnHit.id && target && target.alive
        && target.team !== unit.team) {
      const dur = (eff.applyOnHit.duration | 0) || 0;
      if (dur > 0) {
        if (eff.applyOnHit.id === 'poisoned'  && typeof applyPoisoned  === 'function') applyPoisoned(target, dur);
        if (eff.applyOnHit.id === 'burning'   && typeof applyBurning   === 'function') applyBurning(target, dur);
        if (eff.applyOnHit.id === 'stunned'   && typeof applyStunned   === 'function') applyStunned(target, dur);
        if (eff.applyOnHit.id === 'immobilized' && typeof applyImmobilized === 'function') applyImmobilized(target, dur);
      }
    }
  }
  return expired.length;
}

/* Сессия 20: снимает с юнита все эффекты с expiresAt:'forcedMove'.
   Зовётся в core/ai.js ПОСЛЕ совершения «вынужденного действия»
   (атака или шаг к forcedTarget). Возвращает количество снятых.

   Сейчас единственный носитель — provoked. */
function consumeForcedMoveEffects(unit) {
  if (!unit || !Array.isArray(unit.effects) || !unit.effects.length) return 0;
  const expired = unit.effects.filter(e => e && e.expiresAt === 'forcedMove');
  if (!expired.length) return 0;
  unit.effects = unit.effects.filter(e => !(e && e.expiresAt === 'forcedMove'));
  const cls = CLASSES[unit.classId];
  const who = cls ? `${cls.name} (${unit.team})` : unit.id;
  for (const eff of expired) {
    log(`${who} — «${eff.name}» спадает (вынужденное действие совершено)`, 'info');
  }
  return expired.length;
}

function applyArmored(target, charges) {
  if (!target || !target.alive) return;
  if (!Number.isFinite(charges) || charges < 1) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const existing = target.effects.find(e => e.id === 'armored');
  if (existing) {
    // Правка 07.05.2026: стак — СУММИРУЕТСЯ. Раньше было «лучшая броня
    // вытесняет худшую» (max), но в реальной игре это упиралось в
    // потолок тира: на basic-тире (3 заряда) повторный каст не поднимал
    // число выше 3, даже если игрок успел снять часть зарядов в бою.
    // Накапливание поверх действующих зарядов — естественная семантика
    // «укрепляю броню ещё сильнее»; кулдаун 5 ходов всё равно ограничивает
    // частоту, абьюзить нельзя.
    const before = existing.charges | 0;
    existing.charges = before + charges;
    log(`${who} — «Бронирование» усилено: +${charges} (всего ${existing.charges})`, 'info');
    return;
  }
  // Правка 04.05.2026: убрано поле maxCharges. Концепт «макс. зарядов
  // не существует — броня просто имеет N зарядов, расходуется
  // по 1-в-1 за каждый поглощённый урон.
  target.effects.push({
    id: 'armored',
    name: 'Бронирован',
    charges
  });
  log(`${who} — наложен «Бронирован» (${charges} зарядов)`, 'info');
}

/* Замедлен — точечный stat-эффект, понижающий Скорость на величину
   силы (strength). В отличие от Burning/Poisoned/Stunned/Immobilized
   у Замедлен переменная сила, поэтому applyDurationEffect не подходит:
   на экземпляре эффекта хранится `statMods: { spd: -strength }`, и
   statBreakdown читает её через общую ветку «eff.statMods»
   (см. core/stats-calc.js).

   Правила стака (см. DESIGN.md, Сессия 8):
     — длительности всегда складываются (existing.remaining += duration);
     — в поле силы хранится максимум из старой и новой;
     — statMods.spd переписывается на -max(strength).
   Примеры:
     висит «−2/4 хода», накладывают «−1/5 ходов» → «−2/9 ходов»;
     висит «−1/5 ходов», накладывают «−2/1 ход»  → «−2/6 ходов»;
     висит «−2/4 хода», накладывают «−2/3 хода»  → «−2/7 ходов».

   Спадает в общем tickEffectsAtTurnEnd, как Горит/Отравлен.
   Собственного onTurnStart-хука нет — модификатор пассивный, читается
   через effectiveStats при каждом запросе. clampResourcesAfterStatsChange
   тут не нужен: spd не входит ни в maxHpOf, ни в maxManaOf. */
function applySlowed(target, strength, duration) {
  if (_blockedByPurifyImmunity(target, 'Замедлен')) return;
  if (!target || !target.alive) return;
  if (!Number.isFinite(strength) || strength < 1) return;
  if (!Number.isFinite(duration) || duration < 1) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const existing = target.effects.find(e => e.id === 'slowed');
  if (!existing) {
    target.effects.push({
      id: 'slowed',
      name: 'Замедлен',
      strength,
      duration,
      remaining: duration,
      statMods: { spd: -strength }
    });
    log(`${who} замедлен на ${strength} на ${duration} ход.`, 'info');
    return;
  }
  // Стак: длительности складываются, сила = max(старая, новая).
  existing.remaining += duration;
  existing.duration = duration;
  if (strength > existing.strength) existing.strength = strength;
  existing.statMods = { spd: -existing.strength };
  log(`${who} — продлено замедление до ${existing.remaining} ход. (сила ${existing.strength})`, 'info');
}

/* «Совместная охота» — стаки на жертве. Накладывается ПОСЛЕ нанесения
   урона в triggerOnDealDamagePassives (см. core/damage.js, ветка
   joint_hunt). На экземпляре эффекта хранится `stacks` (натуральное
   число). Длительности нет — стаки уменьшаются вдвое (с округлением вниз)
   в начале каждого хода жертвы (см. SKILLS.joint_hunt_marks.onTurnStart
   в data/skills.js). При результате 0 — эффект снимается.

   Стак: при повторном применении stacksGain суммируется с текущим
   значением (без верхнего лимита). Это согласуется с описанием
   «накладывает +N стаков». Если в будущем понадобится потолок — добавить
   через max(stacks, cap). */
function applyJointHuntStack(target, stacksGain) {
  if (_blockedByPurifyImmunity(target, 'Совместная охота')) return;
  if (!target || !target.alive) return;
  if (!Number.isFinite(stacksGain) || stacksGain < 1) return;
  if (!target.effects) target.effects = [];
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  const existing = target.effects.find(e => e.id === 'joint_hunt_marks');
  if (existing) {
    existing.stacks = (existing.stacks | 0) + stacksGain;
    log(`${who} — «Совместная охота»: +${stacksGain} стак (всего ${existing.stacks})`, 'info');
    return;
  }
  target.effects.push({
    id: 'joint_hunt_marks',
    name: 'Совместная охота',
    stacks: stacksGain
  });
  log(`${who} — «Совместная охота»: +${stacksGain} стак`, 'info');
}

/* «Напуган» — контрольный эффект страха. Длительность принимаем
   обязательно (N>=1 — число своих ходов с принудительным бегом).
   Если в будущем понадобится «expiresAt:'turnEnd'»-вариант — добавить
   отдельную ветку через перегрузку или второй apply-хелпер.

   Иммунитет: unitType==='mechanism'. Проверяем по CLASSES[classId].unitType
   (тип хранится на классе, а не на инстансе — см. data/unit-types.js).
   Если иммун — пишем в лог и не накладываем (декоративный статус без
   последствий мешал бы UI и сбивал ожидания игрока, как с ядом).

   Стак: длительность складывается с новой (как у Burning/Poisoned).
   Усиление параметров пока не предусмотрено (силы/тиров у эффекта нет). */
function applyFrightened(target, duration) {
  if (_blockedByPurifyImmunity(target, 'Напуган')) return;
  if (!target || !target.alive) return;
  if (!Number.isFinite(duration) || duration < 1) return;
  const cls = CLASSES[target.classId];
  if (cls && cls.unitType === 'mechanism') {
    const who = `${cls.name} (${target.team})`;
    log(`${who} — механизм невосприимчив к страху, «Напуган» не действует`, 'info');
    return;
  }
  return applyDurationEffect(target, 'frightened', 'Напуган', duration);
}

/* «Может ли юнит сейчас двигаться» — единая точка проверки. На неё
   опираются и UI (кнопка/режим Move), и сама механика (executeMove),
   и ИИ (aiZombieStepMove). Сейчас единственное условие — не висит
   ли «Обездвижен»; позже сюда же легко добавятся «корни», «паралич
   ног» и т.п., не ломая каждое место по отдельности. */
function canUnitMove(unit) {
  if (!unit || !unit.alive) return false;
  return !hasEffect(unit, 'immobilized');
}
function hasEffect(unit, effectId) {
  return !!(unit && unit.effects && unit.effects.some(e => e.id === effectId));
}

/* Camp v1.5-polarity (09.05.2026): полярность эффекта. Источники по
   приоритету:
     1) eff.polarity на самом инстансе (выставляется apply*-хелпером
        для эффектов без записи в SKILLS — fire_shield, mana_focus,
        camouflage, shield_block, reinforcement, corpse_poison).
     2) SKILLS[eff.id].polarity — для эффектов с записью kind:'effect'
        в data/skills.js (15 шт.).
     3) Defensive fallback 'debuff'. Лучше «случайно снять врагу при
        исцелении» (если кто-то добавил новый эффект и забыл polarity),
        чем «не снять с союзника» — союзник пострадает, починим, новые
        эффекты сразу будут заметны при тестах механики Священника.
   Используется будущими навыками (cleanseDebuffs / dispelBuffs / тип-
   фильтрами в UI цвета чипов). */
function effectPolarityOf(eff) {
  if (!eff) return 'debuff';
  if (eff.polarity === 'buff' || eff.polarity === 'debuff') return eff.polarity;
  if (typeof SKILLS === 'object' && SKILLS && eff.id) {
    const sk = SKILLS[eff.id];
    if (sk && (sk.polarity === 'buff' || sk.polarity === 'debuff')) return sk.polarity;
  }
  return 'debuff';
}
/* Общий код «наложить/продлить эффект с простой duration-семантикой».
   Для Горит/Отравлен/Оглушён этого достаточно: без тиров, без statMod.
   Если в будущем у эффекта появится тир-зависимая сила — придётся
   повторить логику applyCorpsePoison отдельно. */
function applyDurationEffect(target, effectId, displayName, duration) {
  if (_blockedByPurifyImmunity(target, displayName || effectId)) return;
  if (!target || !target.alive) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const existing = target.effects && target.effects.find(e => e.id === effectId);
  const cls = CLASSES[target.classId];
  const who = cls ? `${cls.name} (${target.team})` : target.id;
  if (existing) {
    existing.remaining += duration;
    // duration на экземпляре = длительность ПОСЛЕДНЕГО применения (для
    // справочных tooltip'ов и потенциальных правил «не короче чем»).
    existing.duration = duration;
    log(`${who} — «${displayName}» продлён на ${duration} ход. (осталось ${existing.remaining})`, 'info');
    return;
  }
  if (!target.effects) target.effects = [];
  target.effects.push({
    id: effectId,
    name: displayName,
    duration,
    remaining: duration
  });
  log(`${who} — наложен «${displayName}» на ${duration} ход.`, 'info');
}

/* Когда у юнита меняются статы (обычно из-за (де)баффа), нужно пересчитать
   максимумы HP/маны и обрезать текущие значения, если они превышают новый
   максимум. Важно: в повышающую сторону НЕ меняем — усиление даёт «пустой
   резерв», а не лечит.
   prevStats — статы ДО изменения, по которым считались прежние максимумы. */
function clampResourcesAfterStatsChange(unit, prevStats) {
  const prevMaxHp   = getBaseHp(unit.classId) + prevStats.vit * 2;
  const prevMaxMana = 5 + prevStats.int * 2;
  const newMaxHp   = maxHpOf(unit);
  const newMaxMana = maxManaOf(unit);
  if (unit.hp > newMaxHp)     unit.hp   = newMaxHp;
  if (unit.mana > newMaxMana) unit.mana = newMaxMana;
  // Снижение Vit может добить в 0.
  if (unit.hp <= 0 && unit.alive) {
    unit.hp = 0;
    unit.alive = false;
    unit.isDying = true;
    log(`${CLASSES[unit.classId].name} (${unit.team}) повержен (максимум HP упал ниже текущего)`, 'death');
    scheduleDeathCleanup(unit);
  }
  void prevMaxHp; void prevMaxMana;  // пока используются только как семантический чек
}

/* ================================================================
   === ФАЗЫ ЭФФЕКТОВ НА ХОДЕ НОСИТЕЛЯ ==============================
   ================================================================
   Два общих триггера по длительности эффектов:
     — «начало хода»  (onTurnStart) — срабатывает в beginTurn до того,
       как юнит получит управление (и до запуска ИИ). Нужен эффектам
       вроде регенерации, пробуждения из стана и будущих DoT, которые
       хотят бить в начале хода жертвы.
     — «конец хода»   (onTurnEnd)   — срабатывает в endTurn ДО
       уменьшения счётчика длительности (tickEffectsAtTurnEnd). Это
       сохраняет правило «эффект живёт ровно один собственный ход»:
       на своём последнем собственном end-of-turn он ещё успевает
       отработать, и только потом его remaining уходит в 0.

   Регистрация хука. Хук ищется в трёх местах (в таком порядке):
     1. eff[hookName] — функция прямо на экземпляре эффекта (на случай
        штучного баффа от экипировки/скилла без записи в SKILLS).
     2. SKILLS[eff.id][hookName] — общий реестр.
     3. SKILLS[eff.id].tiers[eff.tier][hookName] — тир-зависимый хук
        (пока не используется, задел).
   Хук — `(unit, effect) => void`. Хук сам отвечает за свои побочные
   эффекты (изменение HP, статов, постановку новых эффектов) и сам
   пишет в лог, ЕСЛИ реально что-то сделал (см. ответ пользователя:
   «только если эффект что-то реально сделал»).

   Инфраструктура отвечает за:
     — итерацию по снимку unit.effects (эффекты, добавленные хуком,
       в этой же фазе не сработают — это осознанно);
     — безопасное прекращение цикла, если носитель умер по ходу фазы;
     — перехват исключений в хуках (один кривой эффект не ломает весь
       ход).
   Возвращает `true`, если носитель умер во время фазы — beginTurn
   использует это, чтобы сразу завершить ход (см. план: «если эффект
   на старте убил носителя — ход моментально заканчивается»). */
function triggerEffectsAtTurnStart(unit) {
  return runEffectPhase(unit, 'onTurnStart');
}
function triggerEffectsAtTurnEnd(unit) {
  return runEffectPhase(unit, 'onTurnEnd');
}
function runEffectPhase(unit, hookName) {
  if (!unit || !unit.alive) return false;
  if (!unit.effects || !unit.effects.length) return false;
  // Снимок массива: если хук добавит новый эффект носителю, в этой же
  // фазе он не сработает (только со следующего цикла).
  const snapshot = unit.effects.slice();
  for (const eff of snapshot) {
    if (!unit.alive) break;
    const handler = resolveEffectHook(eff, hookName);
    if (!handler) continue;
    try { handler(unit, eff); }
    catch (err) { console.error('[effect phase]', hookName, eff && eff.id, err); }
  }
  return !unit.alive;
}
function resolveEffectHook(eff, hookName) {
  if (!eff) return null;
  if (typeof eff[hookName] === 'function') return eff[hookName];
  const skill = SKILLS[eff.id];
  if (!skill) return null;
  if (typeof skill[hookName] === 'function') return skill[hookName];
  // Тир-зависимый хук (задел — пока никто не использует).
  if (eff.tier && skill.tiers && skill.tiers[eff.tier]
      && typeof skill.tiers[eff.tier][hookName] === 'function') {
    return skill.tiers[eff.tier][hookName];
  }
  return null;
}

/* Обработка истечения эффектов: в конце хода юнита-носителя всем его
   эффектам уменьшаем remaining на 1 и удаляем выдохшиеся. После удаления
   пересчитываем ресурсы (эффект, снятый с Vit-дебаффа, обратно HP НЕ
   восстанавливает — см. clampResourcesAfterStatsChange).
   ВАЖНО: вызывается ПОСЛЕ triggerEffectsAtTurnEnd — это правильный
   порядок по правилу «эффект живёт ровно один собственный ход». */
function tickEffectsAtTurnEnd(unit) {
  if (!unit || !unit.effects || !unit.effects.length) return;
  const prevStats = effectiveStats(unit);
  const expired = [];
  const kept = [];
  for (const eff of unit.effects) {
    eff.remaining -= 1;
    if (eff.remaining <= 0) expired.push(eff);
    else kept.push(eff);
  }
  if (expired.length) {
    unit.effects = kept;
    for (const eff of expired) {
      log(`${CLASSES[unit.classId].name} (${unit.team}) — эффект «${eff.name}» закончился`, 'info');
    }
    clampResourcesAfterStatsChange(unit, prevStats);
  }
}


/* === Эффекты священника (Сессия A, 09.05.2026) ===================
   Все 4 хелпера используют один pattern: убрать предыдущий эффект
   того же id (стэка нет — повторное наложение перезаписывает),
   создать новый с нужными числовыми полями + duration + remaining.
   `polarity` дублируется на инстансе для скорости (effectPolarityOf
   читает eff.polarity первым; иначе fallback на SKILLS[id].polarity). */

function applyBlessingBuff(target, lukDelta, duration) {
  if (!target || !target.alive || !Number.isFinite(duration) || duration <= 0) return;
  if (!Array.isArray(target.effects)) target.effects = [];
  // Снимаем предыдущий blessing_buff/curse — это два полюса одного эффекта.
  const prevStats = effectiveStats(target);
  target.effects = target.effects.filter(e => e && e.id !== 'blessing_buff' && e.id !== 'blessing_curse');
  target.effects.push({
    id: 'blessing_buff',
    polarity: 'buff',
    name: 'Благословение',
    duration, remaining: duration,
    statMods: { luk: +(lukDelta | 0) }
  });
  clampResourcesAfterStatsChange(target, prevStats);
  const cls = CLASSES[target.classId];
  log(`${cls ? cls.name : target.id} (${target.team}) — «Благословение» (+${lukDelta} к Удаче на ${duration} ход.)`, 'info');
}

function applyBlessingCurse(target, lukDelta, duration) {
  if (_blockedByPurifyImmunity(target, 'Проклятие удачи')) return;
  if (!target || !target.alive || !Number.isFinite(duration) || duration <= 0) return;
  if (!Array.isArray(target.effects)) target.effects = [];
  const prevStats = effectiveStats(target);
  target.effects = target.effects.filter(e => e && e.id !== 'blessing_buff' && e.id !== 'blessing_curse');
  target.effects.push({
    id: 'blessing_curse',
    polarity: 'debuff',
    name: 'Проклятие удачи',
    duration, remaining: duration,
    statMods: { luk: -(lukDelta | 0) }
  });
  clampResourcesAfterStatsChange(target, prevStats);
  const cls = CLASSES[target.classId];
  log(`${cls ? cls.name : target.id} (${target.team}) — «Проклятие удачи» (-${lukDelta} к Удаче на ${duration} ход.)`, 'info');
}

function applyHolyStrength(target, duration, strBonus, stunChance) {
  if (!target || !target.alive || !Number.isFinite(duration) || duration <= 0) return;
  if (!Array.isArray(target.effects)) target.effects = [];
  const prevStats = effectiveStats(target);
  target.effects = target.effects.filter(e => e && e.id !== 'holy_strength_buff');
  target.effects.push({
    id: 'holy_strength_buff',
    polarity: 'buff',
    name: 'Святая сила',
    duration, remaining: duration,
    statMods: { str: +(strBonus | 0) },
    stunChance: (stunChance | 0)   // % шанс оглушить нежить/демона при базовой атаке (читается в executeAttack)
  });
  clampResourcesAfterStatsChange(target, prevStats);
  const cls = CLASSES[target.classId];
  log(`${cls ? cls.name : target.id} (${target.team}) — «Святая сила» (+${strBonus} Силы, ${stunChance}% оглушить нежить/демонов на ${duration} ход.)`, 'info');
}

/* purify_immunity: до начала следующего хода ЦЕЛИ. Используем
   expiresAt:'turnStart' — снимется в expireTurnStartEffects на её
   ходу (как shield_block / camouflage(elite)). Снимающий механизм
   для накладывающихся дебаффов реализуется в applyDurationEffect /
   applyXxx-хелперах через `hasPurifyImmunity` (см. patch ниже).
   Сейчас ХЕЛПЕР существует и эффект виден в UI; универсальный
   фильтр «дебафф пытается налипнуть на иммунного — сразу слетает»
   будет добавлен в Сессии B вместе со «Священной бронёй». */
function applyPurifyImmunity(target) {
  if (!target || !target.alive) return;
  if (!Array.isArray(target.effects)) target.effects = [];
  target.effects = target.effects.filter(e => e && e.id !== 'purify_immunity');
  target.effects.push({
    id: 'purify_immunity',
    polarity: 'buff',
    name: 'Святая защита от порчи',
    expiresAt: 'turnStart'
  });
  const cls = CLASSES[target.classId];
  log(`${cls ? cls.name : target.id} (${target.team}) — «Святая защита от порчи» (до начала своего хода)`, 'info');
}

/* Хелпер для будущей Сессии B: проверка «висит ли purify_immunity».
   В Сессии A не используется ни одним applyXxx-хелпером — иммунитет
   к новым дебаффам активируется в Сессии B. Объявлен сейчас, чтобы
   полярность сразу стала видна в UI и не пришлось править лишний раз. */
function hasPurifyImmunity(unit) {
  return !!(unit && Array.isArray(unit.effects) && unit.effects.some(e => e && e.id === 'purify_immunity'));
}

/* Camp v1.5-priest-B (10.05.2026): «Священная броня» — buff на цели
   с damageCap=1. Истекает в начале следующего хода цели
   (expiresAt:'turnStart'). При повторном наложении — перезаписывается
   (как fire_shield: «новый щит вытесняет старый»). */
function applyHolyShieldBuff(target) {
  if (!target || !target.alive) return;
  if (!Array.isArray(target.effects)) target.effects = [];
  target.effects = target.effects.filter(e => e && e.id !== 'holy_shield_buff');
  target.effects.push({
    id: 'holy_shield_buff',
    polarity: 'buff',
    name: 'Священная броня',
    expiresAt: 'turnStart',
    damageCap: 1
  });
  const cls = CLASSES[target.classId];
  log(`${cls ? cls.name : target.id} (${target.team}) — «Священная броня» (получаемый урон ≤ 1 до начала своего хода)`, 'info');
}

/* Camp v1.5-priest-C (11.05.2026): «Исцеляющая аура» — пассивка
   священника. В начале СВОЕГО хода юнит-цель (любой союзник, не-механизм)
   проверяет, есть ли рядом (Чебышев=1, 8 направлений) живой союзник с
   пассивкой `healing_aura`. Если есть — лечит на максимум из подходящих
   тиров (если соседних священников несколько, аур не суммируется —
   берётся «лучший» тир). Не действует на механизмы. Зовётся из beginTurn
   после triggerEffectsAtTurnStart. */
function triggerHealingAuraForUnit(unit) {
  if (!unit || !unit.alive) return;
  const ucls = CLASSES[unit.classId];
  if (!ucls) return;
  if (ucls.unitType === 'mechanism') return;
  // Найти соседних союзников с пассивкой healing_aura.
  let bestHeal = 0;
  let bestSourceName = null;
  for (const src of state.units) {
    if (!src || !src.alive) continue;
    if (src.team !== unit.team) continue;
    if (src.id === unit.id) continue;
    // Чебышев = max(|dr|,|dc|) ≤ 1 (8 соседних клеток).
    const dr = Math.abs(src.row - unit.row);
    const dc = Math.abs(src.col - unit.col);
    if (Math.max(dr, dc) > 1) continue;
    if (typeof passiveSkillsOf !== 'function') continue;
    const sids = passiveSkillsOf(src);
    if (!Array.isArray(sids) || !sids.includes('healing_aura')) continue;
    const tier = (typeof getPassiveSkillTier === 'function')
      ? getPassiveSkillTier(src, 'healing_aura') : 'basic';
    const skill = SKILLS && SKILLS.healing_aura;
    const td = skill && skill.tiers && skill.tiers[tier];
    const heal = (td && (td.healAmount | 0)) || 0;
    if (heal > bestHeal) {
      bestHeal = heal;
      bestSourceName = (CLASSES[src.classId] || {}).name || src.id;
    }
  }
  if (bestHeal <= 0) return;
  const hpMax = (typeof maxHpOf === 'function') ? maxHpOf(unit) : unit.hp;
  if (unit.hp >= hpMax) return;  // полное здоровье — не лечим
  const before = unit.hp;
  unit.hp = Math.min(hpMax, unit.hp + bestHeal);
  const actual = unit.hp - before;
  if (actual <= 0) return;
  log(`${ucls.name} (${unit.team}) — «Исцеляющая аура» (${bestSourceName || 'священник'}): +${actual} HP (${unit.hp}/${hpMax})`, 'info');
}

/* Camp v1.5-priest (10.05.2026): единый guard для блокировки новых
   дебаффов на цели с висящим purify_immunity. Возвращает true, если
   эффект следует пропустить (заблокирован), false если можно класть.
   Пишет лог-уведомление с именем «отбитого» эффекта — игрок видит,
   что защита сработала. Использовать в начале каждого apply*-хелпера
   дебаффа: если return true — функция выходит без эффекта.

   Расширения: если в будущем появятся «жёсткие» дебаффы (босс-мажорные),
   обходящие иммунитет — добавить опциональный 3-й аргумент `bypass:true`
   и пропустить проверку. */
function _blockedByPurifyImmunity(target, effectName) {
  if (!hasPurifyImmunity(target)) return false;
  const cls = (typeof CLASSES === 'object') ? CLASSES[target.classId] : null;
  const who = cls ? `${cls.name} (${target.team})` : (target && target.id) || '?';
  log(`${who} — «Святая защита от порчи» отбила «${effectName}»`, 'info');
  return true;
}

