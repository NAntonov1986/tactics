/* damage.js — правила нанесения и применения урона.
   Что внутри:
     • computeIncomingDamage(target, dmg, damageType) — модификаторы по типу
       цели (unitType) и типу удара (damageType). Возвращает
       `{ dmg, note }`: финальное число + человекочитаемая пометка для лога.
       Сейчас работают два правила:
         — иммунитет к яду у mechanism/undead/elemental (urён → 0),
         — святой ×1.5 для undead/demon (Math.floor).
       Новые типовые модификаторы добавляются ОДНОЙ записью здесь, без
       размазывания по местам каста. ВАЖНО: эта функция НЕ занимается
       критом — крит применяется до неё, в исполнителе атаки/каста.
     • isImmuneToPoison(target) — иммунитет к ЭФФЕКТУ отравления (не к урону).
       Используется на стороне накладывающих эффект функций
       (applyCorpsePoison, applyPoisoned), чтобы иммунные юниты не получали
       декоративный «Отравлен» в панели. Список иммунных типов совпадает
       с computeIncomingDamage(poison).
     • applyDamage(target, dmg, source) — единая точка снятия HP. Делает три вещи:
         1) Уменьшает target.hp на dmg.
         2) Если source и враждебная команда — запускает onDealDamage-пассивы
            (через triggerOnDealDamagePassives).
         3) Если HP ≤ 0 — ставит alive=false, isDying=true, пишет лог
            смерти, планирует cleanup в надгробие через scheduleDeathCleanup.
       ВАЖНО: applyDamage принимает уже ПОДГОТОВЛЕННЫЙ урон с учётом типов
       (через computeIncomingDamage). Это сделано осознанно — исполнители
       и без того знают damageType и обязаны логировать настоящее число;
       если бы applyDamage сама лезла в типы, лог и реальный урон могли бы
       разойтись.
     • triggerOnDealDamagePassives(source, target) — для каждой пассивки
       носителя с триггером onDealDamage применяет её эффект на цель.
       Сейчас реализован только corpse_poison.

   Что НЕ внутри:
     • apply*-хелперы статус-эффектов (applyCorpsePoison / applyBurning /
       applyPoisoned / applyStunned / applyImmobilized / applyDurationEffect),
       а также POISON_TIER_RANK, hasEffect, canUnitMove,
       clampResourcesAfterStatsChange, фазы эффектов (triggerEffectsAtTurn*,
       tickEffectsAtTurnEnd). Всё это переедет в `src/core/effects.js` (R12).
       triggerOnDealDamagePassives ниже вызывает applyCorpsePoison из
       монолита; работает за счёт резолва в момент вызова.
     • scheduleDeathCleanup — пока в монолите (анимации/таймеры);
       переедет в render/render-units.js (R17) или останется в монолите
       до движений (R13).
     • log, render — оркестрация рендера/лога, остаётся в монолите.
     • passiveSkillTiers — кросс-доменная функция, пока в монолите рядом
       со скилл-хелперами (см. core/skills.js).

   Где править: правила «иммунитет к X», «множитель Y» — в одном if внутри
     computeIncomingDamage. Новый источник пассивного урона по событию —
     добавить ветку в triggerOnDealDamagePassives + apply-хелпер в effects.js.
     Изменение поведения смерти (анимация, лут, какие триггеры) — в
     applyDamage и/или scheduleDeathCleanup.

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   Все объявления попадают в глобальный scope window.

   Тонкость с порядком загрузки. applyDamage вызывает scheduleDeathCleanup
   и log из inline; triggerOnDealDamagePassives вызывает passiveSkillTiers
   и applyCorpsePoison из inline. Имена резолвятся в момент ВЫЗОВА —
   к моменту первого реального удара (атака игрока, фаербол, тик DoT)
   inline-блок уже выполнен и все эти глобалы существуют. Тот же приём,
   что в weapons.js / skills.js / ai.js / stats-calc.js.
*/

/* ================================================================
   === МОДИФИКАТОРЫ УРОНА ПО ТИПУ ЦЕЛИ ============================
   Задумано как ОДНА точка, через которую считается итоговый урон с
   учётом unitType цели и damageType входящего удара. Позволяет
   держать правила «нежить горит от святого», «механизмы не травятся»
   и т.п. в одном месте, не размазывая их по местам каста.

   Текущие правила:
   - Иммунитет к яду: unitType ∈ {mechanism, undead, elemental} →
     любой урон с damageType='poison' обнуляется (и эффект отравления
     не накладывается — см. isImmuneToPoison ниже).
   - Святой множитель: unitType ∈ {undead, demon} → урон 'holy'
     умножается на 1.5 (округление вниз).

   Возвращает финальный урон, уже после крита (множитель крита
   применяется ДО этой функции — крит считается общим для каста, а
   не на цель). Логи в исполнителях должны печатать ИМЕННО это число,
   чтобы игрок видел согласованную картину «в логе и по полоске HP
   произошло одно и то же». Когда модификатор сработал — возвращаем
   ещё и человекочитаемую пометку, чтобы её можно было дописать в лог. */
/* Сессия 17: переписана как ТРИ ПОСЛЕДОВАТЕЛЬНЫЕ ФАЗЫ.

     Фаза 1 — безусловные снижения (не имеют ресурса/счётчика).
              Сейчас: fire_shield reduction (для fire/frost).
     Фаза 2 — расходуемые щиты (имеют счётчик «прочности», уменьшающийся за акт).
              Сейчас: armored. Расход charges МУТИРУЕТ эффект на цели.
     Фаза 3 — резистенции/иммунитеты по damageType.
              Сейчас: poison immune, holy ×1.5.

   damageType:'special' — short-circuit. Игнорирует все три фазы;
   возвращает max(1, raw) — голый урон, обходит любые защиты. Это
   маркер для будущих скиллов и финальных боссов.

   Минимум 1 урона действует только если incoming до пола был > 0.
   Если фаза 2 (armored) ПОЛНОСТЬЮ поглотила удар или фаза 3 дала
   иммунитет — это НОЛЬ, не один (логика: «минимум 1, если ты вообще
   получаешь урон; иммунитет — ты не получаешь»).

   ВАЖНО про не-pure: фаза 2 МУТИРУЕТ эффект armored на цели (расход
   charges). Это осознанное отступление от принципа pure-функций — иначе
   пришлось бы выносить расход в отдельную точку (applyDamageToTarget),
   что требует миграции всех существующих executeXxx. Прагматичное
   решение: caller вызывает computeIncomingDamage один раз на инстанс
   урона, charges расходуются один раз. Если в будущем появится источник
   урона, обходящий computeIncomingDamage (например, прямой `hp -= 5`),
   armored у него не сработает — это явное условие. */
function computeIncomingDamage(target, dmg, damageType, opts) {
  if (!target || !damageType) return { dmg, note: null };

  // Спец-урон: обход всех фаз. Минимум 1 если raw > 0.
  if (damageType === 'special') {
    return { dmg: Math.max(1, dmg), note: 'спец-урон (обход защит)' };
  }

  // Сессия 19: opts.isDoTTick — caller (DoT-эффекты burning/poisoned)
  // помечает, что урон приходит как тик, а не как обычный удар. Используется
  // пассивкой «Стойкость» (endurance) в фазе 1.4: снижение применяется
  // только к тикам.
  const isDoTTick = !!(opts && opts.isDoTTick);

  let incoming = dmg;
  const notes = [];

  // === Фаза 1: безусловные снижения =================================
  // 1.1 fire_shield reduction для fire/frost (см. applyFireShield в effects.js).
  if ((damageType === 'fire' || damageType === 'frost')
      && Array.isArray(target.effects) && incoming > 0) {
    const sh = target.effects.find(e => e && e.id === 'fire_shield');
    if (sh && Number.isFinite(sh.damageReduction) && sh.damageReduction > 0) {
      const before = incoming;
      incoming = Math.max(1, incoming - sh.damageReduction);
      const reduced = before - incoming;
      if (reduced > 0) notes.push(`огненный щит −${reduced}`);
    }
  }
  // 1.2 shield_block (Сессия 18) — для ЛЮБОГО damageType (special уже
  // отсёк short-circuit выше). Снижает на damageReduction, минимум 1
  // на этой фазе (тот же закон что у fire_shield: фаза 1 не обнуляет
  // удар; полное обнуление — только armored или иммунитет).
  if (Array.isArray(target.effects) && incoming > 0) {
    const sb = target.effects.find(e => e && e.id === 'shield_block');
    if (sb && Number.isFinite(sb.damageReduction) && sb.damageReduction > 0) {
      const before = incoming;
      incoming = Math.max(1, incoming - sb.damageReduction);
      const reduced = before - incoming;
      if (reduced > 0) notes.push(`блок щитом −${reduced}`);
    }
  }
  // 1.3 reinforcement (Сессия 19) — пассивка воина «Укрепление». Эффект
  // `reinforcement` копит stacks на цели через triggerOnTakeDamagePassives
  // (см. applyReinforcementStack). Здесь сtaki снижают входящий урон
  // ОСОБЫМ правилом: max(0, incoming - stacks) — может ОБНУЛИТЬ удар
  // (нарастающая упругость плоти; обычный пол «минимум 1» не действует).
  if (Array.isArray(target.effects) && incoming > 0) {
    const rf = target.effects.find(e => e && e.id === 'reinforcement');
    if (rf && Number.isFinite(rf.stacks) && rf.stacks > 0) {
      const before = incoming;
      // Баланс 04.05.2026: пол 1, как у fire_shield/shield_block
      // (раньше был max(0, ...), могла обнулить полностью). Игрок
      // сказал: «укрепление, как и бронированность, не может снизить
      // урон ниже 1». Endurance (1.4) остаётся max(0, ...) — это
      // принципиально другой случай (DoT-тики, не обычные удары).
      incoming = Math.max(1, incoming - rf.stacks);
      const reduced = before - incoming;
      if (reduced > 0) notes.push(`укрепление −${reduced}`);
    }
  }
  // 1.4 endurance (Сессия 19) — пассивка воина «Стойкость». Срабатывает
  // ТОЛЬКО на DoT-тики (caller передал opts.isDoTTick:true). Снижает
  // на reduction (2/4/6 по тиру), max(0, ...) — может полностью
  // обнулить тик. Если не DoT-тик — ветка пропускается.
  if (isDoTTick && incoming > 0
      && CLASSES[target.classId]
      && typeof passiveSkillsOf === 'function') {
    const sids = passiveSkillsOf(target);
    if (Array.isArray(sids) && sids.includes('endurance')) {
      const tier = (typeof getPassiveSkillTier === 'function')
        ? getPassiveSkillTier(target, 'endurance')
        : 'basic';
      const skill = SKILLS && SKILLS.endurance;
      const td = skill && skill.tiers && skill.tiers[tier];
      const reduction = (td && (td.reduction | 0)) || 0;
      if (reduction > 0) {
        const before = incoming;
        incoming = Math.max(0, incoming - reduction);
        const reduced = before - incoming;
        if (reduced > 0) notes.push(`стойкость −${reduced}`);
      }
    }
  }
  // 1.5 armorFlat (С4-предметы 08.05.2026) — флэт-снижение от надетой
  // брони. Только для damageType:'physical'. Магия, огонь, мороз,
  // электричество, яд, святой — броню обходят. Источник armorFlat —
  // запись ARMORS (для базовой надетой брони с id-string) либо инстанс
  // предмета в слоте armor (после S6-генератора). Логика чтения —
  // armorFlatOf(unit) ниже. Пол 1, как у shield_block/reinforcement
  // (полное обнуление через броню недоступно — броня не может
  // превратить удар в «промах»).
  if (damageType === 'physical' && incoming > 0 && !isDoTTick
      && typeof armorFlatOf === 'function') {
    const af = armorFlatOf(target);
    if (af > 0) {
      const before = incoming;
      incoming = Math.max(1, incoming - af);
      const reduced = before - incoming;
      if (reduced > 0) notes.push(`броня −${reduced}`);
    }
  }
  // 1.6 bony (09.05.2026) — пассивка скелетов «Костлявый». Снижает
  // входящий урон ОТ АТАК С delivery:'ranged' (стрелы, магические
  // дротики и т.п.) на reduction% по тиру (basic 30 / adv 35 / elite 40).
  // Применяется ПОСЛЕ flat-снижений фазы 1, потом ceil-floor с полом 1.
  // Не действует на melee (мечи/когти), aoe (фаербол), special.
  // Источник opts.delivery — caller-функция (executeAttack использует
  // weapon.delivery, executeXxx-скиллы — params.delivery). Если caller
  // не передал delivery — bony не сработает (legacy-pathи таким способом
  // явно отключаются от пассивки). Не trigger'ится — статический модификатор.
  if (incoming > 0 && !isDoTTick && opts && opts.delivery === 'ranged'
      && CLASSES[target.classId] && typeof passiveSkillsOf === 'function') {
    const sids = passiveSkillsOf(target);
    if (Array.isArray(sids) && sids.includes('bony')) {
      const tier = (typeof getPassiveSkillTier === 'function')
        ? getPassiveSkillTier(target, 'bony')
        : 'basic';
      const skill = SKILLS && SKILLS.bony;
      const td = skill && skill.tiers && skill.tiers[tier];
      const pct = (td && (td.reduction | 0)) || 0;
      if (pct > 0) {
        const before = incoming;
        incoming = Math.max(1, Math.floor(before * (100 - pct) / 100));
        const reduced = before - incoming;
        if (reduced > 0) notes.push(`костлявый −${reduced} (${pct}%)`);
      }
    }
  }
  // 1.8 ghostly (Сессия Призрак, 12.05.2026) — пассивка Призрака
  // «Призрачность». Снижает входящий ФИЗИЧЕСКИЙ урон на reduction%
  // (по дизайну 60%, фиксированно для всех тиров; баланс 12.05.2026 —
  // было 80%, снижено по запросу заказчика). Применяется ВМЕСТЕ с
  // evil_slayer/bony как очередной % модификатор — порядок здесь не
  // влияет на итог (все они мультипликативные на incoming). Не
  // действует на магию, огонь, мороз, электричество, святой, яд —
  // особенность природы плоти призрака.
  // !isDoTTick: на DoT-тики не действует (тики не имеют delivery, а
  // DoT-физики у нас пока нет; фильтр оставлен симметрично bony/evil_slayer).
  // Пол 1 — обнулить удар физическая защита не может (минимум 1, как у
  // shield_block/bony). Не trigger'ится — статический модификатор.
  if (damageType === 'physical' && incoming > 0 && !isDoTTick
      && CLASSES[target.classId] && typeof passiveSkillsOf === 'function') {
    const sids = passiveSkillsOf(target);
    if (Array.isArray(sids) && sids.includes('ghostly')) {
      const tier = (typeof getPassiveSkillTier === 'function')
        ? getPassiveSkillTier(target, 'ghostly')
        : 'basic';
      const skill = SKILLS && SKILLS.ghostly;
      const td = skill && skill.tiers && skill.tiers[tier];
      const pct = (td && (td.reduction | 0)) || 0;
      if (pct > 0) {
        const before = incoming;
        incoming = Math.max(1, Math.floor(before * (100 - pct) / 100));
        const reduced = before - incoming;
        if (reduced > 0) notes.push(`призрачность −${reduced} (${pct}%)`);
      }
    }
  }
  // 1.7 evil_slayer (Camp v1.5-priest-B, 10.05.2026) — пассивка священника
  // «Истребитель зла». Снижает входящий урон от АТАК undead/demon на N%.
  // Источник определяется через opts.source (caller передаёт unit).
  // Если source неизвестен (например, DoT от висящего эффекта без autora) —
  // ветка пропускается. Применяется ПОСЛЕ flat-снижений и bony, чтобы
  // композиции работали логично.
  if (incoming > 0 && opts && opts.source && CLASSES[target.classId]
      && typeof passiveSkillsOf === 'function') {
    const sids = passiveSkillsOf(target);
    if (Array.isArray(sids) && sids.includes('evil_slayer')) {
      const sourceCls = CLASSES[opts.source.classId];
      const sourceUt = sourceCls && sourceCls.unitType;
      if (sourceUt === 'undead' || sourceUt === 'demon') {
        const tier = (typeof getPassiveSkillTier === 'function')
          ? getPassiveSkillTier(target, 'evil_slayer')
          : 'basic';
        const skill = SKILLS && SKILLS.evil_slayer;
        const td = skill && skill.tiers && skill.tiers[tier];
        const pct = (td && (td.reductionPercent | 0)) || 0;
        if (pct > 0) {
          const before = incoming;
          incoming = Math.max(1, Math.floor(before * (100 - pct) / 100));
          const reduced = before - incoming;
          if (reduced > 0) notes.push(`истребитель зла −${reduced} (${pct}%)`);
        }
      }
    }
  }

  // === Фаза 2: расходуемые щиты (armored) ===========================
  // armored поглощает урон 1-в-1 за счёт charges. Если incoming > 0:
  //   absorbed = min(incoming, charges)
  //   incoming -= absorbed
  //   charges  -= absorbed   (МУТАЦИЯ эффекта)
  //   charges == 0 → эффект удаляется
  // Если incoming === 0 — armored НЕ трогается (заряды не тратятся
  // впустую). По решению пользователя: если фаза 3 (резистенции)
  // полностью обнулила бы урон, фаза 2 всё равно отрабатывает первой
  // и тратит заряды — «доспеху не важно, что под ним иммунно».
  if (incoming > 0 && Array.isArray(target.effects)) {
    const arm = target.effects.find(e => e && e.id === 'armored');
    if (arm && Number.isFinite(arm.charges) && arm.charges > 0) {
      // Баланс 04.05.2026 (вторая итерация): механика «1 заряд = 1
      // получение урона». Текущее число зарядов вычитается из
      // входящего удара ОДНИМ актом, после чего расходуется ровно
      // 1 заряд (независимо от величины снижения). Пол 1 — броня не
      // обнуляет удар.
      // Пример: 5 зарядов, удары 10/10/10/10/10 → 5/6/7/8/9 урона,
      // charges 4/3/2/1/0 (после 5-го удара эффект снят).
      const reduction = Math.min(arm.charges, incoming - 1);
      if (reduction > 0) {
        incoming -= reduction;
      }
      // Один заряд уходит ВСЕГДА, даже если reduction оказался 0
      // (например, входящий урон = 1: вычитать нечего, но «попытка
      // защиты» состоялась). Так у игрока есть предсказуемый счётчик
      // оставшейся брони, который убывает за каждый получаемый удар.
      arm.charges -= 1;
      notes.push(reduction > 0
        ? `броня −${reduction} (заряд расходован, осталось ${arm.charges})`
        : `заряд брони расходован (осталось ${arm.charges})`);
      if (arm.charges <= 0) {
        const idx = target.effects.indexOf(arm);
        if (idx >= 0) target.effects.splice(idx, 1);
        notes[notes.length - 1] = 'броня разрушена';
      }
    }
  }

  // === Фаза 3: резистенции/иммунитеты по damageType =================
  const cls = CLASSES[target.classId];
  const ut = cls && cls.unitType;
  if (damageType === 'poison' && (ut === 'mechanism' || ut === 'undead' || ut === 'elemental')) {
    return { dmg: 0, note: notes.length ? (notes.join(', ') + ', иммунитет к яду') : 'иммунитет к яду' };
  }
  if (damageType === 'holy' && (ut === 'undead' || ut === 'demon')) {
    incoming = Math.floor(incoming * 1.5);
    notes.push('святой ×1.5');
  }

  // === Финальная фаза: holy_shield damage cap (Camp v1.5-priest-B, 10.05.2026) ===
  // «Священная броня» — buff с damageCap=1. Жёстко кэпает финальный урон,
  // ПОСЛЕ всех снижений и резистов. Действует на любой тип урона, кроме
  // special (special уже шорт-сёркьютнут в начале функции). DoT-тики
  // тоже капаются — это корректно по дизайну («святая защита от урона»,
  // не только от прямых атак).
  if (incoming > 0 && Array.isArray(target.effects)) {
    const sh = target.effects.find(e => e && e.id === 'holy_shield_buff');
    if (sh && Number.isFinite(sh.damageCap)) {
      const cap = sh.damageCap | 0;
      if (incoming > cap) {
        const before = incoming;
        incoming = cap;
        notes.push(`святая броня: ${before}→${cap}`);
      }
    }
  }
  return { dmg: incoming, note: notes.length ? notes.join(', ') : null };
}

/* Иммунитет к ЭФФЕКТУ отравления (а не к урону типа poison). Используется
   на стороне накладывающих эффект функций (applyCorpsePoison, applyPoisoned),
   чтобы иммунный юнит не получал даже сам статус — иначе в его панели
   висел бы бесполезный «Отравлен», который ничего не делает. Список
   иммунных типов совпадает со списком из computeIncomingDamage(poison). */
function isImmuneToPoison(target) {
  if (!target) return false;
  const cls = CLASSES[target.classId];
  const ut = cls && cls.unitType;
  return ut === 'mechanism' || ut === 'undead' || ut === 'elemental';
}

/* Иммунитет цели к КОНКРЕТНОМУ типу урона. Используется на стороне
   режимов прицеливания активных скиллов (computeRangedTargets в
   core/combat.js): если цель иммунна к damageType скилла — её нельзя
   ВЫБРАТЬ как цель (подсветка не включает, клик не проходит). Это
   страховка к computeIncomingDamage, которая обнуляет урон уже после
   применения — дополнительно блокировать каст на иммунную цель нужно
   ради UX (игрок не должен «провалиться» в бесполезный каст с потерей
   маны).

   Сейчас единственное правило — иммунитет к яду у mechanism/undead/
   elemental (через isImmuneToPoison). Для frost/magic/electric/fire/
   holy/physical иммунитетов пока ни у одного класса нет (задел Сессии 9
   и Сессии 17). Когда появятся (через unit.immunities или таблицу по
   unitType) — расширить эту функцию, не правя места вызова. */
function isImmuneToDamageType(target, damageType) {
  if (!target || !damageType) return false;
  if (damageType === 'poison') return isImmuneToPoison(target);
  // frost / magic / electric / fire / holy / physical — пока ни у кого.
  return false;
}

/* ================================================================
   === УРОН И ЭФФЕКТЫ =============================================
   applyDamage(target, dmg, source) — единая точка снятия HP.
   Помимо самого урона делает три вещи:
     1) Если после урона HP ≤ 0 — ставит isDying, планирует превращение
        в надгробие, пишет лог смерти.
     2) Запускает пассивные «onDealDamage»-способности у source,
        если source — юнит и target — его противник (team != source.team).
     3) При снижении maxHp/maxMana через эффекты ничего не делает —
        это ответственность той функции, которая меняет эффекты
        (applyEffect), не урона.

   ВАЖНО: applyDamage принимает уже ПОДГОТОВЛЕННЫЙ урон с учётом
   типов (см. computeIncomingDamage). Это сделано осознанно — исполнители
   (executeAttack/executeFireball/DoT-эффекты) и без того знают damageType
   и обязаны логировать настоящее число. Если бы applyDamage сама лезла
   в типы, лог и реальный урон могли бы разойтись.
   ================================================================ */
function applyDamage(target, dmg, source) {
  if (typeof DebugLog !== 'undefined') DebugLog.log('combat', 'applyDamage', { targetId: target && target.id, dmg, sourceId: source && source.id, hpBefore: target && target.hp });
  if (!target || !target.alive) return;
  // С21+: пробуждение спящего NPC при получении урона от живого
  // вражеского источника. Закрывает дыру с дальнобойными атаками из-за
  // пределов aggroRadius (Дальний выстрел и пр.). DoT-тики (source=null)
  // и friendly fire не будят. Делегировано в core/aggro.js → wakeOnDamage,
  // чтобы вся aggro-логика лежала в одном месте.
  if (dmg > 0 && typeof wakeOnDamage === 'function') {
    wakeOnDamage(target, source);
  }
  // Сессия 19: пассивы «получил урон» (reinforcement) — ДО отнимания HP,
  // только если урон реально пройдёт (dmg > 0). Триггер не зависит от
  // источника (source может быть null для DoT-тиков), потому что
  // «накопить стак» — реакция тела на любое попадание.
  if (dmg > 0 && typeof triggerOnTakeDamagePassives === 'function') {
    triggerOnTakeDamagePassives(target, source);
  }
  target.hp -= dmg;
  // Пассивы носителя-источника — срабатывают ДО фиксирования смерти,
  // потому что даже если добиваем противника, «укус ядом» уже случился.
  // Порядок не важен: эффект всё равно доживёт только до конца хода
  // источника или цели (у трупного яда длительность 1 = один ход цели).
  if (source && source.alive && source.team !== target.team) {
    triggerOnDealDamagePassives(source, target);
  }
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.isDying = true;
    log(`${CLASSES[target.classId].name} (${target.team}) повержен`, 'death');
    scheduleDeathCleanup(target);
  }
}

/* Для каждой пассивки носителя с триггером onDealDamage — применяем её
   эффект на цель. Сейчас реализован только corpse_poison. */
function triggerOnDealDamagePassives(source, target) {
  const cls = CLASSES[source.classId];
  if (!cls || !cls.passiveSkills) return;
  const tiers = passiveSkillTiers(source.classId, source.level);
  for (const sid of cls.passiveSkills) {
    const skill = SKILLS[sid];
    if (!skill || skill.trigger !== 'onDealDamage') continue;
    const tier = tiers[sid] || 'basic';
    if (sid === 'corpse_poison') {
      applyCorpsePoison(target, tier);
    }
    if (sid === 'joint_hunt') {
      // Стаки добавляются ПОСЛЕ нанесения урона (вызов идёт уже после
      // applyDamage в applyDamage-pipeline). По тиру:
      //   basic    +1 стак,
      //   advanced +2 стака,
      //   elite    +3 стака.
      const tierData = SKILLS.joint_hunt && SKILLS.joint_hunt.tiers && SKILLS.joint_hunt.tiers[tier];
      const gain = tierData && Number.isFinite(tierData.stacksGain) ? tierData.stacksGain : 1;
      if (typeof applyJointHuntStack === 'function') {
        applyJointHuntStack(target, gain);
      }
    }
  }
}
