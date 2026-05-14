/* stats-calc.js — чистые функции расчёта производных значений от статов.
   Это «единственный источник правды» для арифметики, которой пользуются
   и UI (тултипы, секция «Характеристики»), и бой (формулы оружия и скиллов),
   и AI (оценки урона/добивания). Файл — без побочных эффектов: только
   чтение из переданных аргументов и из глобалов CLASSES/CLASS_PROGRESSIONS/
   STAT_LABELS.

   Что внутри:
     • Generic-формулы:
         calcFormulaDamage(formula, stats)         → число (база + ⌊stat/div⌋)
         describeFormula(formula)                  → текст «База 2 + Сила/2 (округл. вниз)»
         describeFormulaBreakdown(formula, stats)  → текст «2 + ⌊6/2⌋ = 2 + 3 = 5»
       Используются и оружием (через тонкие обёртки в weapons.js), и
       активными скиллами (фаербол: см. SKILLS.fireball.tiers[*].formula).
     • statsForLevel(classId, level) — базовые статы класса, прокачанные
       по правилу из CLASS_PROGRESSIONS. Без учёта эффектов/экипировки.
     • Производные значения per-unit (от ЭФФЕКТИВНЫХ статов):
         getBaseHp(classId)                        → CLASSES[id].baseHp
         maxHpOf(unit)                             → baseHp + Vit*2
         maxManaOf(unit)                           → 5 + Int*2
         moveRangeOf(unit)                         → 1 + ⌊(√(8·Spd+1) − 1)/2⌋
         critChanceOf(unit)                        → Luk
     • Учёт эффектов:
         effectiveStats(unit)                      → база + сумма мод-ов, clamp ≥0
         statBreakdown(unit)                       → детализация для тултипов
                                                     (для каждого стата —
                                                      base, [{name, delta}], total)
         aggregateStatMods(unit)                   → суммы мод-ов по ключам
                                                     (тонкая обёртка над statBreakdown)

   Что НЕ внутри:
     • Получение оружия юнита (`getUnitWeapon`) — это инвентарь/бой,
       остаётся в монолите, переедет в `core/combat.js` (R14) или отдельный
       `core/equipment.js`.
     • Расчёт ВХОДЯЩЕГО урона с учётом сопротивлений (`computeIncomingDamage`),
       применение урона (`applyDamage`) — `core/damage.js` (R11).
     • `STAT_LABELS`/`STAT_ICONS`/`STAT_ORDER` — это данные UI, лежат в
       `data/stats.js` (R5). describeFormula читает оттуда подпись.
     • `CLASSES`/`CLASS_PROGRESSIONS` — `data/classes.js` (R8).

   Где править: чтобы сменить формулу maxHpOf / moveRangeOf / etc — тут.
   Чтобы добавить новый эффект-модификатор стат — расширить `statBreakdown`
     одним if (см. задел «statMods на конкретные ключи»).
   Чтобы поменять generic-формулу `{ base, stat, divisor }` на что-то более
     сложное (мультипликативные, нелинейные) — менять обе:
     `calcFormulaDamage` и обе `describe*` (они должны оставаться
     согласованными — один и тот же формат символически и численно).

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   Все объявления попадают в глобальный scope window.

   Тонкость с порядком загрузки. Generic-формулы вызываются из тонких
   обёрток в `weapons.js` (`weaponDamage`/`weaponFormulaText`/
   `weaponFormulaBreakdown`) — те ссылаются на эти функции по имени, резолв
   в момент ВЫЗОВА. То же касается `effectiveStats` ↔ `aggregateStatMods` ↔
   `statBreakdown` (внутренние вызовы) — JS-хойстинг функций решает порядок
   объявлений в файле. STAT_LABELS / CLASSES / CLASS_PROGRESSIONS на момент
   первого вызова уже загружены (соответствующие data-скрипты идут раньше
   stats-calc.js в index.html).
*/

/* ================================================================
   === ОБЩИЕ ХЕЛПЕРЫ ФОРМУЛЫ ======================================
   ================================================================
   Общие хелперы формулы { base, stat, divisor }: base + ⌊stats[stat]/divisor⌋.
   Используются и оружием, и скиллами (фаербол теперь тоже по формуле).
   Если stats[stat] нет — считаем как 0, чтобы не падать на фаербол у не-мага
   или на оружии с опечаткой в stat. */
function calcFormulaDamage(formula, stats) {
  const { base, stat, divisor } = formula;
  return base + Math.floor((stats[stat] || 0) / divisor);
}
function describeFormula(formula) {
  const { base, stat, divisor } = formula;
  const label = STAT_LABELS[stat] || stat;
  return `База ${base} + ${label}/${divisor} (округл. вниз)`;
}
function describeFormulaBreakdown(formula, stats) {
  const { base, stat, divisor } = formula;
  const statVal = stats[stat] || 0;
  const contribution = Math.floor(statVal / divisor);
  const total = base + contribution;
  return `${base} + ⌊${statVal}/${divisor}⌋ = ${base} + ${contribution} = ${total}`;
}

/* Собрать итоговые статы юнита с учётом прокачки класса по уровню.
   Это «базовая» линия — без учёта эффектов/экипировки. Эффекты
   применяются поверх (см. effectiveStats()). */
function statsForLevel(classId, level) {
  const cls = CLASSES[classId];
  if (!cls) return {};
  const prog = CLASS_PROGRESSIONS[classId];
  return prog ? prog(cls.stats, level) : { ...cls.stats };
}

/* ================================================================
   === ПРОИЗВОДНЫЕ ЗНАЧЕНИЯ =======================================
   ================================================================
   Работают всегда от ЭФФЕКТИВНЫХ статов юнита (база + эффекты). Базовое
   HP теперь приходит из класса (CLASSES[classId].baseHp), поэтому у
   героев и монстров можно разный «запас живучести» до учёта Vit.
   ================================================================ */
function getBaseHp(classId) { return (CLASSES[classId] && CLASSES[classId].baseHp) || 0; }
function maxHpOf(unit)      { const s = effectiveStats(unit); return getBaseHp(unit.classId) + s.vit * 2; }
function maxManaOf(unit)    { const s = effectiveStats(unit); return 5 + s.int * 2; }
/* moveRangeOf(unit) — дальность хода в клетках за ход, манхэттенская.
   Треугольная цена (правка 06.05.2026, замена линейного 1+⌊Spd/2⌋).
   Формула: каждая k-я ДОПОЛНИТЕЛЬНАЯ клетка стоит k единиц Spd,
   суммарная стоимость k клеток = k(k+1)/2. Решаем k(k+1)/2 ≤ Spd
   → k = ⌊(√(8·Spd+1) − 1)/2⌋. Итог: 1 базовая клетка + k бонусных.

   Зачем нелинейная: при линейном росте после ~10 уровня прокачки
   герой мог пройти пол-карты за ход. С треугольной ценой каждая
   следующая клетка стоит ВСЁ ДОРОЖЕ — поздняя прокачка движения
   реальна, но требует серьёзного вложения в Spd.

   Таблица (Spd → range):
     0 → 1 | 1-2 → 2 | 3-5 → 3 | 6-9 → 4 | 10-14 → 5 | 15-20 → 6 |
     21-27 → 7 | 28-35 → 8 | 36-44 → 9 | 45-54 → 10 | 55-65 → 11

   Каскад: эта формула каскадно меняет дальность всего, что зависит
   от moveRangeOf — рывок воина (charge через rangeMul), круговой удар
   (whirlwind не зависит от дальности, но другие navigation-скиллы будут),
   скиллы с castRangeMul (см. core/combat.js). Это сознательное
   дизайн-решение: нелинейность нужна везде, где «дальность»
   считается от Spd. */
function moveRangeOf(unit) {
  const s = effectiveStats(unit);
  const spd = Math.max(0, s.spd);
  const k = Math.floor((Math.sqrt(8 * spd + 1) - 1) / 2);
  return 1 + k;
}
function critChanceOf(unit) {
  const s = effectiveStats(unit);
  let chance = s.luk;
  // Пассивка «Сокрушающая магия» (см. SKILLS.crushing_magic) добавляет
  // ⌊Мудрость × mult⌋ к шансу крита. mult зависит от тира: basic 1.0,
  // advanced 1.5, elite 2.0. Потолок 100%. Если пассивки нет — ветка
  // не активируется. На отрицательную luk сейчас не реагируем — это
  // отдельная половинка «промах», задел Сессии 8.
  // Читаем через `passiveSkillsOf` и `getPassiveSkillTier` (core/skills.js):
  // это единый канал, учитывающий override на инстансе (DevTools-выдача,
  // будущая прокачка) — не только классовый список.
  const sids = (typeof passiveSkillsOf === 'function')
    ? passiveSkillsOf(unit)
    : ((CLASSES[unit.classId] && CLASSES[unit.classId].passiveSkills) || []);
  if (Array.isArray(sids) && sids.includes('crushing_magic')) {
    const tier = (typeof getPassiveSkillTier === 'function')
      ? getPassiveSkillTier(unit, 'crushing_magic')
      : 'basic';
    const skill = SKILLS.crushing_magic;
    const tierData = skill && skill.tiers && skill.tiers[tier];
    if (tierData && typeof tierData.mult === 'number') {
      chance += Math.floor(s.wis * tierData.mult);
    }
  }
  // Сессия 21: пассивка «Меткий стрелок» лучника. Плоский бонус к крит-
  // шансу по тиру (5/10/15). Прибавляется ДО общего clamp'а — суммарный
  // потолок 100% уже задан clamp'ом ниже, явная проверка не нужна.
  // Тот же канал чтения, что у crushing_magic: passiveSkillsOf +
  // getPassiveSkillTier (учитывает override на инстансе).
  if (Array.isArray(sids) && sids.includes('marksman')) {
    const tier = (typeof getPassiveSkillTier === 'function')
      ? getPassiveSkillTier(unit, 'marksman')
      : 'basic';
    const skill = SKILLS.marksman;
    const tierData = skill && skill.tiers && skill.tiers[tier];
    if (tierData && typeof tierData.bonus === 'number') {
      chance += tierData.bonus;
    }
  }
  // Сессия 17: clamp в [-100, 100]. 100 — гарантированный крит, -100 —
  // гарантированный промах (когда эффекты вгонят luk в большой минус),
  // 0 — обычный удар. Раньше был только верхний потолок 100% (зашит
  // прямо в Сокрушающей магии); теперь это общая инфраструктура и
  // зеркальный пол -100 для будущих эффектов, понижающих Удачу.
  return Math.max(-100, Math.min(100, chance));
}

/* Эффективные статы = базовые u.stats + суммарные модификаторы от
   висящих на юните эффектов. Трупный яд уменьшает все статы на statMod,
   КРОМЕ Удачи (luk пропускается в statBreakdown — задел под механику
   «Удача выбивает из-под яда»). Другие эффекты с точечными модификаторами
   (statMods на конкретные ключи) расширяются в statBreakdown.
   Статы не опускаются ниже 0 — иначе формулы урона могут давать отрицат.
   числа, что лечило бы цель. */
function effectiveStats(unit) {
  const out = { ...unit.stats };
  const mods = aggregateStatMods(unit);
  for (const k of Object.keys(out)) {
    out[k] = Math.max(0, out[k] + (mods[k] || 0));
  }
  return out;
}

/* Полный разбор характеристик юнита: для каждого стата — база, список
   модификаторов от висящих эффектов (с именем эффекта и дельтой) и
   итоговое значение (clamp'ом в 0). Источник истины для всех мест,
   которым нужна детализация: для UI-тултипа в панели (сессия 2) и
   для aggregateStatMods (которая теперь делегирует сюда).
   Поддерживаются два типа модификаторов:
     • «ко всем статам одинаково» — eff.statMod (число), исключение
       Удачи хардкодом (corpse_poison);
     • «точечные» — eff.statMods (объект `{ ключ: delta, ... }`,
       без встроенных исключений по статам, для slowed и будущих
       эффектов вроде Концентрации манны).
   Если на эффекте есть оба поля — оба применяются (в практике
   эффекты используют что-то одно, см. DESIGN.md, Сессия 8). */
function statBreakdown(unit) {
  const base = unit.stats || {};
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] = { base: base[k], mods: [], total: base[k] };
  }
  if (unit.effects) {
    for (const eff of unit.effects) {
      if (eff.id === 'corpse_poison' && typeof eff.statMod === 'number' && eff.statMod !== 0) {
        for (const k of Object.keys(out)) {
          // Трупный яд не затрагивает Удачу — задел на механику
          // «удача выбивает из-под яда» (будет использоваться позже).
          if (k === 'luk') continue;
          out[k].mods.push({ name: eff.name, delta: eff.statMod });
        }
      }
      // Точечные stat-модификаторы (eff.statMods = { spd: -2, ... }).
      // В отличие от corpse_poison, у statMods нет встроенных исключений
      // по статам — какие ключи перечислены, такие и попадают в
      // детализацию ячеек «Характеристики». Если на эффекте есть и
      // statMod, и statMods — оба применяются (в практике эффекты
      // используют что-то одно, см. DESIGN.md, Сессия 8). Используется
      // эффектом «Замедлен» (statMods: { spd: -strength }) и будущими
      // точечными баффами (Концентрация манны → wis: +N, Сессия 15).
      if (eff.statMods && typeof eff.statMods === 'object') {
        for (const k of Object.keys(eff.statMods)) {
          const delta = eff.statMods[k];
          if (typeof delta !== 'number' || delta === 0) continue;
          if (!out[k]) continue;  // незнакомый ключ — игнор
          out[k].mods.push({ name: eff.name, delta });
        }
      }
    }
  }
  // С2-предметы: модификаторы от аффиксов экипировки. Каждый аффикс
  // отображается в детализации ОТДЕЛЬНОЙ строкой (как Замедлен), чтобы
  // игрок видел, какой именно «Сильный меч» дал ему +1 к Силе.
  // Регулярные stat-ключи (str/vit/dex/spd/wis/int/luk) попадают сюда;
  // спец-ключи (damage / hp_regen / mana_regen) НЕ относятся к статам и
  // обрабатываются отдельно (weaponDamage и triggerEquipmentRegen).
  if (unit.equipment) {
    const equipMods = collectEquipmentStatMods(unit);
    for (const entry of equipMods) {
      const { source, statMods } = entry;
      if (!statMods) continue;
      for (const k of Object.keys(statMods)) {
        const delta = statMods[k];
        if (typeof delta !== 'number' || delta === 0) continue;
        if (!out[k]) continue;  // незнакомый/спец-ключ — пропуск
        out[k].mods.push({ name: source, delta });
      }
    }
  }
  for (const k of Object.keys(out)) {
    const sum = out[k].mods.reduce((s, m) => s + m.delta, 0);
    out[k].total = Math.max(0, out[k].base + sum);
  }
  return out;
}

/* Собирает все stat-модификаторы от надетой экипировки юнита.
   Возвращает массив { source, statMods } — где source это
   человекочитаемое имя аффикса (для UI/тултипов), а statMods —
   объект `{ statKey: delta }`. Включаются ТОЛЬКО аффиксы (prefix/suffix)
   с инстансов предметов; статичные базы предметов на С2 статов не дают
   (это задел: появятся в S4 как `staticStats` у определённых тиров
   брони, например мантия мага с +Wis).

   Пропускаются:
     • слот weapon, если он id-string (defaultWeapon базового оружия —
       без инстанса, аффиксов нет);
     • слот consumable (расходники аффиксов не имеют по дизайну);
     • спец-ключи (damage / hp_regen / mana_regen) — обрабатываются
       отдельно (читатели — weaponDamage и triggerEquipmentRegen).

   Имена источника: имя аффикса (например, «Сильный») плюс краткое
   указание на слот, если предмет нанесён через несколько слотов.
   На С2 берём просто имя аффикса. */
function collectEquipmentStatMods(unit) {
  const out = [];
  if (!unit || !unit.equipment) return out;
  const SLOT_KEYS = ['weapon', 'armor', 'amulet', 'ring'];  // consumable пропущен
  const STAT_KEYS_REGULAR = { str: 1, vit: 1, dex: 1, spd: 1, wis: 1, int: 1, luk: 1 };
  for (const slot of SLOT_KEYS) {
    const e = unit.equipment[slot];
    if (!e || typeof e === 'string') continue;  // нет инстанса
    // Перебираем prefix и suffix.
    const affixIds = [e.prefix, e.suffix].filter(Boolean);
    for (const aid of affixIds) {
      const aff = (typeof AFFIXES === 'object' && AFFIXES) ? AFFIXES[aid] : null;
      if (!aff || !aff.statMods) continue;
      // Фильтруем только регулярные stat-ключи; спец-ключи отдадим
      // отдельным читателям.
      const filtered = {};
      let hasAny = false;
      for (const k of Object.keys(aff.statMods)) {
        if (!STAT_KEYS_REGULAR[k]) continue;
        const d = aff.statMods[k];
        if (typeof d !== 'number' || d === 0) continue;
        filtered[k] = d;
        hasAny = true;
      }
      if (!hasAny) continue;
      out.push({ source: aff.name, statMods: filtered });
    }
  }
  return out;
}

/* Сумма по конкретному «спец-ключу» (damage / hp_regen / mana_regen)
   от всех аффиксов на экипировке. Используется:
     • damage    — в weaponDamage (S2): прибавка к weapon.formula.base
                   ТОЛЬКО для оружия (аффикс damage по forbiddenSlots
                   падает только в weapon).
     • hp_regen  — в triggerEquipmentRegen (S2): +N HP в начале хода.
     • mana_regen— то же, но для маны.
   Если спец-ключа нигде нет — возвращает 0. */
function equipmentSpecialSum(unit, specialKey) {
  if (!unit || !unit.equipment || !specialKey) return 0;
  let sum = 0;
  const SLOT_KEYS = ['weapon', 'armor', 'amulet', 'ring'];
  for (const slot of SLOT_KEYS) {
    const e = unit.equipment[slot];
    if (!e || typeof e === 'string') continue;
    const affixIds = [e.prefix, e.suffix].filter(Boolean);
    for (const aid of affixIds) {
      const aff = (typeof AFFIXES === 'object' && AFFIXES) ? AFFIXES[aid] : null;
      if (!aff || !aff.statMods) continue;
      const v = aff.statMods[specialKey];
      if (typeof v === 'number') sum += v;
    }
  }
  return sum;
}

/* С2-предметы: регенерация HP и маны от аффиксов экипировки.
   Зовётся из beginTurn (core/turn.js) ПОСЛЕ глобального восполнения
   +1 маны и ДО фазы onTurnStart (DoT/Burning/Poisoned).

   Прирост: hp_regen и mana_regen суммируются с аффиксов всех слотов
   через equipmentSpecialSum. Каждый ресурс ограничен своим максимумом
   (maxHpOf / maxManaOf) — лечение «вверх» не идёт, лишнее теряется
   без логирования. Если ресурс уже на максимуме, регенерация молчит.
   Если регенерация активна и реально что-то восполнила — пишем строку
   в лог («+N HP (регенерация)»).

   Не работает на мёртвом юните. Не лечит «не свою» команду. У монстров
   без экипировки equipmentSpecialSum вернёт 0 — оверхед минимален. */
function triggerEquipmentRegen(unit) {
  if (!unit || !unit.alive) return;
  // HP regen.
  const hpGain = equipmentSpecialSum(unit, 'hp_regen');
  if (hpGain > 0) {
    const maxHp = (typeof maxHpOf === 'function') ? maxHpOf(unit) : (unit.hp || 0);
    if (unit.hp < maxHp) {
      const before = unit.hp;
      unit.hp = Math.min(maxHp, unit.hp + hpGain);
      const got = unit.hp - before;
      if (got > 0) {
        const cls = (typeof CLASSES === 'object' && CLASSES) ? CLASSES[unit.classId] : null;
        const who = cls ? `${cls.name} (${unit.team})` : unit.id;
        if (typeof log === 'function') log(`${who}: +${got} HP (регенерация экипировки)`, 'info');
      }
    }
  }
  // Mana regen.
  const manaGain = equipmentSpecialSum(unit, 'mana_regen');
  if (manaGain > 0) {
    const maxMana = (typeof maxManaOf === 'function') ? maxManaOf(unit) : (unit.mana || 0);
    if (unit.mana < maxMana) {
      const before = unit.mana;
      unit.mana = Math.min(maxMana, unit.mana + manaGain);
      const got = unit.mana - before;
      if (got > 0) {
        const cls = (typeof CLASSES === 'object' && CLASSES) ? CLASSES[unit.classId] : null;
        const who = cls ? `${cls.name} (${unit.team})` : unit.id;
        if (typeof log === 'function') log(`${who}: +${got} маны (регенерация экипировки)`, 'info');
      }
    }
  }
}

/* Сумма модификаторов статов от всех висящих эффектов. Обёртка над
   statBreakdown — та единственный обходчик эффектов, все места с
   модификаторами расширяются там. */
function aggregateStatMods(unit) {
  const mods = { str: 0, dex: 0, vit: 0, spd: 0, wis: 0, int: 0, luk: 0 };
  const bd = statBreakdown(unit);
  for (const k of Object.keys(mods)) {
    if (bd[k]) mods[k] = bd[k].mods.reduce((s, m) => s + m.delta, 0);
  }
  return mods;
}
