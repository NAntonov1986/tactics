/* loot.js (core/) — генератор предметов «по сложности» (С6-предметы 08.05.2026).

   Что внутри:
     • generateRewardItem(difficulty) — главная точка. Возвращает
       инстанс предмета или null (если для текущей сложности не
       сгенерировался ни один валидный вариант ни для одного типа).
     • _tryGenerateOfType(type, diff) — попытка сгенерировать предмет
       конкретного типа. Перебирает все базы, все валидные комбинации
       префикс+суффикс, выбирает варианты с total ≤ diff и максимальным
       total. Возвращает инстанс или null.
     • Внутренние хелперы: enumerate баз по типу, аффиксов по форме
       и слоту, сборка инстанса предмета.
     • __generateAndPlaceReward(diff) — DevTools-команда из консоли:
       генерирует и кладёт в state.partyInventory + render.

   Контракт инстанса (то, что возвращает generateRewardItem):
     {
       id: 'loot_<type>_<n>',     // уникальный для UI/tracking
       slotKind: 'weapon'|'armor'|'ring'|'amulet',
       baseId: <id из соответствующего реестра>,
       name: <русское имя базы>,
       icon: <emoji-fallback>,
       spriteSrc: <путь или null>,
       prefix: <id префикса или null>,
       suffix: <id суффикса или null>,
       baseCost: <базовая стоимость в очках>,
       costPoints: <та же базовая стоимость — для совместимости с UI>,
       // для weapon: range, delivery, damageType, formula, weaponType, tier
       // для armor:  armorType, armorFlat, tier
     }

   Алгоритм (резюме из DESIGN.md):
     1) Перемешиваем 4 типа [weapon, armor, ring, amulet]. Идём по списку.
     2) Для типа: enumerate все возможные (база, префикс, суффикс).
        - база: запись из соответствующего реестра с costPoints ≤ diff.
        - префикс/суффикс: AFFIXES с form='prefix'/'suffix', costPoints
          в пределах оставшегося бюджета, slotKind не в forbiddenSlots
          аффикса. Включается опция "null" (нет аффикса).
        - family-дедуп: если оба аффикса заданы, их семейства разные.
     3) Фильтр по требованию аффиксов:
        - weapon, ring, amulet — обязательно хоть один аффикс (минимум
          для дропа = cheapest affix cost = 2);
        - armor — может быть без аффиксов (минимум = base cost тира 1 = 2).
     4) Из оставшихся комбинаций выбираем те, у кого total максимален
        (но ≤ diff). При нескольких — случайный выбор.
     5) Если для этого типа нет ни одной валидной комбинации — переходим
        к следующему типу (всё ещё в случайном порядке).
     6) Если все 4 типа невалидны (например, diff < 2) — возвращаем null.

   Что НЕ внутри (задел):
     • Бюджет «больше, чем diff» — нет. Мы не overshoot, но можем
       undershoot если ровного попадания не нашлось (см. шаг 4).
     • Веса по подтипам (sword/bow/staff внутри weapon) — все базы
       weapon идут в общий пул, и сильнее weighted тот sub-type, у
       которого больше валидных комбинаций. Для текущих 3-3-3 тиров
       это близко к равномерному; в S6+ можно ввести явные веса.
     • Bias toward higher base tier — отложено до балансного пакета
       (см. DESIGN.md → «Возможные расширения»).

   Файл подключается в index.html ПОСЛЕ data/* и core/state.js.
   Потребители: state.js (forceWaveVictory → generateRewardItem,
   regenerateShopInventory → rollRewardForDifficulty). */

(function () {
  let _lootIdCounter = 0;

  function generateRewardItem(difficulty) {
    if (!Number.isFinite(difficulty) || difficulty < 1) return null;
    const types = ['weapon', 'armor', 'ring', 'amulet'];
    _shuffleInPlace(types);
    for (const type of types) {
      const result = _tryGenerateOfType(type, difficulty);
      if (result) return result;
    }
    return null;
  }

  function _tryGenerateOfType(type, diff) {
    const requiresAffix = (type !== 'armor');
    const bases = _basesForType(type);
    if (!bases.length) return null;
    const candidates = [];
    for (const base of bases) {
      const baseCost = base.costPoints | 0;
      if (baseCost > diff) continue;
      const affixBudget = diff - baseCost;
      // Префиксы: «нет префикса» + все валидные.
      const prefixOptions = [null].concat(_affixesByForm('prefix', type, affixBudget, base));
      for (const prefix of prefixOptions) {
        const prefixCost = prefix ? (prefix.costPoints | 0) : 0;
        const remainingForSuffix = affixBudget - prefixCost;
        const suffixOptions = [null].concat(_affixesByForm('suffix', type, remainingForSuffix, base));
        for (const suffix of suffixOptions) {
          // family-дедуп: если оба заданы — семейства разные.
          if (prefix && suffix && prefix.family === suffix.family) continue;
          // weapon/ring/amulet — обязательно ≥1 аффикс.
          if (requiresAffix && !prefix && !suffix) continue;
          const total = baseCost + prefixCost + (suffix ? (suffix.costPoints | 0) : 0);
          if (total > diff) continue;  // уже отсечено выше, защитная страховка
          candidates.push({ base, prefix, suffix, total });
        }
      }
    }
    if (!candidates.length) return null;
    // Выбираем варианты с максимальным total (но ≤ diff).
    let maxTotal = -Infinity;
    for (const c of candidates) if (c.total > maxTotal) maxTotal = c.total;
    const best = candidates.filter(c => c.total === maxTotal);
    const chosen = best[Math.floor(Math.random() * best.length)];
    return _buildInstance(type, chosen);
  }

  /* Доступные базы для типа. Натуральное оружие монстров (claws, wolf_fangs,
     ghost_claws и т.д.) исключаем из дропа — оно привязано к defaultWeapon
     монстра и ни один герой его не наденет.
     Фильтр (правка 14.05.2026): оружие включается, только если его
     weaponType хотя бы у одного героя-класса в allowedWeaponTypes.
     Так новое монстро-оружие отсекается автоматически, без правки
     этого файла. */
  function _basesForType(type) {
    if (type === 'weapon') {
      // Собираем все weaponType, которые хоть кто-то из героев может надеть.
      const heroWeaponTypes = new Set();
      if (typeof CLASSES === 'object' && CLASSES) {
        for (const cid of Object.keys(CLASSES)) {
          const cls = CLASSES[cid];
          if (!cls || cls.kind !== 'hero') continue;
          if (!Array.isArray(cls.allowedWeaponTypes)) continue;
          for (const wt of cls.allowedWeaponTypes) heroWeaponTypes.add(wt);
        }
      }
      const out = [];
      for (const id of Object.keys(WEAPONS)) {
        const w = WEAPONS[id];
        if (!w) continue;
        // Если фильтр по классам сработал — используем его. Иначе fallback
        // на explicit blacklist (на случай, если CLASSES не подгружен).
        if (heroWeaponTypes.size > 0) {
          if (!heroWeaponTypes.has(w.weaponType)) continue;
        } else {
          if (w.weaponType === 'claws' || w.weaponType === 'wolf_fangs' || w.weaponType === 'ghost_claws') continue;
        }
        out.push(w);
      }
      return out;
    }
    if (type === 'armor')  return Object.values(ARMORS);
    if (type === 'ring')   return Object.values(RINGS);
    if (type === 'amulet') return Object.values(AMULETS);
    return [];
  }

  /* Все аффиксы заданной формы (prefix/suffix), удовлетворяющие условиям:
       costPoints ≤ maxCost,
       slotKind не в forbiddenSlots.
     Возвращает массив записей AFFIXES (ссылки, не копии). */
  function _affixesByForm(form, slotKind, maxCost, base) {
    if (typeof AFFIXES !== 'object' || !AFFIXES) return [];
    if (maxCost < 0) return [];
    // Camp v1.5-affix-restrictions (09.05.2026): дополнительный фильтр
    // по weaponType / armorType базы — dex на меч воина, str на лук
    // лучника и т.п. отсекаются ещё на этапе генератора.
    const wt = base && base.weaponType;
    const at = base && base.armorType;
    const out = [];
    for (const id of Object.keys(AFFIXES)) {
      const a = AFFIXES[id];
      if (!a || a.form !== form) continue;
      if ((a.costPoints | 0) > maxCost) continue;
      if (Array.isArray(a.forbiddenSlots) && a.forbiddenSlots.includes(slotKind)) continue;
      if (wt && Array.isArray(a.forbiddenWeaponTypes) && a.forbiddenWeaponTypes.includes(wt)) continue;
      if (at && Array.isArray(a.forbiddenArmorTypes) && a.forbiddenArmorTypes.includes(at)) continue;
      out.push(a);
    }
    return out;
  }

  /* Финальная сборка инстанса предмета из выбранной комбинации. */
  function _buildInstance(type, chosen) {
    const { base, prefix, suffix } = chosen;
    _lootIdCounter += 1;
    const id = 'loot_' + type + '_' + _lootIdCounter;
    const inst = {
      id,
      slotKind: type,
      baseId: base.id,
      name: base.name,
      icon: base.icon || null,
      spriteSrc: base.spriteSrc || null,
      prefix: prefix ? prefix.id : null,
      suffix: suffix ? suffix.id : null,
      baseCost: base.costPoints | 0,
      costPoints: base.costPoints | 0,  // дублируем для UI и tooltip
      // Camp v1.5-affix-inflect (09.05.2026): род базы — нужен itemFullName
      // для согласования префикса (Сильный меч / Сильное кольцо).
      gender: base.gender || undefined
    };
    if (type === 'weapon') {
      inst.range = base.range;
      inst.delivery = base.delivery;
      inst.damageType = base.damageType;
      inst.formula = base.formula ? { ...base.formula } : null;
      inst.weaponType = base.weaponType;
      inst.tier = base.tier;
    } else if (type === 'armor') {
      inst.armorType = base.armorType;
      inst.armorFlat = base.armorFlat;
      inst.tier = base.tier;
    }
    return inst;
  }

  /* Fisher-Yates shuffle in-place. Отдельный helper, чтобы не тащить
     внешнюю зависимость. */
  function _shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /* DevTools-команда: генерирует предмет указанной сложности и кладёт
     в state.partyInventory. Зовётся из консоли:
       __generateAndPlaceReward(8)        // диф 8
       __generateAndPlaceReward(20)       // диф 20
     После добавления автоматически render(), чтобы открытый UI инвентаря
     обновился без рестарта. Возвращает инстанс или null. */
  function __generateAndPlaceReward(difficulty) {
    if (!state) return null;
    const item = generateRewardItem(difficulty);
    if (!item) {
      console.warn('[loot] generateRewardItem(' + difficulty + ') returned null — нет валидных комбинаций');
      return null;
    }
    if (typeof addToInventory === 'function') {
      addToInventory(item);
    } else {
      // Fallback на случай отсутствия хелпера (legacy путь).
      if (!Array.isArray(state.partyInventory)) state.partyInventory = [];
      state.partyInventory.push(item);
    }
    if (typeof itemFullName === 'function' && typeof log === 'function') {
      const fn = itemFullName(item);
      const cost = (typeof itemTotalCost === 'function') ? itemTotalCost(item) : item.costPoints;
      log(`DevTools: сгенерирован «${fn}» (стоимость ${cost})`, 'system');
    }
    if (typeof render === 'function') render();
    return item;
  }

  if (typeof window !== 'undefined') {
    window.generateRewardItem = generateRewardItem;
    window.__generateAndPlaceReward = __generateAndPlaceReward;
  }
})();
