/* skill-tooltip.js (render/) — общий построитель статичного тултипа
   скилла (без runtime-условий: cooldown, мана-нехватка, used-флаги
   и т.п.). Результат — многострочная строка для атрибута title (или
   для будущего HTML-тултипа).

   Зачем существует:
     В UI окошка прокачки (render/render-level-up.js) при выборе
     нового скилла или его улучшения нужно показать конкретные
     цифры — урон, дальность, эффекты, длительность — а не только
     flavor. Логика «что показать про скилл в данном тире» уже была
     в render-panel.js (тултип слота на нижней панели), но там она
     переплетена с runtime-условиями (cooldowns, used-флаги). Здесь —
     чистая, статичная версия: сколько мана/CD/урон/эффект для
     данного skillId+tier с учётом эффективных статов юнита.

   Контракт:
     buildSkillTooltipText(skillId, tier, unit) → string
       skillId: id из SKILLS.
       tier: 'basic' | 'advanced' | 'elite'.
       unit: для калькуляции урона по формуле (effectiveStats).
       Возвращает многострочную строку с \n. Если SKILLS[skillId]
       нет или тир не определён — короткая защитная строка.

     buildSkillUpgradeTooltipText(skillId, fromTier, toTier, unit) → string
       Сравнительный тултип: «Сейчас (тирX): ...» + пустая строка +
       «После апа (тирY): ...». Используется в окне улучшения.

   Что НЕ делает:
     • Не учитывает unit.cooldowns/usedThisWave/mana (это runtime
       состояния — не имеют смысла для preview апа).
     • Не показывает «Бьёт союзников» / «Можно использовать раз за волну»
       и пр. условия — оставлены caller'у render-panel при необходимости.
     • Не повторяет пассивные эффекты юнита (статы/бонусы) — они в
       секции «Характеристики» панели.
     • Для пассивных скиллов выводит компактное описание (имя · тир,
       flavor). Цифры пассивок специфичны для каждого id — пока
       не расписываем (низкий приоритет; можно добавить позже под
       конкретные пассивы).

   Подключается через <script src> в index.html в render/-секции.
   Глобал window.buildSkillTooltipText / window.buildSkillUpgradeTooltipText.

   Используется:
     • render-level-up.js — тултипы карточек выбора нового скилла /
       улучшения тира.
     В будущем: render-panel.js может звать его как «статичную часть»,
     а сверху добавлять runtime-условия. Сейчас — отдельные коды
     (умышленный дубликат на время приоритета). */

(function () {
  'use strict';

  const TIER_LABELS = { basic: 'Базовый', advanced: 'Продвинутый', elite: 'Элитный' };

  function tierLabel(t) { return TIER_LABELS[t] || t; }

  /* Собирает массив строк описания активного скилла в данном тире.
     Каждая строка — одна логическая фраза («Мана: X», «Урон: Y», ...).
     Возвращает массив; склейку через \n делает caller. */
  function buildActiveSkillLines(skill, tier, unit) {
    const lines = [];
    const params = (typeof effectiveSkillParams === 'function')
      ? effectiveSkillParams(skill, tier)
      : { ...skill, ...(skill.tiers && skill.tiers[tier] || {}) };

    // Tier-specific flavor (если есть) перебивает общий.
    const tierFlavor = (skill.tiers && skill.tiers[tier] && skill.tiers[tier].flavor) || null;
    const flavor = tierFlavor || skill.flavor || skill.description;
    if (flavor) lines.push(flavor);

    // Сухая статистика: Мана · CD · Дальность · Область.
    const statParts = [];
    if (typeof params.manaCost === 'number' && params.manaCost > 0) {
      statParts.push(`Мана: ${params.manaCost}`);
    }
    if (typeof params.cooldown === 'number' && params.cooldown > 0) {
      statParts.push(`Перезарядка: ${params.cooldown} ход(ов)`);
    }
    if (typeof params.range === 'number' && params.range > 0) {
      statParts.push(`Дальность: ${params.range} кл.`);
    }
    if (params.area && typeof params.area.size === 'number') {
      statParts.push(`Область: ${params.area.size}×${params.area.size} клеток`);
    }
    if (statParts.length) lines.push(statParts.join(' · '));

    // Тип урона (если delivery+damageType заданы и это не self_buff,
    // teleport, cleanse, grave_target — у этих delivery нет «атаки»,
    // строка "Тип" игроку ни о чём не говорит и только засоряет тултип).
    const _isAttackDelivery = (d) => d !== 'self_buff' && d !== 'teleport'
      && d !== 'cleanse' && d !== 'grave_target' && d !== 'self_aoe';
    if (params.delivery && params.damageType && _isAttackDelivery(params.delivery)
        && typeof describeDamage === 'function') {
      lines.push(`Тип: ${describeDamage(params.delivery, params.damageType)}`);
    }

    // Формула урона.
    const isAoe = params.delivery === 'aoe';
    const critOnAreaSuffix = isAoe ? ' (×2 на всю область)' : '';
    const targetClause = isAoe ? ' каждой цели в области' : ' целью';
    if (params.formula && unit && typeof effectiveStats === 'function'
        && typeof calcFormulaDamage === 'function' && typeof describeFormula === 'function') {
      const stats = effectiveStats(unit);
      const baseDmg = calcFormulaDamage(params.formula, stats);
      lines.push(`Формула: ${describeFormula(params.formula)}`);
      lines.push(`Урон: ${baseDmg}${params.canCrit ? ` · крит ${baseDmg * 2}${critOnAreaSuffix}` : ''}${targetClause}`);
    } else if (typeof params.damage === 'number') {
      lines.push(`Урон: ${params.damage}${params.canCrit ? ` · крит ${params.damage * 2}${critOnAreaSuffix}` : ''}${targetClause}`);
    }

    // Линия (lightning), отскоки (chain_lightning), страйки (prismatic_sphere).
    if (typeof params.lineLength === 'number') {
      lines.push(`Линия: ${params.lineLength} кл. от прицела «от мага»`);
    }
    if (typeof params.bounceCount === 'number') {
      lines.push(`Отскоки: до ${params.bounceCount} (по ближайшим врагам в радиусе 3)`);
    }
    if (Array.isArray(params.strikes) && params.strikes.length) {
      const labels = params.strikes.map(s => {
        const t = (typeof DAMAGE_TYPES === 'object') ? DAMAGE_TYPES[s] : null;
        return (t && t.short) || (t && t.label) || s;
      });
      lines.push(`Удары: ${params.strikes.length} (${labels.join(' → ')})`);
    }

    // Снижение урона (fire_shield, shield_block, fortify_armor).
    // У объектов SKILLS поле `id` не выставлено — id это ключ объекта,
    // поэтому сравниваем по референсу (skill === SKILLS.fire_shield).
    if (typeof params.damageReduction === 'number' && params.damageReduction > 0) {
      const scope = (skill === SKILLS.fire_shield)
        ? 'входящего огненного и ледяного урона'
        : 'входящего урона';
      lines.push(`Снижение ${scope}: −${params.damageReduction} (но не ниже 1)`);
    }
    // Camp v1.5 (09.05.2026): ответный урон Огненного щита.
    // retaliateDmg = retaliateBase + ⌊Wis/3⌋, фиксируется при наложении
    // (см. executeFireShield). Для предпросмотра берём эффективную Wis
    // юнита, как это делает render-panel.js. Если unit не передан —
    // выводим формулу без подстановки.
    if (skill === SKILLS.fire_shield && typeof params.retaliateBase === 'number') {
      if (unit && typeof effectiveStats === 'function') {
        const wis = effectiveStats(unit).wis | 0;
        const ret = (params.retaliateBase | 0) + Math.floor(wis / 3);
        lines.push(`Ответка по атакующему в ближнем бою: ${ret} огня (${params.retaliateBase | 0} + ⌊${wis}/3⌋)`);
      } else {
        lines.push(`Ответка по атакующему в ближнем бою: ${params.retaliateBase | 0} + ⌊Мудрость/3⌋ огня`);
      }
    }

    // Дальность рывка (charge): тиры различаются ТОЛЬКО rangeMul, в общей
    // строке статистики дальность не показывается (range у charge не задан).
    // Без этой ветки тултипы basic/advanced/elite выглядели одинаково.
    // Формула: Math.max(1, Math.ceil(moveRangeOf(unit) × rangeMul)) — та же,
    // что в core/combat.js → chargeRange. Не используем chargeRange напрямую,
    // потому что та считает по уже-выученному тиру юнита, а нам нужен
    // ПРЕДПРОСМОТР для ДРУГОГО тира (например, перед апом basic→advanced).
    if (typeof params.rangeMul === 'number' && skill === SKILLS.charge) {
      if (unit && typeof moveRangeOf === 'function') {
        const mr = moveRangeOf(unit);
        const rng = Math.max(1, Math.ceil(mr * params.rangeMul));
        lines.push(`Дальность рывка: ${rng} кл. (⌈движение ${mr} × ${params.rangeMul}⌉)`);
      } else {
        lines.push(`Дальность рывка: ⌈движение × ${params.rangeMul}⌉`);
      }
    }

    // Длительности баффов.
    if (typeof params.duration === 'number' && params.duration > 0
        && skill !== SKILLS.shield_block) {
      // shield_block истекает по 'expiresAt:turnStart', не по duration —
      // ему отдельная подпись (см. ниже). Остальным длительность нужна.
      // Применяем только если у тира есть duration напрямую (mana_focus,
      // fire_shield и пр.).
      if (params.delivery === 'self_buff' || skill === SKILLS.fire_shield || skill === SKILLS.mana_focus) {
        lines.push(`Действует ${params.duration} ход(а)`);
      }
    }

    // mana_focus — специфика бонуса.
    if (skill === SKILLS.mana_focus && typeof params.wisBonus === 'number' && params.wisBonus > 0) {
      lines.push(`Бонус: Мудрость +${params.wisBonus}`);
    }

    // healPct (second_wind).
    if (typeof params.healPct === 'number' && params.healPct > 0) {
      const pct = Math.round(params.healPct * 100);
      if (unit && typeof maxHpOf === 'function') {
        const heal = Math.ceil(maxHpOf(unit) * params.healPct);
        lines.push(`Лечение: ${heal} HP (${pct}% от максимума)`);
      } else {
        lines.push(`Лечение: ${pct}% от максимума HP`);
      }
      if (params.onceWave) lines.push('Можно использовать один раз за битву');
    }

    // charges (fortify_armor).
    if (typeof params.charges === 'number' && params.charges > 0
        && skill === SKILLS.fortify_armor) {
      lines.push(`Заряды брони: ${params.charges}`);
    }

    // damageMul (whirlwind) — считаем конкретный урон через текущее
    // оружие юнита, как это делает render-panel.js. Без расчёта тиры
    // basic/advanced/elite показывали бы одну и ту же абстрактную
    // строку, и игрок не видел разницы между mul=0.5 и mul=1.0.
    if (typeof params.damageMul === 'number' && skill === SKILLS.whirlwind) {
      if (unit && typeof getUnitWeapon === 'function' && typeof weaponDamage === 'function'
          && typeof effectiveStats === 'function') {
        const w = getUnitWeapon(unit);
        if (w) {
          const baseDmg = weaponDamage(w, effectiveStats(unit), unit);
          const perTarget = Math.max(1, Math.floor(baseDmg * params.damageMul));
          lines.push(`Урон по каждой цели: ${perTarget} (⌊${baseDmg} (оружие) × ${params.damageMul}⌋, минимум 1)`);
        } else {
          lines.push(`Урон по каждой цели: ⌊оружие × ${params.damageMul}⌋ (минимум 1)`);
        }
      } else {
        lines.push(`Урон по каждой цели: ⌊оружие × ${params.damageMul}⌋ (минимум 1)`);
      }
    }

    // Общие условия активации (без runtime: только декларативные).
    if (params.requireUnusedAttack) lines.push('Условие: уже использована обычная атака');
    if (params.requireUnusedMove) lines.push('Условие: не использовано движение в этом ходу');
    if (params.consumesMove) lines.push('Эффект: расходует движение в этом ходу');
    if (params.applySelfBuff === 'second_attack_buff') {
      lines.push('Бонус: Сила +6, Удача +6 на следующую атаку');
    }
    if (params.applySelfBuff === 'second_shot_buff') {
      lines.push('Бонус: Ловкость +6, Удача +6 на следующую атаку');
    }

    // poison_arrow / fire_arrow — duration на следующей атаке.
    if (skill === SKILLS.poison_arrow && typeof params.poisonDuration === 'number') {
      lines.push(`Эффект на цели: «Отравлен» на ${params.poisonDuration} ход.`);
      lines.push('Накладывается на следующую атаку лучника');
    }
    if (skill === SKILLS.fire_arrow && typeof params.burnDuration === 'number') {
      lines.push(`Эффект на цели: «Горит» на ${params.burnDuration} ход.`);
      lines.push('Накладывается на следующую атаку лучника');
    }
    if (skill === SKILLS.long_shot && typeof params.weaponRangeBonus === 'number') {
      lines.push(`Бонус: +${params.weaponRangeBonus} к дальности атаки до конца хода`);
    }
    if (skill === SKILLS.trap) {
      if (params.dmgFromDex && unit && typeof effectiveStats === 'function') {
        const dex = effectiveStats(unit).dex || 0;
        const dmg = (params.dmgBase | 0) + Math.floor(dex / 2);
        lines.push(`Урон ловушки: ${dmg} физ. (база ${params.dmgBase | 0} + ⌊${dex}/2⌋)`);
      } else if (typeof params.dmg === 'number') {
        lines.push(`Урон ловушки: ${params.dmg} физ.`);
      }
      lines.push('Эффект на жертве: «Обездвижен» на 2 хода');
    }
    if (skill === SKILLS.lure) {
      if (typeof params.lureRadius === 'number') {
        lines.push(`Радиус действия: ${params.lureRadius} кл.`);
      }
      if (params.applyOnPickup && params.applyOnPickup.id) {
        const names = { poisoned: 'Отравлен', burning: 'Горит', stunned: 'Оглушён', immobilized: 'Обездвижен' };
        const nm = names[params.applyOnPickup.id] || params.applyOnPickup.id;
        lines.push(`Эффект на подобравшего: «${nm}» на ${params.applyOnPickup.duration | 0} ход.`);
      }
    }
    if (skill === SKILLS.cover) {
      lines.push(params.allowEnemies ? 'Цель: любой живой юнит' : 'Цель: только союзник');
      lines.push('Эффект: меняется местами с целью (свап)');
    }
    if (skill === SKILLS.provoke) {
      lines.push('Эффект: на врагов в радиусе — «Спровоцирован»');
    }
    if (skill === SKILLS.shield_block) {
      lines.push('Действует до начала следующего хода');
    }

    // Camouflage: маскировка с разной длительностью по тирам.
    if (skill === SKILLS.camouflage) {
      if (params.expiresAt === 'turnStart') {
        lines.push('Длительность: до начала следующего своего хода');
      } else if (typeof params.duration === 'number') {
        lines.push(`Длительность: ${params.duration} ход(а)`);
      }
      lines.push('Снимается атакой/уроном/движением');
    }

    // Camp v1.5-priest (09.05.2026): конкретные числа скиллов священника.
    // Каждый скилл имеет свои tier-зависимые поля; общая инфра
    // (manaCost/range/duration на self_buff) их частично покрывает,
    // но эффект+формула — сюда.
    if (skill === SKILLS.healing) {
      const baseHeal = (params.healBase | 0);
      if (unit && typeof effectiveStats === 'function') {
        const wis = effectiveStats(unit).wis | 0;
        const total = baseHeal + Math.floor(wis / 2);
        lines.push(`Лечение: ${total} HP (${baseHeal} + ⌊${wis}/2⌋)`);
      } else {
        lines.push(`Лечение: ${baseHeal} + ⌊Мудрость/2⌋ HP`);
      }
      lines.push('Не действует на механизмы');
    }
    if (skill === SKILLS.blessing) {
      const luk = (params.lukDelta | 0);
      const dur = (params.duration | 0);
      lines.push(`На союзника/себя: +${luk} к Удаче на ${dur} ход.`);
      lines.push(`На враждебную нежить/демона: −${luk} к Удаче на ${dur} ход.`);
      lines.push('Враждебных живых/прочих типов цель не выбрать');
    }
    if (skill === SKILLS.purify_touch) {
      lines.push('Снимает с цели все негативные эффекты');
      const immDur = (params.immunityDuration | 0);
      if (immDur > 0) {
        lines.push('Дополнительно: «Святая защита от порчи» — до начала следующего хода цели новые негативные эффекты не задерживаются');
      }
    }
    if (skill === SKILLS.holy_strength) {
      const str = (params.strBonus | 0);
      const stun = (params.stunChance | 0);
      const dur = (params.duration | 0);
      lines.push(`Бонус: +${str} к Силе на ${dur} ход.`);
      lines.push(`При базовой атаке: ${stun}% шанс оглушить нежить/демона на 1 ход.`);
    }
    if (skill === SKILLS.resurrection) {
      const hp = (params.hpPercent | 0);
      const mp = (params.manaPercent | 0);
      lines.push('Цель: надгробие союзного героя в радиусе 1');
      if (hp === 0 && mp === 0) {
        lines.push('Воскрешает с 1 HP и 0 маны');
      } else {
        lines.push(`Воскрешает с ${hp}% maxHP и ${mp}% maxMana`);
      }
      lines.push('Воскрешённый пропускает свой ближайший ход');
    }
    if (skill === SKILLS.holy_shield) {
      const r = (params.range | 0);
      lines.push(`Цель: союзник в радиусе ${r}${params.allowSelf ? ' (можно на себя)' : ''}`);
      lines.push('Эффект: входящий урон ≤ 1 до начала следующего хода цели');
    }
    if (skill === SKILLS.light_wave) {
      const r = (params.range | 0);
      const dur = (params.frightenedDuration | 0) || 1;
      lines.push(`Бьёт всех в радиусе ${r} клеток вокруг кастера`);
      lines.push('Цели: только нежить и демоны (союзники и прочие враги не задеваются)');
      if (unit && typeof effectiveStats === 'function') {
        const wis = effectiveStats(unit).wis | 0;
        const div = (typeof params.wisDivisor === 'number' && params.wisDivisor > 0) ? params.wisDivisor : 2;
        const dmg = (params.damageBase | 0) + Math.floor(wis / div);
        lines.push(`Урон: ${dmg} (${params.damageBase | 0}+⌊${wis}/${div}⌋) каждой цели в области`);
      } else {
        lines.push(`Урон: ${params.damageBase | 0}+⌊Мудрость/${params.wisDivisor}⌋ каждой цели в области`);
      }
      lines.push(`Эффект на цели: «Напуган» на ${dur} ход.`);
    }

    // hitsFriendlies (09.05.2026): фаербол и его аналоги могут задеть
    // союзников и самого кастера, если те окажутся в AoE/линии. Игрок
    // должен видеть это при выборе нового скилла на ап-окне (раньше
    // строка была только в боевом тултипе render-panel.js — баг
    // 09.05.2026: «не виден ответный урон»).
    if (params.hitsFriendlies) {
      if (typeof params.lineLength === 'number') {
        lines.push('Бьёт всех на линии — включая союзников');
      } else if (params.area) {
        lines.push('Бьёт всех в зоне — союзников и самого мага тоже');
      } else {
        lines.push('Бьёт всех в зоне — включая союзников');
      }
    }

    // applyEffect — общий блок (slowed/burning/poisoned/stunned/immobilized).
    if (params.applyEffect && params.applyEffect.id) {
      const effSk = (typeof SKILLS === 'object' && SKILLS) ? SKILLS[params.applyEffect.id] : null;
      const effName = (effSk && effSk.name) || params.applyEffect.id;
      let suffix = '';
      if (typeof params.applyEffect.percent === 'number') {
        suffix = (params.applyEffect.id === 'slowed')
          ? ` (−${params.applyEffect.percent}% Скорости)`
          : ` (−${params.applyEffect.percent}%)`;
      } else if (typeof params.applyEffect.strength === 'number') {
        suffix = ` (сила ${params.applyEffect.strength})`;
      }
      const chanceSuffix = (typeof params.applyEffect.chance === 'number')
        ? ` (${params.applyEffect.chance}% шанс)`
        : '';
      const targetScope = isAoe ? 'каждой цели в области' : 'по цели';
      lines.push(`Эффект: «${effName}»${suffix} на ${params.applyEffect.duration} ход(а) ${targetScope}${chanceSuffix}`);
    }

    return lines;
  }

  /* Пассивные скиллы. Строки тултипа: flavor + tier-зависимые цифры.
     Раньше была только flavor + «(Пассивный навык — действует постоянно)»,
     из-за чего предпросмотр в окне прокачки не показывал бонус (баг
     09.05.2026: marksman при первом изучении скрывал, на сколько именно
     повышается шанс крита). Теперь дописываем числа из skill.tiers[tier]
     по конкретному id — список синхронизирован с боевым тултипом
     (см. render-panel.js → секция «Пассивы»). */
  function buildPassiveSkillLines(skill, tier, unit) {
    const lines = [];
    const tierFlavor = (skill.tiers && skill.tiers[tier] && skill.tiers[tier].flavor) || null;
    const flavor = tierFlavor || skill.flavor || skill.description;
    if (flavor) lines.push(flavor);
    const td = (skill.tiers && skill.tiers[tier]) || {};
    if (skill === SKILLS.marksman) {
      const bonus = (typeof td.bonus === 'number') ? td.bonus : 0;
      lines.push(`Эффект: +${bonus}% к шансу критического удара`);
    } else if (skill === SKILLS.crushing_magic) {
      const mult = (typeof td.mult === 'number') ? td.mult : 1;
      if (unit && typeof effectiveStats === 'function') {
        const wis = effectiveStats(unit).wis | 0;
        const bonus = Math.floor(wis * mult);
        lines.push(`Эффект: +${bonus}% к шансу крита (⌊Мудрость ${wis} × ${mult}⌋)`);
      } else {
        lines.push(`Эффект: +⌊Мудрость × ${mult}⌋% к шансу крита`);
      }
    } else if (skill === SKILLS.mana_regen) {
      const amt = (typeof td.amount === 'number') ? td.amount : 0;
      const cap = (typeof td.capPerWave === 'number') ? td.capPerWave : 0;
      lines.push(`Эффект: +${amt} маны в конце своего хода (не выше maxMana)`);
      lines.push(`Лимит за битву: ${cap} маны`);
    } else if (skill === SKILLS.mana_absorb) {
      const heal = (typeof td.heal === 'number') ? td.heal : 0;
      lines.push(`Эффект: +${heal} HP при любой трате маны (не выше maxHp)`);
    } else if (skill === SKILLS.corpse_poison) {
      const pct = (typeof td.statPercent === 'number') ? td.statPercent : 0;
      const dur = (typeof td.duration === 'number') ? td.duration : 0;
      lines.push(`Эффект на цели после удара: «Трупный яд» на ${dur} ход.`);
      lines.push(`Снижает все статы цели (кроме Удачи) на ${pct}% от базы (округление вверх)`);
    } else if (skill === SKILLS.joint_hunt) {
      const gain = (typeof td.stacksGain === 'number') ? td.stacksGain : 1;
      lines.push(`При ударе: бьёт +N урона, где N = висящих стаков «Совместной охоты» на цели`);
      lines.push(`После удара: накладывает +${gain} стак(а) (стаки делятся пополам в начале хода жертвы)`);
    } else if (skill === SKILLS.wolf_howl) {
      const spd = (typeof td.spdBuff === 'number') ? td.spdBuff : 0;
      lines.push(`В начале своего хода (если активен): пробуждает спящих волков рядом`);
      if (spd > 0) {
        lines.push(`Пробуждённые получают +${spd} к Скорости до конца следующего хода (инициатива пересчитывается)`);
      } else {
        lines.push('Без бонуса к Скорости (только пробуждение)');
      }
    } else if (skill === SKILLS.pack_leader) {
      const r = (typeof td.radius === 'number') ? td.radius : 5;
      const pct = (typeof td.strPercent === 'number') ? td.strPercent : 0;
      lines.push(`Аура: подчинённые волки в радиусе ${r} клеток получают +${pct}% Силы (от базовой)`);
      lines.push('На самого вожака не действует. Спадает при выходе из радиуса или его гибели.');
    } else if (skill === SKILLS.reinforcement) {
      const gain = (typeof td.gainPerHit === 'number') ? td.gainPerHit : 0;
      lines.push(`При получении урона: +${gain} стак «Укрепления» (длится до начала своего хода)`);
      lines.push('Каждый стак снижает входящий урон на 1 (может полностью обнулить)');
    } else if (skill === SKILLS.evil_slayer) {
      const r = (td.reductionPercent | 0);
      const b = (td.bonusPercent | 0);
      lines.push(`Получает на ${r}% меньше урона от нежити и демонов`);
      lines.push(`Наносит на ${b}% больше урона по нежити и демонам`);
    } else if (skill === SKILLS.healing_aura) {
      const h = (td.healAmount | 0);
      lines.push(`В начале своего хода соседние союзники восстанавливают ${h} HP`);
      lines.push('Соседи — 8 клеток вокруг (включая диагональные)');
      lines.push('Не действует на механизмы');
    } else if (skill === SKILLS.endurance) {
      const red = (typeof td.reduction === 'number') ? td.reduction : 0;
      lines.push(`Срабатывает: при каждом тике DoT (Горение, Отравление и т.п.)`);
      lines.push(`Эффект: уменьшает урон тика на ${red} (может полностью обнулить)`);
      lines.push('На обычные удары и AoE НЕ влияет');
    }
    lines.push('(Пассивный навык — действует постоянно)');
    return lines;
  }

  /* Главная экспортируемая функция: один тир. */
  function buildSkillTooltipText(skillId, tier, unit) {
    const sk = (typeof SKILLS === 'object' && SKILLS) ? SKILLS[skillId] : null;
    if (!sk) return String(skillId || '');
    const head = `${sk.name} · тир: ${tierLabel(tier)}`;
    const body = (sk.kind === 'passive')
      ? buildPassiveSkillLines(sk, tier, unit)
      : buildActiveSkillLines(sk, tier, unit);
    return [head].concat(body).join('\n');
  }

  /* Сравнительный тултип для апа: оба тира с разделителями. ВАЖНО:
     кастомный tooltip.js (см. parsePlainTitle) фильтрует пустые строки
     через .filter(Boolean), поэтому пустые '\n' для разделения блоков
     не сработают. Вместо этого используем символьные сепараторы. */
  function buildSkillUpgradeTooltipText(skillId, fromTier, toTier, unit) {
    const sk = (typeof SKILLS === 'object' && SKILLS) ? SKILLS[skillId] : null;
    if (!sk) return String(skillId || '');
    const before = (sk.kind === 'passive')
      ? buildPassiveSkillLines(sk, fromTier, unit)
      : buildActiveSkillLines(sk, fromTier, unit);
    const after = (sk.kind === 'passive')
      ? buildPassiveSkillLines(sk, toTier, unit)
      : buildActiveSkillLines(sk, toTier, unit);
    const out = [];
    out.push(`${sk.name}: ${tierLabel(fromTier)} → ${tierLabel(toTier)}`);
    out.push(`▼ Сейчас (${tierLabel(fromTier)}):`);
    out.push.apply(out, before);
    out.push('─────');
    out.push(`▲ После апа (${tierLabel(toTier)}):`);
    out.push.apply(out, after);
    return out.join('\n');
  }

  // Экспорт.
  window.buildSkillTooltipText = buildSkillTooltipText;
  window.buildSkillUpgradeTooltipText = buildSkillUpgradeTooltipText;
})();
