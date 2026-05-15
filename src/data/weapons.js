/* weapons.js — реестр оружия и тонкие обёртки для доступа к его формуле.
   Что внутри:
     • WEAPONS — реестр всего оружия в игре. Поля каждой записи:
         id (строка-ключ, дублирует ключ объекта для удобства),
         name (русское название),
         icon (эмодзи fallback для plain-text тултипов и лога),
         spriteSrc (путь к pixel-art PNG для слота экипировки),
         range (дальность атаки в клетках, манхэттен),
         delivery (ключ из DELIVERY_TYPES — melee/ranged/aoe),
         damageType (ключ из DAMAGE_TYPES — physical/fire/...),
         formula ({ base, stat, divisor } — итоговый урон =
           base + ⌊stats[stat] / divisor⌋).
     • weaponDamage(weapon, stats) — итоговое число урона.
     • weaponFormulaText(weapon) — человекочитаемая «База 2 + Сила/2 (округл. вниз)».
     • weaponFormulaBreakdown(weapon, stats) — пошаговая подстановка
       «2 + ⌊6/2⌋ = 2 + 3 = 5» для тултипа.
     • getUnitWeapon(unit) — какое оружие сейчас «в руке» у юнита: берётся
       из unit.equipment.weapon (если есть) с фолбэком на CLASSES[id].defaultWeapon.
       Возвращает запись из WEAPONS или null.
   Что НЕ внутри:
     • Generic-хелперы calcFormulaDamage / describeFormula / describeFormulaBreakdown —
       в src/core/stats-calc.js (R10). Они подключаются ПОСЛЕ weapons.js
       в порядке script-тегов (data/ → core/), но вызовы из обёрток ниже
       резолвятся в момент ВЫЗОВА, а не определения, поэтому к моменту
       первого weaponDamage оба файла уже загружены.
     • Какое оружие у класса по умолчанию — на самом классе через
       CLASSES[id].defaultWeapon (см. src/data/classes.js).
     • Что с пустым слотом оружия — логика боя в src/core/combat.js.
   Где править параметры существующего оружия: тут, в нужной записи WEAPONS.
   Где добавить новое оружие: добавить запись в WEAPONS, проверить, что
     spriteSrc указывает на реальный файл в assets/sprites/, далее
     либо использовать через CLASSES[id].defaultWeapon, либо вешать через
     инвентарь (когда появится).
   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   WEAPONS, weaponDamage, weaponFormulaText, weaponFormulaBreakdown попадают
   в глобальный scope window.
*/

/* ================================================================
   === ОРУЖИЕ =====================================================
   ================================================================
   Оружие — данные. Базовая атака класса теперь полностью определяется
   экипированным оружием: дальность, формула урона, delivery и тип.
   Это задел под инвентарь: менять меч на жезл — значит менять строку
   данных, а не логику боя.

   Формула урона описывается символически полем formula = { base, stat,
   divisor }: итоговый урон = base + ⌊stats[stat] / divisor⌋. Из одного
   источника строится и само число (weaponDamage), и человекочитаемая
   форма «База 2 + Сила/2» (weaponFormulaText), и пошаговая подстановка
   «2 + ⌊6/2⌋ = 2 + 3 = 5» (weaponFormulaBreakdown). Так tooltip нельзя
   рассогласовать с реальной арифметикой — меняем формулу в одном месте.
   ================================================================ */
/* С3-предметы (07.05.2026): тиры баз и weaponType.
   • Поле `weaponType` группирует записи в семейство для класс-локов
     (например, warrior носит весь sword-семейство). Используется
     CLASSES[id].allowedWeaponTypes (см. data/classes.js).
   • Поле `tier` — индекс качества (1/2/3). Информационно для UI.
   • Поле `costPoints` — стоимость в очках сложности; читается
     cost-fitting генератором loot.js (S6). По дизайну (см. DESIGN.md)
     — 0/4/8 для тиров 1/2/3 у героического оружия.
   • Натуральное оружие монстров (claws, wolf_fangs) имеет `costPoints: 0`
     и собственный weaponType — оно не дропается, не входит в обычный
     allowedWeaponTypes у героев.
   • Делитель формулы константный по типу — меняется только база. */
const WEAPONS = {
  sword: {
    id: 'sword', name: 'Меч', icon: '🗡', spriteSrc: 'assets/sprites/sword.png',
    gender: 'm',
    weaponType: 'sword', tier: 1, costPoints: 0,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 2, stat: 'str', divisor: 2 }
  },
  heavy_sword: {
    id: 'heavy_sword', name: 'Тяжёлый меч', icon: '🗡',
    gender: 'm',
    spriteSrc: 'assets/sprites/heavy_sword.png',
    weaponType: 'sword', tier: 2, costPoints: 4,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 4, stat: 'str', divisor: 2 }
  },
  legendary_sword: {
    id: 'legendary_sword', name: 'Легендарный клинок', icon: '🗡',
    gender: 'm',
    spriteSrc: 'assets/sprites/legendary_sword.png',
    weaponType: 'sword', tier: 3, costPoints: 8,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 6, stat: 'str', divisor: 2 }
  },

  bow: {
    id: 'bow', name: 'Лук', icon: '🏹', spriteSrc: 'assets/sprites/bow.png',
    gender: 'm',
    weaponType: 'bow', tier: 1, costPoints: 0,
    range: 4, delivery: 'ranged', damageType: 'physical',
    formula: { base: 1, stat: 'dex', divisor: 2 }
  },
  composite_bow: {
    id: 'composite_bow', name: 'Композитный лук', icon: '🏹',
    gender: 'm',
    spriteSrc: 'assets/sprites/composite_bow.png',
    weaponType: 'bow', tier: 2, costPoints: 4,
    range: 4, delivery: 'ranged', damageType: 'physical',
    formula: { base: 3, stat: 'dex', divisor: 2 }
  },
  longbow: {
    id: 'longbow', name: 'Длинный лук', icon: '🏹',
    gender: 'm',
    spriteSrc: 'assets/sprites/longbow.png',
    weaponType: 'bow', tier: 3, costPoints: 8,
    range: 4, delivery: 'ranged', damageType: 'physical',
    formula: { base: 5, stat: 'dex', divisor: 2 }
  },

  staff: {
    // Иконка: кристальный шар — самый узнаваемый «магический инструмент»
    // в эмодзи. Волшебная палочка 🪄 визуально читается как короткий
    // прутик и в слоте экипировки терялась.
    id: 'staff', name: 'Жезл', icon: '🔮', spriteSrc: 'assets/sprites/staff.png',
    gender: 'm',
    weaponType: 'staff', tier: 1, costPoints: 0,
    range: 3, delivery: 'ranged', damageType: 'magic',
    formula: { base: 1, stat: 'wis', divisor: 3 }
  },
  magic_staff: {
    id: 'magic_staff', name: 'Магический посох', icon: '🔮',
    gender: 'm',
    spriteSrc: 'assets/sprites/magic_staff.png',
    weaponType: 'staff', tier: 2, costPoints: 4,
    range: 3, delivery: 'ranged', damageType: 'magic',
    formula: { base: 3, stat: 'wis', divisor: 3 }
  },
  archmage_staff: {
    id: 'archmage_staff', name: 'Посох архимага', icon: '🔮', spriteSrc: null,
    gender: 'm',
    weaponType: 'staff', tier: 3, costPoints: 8,
    range: 3, delivery: 'ranged', damageType: 'magic',
    formula: { base: 5, stat: 'wis', divisor: 3 }
  },

  /* Посохи священника (09.05.2026). Отдельный weaponType:'priest_staff'
     — мага и священника НЕ должны путать слотами: формулы у них
     разные (мага — magic/wis/ranged, священника — physical/str/melee).
     Одинаковые base=1/3/5 по тирам как у других trees. */
  priest_staff: {
    id: 'priest_staff', name: 'Посох', icon: '🪄',
    gender: 'm',
    spriteSrc: 'assets/sprites/priest_staff.png',
    weaponType: 'priest_staff', tier: 1, costPoints: 0,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 1, stat: 'str', divisor: 2 }
  },
  reinforced_staff: {
    id: 'reinforced_staff', name: 'Укреплённый посох', icon: '🪄',
    gender: 'm',
    spriteSrc: 'assets/sprites/reinforced_staff.png',
    weaponType: 'priest_staff', tier: 2, costPoints: 4,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 3, stat: 'str', divisor: 2 }
  },
  battle_staff: {
    id: 'battle_staff', name: 'Боевой посох', icon: '🪄',
    gender: 'm',
    spriteSrc: 'assets/sprites/battle_staff.png',
    weaponType: 'priest_staff', tier: 3, costPoints: 8,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 5, stat: 'str', divisor: 2 }
  },

  claws: {
    // Когти зомби — натуральное оружие монстра, не дропается.
    // weaponType: 'claws' гарантирует, что герои не получат класс-лок
    // на это оружие.
    id: 'claws', name: 'Когти', icon: '🪓', spriteSrc: 'assets/sprites/claws.png',
    gender: 'pl',
    weaponType: 'claws', tier: 1, costPoints: 0,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 2, stat: 'str', divisor: 2 }
  },
  wolf_fangs: {
    // Клыки волка — натуральное оружие группы «волки» (Волк, Волк-вожак).
    id: 'wolf_fangs', name: 'Клыки волка', icon: '🦷',
    gender: 'pl',
    spriteSrc: 'assets/sprites/wolf_fangs.png',
    weaponType: 'wolf_fangs', tier: 1, costPoints: 0,
    range: 1, delivery: 'melee', damageType: 'physical',
    formula: { base: 2, stat: 'str', divisor: 2 }
  },
  /* Призрачные когти (12.05.2026). Натуральное оружие Призрака (group:undead,
     лидер группы с 5-й волны). delivery:'melee' (range:1), но damageType:
     'magic' — урон вкладывается магической природой призрачной плоти,
     не блокируется fire_shield (там фильтр fire/frost). База 3 + Сила/2 —
     заметно выше обычных когтей (2 + Сила/2), чтобы при стартовой Силе 6 раздавать
     стабильно 6 урона за удар, и компенсировать отсутствие у Призрака
     второй атаки/яда. weaponType:'ghost_claws' — отдельный, в
     allowedWeaponTypes у героев его быть не должно. */
  ghost_claws: {
    id: 'ghost_claws', name: 'Призрачные когти', icon: '👻',
    gender: 'pl',
    spriteSrc: 'assets/sprites/ghost_claws.png',
    weaponType: 'ghost_claws', tier: 1, costPoints: 0,
    range: 1, delivery: 'melee', damageType: 'magic',
    formula: { base: 3, stat: 'str', divisor: 2 }
  }
};

/* Тонкие обёртки для читаемости на стороне оружия — код боя ничего не знает
   про обобщённые «формулы», он просит «урон оружия».
   Сами generic-хелперы calcFormulaDamage / describeFormula / describeFormulaBreakdown
   живут в src/core/stats-calc.js (R10). Они подключаются ПОСЛЕ weapons.js, но
   вызовы из обёрток ниже резолвятся в момент ВЫЗОВА — к этому моменту оба
   файла уже загружены.

   С2-предметы: третий параметр `unit` опциональный. Если передан, к
   итоговому урону прибавляется damage-бонус от аффиксов экипировки
   (через equipmentSpecialSum в core/stats-calc.js). Бонус — флэт +N к
   результату ВНУТРИ weaponDamage, поэтому он входит в «базовый удар»
   и удваивается критом наравне с базой оружия в executeAttack
   (`if (crit) dmg *= 2`). Это намеренно: damage-аффикс — часть оружия,
   не отдельная пассивка. Сравни с joint_hunt-бонусом, который
   прибавляется ПОСЛЕ крита и критом не удваивается (см. core/combat.js).
   Типовые модификаторы цели (computeIncomingDamage) применяются ко
   всему уже-критом-удвоенному числу. Если `unit` не передан — расчёт
   чистый по формуле, как раньше (для AI-оценки источника без юнита,
   тестов и т.п.).

   Damage-аффиксы по дизайну могут выпадать ТОЛЬКО на оружие
   (forbiddenSlots: ['armor', 'ring', 'amulet', 'consumable'] в data/affixes.js),
   но equipmentSpecialSum суммирует по всем слотам — это безопасно:
   если в будущем разрешим damage-аффикс на амулете, формула не
   потребует правки. Также суммирование терпит и другие источники
   (например, эффект «Подъём» через statMods.damage, если такой
   появится позже). */
function weaponDamage(weapon, stats, unit) {
  // Защита от инстансов без formula (например, кривой test-спавнер
  // или предмет, чей baseId не resolved'нулся в реестре). Без этой
  // ветки calcFormulaDamage(undefined,...) бросает исключение и
  // render() падает в панели юнита, оставляя последний кадр на экране.
  let base = (weapon && weapon.formula)
    ? calcFormulaDamage(weapon.formula, stats)
    : 0;
  if (unit && typeof equipmentSpecialSum === 'function') {
    base += equipmentSpecialSum(unit, 'damage');
    // Балансная правка 14.05.2026: medium_armor (лучник) даёт
    // attackDamageBonus 1/2/3 на базе. equipmentSpecialSum суммирует
    // поле напрямую с item-инстанса в слоте armor. Бонус попадает в
    // базу удара ⇒ удваивается критом (симметрично damage-аффиксу).
    base += equipmentSpecialSum(unit, 'attackDamageBonus');
  }
  return base;
}
function weaponFormulaText(weapon) {
  if (!weapon || !weapon.formula) return '—';
  return describeFormula(weapon.formula);
}
function weaponFormulaBreakdown(weapon, stats) {
  if (!weapon || !weapon.formula) return '—';
  return describeFormulaBreakdown(weapon.formula, stats);
}


/* Базовая атака юнита определяется его экипированным оружием.
   Слот `unit.equipment.weapon` может содержать:
     • id-строку из реестра WEAPONS (стартовый defaultWeapon класса
       либо id базового оружия из инвентаря) — резолвим через WEAPONS[id];
     • инстанс предмета (объект) — возвращаем как есть. Инстанс должен
       по форме совпадать с записью WEAPONS (поля name/icon/range/delivery/
       damageType/formula). С1-предметы: пока инстансы создаются вручную
       тестовым спавнером; в S3 появятся настоящие через генератор loot.js.
     • null/undefined — фолбэк на CLASSES[id].defaultWeapon (id-строка). */
function getUnitWeapon(unit) {
  const slot = unit && unit.equipment && unit.equipment.weapon;
  if (slot && typeof slot === 'object') return slot;
  const wid = slot || (CLASSES[unit.classId] && CLASSES[unit.classId].defaultWeapon);
  return wid ? (WEAPONS[wid] || null) : null;
}

/* Сессия 21: эффективная дальность атаки юнита.
   База — `weapon.range`. К ней прибавляется сумма всех
   `statMods.weaponRangeBonus` со ВСЕХ висящих эффектов носителя. Это
   НЕ обычный стат (нет в str/dex/...), поэтому в `effectiveStats` он
   намеренно не попадает — слишком специфичен. Вместо этого все читатели
   дальности атаки (combat: computeAttackTargets/Area; ai: aiAttackable*;
   render-panel: тултип атаки) ходят в weaponRangeOf(unit).

   Возвращает 0 если оружия нет. Минимум — 1 клетка для надетого оружия
   (даже если weaponRangeBonus отрицательный — отдалить меч на 0 клеток
   значит «не атаковать», это сейчас не нужный кейс).
*/
function weaponRangeOf(unit) {
  const w = getUnitWeapon(unit);
  if (!w) return 0;
  let bonus = 0;
  if (Array.isArray(unit.effects)) {
    for (const eff of unit.effects) {
      if (eff && eff.statMods && typeof eff.statMods.weaponRangeBonus === 'number') {
        bonus += eff.statMods.weaponRangeBonus;
      }
    }
  }
  return Math.max(1, (w.range | 0) + bonus);
}
