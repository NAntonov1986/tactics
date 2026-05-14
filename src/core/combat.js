/* combat.js (core/) — выполнение боевых действий: базовая атака и активные
   навыки, способные нанести урон. После R14 здесь живёт всё, что превращает
   намерение «ударить/кастануть» в фактическое изменение HP, статусов и логи.

   Что внутри:
     • computeAttackTargets(unit) — массив живых вражеских юнитов в зоне
       поражения текущего оружия. Дальность — манхэттенская, живые юниты
       и надгробия НЕ блокируют (стрельба «сквозь»).
     • computeAttackArea(unit) — все клетки в зоне досягаемости оружия
       (для подсветки в режиме атаки). Диамант радиусом = weapon.range,
       без клетки самого юнита, отсечённый границами поля.
     • rollCrit(unit) — `Math.random() * 100 < critChanceOf(unit)`. Один
       ролл на одно «ударное событие» (для AoE — один на каст).
     • executeAttack(targetId) — базовая атака активным юнитом по targetId.
       Жёстко проверяет: actionsUsedThisTurn.attack, валидность цели,
       наличие оружия. Считает урон через weaponDamage → крит ×2 →
       computeIncomingDamage (типовые модификаторы цели). Зовёт applyDamage,
       пишет лог, играет анимацию, проверяет checkVictory.
     • computeFireballRange(unit) — клетки, куда МОЖНО прицелить фаербол
       (для подсветки прицела в режиме F). Манхэттенский диамант радиусом
       SKILLS.fireball.range, ограниченный полем.
     • computeFireballAoe(row, col) — 3×3 квадрат вокруг центра (с пометкой
       isCenter: true для центральной клетки). Без отсечения по типу
       содержимого: «куда долетит» — отдельная физика, кому достанется
       урон — решается уже в executeFireball через unitAt.
     • executeFireball(targetRow, targetCol) — каст фаербола активным юнитом.
       Параметры берутся через getUnitSkillParams (учёт ТИРА). Один ролл
       крита на каст, урон по формуле от effectiveStats кастера, потарг.
       computeIncomingDamage (нежить vs огонь и т.п.), applyDamage по AoE,
       статус-эффекты тира (Горение для advanced/elite) — после урона на
       выживших. Дружественный огонь — осознанная механика: бьёт всех
       живых в зоне, включая самого кастера.

   Что НЕ внутри:
     • Режимы прицеливания (enterMode/exitMode) и обработка кликов —
       в монолите, переедут в `ui/input.js` (R18). Combat.js — про
       исполнение, не про намерение.
     • Анимации (playHitAnimation, playFireballBlast) — в монолите,
       переедут в render-кластер (R17). combat.js дёргает их как
       fire-and-forget по имени.
     • Фаза смерти (scheduleDeathCleanup) — в монолите рядом с анимациями.
       applyDamage сам её триггерит.
     • applyDamage / computeIncomingDamage / triggerOnDealDamagePassives —
       это правила НАНЕСЕНИЯ урона, в `core/damage.js` (R11). combat.js
       только зовёт их.
     • applySkillEffectDef / getUnitSkillParams — `core/skills.js` (R12.5).
       combat.js берёт из них «что применять», но не реализует сами эффекты.
     • Хелперы apply*-эффектов (applyBurning и т.п.) — `core/effects.js`
       (R12). combat.js до них не дотягивается напрямую, всё через
       applySkillEffectDef.

   Где править: правила «как считается итоговый урон базовой атаки» —
     `executeAttack` (порядок: weaponDamage → ×2 за крит → типовой
     модификатор цели). Правила фаербола (формула, AoE-форма, дружественный
     огонь, эффект тира) — `executeFireball`. Радиус оружия для подсветки —
     не здесь, а в `weapons.js` (range у оружия) и `computeAttackArea` его
     просто читает. Радиус фаербола — в `data/skills.js` (range у скилла).

   Тонкость с порядком загрузки. combat.js подключается ПОСЛЕ
   `core/movement.js` (нужна `inBounds`, `unitAt`) и до/после `core/ai.js`
   (ai.js статически ссылается на executeAttack, но только в теле функций —
   резолв в момент ВЫЗОВА, не загрузки). На практике безопасный порядок —
   между movement.js и ai.js, чтобы порядок чтения соответствовал смыслу:
   «как ходим → как бьём → как ИИ выбирает между ходить и бить».

   Внешние имена, которые combat.js использует через script-scope
   (резолв при вызове): `state`, `getActiveUnit`, `getUnit` (монолит);
   `getUnitWeapon`, `weaponDamage` (data/weapons.js); `CLASSES` (data/classes.js);
   `SKILLS` (data/skills.js); `inBounds`, `unitAt` (core/movement.js);
   `effectiveStats`, `critChanceOf`, `calcFormulaDamage`,
   `describeFormulaBreakdown` (core/stats-calc.js); `computeIncomingDamage`,
   `applyDamage` (core/damage.js); `canUnitMove` (core/effects.js);
   `getUnitSkillParams`, `applySkillEffectDef`, `triggerOnManaSpent` (core/skills.js);
   `describeDamage` (data/damage-types.js); `log`, `render`, `checkVictory`,
   `playHitAnimation`, `playFireballBlast`, `PreviewState.fireball` (монолит). */

/* ================================================================
   === АТАКА ======================================================
   Цели — враги в пределах дальности базовой атаки класса.
   Дальность считается по правилам движения (ортогональная дистанция,
   но живые юниты её НЕ блокируют — стрелять «сквозь» разрешено).
   Т.е. дальность = |dr| + |dc| (манхэттенское расстояние).
*/
function computeAttackTargets(unit) {
  const w = getUnitWeapon(unit);
  if (!w) return [];
  // Сессия 21: дальность атаки = w.range + statMods.weaponRangeBonus от
  // эффектов носителя (Дальний выстрел). Источник правды — weaponRangeOf
  // в data/weapons.js, единый для боя/AI/UI.
  const range = weaponRangeOf(unit);
  return state.units.filter(u =>
    u.alive && u.team !== unit.team &&
    isTargetInRange(unit, u, range)
  );
}

/* Все клетки, куда юнит МОЖЕТ выстрелить/ударить (зона досягаемости).
   Это диамант манхэттенского радиуса = range, без клетки самого юнита.
   Клетки вне поля отсекаются. Используется для визуала режима атаки. */
function computeAttackArea(unit) {
  const w = getUnitWeapon(unit);
  if (!w) return [];
  // Сессия 21: см. computeAttackTargets — единый источник через weaponRangeOf.
  const range = weaponRangeOf(unit);
  const cells = [];
  for (let dr = -range; dr <= range; dr++) {
    const maxDc = range - Math.abs(dr);
    for (let dc = -maxDc; dc <= maxDc; dc++) {
      if (dr === 0 && dc === 0) continue; // свою клетку не подсвечиваем
      const r = unit.row + dr, c = unit.col + dc;
      if (!inBounds(r, c)) continue;
      cells.push({ row: r, col: c });
    }
  }
  return cells;
}

function rollCrit(unit) {
  // Шанс крита = Удача в процентах (эффективная — с учётом дебаффов).
  return Math.random() * 100 < critChanceOf(unit);
}

function executeAttack(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  if (u.actionsUsedThisTurn.attack) return;
  const target = getUnit(targetId);
  if (!target || !target.alive || target.team === u.team) return;
  const valid = computeAttackTargets(u).some(t => t.id === targetId);
  if (!valid) return;

  const cls = CLASSES[u.classId];
  const weapon = getUnitWeapon(u);
  if (!weapon) return;
  const uStats = effectiveStats(u);
  // С2-предметы: 3-й параметр — юнит, чтобы weaponDamage добавил
  // damage-бонус с аффиксов экипировки (Жестокий/Удара/Беспощадный/...).
  // Этот бонус — ЧАСТЬ базового удара (внутри weaponDamage), поэтому
  // строкой ниже крит удваивает его наравне с базой оружия.
  let dmg = weaponDamage(weapon, uStats, u);
  const crit = rollCrit(u);
  if (crit) dmg *= 2;
  // Бонус «Совместная охота» — фиксированная прибавка к урону, читается
  // только если у атакующего висит пассивка joint_hunt и на цели
  // висят стаки joint_hunt_marks. Считается ПОСЛЕ крита (стаки — пассивный
  // бонус, а не часть «броска оружия», поэтому крит их не удваивает) и
  // ДО computeIncomingDamage (типовые модификаторы цели применяются ко
  // всему урону вместе).
  const jhBonus = (typeof getJointHuntDamageBonus === 'function')
    ? getJointHuntDamageBonus(u, target) : 0;
  if (jhBonus > 0) dmg += jhBonus;
  // Camp v1.5-priest-B (10.05.2026): evil_slayer бонус к ВЫХОДЯЩЕМУ урону
  // у священника по нежити/демонам. Применяем ПОСЛЕ jhBonus (не накапливается
  // с jhBonus как с другими фиксами — jhBonus это статья урона волков, у
  // священника её нет; защитная чистая ветка).
  if (typeof passiveSkillsOf === 'function') {
    const usids = passiveSkillsOf(u);
    if (Array.isArray(usids) && usids.includes('evil_slayer')) {
      const tcls = CLASSES[target.classId];
      const tut = tcls && tcls.unitType;
      if (tut === 'undead' || tut === 'demon') {
        const tier = (typeof getPassiveSkillTier === 'function')
          ? getPassiveSkillTier(u, 'evil_slayer') : 'basic';
        const skill = SKILLS && SKILLS.evil_slayer;
        const td = skill && skill.tiers && skill.tiers[tier];
        const pct = (td && (td.bonusPercent | 0)) || 0;
        if (pct > 0) {
          const before = dmg;
          dmg = Math.floor(before * (100 + pct) / 100);
        }
      }
    }
  }
  // Применяем модификаторы по типу цели (иммунитет к яду, святой ×1.5
  // и т.п.). Делаем это ПОСЛЕ крита: множитель крита = «как точно
  // попали», множитель типа = «как цель относится к этому виду урона».
  const adj = computeIncomingDamage(target, dmg, weapon.damageType, { delivery: weapon.delivery, source: u });
  dmg = adj.dmg;

  // Огненный щит цели (Сессия 14): запоминаем эффект ДО applyDamage,
  // на случай если в будущем смерть цели начнёт сбрасывать эффекты.
  // Сейчас не сбрасывает, но паттерн безопасный. Спека: «На мёртвой
  // цели щит тоже срабатывает (условие — висел ли щит в момент удара)».
  const incomingShield = (weapon.delivery === 'melee' && Array.isArray(target.effects))
    ? target.effects.find(e => e && e.id === 'fire_shield')
    : null;
  const retaliateDmg = (incomingShield && Number.isFinite(incomingShield.retaliateDmg))
    ? incomingShield.retaliateDmg : 0;

  // Сессия 19+ правка 04.05.2026: ЛОГ удара пишется ПЕРЕД applyDamage,
  // потому что внутри applyDamage срабатывает triggerOnTakeDamagePassives
  // (Укрепление: «+1 стак»). Если бы лог удара шёл после, в потоке
  // событий стак появлялся бы раньше самого удара — игрок ожидал бы,
  // что новый стак уже снижает этот урон, а он копится для следующего.
  // Сначала пишем «удар X урона», потом applyDamage с побочными
  // триггерами на цели.
  u.actionsUsedThisTurn.attack = true;
  state.mode = null;

  const dmgDesc = describeDamage(weapon.delivery, weapon.damageType);
  const noteSuffix = adj.note ? ` (${adj.note})` : '';
  if (crit) {
    log(`${cls.name} (${u.team}) атакует ${CLASSES[target.classId].name} (${target.team}) из «${weapon.name}» — КРИТ, ${dmg} ${dmgDesc} урона${noteSuffix}!`, 'crit');
  } else {
    log(`${cls.name} (${u.team}) атакует ${CLASSES[target.classId].name} (${target.team}) из «${weapon.name}» — ${dmg} ${dmgDesc} урона${noteSuffix}`, 'damage');
  }

  applyDamage(target, dmg, u);
  // Camp v1.5-priest (09.05.2026): «Святая сила» — шанс оглушить нежить/демона.
  if (target.alive && Array.isArray(u.effects)) {
    const hs = u.effects.find(e => e && e.id === 'holy_strength_buff');
    if (hs && (hs.stunChance | 0) > 0) {
      const tcls = CLASSES[target.classId] || {};
      if (tcls.unitType === 'undead' || tcls.unitType === 'demon') {
        if (Math.random() * 100 < (hs.stunChance | 0)) {
          if (typeof applyStunned === 'function') {
            applyStunned(target, 1);
            log(`${cls.name} (${u.team}) — «Святая сила»: оглушает ${tcls.name || target.classId} (${target.team})`, 'info');
          }
        }
      }
    }
  }
  // С24: применить эффекты с expiresAt:'nextAttack' (poison_arrow_buff,
  // fire_arrow_buff, second_attack_buff) — снимет их с атакующего и
  // наложит applyOnHit на цель (если она враг и жива). statMods-эффекты
  // (second_attack_buff) уже учтены в weaponDamage(...) выше — здесь
  // только снятие.
  if (typeof consumeNextAttackEffects === 'function') {
    consumeNextAttackEffects(u, target);
  }
  // С23: «Маскировка» снимается с атакующего после фактического удара.
  // Безусловный вызов — если эффекта нет, removeCamouflage делает no-op.
  // Конкретный момент: ПОСЛЕ applyDamage и consumeNextAttackEffects, но
  // ДО ответки fire_shield ниже — атака уже состоялась, удар нанесён,
  // дальше события не должны переписать факт «лучник раскрыл себя».
  if (typeof removeCamouflage === 'function') {
    removeCamouflage(u, 'атака');
  }
  const targetDying = !target.alive;

  // Ответка огненного щита (Сессия 14). Условия:
  //   1) Атака была melee (weapon.delivery === 'melee') — отфильтровано
  //      ещё на стадии вычисления incomingShield.
  //   2) У цели в момент удара висел fire_shield — incomingShield != null.
  //   3) retaliateDmg > 0.
  //   4) Атакующий жив (даже если у нас бы случился странный сценарий
  //      «атакер умер своим же действием»).
  // Применение: `applyDamage(u, ..., null)` — source=null блокирует
  // triggerOnDealDamagePassives (ответка не считается melee-атакой,
  // см. DESIGN.md → «не вызывает рекурсивных ответок»). Если у атакера
  // сам тоже висит fire_shield — computeIncomingDamage у него снизит
  // ответный урон через damageReduction; но НОВУЮ ответку в обратную
  // сторону мы не запускаем (её делал бы только executeAttack, мы же
  // здесь работаем напрямую через applyDamage).
  if (incomingShield && retaliateDmg > 0 && u.alive) {
    const retAdj = computeIncomingDamage(u, retaliateDmg, 'fire');
    const retNote = retAdj.note ? ` (${retAdj.note})` : '';
    const targetCls = CLASSES[target.classId];
    log(`  «Огненный щит» ${targetCls ? targetCls.name : target.id} (${target.team}) — ответка ${retAdj.dmg} огня по ${cls.name} (${u.team})${retNote}`, 'damage');
    applyDamage(u, retAdj.dmg, null);
  }

  render();
  // Анимация попадания. Если юнит умирает — отдельную дрожь не играем,
  // fade+scale из .is-dying самодостаточен.
  playHitAnimation(target.id, crit, targetDying);
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ФАЕРБОЛ ====================================================
   Маг кастует «Огненный шар»:
   — цель: любая клетка в пределах манхэттенской дальности (SKILLS.fireball.range),
     включая пустую, вражескую, союзную и свою собственную. Друг.огонь осознан;
   — зона поражения: квадрат 3×3 с центром в целевой клетке;
   — урон по формуле SKILLS.fireball.formula = 2 + ⌊Мудрость/2⌋ всем живым
     юнитам в зоне (в том числе самому магу, если стоит в зоне);
   — один ролл крита на каст (Удача%) — удваивает урон по всей области;
   — стоимость 10 маны, не более 1 раза за ход;
   — не расходует базовую атаку и не мешает движению (отдельное действие).
*/
function computeFireballRange(unit) {
  const range = SKILLS.fireball.range;
  const cells = [];
  for (let dr = -range; dr <= range; dr++) {
    const maxDc = range - Math.abs(dr);
    for (let dc = -maxDc; dc <= maxDc; dc++) {
      const r = unit.row + dr, c = unit.col + dc;
      if (!inBounds(r, c)) continue;
      cells.push({ row: r, col: c });
    }
  }
  return cells;
}

function computeFireballAoe(row, col) {
  const cells = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr, c = col + dc;
      if (!inBounds(r, c)) continue;
      cells.push({ row: r, col: c, isCenter: dr === 0 && dc === 0 });
    }
  }
  return cells;
}

function executeFireball(targetRow, targetCol) {
  const u = getActiveUnit();
  if (!u) return;
  // Параметры скилла берём с учётом ТИРА юнита: тир определяет manaCost,
  // formula и опциональный applyEffect. Общие поля (range, area, delivery,
  // damageType, canCrit, hitsFriendlies) — на верхнем уровне SKILLS.fireball.
  // slotIdx из state.modeSlotIdx — если фаербол в нескольких слотах
  // с разными тирами, кастуем тем, на который игрок кликнул.
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  const params = getUnitSkillParams(u, 'fireball', slotIdx);
  // Право на каст: либо у класса в activeSkills есть fireball, либо
  // юниту его выдали через override (DevTools — см. ui/dev-tools.js).
  // Это разрешает тестировать фаербол на любом юните, не трогая список
  // классовых навыков.
  const fbList = Array.isArray(u.activeSkillsOverride)
    ? u.activeSkillsOverride
    : ((CLASSES[u.classId] && CLASSES[u.classId].activeSkills) || []);
  if (!fbList.includes('fireball')) return;
  // Общее правило: не более одного активного навыка за ход.
  if (u.skillsUsedThisTurn.length > 0) return;
  if (u.mana < params.manaCost) return;
  // Парная защита к enterMode: «Обездвижен» блокирует скиллы с
  // movesUser. У фаербола флага нет — но проверка на месте на случай
  // прямого вызова executeXxx из будущего ИИ/хоткея.
  if (params.movesUser && !canUnitMove(u)) return;
  if (!inBounds(targetRow, targetCol)) return;
  const dist = Math.abs(targetRow - u.row) + Math.abs(targetCol - u.col);
  if (dist > params.range) return;

  u.mana -= params.manaCost;
  // Триггер пассивок с trigger='onManaSpent' (Сессия 7: «Поглощение маны»).
  // Стоит здесь, СРАЗУ после фактического вычета маны, чтобы любая
  // будущая активка могла одной строкой повторить вызов и не таскать
  // правило по местам каста.
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('fireball');
  applyCooldown(u, 'fireball', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'fireball');
  state.mode = null;
  PreviewState.fireball = null;

  // Один ролл крита на весь каст.
  const crit = params.canCrit && rollCrit(u);
  // Урон — по формуле фаербола от ЭФФЕКТИВНЫХ характеристик кастера
  // (то есть с учётом возможных дебаффов на самом маге).
  const uStats = effectiveStats(u);
  const baseDmg = calcFormulaDamage(params.formula, uStats);
  const dmg = crit ? baseDmg * 2 : baseDmg;

  const clsU = CLASSES[u.classId];
  const dmgDesc = describeDamage(params.delivery, params.damageType);
  // В лог проставляем разбор: «Маг кастует Огненный шар [по площади · огненный]
  // → (r,c) · урон 5 (2 + ⌊6/2⌋)». Игрок видит, почему именно столько.
  const breakdown = describeFormulaBreakdown(params.formula, uStats);
  log(
    `${clsU.name} (${u.team}) кастует «${params.name}» [${dmgDesc}] → (${targetRow},${targetCol}) · урон ${baseDmg} (${breakdown})` +
    (crit ? ' — КРИТ!' : ''),
    crit ? 'crit' : 'info'
  );

  // Собираем попавших юнитов (живых в зоне 3×3).
  const aoe = computeFireballAoe(targetRow, targetCol);
  const hits = [];
  for (const { row, col } of aoe) {
    const t = unitAt(row, col);
    if (t && t.alive) hits.push(t);
  }

  // Визуальная вспышка — стартует сразу, играется параллельно с логикой.
  playFireballBlast(targetRow, targetCol);

  // Применяем урон через общий applyDamage. В AoE пассивы кастера тоже
  // триггерятся (applyDamage проверяет team), что корректно для будущих
  // вариантов: если у огненного шара появится «опаляющий яд», он сработает
  // на всех врагов в зоне. У мага сейчас нет пассивок, так что ничего
  // дополнительно не накапливается.
  // Модификатор по типу цели считается ПОТАРГЕТНО: одна и та же вспышка
  // может ударить и по живому, и по нежити — у каждого своя итоговая цифра.
  for (const target of hits) {
    const selfTag = target.id === u.id ? ' (сам себе)' : '';
    const adj = computeIncomingDamage(target, dmg, params.damageType, { delivery: params.delivery });
    const noteSuffix = adj.note ? ` (${adj.note})` : '';
    log(`  ${CLASSES[target.classId].name} (${target.team}) — ${adj.dmg} ${dmgDesc} урона от взрыва${selfTag}${noteSuffix}`, crit ? 'crit' : 'damage');
    applyDamage(target, adj.dmg, u);
  }

  // Эффекты тира — навешиваются ПОСЛЕ урона на всех, кто уцелел.
  // Дохлым (умершим от самого фаербола) эффект не вешается: applySkillEffectDef
  // защищается тем, что target должен быть жив; вспомогательные applyXxx
  // тоже проверяют alive. У advanced/elite фаербола это «Горение».
  if (params.applyEffect) {
    for (const target of hits) {
      if (!target.alive) continue;
      applySkillEffectDef(target, params.applyEffect);
    }
  }

  render();
  // Анимация попадания на каждом из пострадавших. Запускаем после render()
  // чтобы классы применились к свежим DOM-элементам.
  for (const target of hits) {
    playHitAnimation(target.id, crit, !target.alive);
  }

  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === SINGLE-TARGET RANGED SKILLS ================================
   ================================================================
   Универсальный путь для активных скиллов с delivery !== 'aoe':
   ice_arrow, magic_arrow (Сессия 9), и далее (Цепная молния — С11,
   Призматическая сфера — С12, Очищение — С15).

   Точки расширения:
     • computeRangedTargets(u, skillId) — массив целей в радиусе.
       Фильтр: живые, чужая команда, не иммунные к damageType скилла.
       Используется и режимом прицеливания (render-overlay), и тонкими
       executeXxx-обёртками (валидация перед applyDamage).
     • executeSingleTargetSkill(u, targetId, skillId) — один проход:
       canActivateSkill → списание маны (+ triggerOnManaSpent) →
       ролл крита → урон по цели через computeIncomingDamage →
       applySkillEffectDef для тира → render → анимация → checkVictory.
     • executeIceArrow / executeMagicArrow — тонкие именованные обёртки
       (для DevTools и хоткей-биндингов).

   Друг.огонь / hitsFriendlies. Для single-target цели можно бить только
   ВРАЖЕСКИХ юнитов (computeRangedTargets фильтрует team !== u.team).
   Поле hitsFriendlies в данных скилла на single-target не влияет —
   это поле для AoE (фаербол), задел не наследуем.
*/
function computeRangedTargets(unit, skillId) {
  if (!unit || !skillId) return [];
  const skill = SKILLS[skillId];
  if (!skill) return [];
  const params = getUnitSkillParams(unit, skillId);
  const range = params.range;
  // Camp v1.5-priest (09.05.2026): targetingMode-фильтр.
  //   'ally_self', 'ally_self_or_undead_demon', 'self', undefined=enemy-only.
  const tm = params.targetingMode;
  if (tm) {
    return state.units.filter(t => {
      if (!t.alive) return false;
      if (!isTargetInRange(unit, t, range)) return false;
      if (tm === 'self') return t.id === unit.id;
      const isAlly = (t.team === unit.team);
      if (tm === 'ally_self') return isAlly || t.id === unit.id;
      if (tm === 'ally_self_or_undead_demon') {
        if (isAlly || t.id === unit.id) return true;
        const cls = CLASSES[t.classId];
        const ut = cls && cls.unitType;
        return ut === 'undead' || ut === 'demon';
      }
      return false;
    });
  }
  // strikes-aware иммунитет (Сессия 12: Призматическая сфера наносит
  // несколько ударов разных типов одной цели). Если в скилле задан
  // массив `strikes` — цель отсеивается, ТОЛЬКО если она иммунна КО
  // ВСЕМ типам из этого массива (т.е. ни один удар не пройдёт). Если
  // strikes отсутствует — используется обычный фильтр по damageType.
  const strikes = Array.isArray(params.strikes) && params.strikes.length
    ? params.strikes
    : null;
  const dt = params.damageType;
  return state.units.filter(t => {
    if (!t.alive || t.team === unit.team) return false;
    if (!isTargetInRange(unit, t, range)) return false;
    if (strikes) {
      // Иммунен ко ВСЕМ — отсекаем (ни один страйк не пройдёт).
      return !strikes.every(s => isImmuneToDamageType(t, s));
    }
    return !isImmuneToDamageType(t, dt);
  });
}

function executeSingleTargetSkill(u, targetId, skillId) {
  if (!u) return;
  // slotIdx из state.modeSlotIdx — гарантирует, что мана и эффект
  // тира соответствуют слоту, по которому игрок кликнул (если один
  // и тот же скилл выдан в несколько слотов с разными тирами).
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, skillId, slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive || target.team === u.team) return;
  const params = getUnitSkillParams(u, skillId, slotIdx);
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > params.range) return;
  // Иммунитет к damageType. Сейчас isImmuneToDamageType возвращает false
  // для frost/magic/electric/fire/holy/physical — задел Сессии 17. Когда
  // появится классовый иммунитет, этот if заблокирует и каст «через
  // консоль / AI», минуя computeRangedTargets.
  if (isImmuneToDamageType(target, params.damageType)) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push(skillId);
  applyCooldown(u, skillId, params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, skillId);  // С23: снимает камуфляж атакующего, если был.
  state.mode = null;

  // Один ролл крита на каст.
  const crit = params.canCrit && rollCrit(u);
  const uStats = effectiveStats(u);
  const baseDmg = calcFormulaDamage(params.formula, uStats);
  const dmg = crit ? baseDmg * 2 : baseDmg;

  const clsU = CLASSES[u.classId];
  const clsT = CLASSES[target.classId];
  const dmgDesc = describeDamage(params.delivery, params.damageType);
  const breakdown = describeFormulaBreakdown(params.formula, uStats);
  log(
    `${clsU.name} (${u.team}) кастует «${params.name}» [${dmgDesc}] → ${clsT.name} (${target.team}) · урон ${baseDmg} (${breakdown})` +
    (crit ? ' — КРИТ!' : ''),
    crit ? 'crit' : 'info'
  );

  // Применяем урон с учётом типового модификатора цели. computeIncomingDamage
  // обнулит урон у цели с иммунитетом — на этапе выбора мы её отфильтровали,
  // но если каст пришёл напрямую, страховка сработает.
  const adj = computeIncomingDamage(target, dmg, params.damageType, { delivery: params.delivery });
  const noteSuffix = adj.note ? ` (${adj.note})` : '';
  log(`  ${clsT.name} (${target.team}) — ${adj.dmg} ${dmgDesc} урона${noteSuffix}`, crit ? 'crit' : 'damage');
  applyDamage(target, adj.dmg, u);

  // Эффект тира — на выжившую цель (если не добили самим уроном).
  // applySkillEffectDef сама отсеивает мёртвых (через apply*-хелперы),
  // явная проверка здесь — ради ясности и симметрии с executeFireball.
  if (params.applyEffect && target.alive) {
    applySkillEffectDef(target, params.applyEffect);
  }

  render();
  playHitAnimation(target.id, crit, !target.alive);
  if (checkVictory()) { render(); return; }
}

/* Тонкие именованные обёртки — для DevTools (см. ACTIVE_EXECUTORS) и
   хоткеев. Параметризованы только id скилла, всё исполнение — общее. */
function executeIceArrow(targetId)   { executeSingleTargetSkill(getActiveUnit(), targetId, 'ice_arrow');   }
function executeMagicArrow(targetId) { executeSingleTargetSkill(getActiveUnit(), targetId, 'magic_arrow'); }

/* dispatchActiveSkill(u, targetId, skillId) — диспатчер для click-handler
   в render-overlay (single-target ranged ветка). По умолчанию вызывает
   executeSingleTargetSkill (общий путь для ice_arrow/magic_arrow); для
   скиллов с особой логикой (chain_lightning — отскоки) направляет на
   их собственный executor. Вынос в одну точку: render-overlay не должен
   знать про специфику конкретных скиллов, выбор делает combat.js. */
function dispatchActiveSkill(u, targetId, skillId) {
  if (typeof DebugLog !== 'undefined') DebugLog.log('action', 'dispatchActiveSkill', { skillId, casterId: u && u.id, targetId });
  const fn = SKILL_EXECUTORS[skillId];
  if (fn) return fn(targetId);
  // Fallback — общий путь для скиллов БЕЗ собственной execute-функции
  // (ice_arrow, magic_arrow): один ролл крита, один applyDamage,
  // optional applyEffect. См. executeSingleTargetSkill ниже.
  // skillId передаётся, потому что fallback читает данные тира по нему.
  return executeSingleTargetSkill(u, targetId, skillId);
}

/* Реестр всех скиллов с собственным execute-исполнителем, принимающим
   targetId (юнит-цель). Раньше эта же таблица жила как 17-веточный
   switch внутри dispatchActiveSkill (С24-рефактор: вынесено в реестр).

   Что НЕ здесь:
     • charge / teleport / trap / lure / fireball / lightning — у них
       target = клетка, не юнит, поэтому они зовутся напрямую из
       render-overlay (при клике на подсвеченную клетку) и в этот реестр
       не попадают. ACTIVE_EXECUTORS в dev-tools.js остаётся ОТДЕЛЬНЫМ
       источником «есть исполнитель / нет», т.к. он покрывает оба
       канала вызова (через dispatch и напрямую). Если когда-нибудь
       dispatch расширим до клеточных скиллов — можно будет
       консолидировать.

   Порядок вычисления реестра. Файл — обычный <script src>; const
   SKILL_EXECUTORS вычисляется ВНИЗУ, ПОСЛЕ всех executeXxx-объявлений
   выше. Так function declarations к моменту создания объекта уже
   существуют (function declarations hoisted). dispatchActiveSkill
   объявлен раньше реестра, но вызывается из event-handler-ов уже
   ПОСЛЕ полного исполнения файла — значение SKILL_EXECUTORS к моменту
   первого click'а готово. */
const SKILL_EXECUTORS = {
  chain_lightning:  executeChainLightning,
  prismatic_sphere: executePrismaticSphere,
  fire_shield:      executeFireShield,
  mana_focus:       executeManaFocus,
  purify:           executeCleanse,
  shield_block:     executeShieldBlock,
  whirlwind:        executeWhirlwind,
  second_wind:      executeSecondWind,
  fortify_armor:    executeFortifyArmor,
  second_attack:    executeSecondAttack,
  provoke:          executeProvoke,
  cover:            executeCover,
  poison_arrow:     executePoisonArrow,
  fire_arrow:       executeFireArrow,
  long_shot:        executeLongShot,
  second_shot:      executeSecondShot,
  camouflage:       executeCamouflage,
  // Camp v1.5-priest (Сессия A, 09.05.2026): священник.
  healing:          executeHealing,
  blessing:         executeBlessing,
  purify_touch:     executePurifyTouch,
  holy_strength:    executeHolyStrength,
  // Camp v1.5-priest-B (10.05.2026): священник, продолжение.
  resurrection:     executeResurrection,
  holy_shield:      executeHolyShield,
  // Camp v1.5-priest-C (11.05.2026): священник, финал.
  light_wave:       executeLightWave,
  // Сессия Призрак (12.05.2026): AI-only активка лидера нежити.
  ghostly_scream:   executeGhostlyScream,
};

/* ================================================================
   === МОЛНИЯ (LINE AoE, Сессия 10) ===============================
   ================================================================
   Прицел — одна из 4 СМЕЖНЫХ к магу клеток (вверх/вниз/влево/вправо).
   Линия идёт от выбранной клетки прицеливания «от мага» на lineLength
   клеток (5/7/9 по тиру), сама клетка прицеливания — первая в линии.
   Если линия упирается в край поля — укорачивается до границы (без
   жалобы пользователю; ситуация валидная — просто меньше клеток).

   Точки расширения:
     • computeLightningAnchors(unit) — массив 4 валидных смежных клеток
       с предвычисленным направлением {row, col, dirRow, dirCol};
       клетки за границей поля отсекаются.
     • computeLightningLine(unit, anchorRow, anchorCol) — массив клеток
       линии для текущего тира юнита (читает lineLength через
       getUnitSkillParams). Сама anchor — первая клетка.
     • executeLightning(anchorRow, anchorCol) — каст: canActivateSkill →
       проверка смежности anchor → списание маны → ролл крита (один на
       каст) → урон по формуле всем живым на линии (включая союзников)
       через computeIncomingDamage → applySkillEffectDef для каждого с
       elite-тира stunned/1/15% → render → playHitAnimation → checkVictory.
*/
function computeLightningAnchors(unit) {
  if (!unit) return [];
  const dirs = [
    { dr: -1, dc:  0 },  // вверх
    { dr:  1, dc:  0 },  // вниз
    { dr:  0, dc: -1 },  // влево
    { dr:  0, dc:  1 },  // вправо
  ];
  const out = [];
  for (const { dr, dc } of dirs) {
    const r = unit.row + dr, c = unit.col + dc;
    if (!inBounds(r, c)) continue;
    out.push({ row: r, col: c, dirRow: dr, dirCol: dc });
  }
  return out;
}

function computeLightningLine(unit, anchorRow, anchorCol) {
  if (!unit) return [];
  // slot-aware: в режиме прицеливания state.modeSlotIdx уже выставлен
  // (см. enterMode), и длина линии берётся по тиру СЛОТА. Это критично
  // когда один и тот же "lightning" выдан в разные слоты с разными
  // тирами — превью должно совпадать с тем, чем юнит реально кастует.
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  const params = getUnitSkillParams(unit, 'lightning', slotIdx);
  const length = (params.lineLength | 0) || 0;
  if (length <= 0) return [];
  const dr = anchorRow - unit.row;
  const dc = anchorCol - unit.col;
  // Сейф: anchor должна быть смежной (manhattan = 1).
  if (Math.abs(dr) + Math.abs(dc) !== 1) return [];
  const cells = [];
  for (let i = 0; i < length; i++) {
    const r = anchorRow + dr * i;
    const c = anchorCol + dc * i;
    if (!inBounds(r, c)) break;  // линия упёрлась в край — обрезается
    cells.push({ row: r, col: c });
  }
  return cells;
}

function executeLightning(anchorRow, anchorCol) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'lightning', slotIdx)) return;
  const params = getUnitSkillParams(u, 'lightning', slotIdx);
  // Anchor должна быть смежной — проверка дублирует фильтр overlay,
  // но защищает от прямого вызова из консоли/AI с некорректной парой.
  const dr = anchorRow - u.row;
  const dc = anchorCol - u.col;
  if (Math.abs(dr) + Math.abs(dc) !== 1) return;
  if (!inBounds(anchorRow, anchorCol)) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('lightning');
  applyCooldown(u, 'lightning', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'lightning');
  state.mode = null;
  if (typeof PreviewState.lightning !== 'undefined') PreviewState.lightning = null;

  const crit = params.canCrit && rollCrit(u);
  const uStats = effectiveStats(u);
  const baseDmg = calcFormulaDamage(params.formula, uStats);
  const dmg = crit ? baseDmg * 2 : baseDmg;

  const clsU = CLASSES[u.classId];
  const dmgDesc = describeDamage(params.delivery, params.damageType);
  const breakdown = describeFormulaBreakdown(params.formula, uStats);
  const lineCells = computeLightningLine(u, anchorRow, anchorCol);
  log(
    `${clsU.name} (${u.team}) кастует «${params.name}» [${dmgDesc}] → линия ${lineCells.length} кл. от (${anchorRow},${anchorCol}) · урон ${baseDmg} (${breakdown})` +
    (crit ? ' — КРИТ!' : ''),
    crit ? 'crit' : 'info'
  );

  // Сбор живых юнитов на линии (включая союзников).
  const hits = [];
  for (const { row, col } of lineCells) {
    const t = unitAt(row, col);
    if (t && t.alive) hits.push(t);
  }

  for (const target of hits) {
    const selfTag = target.team === u.team ? ' (свой)' : '';
    const adj = computeIncomingDamage(target, dmg, params.damageType, { delivery: params.delivery });
    const noteSuffix = adj.note ? ` (${adj.note})` : '';
    log(`  ${CLASSES[target.classId].name} (${target.team}) — ${adj.dmg} ${dmgDesc} урона${selfTag}${noteSuffix}`, crit ? 'crit' : 'damage');
    applyDamage(target, adj.dmg, u);
  }

  // Эффект тира — независимый ролл applyEffect.chance на каждого
  // выжившего (elite-Молния: stunned/1/15%). applySkillEffectDef сам
  // отсекает мёртвых через apply*-хелперы.
  if (params.applyEffect) {
    for (const target of hits) {
      if (!target.alive) continue;
      applySkillEffectDef(target, params.applyEffect);
    }
  }

  render();
  for (const target of hits) {
    playHitAnimation(target.id, crit, !target.alive);
  }
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ЦЕПНАЯ МОЛНИЯ (Сессия 11) ==================================
   ================================================================
   Initial — single-target ranged 4 (electric). После попадания —
   bounceCount отскоков. Каждый отскок: от ПОСЛЕДНЕЙ пораженной цели
   ищется ближайший ещё-не-пораженный враг в радиусе 3 манхэттен,
   не иммунный к electric. Тай-брейки: мин. дистанция → мин. Удача
   (эффективная) → случайный. Если кандидатов нет — отскоки прекращаются
   (оставшиеся «теряются»). Один ролл крита на ВЕСЬ каст (включая отскоки).

   Прицеливание initial-цели идёт через универсальный single-target
   overlay (kind:'active', delivery:'ranged'); click → dispatchActiveSkill
   → executeChainLightning. canActivateSkill / списание маны / лог /
   анимация — здесь, не в общем executeSingleTargetSkill, потому что
   логика отскоков специфична. */
function executeChainLightning(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'chain_lightning', slotIdx)) return;
  const initial = getUnit(targetId);
  if (!initial || !initial.alive || initial.team === u.team) return;
  const params = getUnitSkillParams(u, 'chain_lightning', slotIdx);
  const dist = Math.abs(initial.row - u.row) + Math.abs(initial.col - u.col);
  if (dist > params.range) return;
  if (isImmuneToDamageType(initial, params.damageType)) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('chain_lightning');
  applyCooldown(u, 'chain_lightning', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'chain_lightning');
  state.mode = null;

  const crit = params.canCrit && rollCrit(u);
  const uStats = effectiveStats(u);
  const baseDmg = calcFormulaDamage(params.formula, uStats);
  const dmg = crit ? baseDmg * 2 : baseDmg;

  const clsU = CLASSES[u.classId];
  const dmgDesc = describeDamage(params.delivery, params.damageType);
  const breakdown = describeFormulaBreakdown(params.formula, uStats);
  const bounceCount = (params.bounceCount | 0) || 0;
  log(
    `${clsU.name} (${u.team}) кастует «${params.name}» [${dmgDesc}] → ${CLASSES[initial.classId].name} (${initial.team}) · урон ${baseDmg} (${breakdown}), отскоков до ${bounceCount}` +
    (crit ? ' — КРИТ!' : ''),
    crit ? 'crit' : 'info'
  );

  // Цепочка: initial + отскоки. Каждый шаг — ищем следующего кандидата
  // от ПОСЛЕДНЕЙ пораженной цели.
  const hits = [initial];
  for (let b = 0; b < bounceCount; b++) {
    const last = hits[hits.length - 1];
    const hitIds = new Set(hits.map(h => h.id));
    const candidates = state.units.filter(t =>
      t.alive && t.team !== u.team && !hitIds.has(t.id) &&
      !isImmuneToDamageType(t, params.damageType) &&
      Math.abs(t.row - last.row) + Math.abs(t.col - last.col) <= 3
    );
    if (!candidates.length) break;
    // Тай-брейк: мин. дистанция → мин. Удача (эфф.) → случайный.
    candidates.sort((a, b) => {
      const dA = Math.abs(a.row - last.row) + Math.abs(a.col - last.col);
      const dB = Math.abs(b.row - last.row) + Math.abs(b.col - last.col);
      if (dA !== dB) return dA - dB;
      const luckA = effectiveStats(a).luk || 0;
      const luckB = effectiveStats(b).luk || 0;
      if (luckA !== luckB) return luckA - luckB;
      return Math.random() - 0.5;
    });
    hits.push(candidates[0]);
  }

  // Применение урона по всей цепочке.
  for (let i = 0; i < hits.length; i++) {
    const target = hits[i];
    const adj = computeIncomingDamage(target, dmg, params.damageType, { delivery: params.delivery });
    const noteSuffix = adj.note ? ` (${adj.note})` : '';
    const tag = i === 0 ? 'попадание' : `отскок ${i}`;
    log(`  ${CLASSES[target.classId].name} (${target.team}) — ${adj.dmg} ${dmgDesc} урона (${tag})${noteSuffix}`, crit ? 'crit' : 'damage');
    applyDamage(target, adj.dmg, u);
  }

  render();
  for (const target of hits) {
    playHitAnimation(target.id, crit, !target.alive);
  }
  if (checkVictory()) { render(); return; }
}


/* ================================================================
   === ПРИЗМАТИЧЕСКАЯ СФЕРА (Сессия 12) ===========================
   ================================================================
   Single-target ranged 4, 10 маны. Три удара последовательно по одной
   цели в порядке electric → frost → fire, каждый — отдельный проход
   через computeIncomingDamage (иммунитет к одному типу обнуляет только
   свой удар). Один ролл крита на ВЕСЬ каст. Если цель умерла после
   страйка — оставшиеся не наносятся (applyDamage сама фильтрует
   мёртвых; чтобы лог не засорялся «удар по трупу» — break после
   фиксации смерти).

   Прицеливание — универсальный single-target overlay (kind:'active',
   delivery:'ranged'); click → dispatchActiveSkill → executePrismaticSphere.
   Иммунитет цели КО ВСЕМ трём типам отфильтровывается на стороне
   computeRangedTargets (через `strikes`-aware ветку). Иммунитет к 1-2
   из 3 — цель валидна, остальные удары пройдут. */
function executePrismaticSphere(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'prismatic_sphere', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive || target.team === u.team) return;
  const params = getUnitSkillParams(u, 'prismatic_sphere', slotIdx);
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > params.range) return;
  const strikes = Array.isArray(params.strikes) ? params.strikes : [];
  if (!strikes.length) return;
  // Иммунитет КО ВСЕМ страйк-типам — отказ (страховка от прямого вызова
  // из консоли/AI, минующего computeRangedTargets).
  if (strikes.every(s => isImmuneToDamageType(target, s))) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('prismatic_sphere');
  applyCooldown(u, 'prismatic_sphere', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'prismatic_sphere');
  state.mode = null;

  // Один ролл крита на ВЕСЬ каст. Каждый страйк — крит/не-крит вместе.
  const crit = params.canCrit && rollCrit(u);
  const uStats = effectiveStats(u);
  const baseDmg = calcFormulaDamage(params.formula, uStats);
  const dmg = crit ? baseDmg * 2 : baseDmg;

  const clsU = CLASSES[u.classId];
  const breakdown = describeFormulaBreakdown(params.formula, uStats);
  log(
    `${clsU.name} (${u.team}) кастует «${params.name}» → ${CLASSES[target.classId].name} (${target.team}) · ${strikes.length} удар(а) по ${baseDmg} (${breakdown})` +
    (crit ? ' — КРИТ!' : ''),
    crit ? 'crit' : 'info'
  );

  // Последовательное применение страйков. computeIncomingDamage может
  // вернуть 0 для иммунного типа — это валидно, страйк просто не наносит
  // урон, а не пропускается. Лог при этом всё равно фиксирует попытку
  // (с пометкой «иммунитет к X»), чтобы игрок видел, что произошло.
  for (let i = 0; i < strikes.length; i++) {
    if (!target.alive) break;  // добили — оставшиеся страйки не пишем
    const dt = strikes[i];
    const dmgDesc = describeDamage(params.delivery, dt);
    const adj = computeIncomingDamage(target, dmg, dt);
    const noteSuffix = adj.note ? ` (${adj.note})` : '';
    log(`  страйк ${i + 1}/${strikes.length}: ${CLASSES[target.classId].name} (${target.team}) — ${adj.dmg} ${dmgDesc} урона${noteSuffix}`, crit ? 'crit' : 'damage');
    applyDamage(target, adj.dmg, u);
  }

  render();
  playHitAnimation(target.id, crit, !target.alive);
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ТЕЛЕПОРТ (Сессия 13) =======================================
   ================================================================
   Self-move skill, movesUser:true (canActivateSkill блокирует под
   «Обездвижен»). 5/5/3 маны, дальность 10/15/20 кл. (manaCost и range
   тир-зависимые — оба в tiers[tier]).

   Дистанция — манхэттен, БЕЗ учёта блокеров (можно телепортироваться
   «сквозь» юнитов и надгробия). Целевая клетка должна быть свободной
   (нет живого юнита и нет надгробия). Клетка самого мага исключается.

   НЕ ставит actionsUsedThisTurn.move = true — обычное движение этот
   ход остаётся доступным. Расходуется только слот активного скилла
   (через u.skillsUsedThisTurn.push, общее правило «один активный
   навык за ход»). canCrit: false — телепорт не наносит урон, ролл
   крита не делается; но triggerOnManaSpent зовётся как у любого
   активного навыка с тратой маны (Поглощение маны корректно
   подхватит). */
function executeTeleport(targetRow, targetCol) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'teleport', slotIdx)) return;
  const params = getUnitSkillParams(u, 'teleport', slotIdx);
  if (!inBounds(targetRow, targetCol)) return;
  const dist = Math.abs(targetRow - u.row) + Math.abs(targetCol - u.col);
  if (dist <= 0 || dist > params.range) return;
  // Свободная клетка: ни живого юнита, ни надгробия. Через unitAt/graveAt
  // (movement.js) — те же примитивы, что использует обычное движение.
  if (unitAt(targetRow, targetCol)) return;
  if (graveAt(targetRow, targetCol)) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('teleport');
  applyCooldown(u, 'teleport', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'teleport');
  state.mode = null;

  const fromR = u.row, fromC = u.col;
  u.row = targetRow;
  u.col = targetCol;

  const clsU = CLASSES[u.classId];
  log(`${clsU.name} (${u.team}) телепортируется (${fromR},${fromC}) → (${targetRow},${targetCol}) · ${params.manaCost} маны`, 'info');

  render();
  if (checkVictory()) { render(); return; }
}


/* ================================================================
   === КАПКАН / ПРИМАНКА (С22) ====================================
   ================================================================
   Оба — активные place_object скиллы лучника. Цель — пустая клетка в
   манхэттенском радиусе ≤ params.range. «Пустая» = нет живого юнита,
   нет надгробия, нет другого объекта (универсальное правило: на
   надгробии/занятой клетке нельзя размещать ничего поверх).

   Режим прицеливания: state.mode === 'trap' / 'lure'. Подсветка
   валидных клеток — в render-overlay.js (общая ветка для delivery
   === 'place_object'). Click → executeTrap/executeLure.

   Один объект на клетку. addObject в core/state.js. Срабатывание —
   triggerObjectsOnPathStep / triggerObjectsOnMoveEnd в movement.js,
   handleTrapTrigger / handleLureTrigger там же. */
function executePlaceObject(skillId, targetRow, targetCol) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, skillId, slotIdx)) return;
  const params = getUnitSkillParams(u, skillId, slotIdx);
  if (!inBounds(targetRow, targetCol)) return;
  const dist = Math.abs(targetRow - u.row) + Math.abs(targetCol - u.col);
  // Дистанция > 0 (нельзя ставить под собой — пользователь явно
  // подтвердил 05.05.2026) и ≤ params.range (манхэттен).
  if (dist <= 0 || dist > (params.range | 0)) return;
  // Клетка должна быть свободна полностью: ни юнита, ни надгробия,
  // ни другого объекта, ни дерева. Дерево — непроходимый блокер;
  // ставить капкан/приманку «под него» нет смысла, и UI давно фильтрует
  // (render-overlay), но защитный check тут гарантирует консистентность
  // даже при прямом вызове executeTrap/executeLure из консоли/тестов.
  if (unitAt(targetRow, targetCol)) return;
  if (graveAt(targetRow, targetCol)) return;
  if (objectAt(targetRow, targetCol)) return;
  if (treeAt(targetRow, targetCol)) return;

  // Собираем payload по типу объекта.
  let payload = {};
  if (skillId === 'trap') {
    if (params.dmgFromDex) {
      // Элитный тир: dmg фиксируется в момент установки от текущей dex
      // кастера через effectiveStats. dexAtInstall сохраняем для лога/отладки.
      const dex = effectiveStats(u).dex || 0;
      const dmg = (params.dmgBase | 0) + Math.floor(dex / 2);
      payload = { dmg, dexAtInstall: dex };
    } else {
      payload = { dmg: (params.dmg | 0) || 0 };
    }
  } else if (skillId === 'lure') {
    payload = {
      lureRadius: (params.lureRadius | 0) || 0,
      applyOnPickup: params.applyOnPickup || null
    };
  }

  // Регистрация объекта в state. Учёт траты слота активного навыка
  // и кулдауна — общим путём (как у любого активного скилла).
  addObject({
    kind: skillId,
    row: targetRow,
    col: targetCol,
    ownerTeam: u.team,
    payload
  });

  if (typeof params.manaCost === 'number' && params.manaCost > 0) {
    u.mana -= params.manaCost;
    triggerOnManaSpent(u, params.manaCost);
  }
  u.skillsUsedThisTurn.push(skillId);
  applyCooldown(u, skillId, params);
  onActiveSkillCast(u, skillId);
  state.mode = null;

  const clsU = CLASSES[u.classId];
  const objName = (skillId === 'trap') ? 'капкан' : 'приманку';
  const detail = (skillId === 'trap')
    ? `(урон ${payload.dmg})`
    : `(радиус ${payload.lureRadius})`;
  log(`${clsU.name} (${u.team}) ставит ${objName} на (${targetRow},${targetCol}) ${detail}`, 'info');

  render();
  if (checkVictory()) { render(); return; }
}

function executeTrap(targetRow, targetCol) { executePlaceObject('trap', targetRow, targetCol); }
function executeLure(targetRow, targetCol) { executePlaceObject('lure', targetRow, targetCol); }


/* ================================================================
   === ОГНЕННЫЙ ЩИТ (Сессия 14) ===================================
   ================================================================
   Активный buff. Цель — сам маг или союзник в манхэттене ≤1, 8 маны,
   длительность 3 хода (всё одинаково по тирам). retaliateDmg
   зафиксирован при наложении: `retaliateBase + ⌊wis_кастера/3⌋`,
   retaliateBase 2/4/6 по тирам. damageReduction 2/3/4 по тирам.

   Прицеливание — собственная ветка в render-overlay.js
   (state.mode === 'fire_shield', .buff-target). delivery:'self_buff'
   исключает скилл из универсальной single-target ranged ветки и из
   ветки 'teleport'. Click → dispatchActiveSkill → executeFireShield.

   canCrit:false — крит для ответки не катается. retaliateDmg —
   фиксированное число, не зависит от Удачи. */
function executeFireShield(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'fire_shield', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  // Цель: сам маг или союзник. Враги — невалидны.
  if (target.team !== u.team) return;
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > 1) return;
  const params = getUnitSkillParams(u, 'fire_shield', slotIdx);

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('fire_shield');
  applyCooldown(u, 'fire_shield', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'fire_shield');
  state.mode = null;

  // retaliateDmg фиксируем В МОМЕНТ наложения от effectiveStats(u).
  // После наложения изменение Мудрости кастера/её снятие НЕ влияет —
  // эффект на цели хранит число.
  const uStats = effectiveStats(u);
  const wisBonus = Math.floor((uStats.wis || 0) / 3);
  const retaliateBase = (params.retaliateBase | 0) || 0;
  const retaliateDmg = retaliateBase + wisBonus;
  const damageReduction = (params.damageReduction | 0) || 0;
  const duration = (params.duration | 0) || 3;

  const clsU = CLASSES[u.classId];
  const clsT = CLASSES[target.classId];
  const targetTag = (target.id === u.id) ? 'на себя' : `на ${clsT.name} (${target.team})`;
  log(
    `${clsU.name} (${u.team}) накладывает «Огненный щит» ${targetTag} · ответка ${retaliateDmg} огня (${retaliateBase}+⌊${uStats.wis || 0}/3⌋), снижение огненного/ледяного ${damageReduction}, ${duration} ход.`,
    'info'
  );

  applyFireShield(target, duration, retaliateDmg, damageReduction);

  render();
  if (checkVictory()) { render(); return; }
}


/* ================================================================
   === КОНЦЕНТРАЦИЯ МАНЫ (Сессия 15) ==============================
   ================================================================
   Активный self-buff. delivery:'self_buff', range:0 — overlay
   подсветит ровно клетку самого мага (универсальная self_buff-ветка
   в render-overlay.js фильтрует по «союзник в манхэттене ≤range»;
   range:0 → только сам маг). Click → dispatchActiveSkill →
   executeManaFocus(targetId), где targetId === u.id.

   Параметры тира (basic/advanced/elite):
     manaCost  6  6  6
     duration  5  8  12
     wisBonus +4 +6 +8

   wisBonus читается из tiers[tier].wisBonus и кладётся на эффект
   как `statMods: { wis: +bonus }`. Общая ветка effectiveStats
   подхватит и применит ко ВСЕМ формулам новых кастов мага. */
function executeManaFocus(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'mana_focus', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  // Self-only: targetId должен совпадать с кастером. Страховка от
  // прямого вызова из консоли с чужим targetId.
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'mana_focus', slotIdx);

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('mana_focus');
  applyCooldown(u, 'mana_focus', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'mana_focus');
  state.mode = null;

  const wisBonus = (params.wisBonus | 0) || 0;
  const duration = (params.duration | 0) || 0;

  const clsU = CLASSES[u.classId];
  log(`${clsU.name} (${u.team}) кастует «${params.name}» на себя · Мудрость +${wisBonus}, ${duration} ход.`, 'info');

  applyManaFocus(target, duration, wisBonus);

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ОЧИЩЕНИЕ (Сессия 15) =======================================
   ================================================================
   Активный single-target. Цель — ЛЮБОЙ живой юнит (сам маг, союзник,
   ВРАГ) в манхэттене ≤4. Снимает ВСЕ эффекты с цели через
   clearAllEffects (см. core/effects.js). Если эффектов не было —
   каст всё равно проходит, мана списывается (то же поведение, что
   у фаербола в пустую клетку).

   delivery:'cleanse' исключает скилл из универсальных ranged/self_buff
   веток overlay-я. Своя ветка в render-overlay.js (state.mode ===
   'cleanse'? — нет, через общий чек `delivery === 'cleanse'`).

   Параметры тира: manaCost 8/6/4 (basic/advanced/elite). range=4
   одинаков для всех тиров. canCrit:false — урона нет. */
function executeCleanse(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'purify', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  const params = getUnitSkillParams(u, 'purify', slotIdx);
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > params.range) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('purify');
  applyCooldown(u, 'purify', params);  // С17: ставит cooldown, если у тира скилла он задан
  onActiveSkillCast(u, 'purify');
  state.mode = null;

  const clsU = CLASSES[u.classId];
  const clsT = CLASSES[target.classId];
  const targetTag = (target.id === u.id) ? 'на себя' : `на ${clsT.name} (${target.team})`;
  const removedCount = clearAllEffects(target);
  if (removedCount > 0) {
    log(`${clsU.name} (${u.team}) кастует «${params.name}» ${targetTag} — снято эффектов: ${removedCount}`, 'info');
  } else {
    log(`${clsU.name} (${u.team}) кастует «${params.name}» ${targetTag} — снимать нечего`, 'info');
  }

  render();
  if (checkVictory()) { render(); return; }
}


/* ================================================================
   === РЫВОК ВОИНА (С18) ==========================================
   ================================================================
   Активный self-move skill (delivery:'leap'). Без маны, кулдаун 5.
   Дальность каста = ⌈moveRangeOf(u) × tierMul⌉, манхэттен. Целевая
   клетка — пустая (без живых юнитов и надгробий и деревьев). Путь
   НЕ проверяется — рывок «перепрыгивает» через всё.

   НЕ ставит actionsUsedThisTurn.move=true — обычное движение остаётся
   доступным. movesUser:false (мы не используем тут механизм canUnitMove,
   потому что рывок может быть полезен и под immobilized — но по
   спеке пока immobilized блокирует). Хм, оставим как есть: проверка
   движения через canUnitMove не делается (нет params.movesUser);
   если пользователь захочет — можно добавить). */
function executeCharge(targetRow, targetCol) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'charge', slotIdx)) return;
  const params = getUnitSkillParams(u, 'charge', slotIdx);
  if (!inBounds(targetRow, targetCol)) return;
  const dist = Math.abs(targetRow - u.row) + Math.abs(targetCol - u.col);
  const range = chargeRange(u, slotIdx);
  if (dist <= 0 || dist > range) return;
  // Целевая клетка свободна (нет живого юнита, надгробия, дерева).
  if (unitAt(targetRow, targetCol)) return;
  if (graveAt(targetRow, targetCol)) return;
  if (treeAt(targetRow, targetCol)) return;

  u.skillsUsedThisTurn.push('charge');
  applyCooldown(u, 'charge', params);
  onActiveSkillCast(u, 'charge');
  state.mode = null;

  const fromR = u.row, fromC = u.col;
  // Сессия 18 правка: РЫВОК БЕГОМ. Воин не телепортируется, а пробегает
  // по клеткам с анимацией movement (с удвоенной скоростью). Путь —
  // прямой L-образный: сначала по строкам, потом по столбцам, БЕЗ
  // обхода блокеров (рывок «перепрыгивает» юнитов и деревья — это
  // и есть его суть). На целевой клетке проверка свободы уже сделана
  // выше; промежуточные клетки могут быть заняты, но мы их не задерживаем.
  //
  // С22 правка: Рывок прерывается на капканах. Идём по пути пошагово,
  // на каждом шаге зовём triggerObjectsOnPathStep — если на клетке капкан,
  // он сработает (урон + immobilized) и движение прервётся через
  // canUnitMove-проверку. triggerObjectsOnMoveEnd для charge НЕ зовём:
  // приманка на charge не срабатывает (Рывок — это не «нормальный шаг
  // на клетку», а прорыв; lure-семантика «враг завершил ход» для него
  // неприменима).
  const path = computeChargePath(fromR, fromC, targetRow, targetCol);
  const actualPath = [path[0]];
  let lastR = fromR, lastC = fromC;
  for (let i = 1; i < path.length; i++) {
    const step = path[i];
    u.row = step.row;
    u.col = step.col;
    lastR = step.row;
    lastC = step.col;
    actualPath.push(step);
    if (typeof triggerObjectsOnPathStep === 'function') {
      triggerObjectsOnPathStep(u, step.row, step.col);
    }
    // Если капкан убил/обездвижил воина — оставшиеся клетки рывка
    // пропускаются. canUnitMove читает свежий immobilized, поставленный
    // handleTrapTrigger выше.
    if (!u.alive || (typeof canUnitMove === 'function' && !canUnitMove(u))) break;
  }

  const clsU = CLASSES[u.classId];
  log(`${clsU.name} (${u.team}) совершает рывок (${fromR},${fromC}) → (${lastR},${lastC})`, 'info');

  render();
  // Скорость ×2 относительно обычного движения (STEP_MS=370 → 185 мс/шаг).
  // Воин «прорывается» — это и есть смысл навыка; обычная ходьба слишком
  // медленная для динамичного скилла. Анимация идёт по фактически
  // пройденному пути (если рывок прервался капканом — анимация
  // остановится на клетке капкана).
  if (typeof playMoveAnimation === 'function') {
    playMoveAnimation(u.id, actualPath, { speedMul: 2 });
  }
  if (checkVictory()) { render(); return; }
}

/* L-образный путь от (sr,sc) к (tr,tc) — сначала по строкам (вверх/вниз),
   потом по столбцам (влево/вправо). Возвращает массив клеток ВКЛЮЧАЯ
   стартовую и финальную. Не учитывает блокеры — это намеренно для
   рывка («перепрыгивание»). Длина всегда = manhattan(s, t) + 1. */
function computeChargePath(sr, sc, tr, tc) {
  const path = [{ row: sr, col: sc }];
  let r = sr, c = sc;
  while (r !== tr) {
    r += (tr > r) ? 1 : -1;
    path.push({ row: r, col: c });
  }
  while (c !== tc) {
    c += (tc > c) ? 1 : -1;
    path.push({ row: r, col: c });
  }
  return path;
}

/* chargeRange(u, slotIdx) — общая точка для overlay и executor.
   moveRangeOf динамически зависит от effectiveStats(u).spd, поэтому
   зависит от баффов/дебаффов скорости. */
function chargeRange(u, slotIdx) {
  if (!u) return 0;
  const params = getUnitSkillParams(u, 'charge', slotIdx);
  const mr = (typeof moveRangeOf === 'function') ? moveRangeOf(u) : 0;
  const mul = (typeof params.rangeMul === 'number') ? params.rangeMul : 0;
  return Math.max(1, Math.ceil(mr * mul));
}

/* ================================================================
   === БЛОК ЩИТОМ (С18) ===========================================
   ================================================================
   Self-buff. delivery:'self_buff' + range:0 → подсветка только клетки
   воина (общая ветка self_buff в render-overlay). Без маны, кулдаун 4.
   Накладывает на самого воина эффект `shield_block` с damageReduction
   3/5/7. Эффект снимается в начале СЛЕДУЮЩЕГО хода через
   expireTurnStartEffects (см. core/effects.js, beginTurn). */
function executeShieldBlock(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'shield_block', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return; // self-only
  const params = getUnitSkillParams(u, 'shield_block', slotIdx);

  u.skillsUsedThisTurn.push('shield_block');
  applyCooldown(u, 'shield_block', params);
  onActiveSkillCast(u, 'shield_block');
  state.mode = null;

  const reduction = (params.damageReduction | 0) || 0;
  applyShieldBlock(target, reduction);

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === КРУГОВОЙ УДАР (С18) ========================================
   ================================================================
   Self-AoE по 8 СМЕЖНЫМ клеткам. delivery:'self_aoe' → новая ветка
   overlay подсвечивает 8 клеток вокруг воина, любой клик кастует.
   Урон = floor(weaponDamage(u) × tierMul), минимум 1. damageType
   с оружия. consumesBasicAttack:false. Кулдаун 3.

   Крит — отдельный ролл на каждую цель (как фаербол). Бьёт всех
   живых юнитов на 8 клетках, ВКЛЮЧАЯ союзников (friendly fire,
   осознанно — это AoE-«меч в круг»). Самого воина не бьёт (его
   клетка — центр, не входит в 8 смежных). */
function executeWhirlwind(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'whirlwind', slotIdx)) return;
  const params = getUnitSkillParams(u, 'whirlwind', slotIdx);

  // 8 смежных клеток (включая диагонали).
  const offsets = [
    [-1,-1],[-1, 0],[-1, 1],
    [ 0,-1],        [ 0, 1],
    [ 1,-1],[ 1, 0],[ 1, 1]
  ];
  const weapon = getUnitWeapon(u);
  if (!weapon) return; // воин без оружия физически не может
  const uStats = effectiveStats(u);
  // С2-предметы: учёт damage-аффиксов как и в обычной атаке (см. executeAttack).
  const baseDmg = weaponDamage(weapon, uStats, u);
  const mul = (typeof params.damageMul === 'number') ? params.damageMul : 0;
  const dmgPerTarget = Math.max(1, Math.floor(baseDmg * mul));

  u.skillsUsedThisTurn.push('whirlwind');
  applyCooldown(u, 'whirlwind', params);
  onActiveSkillCast(u, 'whirlwind');
  state.mode = null;

  const clsU = CLASSES[u.classId];
  const dmgType = weapon.damageType;
  const dmgDesc = describeDamage('aoe', dmgType);
  log(
    `${clsU.name} (${u.team}) кастует «${params.name}» [${dmgDesc}] · базовый урон ${dmgPerTarget} каждой цели в круге`,
    'info'
  );

  // Сбор живых целей на 8 клетках.
  const hits = [];
  for (const [dr, dc] of offsets) {
    const r = u.row + dr, c = u.col + dc;
    if (!inBounds(r, c)) continue;
    const t = unitAt(r, c);
    if (t && t.alive) hits.push(t);
  }

  // Урон каждой цели — отдельный ролл крита и отдельный computeIncomingDamage.
  for (const target of hits) {
    const crit = params.canCrit && rollCrit(u);
    const finalDmg = crit ? dmgPerTarget * 2 : dmgPerTarget;
    const adj = computeIncomingDamage(target, finalDmg, dmgType);
    const noteSuffix = adj.note ? ` (${adj.note})` : '';
    const selfTag = target.team === u.team ? ' (свой)' : '';
    log(
      `  ${CLASSES[target.classId].name} (${target.team}) — ${adj.dmg} ${dmgDesc} урона${selfTag}${noteSuffix}` + (crit ? ' — КРИТ!' : ''),
      crit ? 'crit' : 'damage'
    );
    applyDamage(target, adj.dmg, u);
  }

  render();
  for (const target of hits) {
    playHitAnimation(target.id, false, !target.alive);
  }
  if (checkVictory()) { render(); return; }
}


/* ================================================================
   === ВТОРОЕ ДЫХАНИЕ (С19) =======================================
   ================================================================
   Активный self-heal, раз за волну (НЕ cooldown). Лечение =
   ⌈healPct × maxHpOf(u)⌉, не выше maxHp. canActivateSkill уже
   блокирует повторный каст по unit.usedThisWave[skillId]; здесь
   только применяем лечение и ставим флаг через applyUsedThisWave. */
function executeSecondWind(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'second_wind', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'second_wind', slotIdx);

  u.skillsUsedThisTurn.push('second_wind');
  applyCooldown(u, 'second_wind', params);
  onActiveSkillCast(u, 'second_wind');
  applyUsedThisWave(u, 'second_wind');
  state.mode = null;

  const maxHp = maxHpOf(u);
  const heal = Math.min(maxHp - u.hp, Math.ceil(maxHp * (params.healPct || 0)));
  u.hp += Math.max(0, heal);

  const clsU = CLASSES[u.classId];
  if (heal > 0) {
    log(`${clsU.name} (${u.team}) — «Второе дыхание»: +${heal} HP`, 'info');
  } else {
    log(`${clsU.name} (${u.team}) — «Второе дыхание» применён, но HP уже на максимуме`, 'info');
  }

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === УКРЕПИТЬ БРОНЮ (С19) =======================================
   ================================================================
   Активный self-buff, кулдаун 5. Накладывает applyArmored(self, charges)
   с charges = 3/5/7 по тиру. */
function executeFortifyArmor(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'fortify_armor', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'fortify_armor', slotIdx);

  u.skillsUsedThisTurn.push('fortify_armor');
  applyCooldown(u, 'fortify_armor', params);
  onActiveSkillCast(u, 'fortify_armor');
  state.mode = null;

  const charges = (params.charges | 0) || 0;
  if (charges > 0) {
    applyArmored(target, charges);
  }

  render();
  if (checkVictory()) { render(); return; }
}


/* ================================================================
   === МАСКИРОВКА (С23) ===========================================
   ================================================================
   Активный self-buff (delivery:self_buff, range:0). Накладывает эффект
   camouflage через applyCamouflage(u, params.duration). Все три тира
   НЕ требуют непотраченных атаки/движения и НЕ завершают ход —
   баланс 06.05.2026.

   Длительность по тиру:
     • basic    — без duration в params → applyCamouflage без второго
                  аргумента → эффект с expiresAt:turnStart (1 AI-раунд).
     • advanced — duration:3 → remaining:3, тикает в концах своих ходов.
     • elite    — duration:5 → remaining:5.

   Снятие камуфляжа реализовано НЕ здесь:
     • executeAttack / executeMove → removeCamouflage с прямой причиной.
     • onActiveSkillCast → removeCamouflage при использовании ЛЮБОГО
       другого активного навыка (исключение — сама Маскировка).
   См. шапку SKILLS.camouflage для полного списка. */
function executeCamouflage(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'camouflage', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'camouflage', slotIdx);

  u.skillsUsedThisTurn.push('camouflage');
  applyCooldown(u, 'camouflage', params);
  state.mode = null;

  // duration берётся ТОЛЬКО из tier-params; если не задан — applyCamouflage
  // ставит expiresAt:turnStart (basic-режим). undefined корректно
  // пробрасывается — applyCamouflage его проверит через Number.isFinite.
  applyCamouflage(u, params.duration);

  // С23 (баланс 06.05.2026): onActiveSkillCast ниже сработает на каждый
  // другой execute-навык и снимет камуфляж, но для самой «Маскировки»
  // skillId==camouflage → проверка внутри пропустит снятие (иначе только
  // что наложенный эффект мгновенно слетел бы).
  if (typeof onActiveSkillCast === 'function') onActiveSkillCast(u, 'camouflage');

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ОБЩИЙ ХЕЛПЕР: дополнительная атака за ход (С20 + С21) =======
   ================================================================
   Извлечён в Сессии 21 из executeSecondAttack — чтобы «Вторая атака»
   воина и «Второй выстрел» лучника не разъехались. Делает три вещи
   на основании tier-параметров скилла:
     1. Сбрасывает actionsUsedThisTurn.attack=false (главный эффект).
     2. Если params.consumesMove — расходует движение этого хода.
     3. Если params.applySelfBuff — вызывает переданный buffApplier(u)
        (вызов отдельной apply*-функции; общая «таблица» здесь не
        нужна — каждый скилл точно знает, какой свой бафф ставить).

   Логирование, render, applyCooldown, skillsUsedThisTurn.push —
   остаются за caller'ом (это часть скилл-специфичного флоу). */
function enableExtraAttack(u, params, buffApplier) {
  if (!u || !params) return;
  if (u.actionsUsedThisTurn) u.actionsUsedThisTurn.attack = false;
  if (params.consumesMove && u.actionsUsedThisTurn) {
    u.actionsUsedThisTurn.move = true;
  }
  if (params.applySelfBuff && typeof buffApplier === 'function') {
    buffApplier(u);
  }
}

/* ================================================================
   === ВТОРАЯ АТАКА (С20) =========================================
   ================================================================
   Активный self-buff (delivery:'self_buff', range:0). Сбрасывает
   actionsUsedThisTurn.attack = false → игрок может атаковать ещё раз.
   Базовый ДОПОЛНИТЕЛЬНО ставит actionsUsedThisTurn.move = true (по
   правилу tier-флага consumesMove). Элитный накладывает на воина
   second_attack_buff (Сила/Удача +6 на следующую атаку — бафф
   снимается после первой же атаки носителя, см. С24).

   С21: общая логика выехала в enableExtraAttack(u, params, applier). */
function executeSecondAttack(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'second_attack', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'second_attack', slotIdx);

  u.skillsUsedThisTurn.push('second_attack');
  applyCooldown(u, 'second_attack', params);
  onActiveSkillCast(u, 'second_attack');
  state.mode = null;

  enableExtraAttack(u, params, applySecondAttackBuff);

  const clsU = CLASSES[u.classId];
  log(`${clsU.name} (${u.team}) — «Вторая атака»: возможность атаки восстановлена`, 'info');

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ДАЛЬНИЙ ВЫСТРЕЛ (С21) ======================================
   ================================================================
   Активный self-buff (delivery:'self_buff', range:0). Накладывает на
   лучника эффект long_shot_buff со statMods.weaponRangeBonus по тиру.
   Не сбрасывает атаку (это не second_shot), не расходует движение.
   Бафф спадает в endTurn носителя через expireTurnEndEffects. */
function executeLongShot(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'long_shot', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'long_shot', slotIdx);

  u.skillsUsedThisTurn.push('long_shot');
  applyCooldown(u, 'long_shot', params);
  onActiveSkillCast(u, 'long_shot');
  state.mode = null;

  const bonus = (params.weaponRangeBonus | 0) || 0;
  if (bonus > 0) {
    applyLongShotBuff(u, bonus);
  }

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ВТОРОЙ ВЫСТРЕЛ (С21) =======================================
   ================================================================
   Зеркало executeSecondAttack — общий путь через enableExtraAttack.
   Элитный тир ставит второй_shot_buff (через applySecondShotBuff). */
function executeSecondShot(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'second_shot', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'second_shot', slotIdx);

  u.skillsUsedThisTurn.push('second_shot');
  applyCooldown(u, 'second_shot', params);
  onActiveSkillCast(u, 'second_shot');
  state.mode = null;

  enableExtraAttack(u, params, applySecondShotBuff);

  const clsU = CLASSES[u.classId];
  log(`${clsU.name} (${u.team}) — «Второй выстрел»: возможность атаки восстановлена`, 'info');

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ПРОВОКАЦИЯ (С20) ===========================================
   ================================================================
   Активный self_aura. На каждого ВРАЖЕСКОГО юнита в манхэттене ≤range
   накладывается provoked (forcedTarget=u.id). Перезапись — полная
   (новая Провокация перебивает старый forcedTarget).

   Тиры различаются ТОЛЬКО радиусом (3/4/5). Бонусной брони на воина
   больше нет (правка 05.05.2026 — `armorCharges` убран из всех тиров
   skills.js).

   Снятие provoked происходит в AI после первого «вынужденного
   действия» (атака или шаг к forcedTarget) — см. consumeForcedMoveEffects
   и core/ai.js. */
function executeProvoke(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'provoke', slotIdx)) return;
  const params = getUnitSkillParams(u, 'provoke', slotIdx);
  const range = (params.range | 0) || 0;

  u.skillsUsedThisTurn.push('provoke');
  applyCooldown(u, 'provoke', params);
  onActiveSkillCast(u, 'provoke');
  state.mode = null;

  // Враги в манхэттене ≤range.
  const enemies = state.units.filter(t =>
    t.alive && t.team !== u.team &&
    isTargetInRange(u, t, range)
  );
  for (const e of enemies) {
    applyProvoked(e, u.id);
  }
  const clsU = CLASSES[u.classId];
  log(`${clsU.name} (${u.team}) кастует «Провокация» (радиус ${range}) — затронуто врагов: ${enemies.length}`, 'info');

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ПРИКРЫТЬ (С20) =============================================
   ================================================================
   Активный single-target свап позиций. delivery:'cover' — отдельная
   ветка overlay, подсветка возможных целей в радиусе params.range.
   Базовый/advanced — только союзники. Elite — любой живой юнит
   (allowEnemies:true).

   Запрет: оба участника должны быть НЕ immobilized (canUnitMove).
   Не расходует движение воина (только слот активного скилла).
   AoE-объекты на клетках НЕ триггерятся (это телепорт-свап). */
function executeCover(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'cover', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id === u.id) return;
  const params = getUnitSkillParams(u, 'cover', slotIdx);

  // Фильтр цели: для basic/advanced только союзник.
  if (!params.allowEnemies && target.team !== u.team) return;
  // Радиус.
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist <= 0 || dist > (params.range | 0)) return;
  // Запрет immobilized у обоих.
  if (typeof canUnitMove === 'function' && (!canUnitMove(u) || !canUnitMove(target))) return;

  u.skillsUsedThisTurn.push('cover');
  applyCooldown(u, 'cover', params);
  onActiveSkillCast(u, 'cover');
  state.mode = null;

  // Свап позиций.
  const uR = u.row, uC = u.col;
  u.row = target.row;
  u.col = target.col;
  target.row = uR;
  target.col = uC;

  const clsU = CLASSES[u.classId];
  const clsT = CLASSES[target.classId];
  log(`${clsU.name} (${u.team}) меняется местами с ${clsT.name} (${target.team})`, 'info');

  render();
  if (checkVictory()) { render(); return; }
}


/* ================================================================
   === ОТРАВЛЕННАЯ СТРЕЛА (С24) ===================================
   ================================================================
   Активный self-buff. Накладывает на лучника `poison_arrow_buff` со
   `applyOnHit:{id:'poisoned', duration}` и `expiresAt:'nextAttack'`.
   Бафф висит сколько угодно ходов до первой атаки носителя; на этой
   атаке consumeNextAttackEffects (см. core/effects.js, вызывается из
   executeAttack) снимет его и наложит «Отравлен» на цель. */
function executePoisonArrow(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'poison_arrow', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'poison_arrow', slotIdx);

  u.skillsUsedThisTurn.push('poison_arrow');
  applyCooldown(u, 'poison_arrow', params);
  onActiveSkillCast(u, 'poison_arrow');
  state.mode = null;

  const duration = (params.poisonDuration | 0) || 0;
  if (duration > 0) {
    applyPoisonArrowBuff(u, duration);
  }

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ГОРЯЩАЯ СТРЕЛА (С24) =======================================
   ================================================================
   Зеркало executePoisonArrow. */
function executeFireArrow(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'fire_arrow', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  if (target.id !== u.id) return;
  const params = getUnitSkillParams(u, 'fire_arrow', slotIdx);

  u.skillsUsedThisTurn.push('fire_arrow');
  applyCooldown(u, 'fire_arrow', params);
  onActiveSkillCast(u, 'fire_arrow');
  state.mode = null;

  const duration = (params.burnDuration | 0) || 0;
  if (duration > 0) {
    applyFireArrowBuff(u, duration);
  }

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === СВЯЩЕННИК — СЕССИЯ A (09.05.2026) ==========================
   ================================================================ */

function executeHealing(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'healing', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  const params = getUnitSkillParams(u, 'healing', slotIdx);
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > params.range) return;
  const tcls = CLASSES[target.classId] || {};
  if (tcls.unitType === 'mechanism') {
    log('Исцеление не действует на механизмы', 'system');
    return;
  }
  if (target.team !== u.team && target.id !== u.id) return;
  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('healing');
  applyCooldown(u, 'healing', params);
  onActiveSkillCast(u, 'healing');
  state.mode = null;
  const uStats = effectiveStats(u);
  const wis = uStats.wis | 0;
  const healAmount = (params.healBase | 0) + Math.floor(wis / 2);
  const hpMax = (typeof maxHpOf === 'function') ? maxHpOf(target) : target.hp;
  const before = target.hp;
  target.hp = Math.min(hpMax, target.hp + healAmount);
  const actualHeal = target.hp - before;
  const clsU = CLASSES[u.classId];
  const clsT = CLASSES[target.classId];
  const tName = (target.id === u.id) ? 'себя' : `${clsT.name} (${target.team})`;
  log(`${clsU.name} (${u.team}) исцеляет ${tName}: +${actualHeal} HP (${params.healBase}+floor(${wis}/2)=${healAmount}, ${target.hp}/${hpMax})`, 'info');
  render();
  if (checkVictory()) { render(); return; }
}

function executeBlessing(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'blessing', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  const params = getUnitSkillParams(u, 'blessing', slotIdx);
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > params.range) return;
  const tcls = CLASSES[target.classId] || {};
  const isAlly = (target.team === u.team) || target.id === u.id;
  const isCursable = (tcls.unitType === 'undead' || tcls.unitType === 'demon');
  if (!isAlly && !isCursable) {
    log('Благословение не действует на эту цель', 'system');
    return;
  }
  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('blessing');
  applyCooldown(u, 'blessing', params);
  onActiveSkillCast(u, 'blessing');
  state.mode = null;
  const lukDelta = (params.lukDelta | 0) || 0;
  const duration = (params.duration | 0) || 0;
  if (isAlly) {
    if (typeof applyBlessingBuff === 'function') applyBlessingBuff(target, lukDelta, duration);
  } else {
    if (typeof applyBlessingCurse === 'function') applyBlessingCurse(target, lukDelta, duration);
  }
  render();
  if (checkVictory()) { render(); return; }
}

function executePurifyTouch(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'purify_touch', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  const params = getUnitSkillParams(u, 'purify_touch', slotIdx);
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > params.range) return;
  if (target.team !== u.team && target.id !== u.id) return;
  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('purify_touch');
  applyCooldown(u, 'purify_touch', params);
  onActiveSkillCast(u, 'purify_touch');
  state.mode = null;
  let removed = 0;
  if (Array.isArray(target.effects) && target.effects.length) {
    const prevStats = effectiveStats(target);
    const toRemove = target.effects.filter(e => effectPolarityOf(e) === 'debuff');
    if (toRemove.length) {
      for (const eff of toRemove) {
        const idx = target.effects.indexOf(eff);
        if (idx >= 0) target.effects.splice(idx, 1);
        removed++;
      }
      clampResourcesAfterStatsChange(target, prevStats);
    }
  }
  const clsU = CLASSES[u.classId];
  const clsT = CLASSES[target.classId];
  const tName = (target.id === u.id) ? 'себя' : `${clsT.name} (${target.team})`;
  log(`${clsU.name} (${u.team}) — «Очищающее касание» на ${tName}: снято дебаффов ${removed}`, 'info');
  const immDur = (params.immunityDuration | 0) || 0;
  if (immDur > 0 && typeof applyPurifyImmunity === 'function') {
    applyPurifyImmunity(target);
  }
  render();
  if (checkVictory()) { render(); return; }
}

function executeHolyStrength(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'holy_strength', slotIdx)) return;
  if (targetId && targetId !== u.id) return;
  const params = getUnitSkillParams(u, 'holy_strength', slotIdx);
  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('holy_strength');
  applyCooldown(u, 'holy_strength', params);
  onActiveSkillCast(u, 'holy_strength');
  state.mode = null;
  const strBonus = (params.strBonus | 0) || 0;
  const stunChance = (params.stunChance | 0) || 0;
  const duration = (params.duration | 0) || 0;
  if (typeof applyHolyStrength === 'function') {
    applyHolyStrength(u, duration, strBonus, stunChance);
  }
  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === СВЯЩЕННИК — СЕССИЯ B (10.05.2026) ==========================
   ================================================================ */

/* Воскрешение. Цель — НАДГРОБИЕ (state.units с !alive) союзного героя
   в манхэттене ≤range. Ставит alive=true, isDying=false; восстанавливает
   ресурсы по тиру; назначает skipNextOwnTurn=true для пропуска ближайшего
   собственного хода. UI грейв-таргетинга — ветка delivery:'grave_target'
   в render-overlay.js. */
function executeResurrection(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'resurrection', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target) return;
  // Цель ДОЛЖНА быть мёртвой (надгробие), на дистанции ≤ params.range,
  // союзником, и героем (не монстром).
  if (target.alive) return;
  if (target.team !== u.team) return;
  const tcls = CLASSES[target.classId];
  if (!tcls || tcls.kind !== 'hero') return;
  const params = getUnitSkillParams(u, 'resurrection', slotIdx);
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > (params.range | 0)) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('resurrection');
  applyCooldown(u, 'resurrection', params);
  onActiveSkillCast(u, 'resurrection');
  state.mode = null;

  // Восстанавливаем юнита.
  target.alive = true;
  target.isDying = false;
  // Сбрасываем эффекты, чтобы не висели «мёртвые» дебаффы.
  target.effects = [];
  target.actionsUsedThisTurn = { move: false, attack: false };
  target.skillsUsedThisTurn = [];
  target.cooldowns = {};
  // Ресурсы по тиру: hpPercent/manaPercent от max. basic = 0/0 → ставим 1 HP минимум.
  const hpPct = (params.hpPercent | 0) || 0;
  const manaPct = (params.manaPercent | 0) || 0;
  const hpMax = (typeof maxHpOf === 'function') ? maxHpOf(target) : 1;
  const manaMax = (typeof maxManaOf === 'function') ? maxManaOf(target) : 0;
  target.hp = Math.max(1, Math.floor(hpMax * hpPct / 100));
  target.mana = Math.floor(manaMax * manaPct / 100);
  // Флаг: пропустить ближайший собственный ход (в beginTurn).
  target.skipNextOwnTurn = true;

  const clsU = CLASSES[u.classId];
  const tName = `${tcls.name} (${target.team})`;
  log(`${clsU.name} (${u.team}) воскрешает ${tName}: ${target.hp}/${hpMax} HP, ${target.mana}/${manaMax} маны (пропустит ближайший свой ход)`, 'info');

  render();
  if (checkVictory()) { render(); return; }
}

/* Священная броня. Цель — союзник на манхэттене ≤range; для elite-тира
   разрешён self (params.allowSelf). Накладывает holy_shield_buff
   (damageCap=1, expiresAt:'turnStart'). */
function executeHolyShield(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'holy_shield', slotIdx)) return;
  const target = getUnit(targetId);
  if (!target || !target.alive) return;
  const params = getUnitSkillParams(u, 'holy_shield', slotIdx);
  // Цель должна быть СОЮЗНИКОМ; сам — только если allowSelf=true (elite).
  if (target.team !== u.team) return;
  if (target.id === u.id && !params.allowSelf) return;
  const dist = Math.abs(target.row - u.row) + Math.abs(target.col - u.col);
  if (dist > (params.range | 0)) return;

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('holy_shield');
  applyCooldown(u, 'holy_shield', params);
  onActiveSkillCast(u, 'holy_shield');
  state.mode = null;

  if (typeof applyHolyShieldBuff === 'function') applyHolyShieldBuff(target);
  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === СВЯЩЕННИК — СЕССИЯ C (11.05.2026) ==========================
   ================================================================
   Волна света. AoE вокруг кастера (манхэттенский радиус), бьёт ТОЛЬКО
   undead/demon. На каждой попавшей цели — урон holy + «Напуган» на
   frightenedDuration ход.
   targetId здесь декоративный (UI кликает на любую клетку в радиусе или
   на каста; реальный target — все враги в радиусе). */
function executeLightWave(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'light_wave', slotIdx)) return;
  const params = getUnitSkillParams(u, 'light_wave', slotIdx);

  u.mana -= params.manaCost;
  triggerOnManaSpent(u, params.manaCost);
  u.skillsUsedThisTurn.push('light_wave');
  applyCooldown(u, 'light_wave', params);
  onActiveSkillCast(u, 'light_wave');
  state.mode = null;
  PreviewState.fireball = null;  // на случай если UI хранил превью

  // Один ролл крита на весь каст.
  const crit = params.canCrit && (typeof rollCrit === 'function') && rollCrit(u);
  // Формула: damageBase + ⌊wis / wisDivisor⌋. wisDivisor может быть 1.5 (elite).
  const uStats = effectiveStats(u);
  const wis = (uStats.wis | 0);
  const div = (typeof params.wisDivisor === 'number' && params.wisDivisor > 0) ? params.wisDivisor : 2;
  const baseDmg = (params.damageBase | 0) + Math.floor(wis / div);
  const dmg = crit ? baseDmg * 2 : baseDmg;

  const clsU = CLASSES[u.classId];
  const dmgDesc = (typeof describeDamage === 'function') ? describeDamage('aoe', params.damageType) : 'святой по площади';
  log(
    `${clsU.name} (${u.team}) кастует «Волна света» [${dmgDesc}] · радиус ${params.range} · урон ${baseDmg} (${params.damageBase | 0}+⌊${wis}/${div}⌋)` +
    (crit ? ' — КРИТ!' : ''),
    crit ? 'crit' : 'info'
  );

  // Цели — undead/demon в манхэттене ≤ range, в т.ч. через стены/деревья.
  const range = (params.range | 0);
  const dur = (params.frightenedDuration | 0) || 1;
  const targets = [];
  for (const t of state.units) {
    if (!t || !t.alive) continue;
    if (t.team === u.team) continue;
    const tcls = CLASSES[t.classId];
    if (!tcls) continue;
    if (tcls.unitType !== 'undead' && tcls.unitType !== 'demon') continue;
    const md = Math.abs(t.row - u.row) + Math.abs(t.col - u.col);
    if (md > range) continue;
    targets.push(t);
  }

  // Опционально: визуальная вспышка вокруг кастера (если render есть).
  if (typeof playFireballBlast === 'function') {
    // Используем тот же визуальный эффект (пока нет специфичного для light_wave);
    // центр — клетка кастера.
    playFireballBlast(u.row, u.col);
  }

  for (const t of targets) {
    const adj = computeIncomingDamage(t, dmg, params.damageType, { delivery: 'aoe', source: u });
    const noteSuffix = adj.note ? ` (${adj.note})` : '';
    log(`  ${CLASSES[t.classId].name} (${t.team}) — ${adj.dmg} ${dmgDesc} урона${noteSuffix}`, crit ? 'crit' : 'damage');
    applyDamage(t, adj.dmg, u);
    // Накладываем Напуган на выживших. applyFrightened сам пропустит мёртвых.
    if (t.alive && typeof applyFrightened === 'function') {
      applyFrightened(t, dur);
    }
  }

  render();
  if (checkVictory()) { render(); return; }
}

/* ================================================================
   === ПРИЗРАЧНЫЙ КРИК (Сессия Призрак, 12.05.2026) ===============
   ================================================================
   AI-only активный навык лидера группы «нежить». delivery:'self_cast' —
   подсветки клеток нет, цели подбираются глобально (см. ниже). Один раз
   за бой (onceWave:true) и бесплатный (manaCost:0). canActivateSkill
   уже проверяет оба условия; здесь — только применение эффекта.

   Что делает в момент каста:
     1. Переводит все живые юниты с unitType==='undead' и
        aggroState==='sleeping' в active. Включая союзников Призрака
        и любую нежить на доске (правило «вся нежить просыпается»);
        фильтр по team намеренно отсутствует.
     2. Накладывает «Оглушён» на duration ход(ов) на ВСЕХ живых
        ГЕРОЕВ (CLASSES[id].kind==='hero'), независимо от команды.
        applyStunned идёмпотентно стакает duration через
        applyDurationEffect — повторные крики (если бы их разрешили)
        просто продлят оглушение.

   Что НЕ делает:
     • Не наносит урон, не двигает.
     • Не будит союзников Призрака, если они уже active — это no-op.
     • Не оглушает самого Призрака и других нежить-юнитов.

   targetId здесь обязан быть u.id (self-cast). Если caller передал
   другой id — мы просто отыгрываем по u, как и другие self-навыки. */
function executeGhostlyScream(targetId) {
  const u = getActiveUnit();
  if (!u) return;
  const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
  if (!canActivateSkill(u, 'ghostly_scream', slotIdx)) return;
  const params = getUnitSkillParams(u, 'ghostly_scream', slotIdx);

  u.skillsUsedThisTurn.push('ghostly_scream');
  applyCooldown(u, 'ghostly_scream', params);
  onActiveSkillCast(u, 'ghostly_scream');
  if (typeof applyUsedThisWave === 'function') {
    applyUsedThisWave(u, 'ghostly_scream');
  }
  state.mode = null;

  const clsU = CLASSES[u.classId];
  log(`${clsU.name} (${u.team}) испускает «Призрачный крик»`, 'info');

  // Шаг 1: будим всех спящих нежить.
  let awoken = 0;
  for (const o of state.units) {
    if (!o || !o.alive) continue;
    const ocls = CLASSES[o.classId];
    if (!ocls || ocls.unitType !== 'undead') continue;
    if (o.aggroState !== 'sleeping') continue;
    o.aggroState = 'active';
    awoken++;
    const who = `${ocls.name} (${o.team})`;
    log(`  ${who} — пробуждён «Призрачным криком»`, 'info');
  }
  if (awoken === 0) {
    log(`  Спящей нежити на доске нет`, 'info');
  }

  // Шаг 2: оглушение всех живых героев. Фильтр по kind==='hero', а не по
  // team — на случай будущих «вражеских героев» или PvP-режима. Призрака
  // и других нежить-юнитов не оглушаем (это союзный навык поддержки).
  const dur = (params.stunDuration | 0) || 1;
  const heroes = state.units.filter(t => {
    if (!t || !t.alive) return false;
    const tcls = CLASSES[t.classId];
    return tcls && tcls.kind === 'hero';
  });
  for (const h of heroes) {
    if (typeof applyStunned === 'function') {
      applyStunned(h, dur);
    }
  }
  if (!heroes.length) {
    log(`  Героев на поле нет — крик ушёл в пустоту`, 'info');
  }

  render();
  if (checkVictory()) { render(); return; }
}
