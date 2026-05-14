/* affixes.js — реестр префиксов и суффиксов для системы предметов
   (С2-предметы, 07.05.2026).

   Что внутри:
     • AFFIXES — единый объект-реестр всех аффиксов. Ключ = id записи.
       Поля каждой записи:
         id              (строка-ключ, дублирует ключ объекта),
         family          (семейство: 'str'/'vit'/'dex'/'spd'/'wis'/'int'/
                          'luk'/'damage'/'hp_regen'/'mana_regen'),
         form            ('prefix' | 'suffix'),
         effectLevel     (1 | 2 | 3 — числовой уровень внутри семейства;
                          информационно, для генератора и UI),
         name            (русское имя; для prefix — прилагательное в м.р.,
                          для suffix — существительное в род.падеже),
         costPoints      (стоимость в очках сложности; используется
                          cost-fitting генератором loot.js в S6),
         statMods        ({ statKey: delta } — модификаторы характеристик
                          ИЛИ специальные ключи: 'damage' (флэт+урон оружия),
                          'hp_regen', 'mana_regen' — обрабатываются отдельно),
         forbiddenSlots  ([slotKind] — слоты, на которых аффикс выпасть
                          не может. По умолчанию пусто = можно везде).

   Что НЕ внутри:
     • Применение аффиксов к статам юнита — `equipmentStatMods(unit)` в
       core/stats-calc.js (S2).
     • Применение `damage`-аффиксов к weaponDamage — `data/weapons.js`
       расширяется чтением аффиксов с инстанса оружия (S2).
     • Регенерация HP/маны от аффиксов — новый триггер в `beginTurn`
       (`triggerEquipmentRegen`) перед `triggerEffectsAtTurnStart` (S2).
     • Cost-fitting генератор и family-дедуп при выборе аффиксов —
       `core/loot.js` (S6).
     • Class-локи на отдельные аффиксы — пока не используются; задел
       через `forbiddenSlots`.

   Стартовый набор (С2): 30 пар = 60 записей. Семейства и стоимости
   задокументированы в DESIGN.md → «Система предметов → Стартовый набор
   аффиксов». Если меняешь набор/имена — синхронизируй DESIGN.md.

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   AFFIXES попадает в глобальный scope window. */

const AFFIXES = {
  // ============ Семейство str (+Сила) ============
  // +1 / +2 / +3, цены 2 / 4 / 6.
  str_1_p:  { id: 'str_1_p',  family: 'str', form: 'prefix', effectLevel: 1, name: 'Сильный',     costPoints: 2, statMods: { str: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['bow', 'staff'], forbiddenArmorTypes: ['medium_armor', 'robe'] },
  str_1_s:  { id: 'str_1_s',  family: 'str', form: 'suffix', effectLevel: 1, name: 'Зверя',       costPoints: 2, statMods: { str: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['bow', 'staff'], forbiddenArmorTypes: ['medium_armor', 'robe'] },
  str_2_p:  { id: 'str_2_p',  family: 'str', form: 'prefix', effectLevel: 2, name: 'Могучий',     costPoints: 4, statMods: { str: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['bow', 'staff'], forbiddenArmorTypes: ['medium_armor', 'robe'] },
  str_2_s:  { id: 'str_2_s',  family: 'str', form: 'suffix', effectLevel: 2, name: 'Льва',        costPoints: 4, statMods: { str: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['bow', 'staff'], forbiddenArmorTypes: ['medium_armor', 'robe'] },
  str_3_p:  { id: 'str_3_p',  family: 'str', form: 'prefix', effectLevel: 3, name: 'Гигантский',  costPoints: 6, statMods: { str: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['bow', 'staff'], forbiddenArmorTypes: ['medium_armor', 'robe'] },
  str_3_s:  { id: 'str_3_s',  family: 'str', form: 'suffix', effectLevel: 3, name: 'Минотавра',   costPoints: 6, statMods: { str: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['bow', 'staff'], forbiddenArmorTypes: ['medium_armor', 'robe'] },

  // ============ Семейство vit (+Живучесть) ============
  vit_1_p:  { id: 'vit_1_p',  family: 'vit', form: 'prefix', effectLevel: 1, name: 'Крепкий',       costPoints: 2, statMods: { vit: 1 }, forbiddenSlots: [] },
  vit_1_s:  { id: 'vit_1_s',  family: 'vit', form: 'suffix', effectLevel: 1, name: 'Медведя',       costPoints: 2, statMods: { vit: 1 }, forbiddenSlots: [] },
  vit_2_p:  { id: 'vit_2_p',  family: 'vit', form: 'prefix', effectLevel: 2, name: 'Стойкий',       costPoints: 4, statMods: { vit: 2 }, forbiddenSlots: [] },
  vit_2_s:  { id: 'vit_2_s',  family: 'vit', form: 'suffix', effectLevel: 2, name: 'Дуба',          costPoints: 4, statMods: { vit: 2 }, forbiddenSlots: [] },
  vit_3_p:  { id: 'vit_3_p',  family: 'vit', form: 'prefix', effectLevel: 3, name: 'Несокрушимый',  costPoints: 6, statMods: { vit: 3 }, forbiddenSlots: [] },
  vit_3_s:  { id: 'vit_3_s',  family: 'vit', form: 'suffix', effectLevel: 3, name: 'Гранита',       costPoints: 6, statMods: { vit: 3 }, forbiddenSlots: [] },

  // ============ Семейство dex (+Ловкость) ============
  dex_1_p:  { id: 'dex_1_p',  family: 'dex', form: 'prefix', effectLevel: 1, name: 'Ловкий',     costPoints: 2, statMods: { dex: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'staff', 'priest_staff'], forbiddenArmorTypes: ['heavy_armor', 'robe', 'priest_robe'] },
  dex_1_s:  { id: 'dex_1_s',  family: 'dex', form: 'suffix', effectLevel: 1, name: 'Кошки',      costPoints: 2, statMods: { dex: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'staff', 'priest_staff'], forbiddenArmorTypes: ['heavy_armor', 'robe', 'priest_robe'] },
  dex_2_p:  { id: 'dex_2_p',  family: 'dex', form: 'prefix', effectLevel: 2, name: 'Меткий',     costPoints: 4, statMods: { dex: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'staff', 'priest_staff'], forbiddenArmorTypes: ['heavy_armor', 'robe', 'priest_robe'] },
  dex_2_s:  { id: 'dex_2_s',  family: 'dex', form: 'suffix', effectLevel: 2, name: 'Орла',       costPoints: 4, statMods: { dex: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'staff', 'priest_staff'], forbiddenArmorTypes: ['heavy_armor', 'robe', 'priest_robe'] },
  dex_3_p:  { id: 'dex_3_p',  family: 'dex', form: 'prefix', effectLevel: 3, name: 'Точный',     costPoints: 6, statMods: { dex: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'staff', 'priest_staff'], forbiddenArmorTypes: ['heavy_armor', 'robe', 'priest_robe'] },
  dex_3_s:  { id: 'dex_3_s',  family: 'dex', form: 'suffix', effectLevel: 3, name: 'Сокола',     costPoints: 6, statMods: { dex: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'staff', 'priest_staff'], forbiddenArmorTypes: ['heavy_armor', 'robe', 'priest_robe'] },

  // ============ Семейство spd (+Скорость) ============
  spd_1_p:  { id: 'spd_1_p',  family: 'spd', form: 'prefix', effectLevel: 1, name: 'Быстрый',         costPoints: 2, statMods: { spd: 1 }, forbiddenSlots: [] },
  spd_1_s:  { id: 'spd_1_s',  family: 'spd', form: 'suffix', effectLevel: 1, name: 'Ветра',           costPoints: 2, statMods: { spd: 1 }, forbiddenSlots: [] },
  spd_2_p:  { id: 'spd_2_p',  family: 'spd', form: 'prefix', effectLevel: 2, name: 'Стремительный',   costPoints: 4, statMods: { spd: 2 }, forbiddenSlots: [] },
  spd_2_s:  { id: 'spd_2_s',  family: 'spd', form: 'suffix', effectLevel: 2, name: 'Стрижа',          costPoints: 4, statMods: { spd: 2 }, forbiddenSlots: [] },
  spd_3_p:  { id: 'spd_3_p',  family: 'spd', form: 'prefix', effectLevel: 3, name: 'Молниеносный',    costPoints: 6, statMods: { spd: 3 }, forbiddenSlots: [] },
  spd_3_s:  { id: 'spd_3_s',  family: 'spd', form: 'suffix', effectLevel: 3, name: 'Молнии',          costPoints: 6, statMods: { spd: 3 }, forbiddenSlots: [] },

  // ============ Семейство wis (+Мудрость) ============
  // Правка по запросу: «Прозорливый» (+1) и «Мудрый» (+2) поменялись местами.
  wis_1_p:  { id: 'wis_1_p',  family: 'wis', form: 'prefix', effectLevel: 1, name: 'Прозорливый',  costPoints: 2, statMods: { wis: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  wis_1_s:  { id: 'wis_1_s',  family: 'wis', form: 'suffix', effectLevel: 1, name: 'Совы',         costPoints: 2, statMods: { wis: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  wis_2_p:  { id: 'wis_2_p',  family: 'wis', form: 'prefix', effectLevel: 2, name: 'Мудрый',       costPoints: 4, statMods: { wis: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  wis_2_s:  { id: 'wis_2_s',  family: 'wis', form: 'suffix', effectLevel: 2, name: 'Старца',       costPoints: 4, statMods: { wis: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  wis_3_p:  { id: 'wis_3_p',  family: 'wis', form: 'prefix', effectLevel: 3, name: 'Просветлённый',costPoints: 6, statMods: { wis: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  wis_3_s:  { id: 'wis_3_s',  family: 'wis', form: 'suffix', effectLevel: 3, name: 'Оракула',      costPoints: 6, statMods: { wis: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },

  // ============ Семейство int (+Интеллект) ============
  // Правка по запросу: «Толковый» (+1) и «Умный» (+2) поменялись местами.
  int_1_p:  { id: 'int_1_p',  family: 'int', form: 'prefix', effectLevel: 1, name: 'Толковый',    costPoints: 2, statMods: { int: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  int_1_s:  { id: 'int_1_s',  family: 'int', form: 'suffix', effectLevel: 1, name: 'Школяра',     costPoints: 2, statMods: { int: 1 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  int_2_p:  { id: 'int_2_p',  family: 'int', form: 'prefix', effectLevel: 2, name: 'Умный',       costPoints: 4, statMods: { int: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  int_2_s:  { id: 'int_2_s',  family: 'int', form: 'suffix', effectLevel: 2, name: 'Магистра',    costPoints: 4, statMods: { int: 2 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  int_3_p:  { id: 'int_3_p',  family: 'int', form: 'prefix', effectLevel: 3, name: 'Гениальный',  costPoints: 6, statMods: { int: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  int_3_s:  { id: 'int_3_s',  family: 'int', form: 'suffix', effectLevel: 3, name: 'Гения',       costPoints: 6, statMods: { int: 3 }, forbiddenSlots: [], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },

  // ============ Семейство luk (+Удача) ============
  // Правка по запросу: «Везучий» (+1) и «Счастливый» (+2) поменялись местами.
  luk_1_p:  { id: 'luk_1_p',  family: 'luk', form: 'prefix', effectLevel: 1, name: 'Везучий',         costPoints: 2, statMods: { luk: 1 }, forbiddenSlots: [] },
  luk_1_s:  { id: 'luk_1_s',  family: 'luk', form: 'suffix', effectLevel: 1, name: 'Удачи',           costPoints: 2, statMods: { luk: 1 }, forbiddenSlots: [] },
  luk_2_p:  { id: 'luk_2_p',  family: 'luk', form: 'prefix', effectLevel: 2, name: 'Счастливый',      costPoints: 4, statMods: { luk: 2 }, forbiddenSlots: [] },
  luk_2_s:  { id: 'luk_2_s',  family: 'luk', form: 'suffix', effectLevel: 2, name: 'Фортуны',         costPoints: 4, statMods: { luk: 2 }, forbiddenSlots: [] },
  luk_3_p:  { id: 'luk_3_p',  family: 'luk', form: 'prefix', effectLevel: 3, name: 'Благословенный',  costPoints: 6, statMods: { luk: 3 }, forbiddenSlots: [] },
  luk_3_s:  { id: 'luk_3_s',  family: 'luk', form: 'suffix', effectLevel: 3, name: 'Триумфа',         costPoints: 6, statMods: { luk: 3 }, forbiddenSlots: [] },

  // ============ Семейство damage (+флэт-урон оружия) ============
  // Аффиксы только на оружие — forbiddenSlots блокирует остальные.
  // Прибавка читается из weaponDamage(): item.statMods.damage суммируется
  // в weapon.formula.base в момент атаки.
  dmg_1_p:  { id: 'dmg_1_p',  family: 'damage', form: 'prefix', effectLevel: 1, name: 'Жестокий',     costPoints: 2, statMods: { damage: 1 }, forbiddenSlots: ['armor', 'ring', 'amulet', 'consumable'] },
  dmg_1_s:  { id: 'dmg_1_s',  family: 'damage', form: 'suffix', effectLevel: 1, name: 'Удара',        costPoints: 2, statMods: { damage: 1 }, forbiddenSlots: ['armor', 'ring', 'amulet', 'consumable'] },
  dmg_2_p:  { id: 'dmg_2_p',  family: 'damage', form: 'prefix', effectLevel: 2, name: 'Беспощадный',  costPoints: 4, statMods: { damage: 2 }, forbiddenSlots: ['armor', 'ring', 'amulet', 'consumable'] },
  dmg_2_s:  { id: 'dmg_2_s',  family: 'damage', form: 'suffix', effectLevel: 2, name: 'Резни',        costPoints: 4, statMods: { damage: 2 }, forbiddenSlots: ['armor', 'ring', 'amulet', 'consumable'] },
  dmg_3_p:  { id: 'dmg_3_p',  family: 'damage', form: 'prefix', effectLevel: 3, name: 'Смертоносный', costPoints: 6, statMods: { damage: 3 }, forbiddenSlots: ['armor', 'ring', 'amulet', 'consumable'] },
  dmg_3_s:  { id: 'dmg_3_s',  family: 'damage', form: 'suffix', effectLevel: 3, name: 'Палача',       costPoints: 6, statMods: { damage: 3 }, forbiddenSlots: ['armor', 'ring', 'amulet', 'consumable'] },

  // ============ Семейство hp_regen (+регенерация HP в начале хода) ============
  // На любые слоты кроме расходника. Сложение: если на одном предмете
  // несколько hp_regen — суммируются (но family-дедуп при equip это
  // запрещает: на одном предмете семейство только одно).
  hpreg_1_p: { id: 'hpreg_1_p', family: 'hp_regen', form: 'prefix', effectLevel: 1, name: 'Лечащий',     costPoints: 4, statMods: { hp_regen: 1 }, forbiddenSlots: ['consumable'] },
  hpreg_1_s: { id: 'hpreg_1_s', family: 'hp_regen', form: 'suffix', effectLevel: 1, name: 'Заживления',  costPoints: 4, statMods: { hp_regen: 1 }, forbiddenSlots: ['consumable'] },
  hpreg_2_p: { id: 'hpreg_2_p', family: 'hp_regen', form: 'prefix', effectLevel: 2, name: 'Живительный', costPoints: 8, statMods: { hp_regen: 2 }, forbiddenSlots: ['consumable'] },
  hpreg_2_s: { id: 'hpreg_2_s', family: 'hp_regen', form: 'suffix', effectLevel: 2, name: 'Жизни',       costPoints: 8, statMods: { hp_regen: 2 }, forbiddenSlots: ['consumable'] },
  hpreg_3_p: { id: 'hpreg_3_p', family: 'hp_regen', form: 'prefix', effectLevel: 3, name: 'Бессмертный', costPoints: 12, statMods: { hp_regen: 3 }, forbiddenSlots: ['consumable'] },
  hpreg_3_s: { id: 'hpreg_3_s', family: 'hp_regen', form: 'suffix', effectLevel: 3, name: 'Феникса',     costPoints: 12, statMods: { hp_regen: 3 }, forbiddenSlots: ['consumable'] },

  // ============ Семейство mana_regen (+регенерация маны в начале хода) ============
  // ВАЖНО (правка 12.05.2026): на оружии типа sword/bow и броне типа
  // heavy_armor/medium_armor аффикс не выпадает — это инвентарь воина
  // и лучника, у которых маны нет, и аффикс был бы мёртвым. Маг
  // (staff/robe) и священник (priest_staff/priest_robe) — целевые
  // классы, у них фильтры пропускают. На кольце/амулете ограничения
  // нет: амулет с реген-маной может попасть на воина, но дальше быть
  // передан магу. Симметрично с wis/int — теми же типами заблокированы.
  mareg_1_p: { id: 'mareg_1_p', family: 'mana_regen', form: 'prefix', effectLevel: 1, name: 'Зачарованный', costPoints: 4,  statMods: { mana_regen: 1 }, forbiddenSlots: ['consumable'], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  mareg_1_s: { id: 'mareg_1_s', family: 'mana_regen', form: 'suffix', effectLevel: 1, name: 'Источника',    costPoints: 4,  statMods: { mana_regen: 1 }, forbiddenSlots: ['consumable'], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  mareg_2_p: { id: 'mareg_2_p', family: 'mana_regen', form: 'prefix', effectLevel: 2, name: 'Магический',   costPoints: 8,  statMods: { mana_regen: 2 }, forbiddenSlots: ['consumable'], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  mareg_2_s: { id: 'mareg_2_s', family: 'mana_regen', form: 'suffix', effectLevel: 2, name: 'Чародея',      costPoints: 8,  statMods: { mana_regen: 2 }, forbiddenSlots: ['consumable'], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  mareg_3_p: { id: 'mareg_3_p', family: 'mana_regen', form: 'prefix', effectLevel: 3, name: 'Эфирный',      costPoints: 12, statMods: { mana_regen: 3 }, forbiddenSlots: ['consumable'], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] },
  mareg_3_s: { id: 'mareg_3_s', family: 'mana_regen', form: 'suffix', effectLevel: 3, name: 'Архимага',     costPoints: 12, statMods: { mana_regen: 3 }, forbiddenSlots: ['consumable'], forbiddenWeaponTypes: ['sword', 'bow'], forbiddenArmorTypes: ['heavy_armor', 'medium_armor'] }
};

/* ================================================================
   === ХЕЛПЕРЫ РАБОТЫ С АФФИКСАМИ =================================
   ================================================================ */

/* Возвращает список всех аффиксов, надетых на инстанс предмета.
   Инстанс хранит prefix/suffix как id-строки (либо null). */
function itemAffixes(item) {
  if (!item) return [];
  const out = [];
  if (item.prefix && AFFIXES[item.prefix]) out.push(AFFIXES[item.prefix]);
  if (item.suffix && AFFIXES[item.suffix]) out.push(AFFIXES[item.suffix]);
  return out;
}

/* Camp v1.5-affix-inflect (09.05.2026): склонение префикса-прилагательного
   по роду базы. Префиксы хранятся в мужском роде («Крепкий») и должны
   согласовываться с базой по роду:
     m  — Крепкий меч        (мужской)
     f  — Крепкая кольчуга   (женский, кончается на -а/-я)
     n  — Крепкое кольцо     (средний, кончается на -о/-е)
     pl — Крепкие когти      (множ. число)

   Алгоритм:
   1. Определяем стем — отрезаем от хвоста «ый» / «ий» / «ой».
   2. Окончания: f='ая', n='ое'. Plural — 'ие' если стем оканчивается
      на к/г/х/ж/ш/ч/щ (правило «после шипящих/гг — пишем И»),
      иначе 'ые'.

   Для нерегулярных прилагательных (если такие появятся) — допустим
   override через поле `nameForms` на самом аффиксе:
     { m: '...', f: '...', n: '...', pl: '...' }
   Если override есть — используем; иначе вычисляем алгоритмически. */
// Camp v1.5-affix-inflect: правила орфографии после согласных стема.
//   После к/г/х/ж/ш/ч/щ во множ. числе пишется «и», не «ы» (Жестокие, Могучие).
//   После ж/ш/ч/щ в безударном среднем роде пишется «е», не «о» (Могучее, Лечащее).
//   В женском роде универсально «ая» (после ж/ш/ч/щ — «а», не «я», что уже совпадает).
const _PLURAL_I_LETTERS = new Set(['к', 'г', 'х', 'ж', 'ш', 'ч', 'щ']);
const _NEUTER_E_LETTERS = new Set(['ж', 'ш', 'ч', 'щ']);
function inflectPrefix(name, gender) {
  if (!name) return '';
  if (!gender || gender === 'm') return name;
  const last2 = name.slice(-2);
  if (last2 !== 'ый' && last2 !== 'ий' && last2 !== 'ой') return name;
  const stem = name.slice(0, -2);
  const lastStem = stem.slice(-1);
  if (gender === 'f')  return stem + 'ая';
  if (gender === 'n')  return stem + (_NEUTER_E_LETTERS.has(lastStem) ? 'ее' : 'ое');
  if (gender === 'pl') return stem + (_PLURAL_I_LETTERS.has(lastStem) ? 'ие' : 'ые');
  return name;
}

/* Полное «отображаемое» имя предмета с учётом prefix/suffix.
   Префикс — впереди в виде прилагательного, суффикс — после базы в род.падеже.
   Пример: «Сильный меч резни», «Лук силы», «Меч».
   Camp v1.5-affix-inflect (09.05.2026): префикс склоняется по item.gender
   (или gender базы из реестра WEAPONS/ARMORS/RINGS/AMULETS). */
function itemFullName(item) {
  if (!item) return '';
  const baseName = item.name || item.id || '?';
  const prefAff = item.prefix && AFFIXES[item.prefix] ? AFFIXES[item.prefix] : null;
  const sufAff  = item.suffix && AFFIXES[item.suffix] ? AFFIXES[item.suffix] : null;
  let gender = item.gender;
  if (!gender && item.baseId) {
    if (item.slotKind === 'weapon' && typeof WEAPONS !== 'undefined' && WEAPONS[item.baseId]) {
      gender = WEAPONS[item.baseId].gender;
    } else if (item.slotKind === 'armor' && typeof ARMORS !== 'undefined' && ARMORS[item.baseId]) {
      gender = ARMORS[item.baseId].gender;
    } else if (item.slotKind === 'ring' && typeof RINGS !== 'undefined' && RINGS[item.baseId]) {
      gender = RINGS[item.baseId].gender;
    } else if (item.slotKind === 'amulet' && typeof AMULETS !== 'undefined' && AMULETS[item.baseId]) {
      gender = AMULETS[item.baseId].gender;
    } else if (item.slotKind === 'consumable' && typeof CONSUMABLES !== 'undefined' && CONSUMABLES[item.baseId]) {
      gender = CONSUMABLES[item.baseId].gender;
    }
  }
  if (!gender) gender = 'm';
  let pref = null;
  if (prefAff) {
    pref = (prefAff.nameForms && prefAff.nameForms[gender]) || inflectPrefix(prefAff.name, gender);
  }
  const suf = sufAff ? sufAff.name : null;
  let out = baseName;
  if (pref) out = pref + ' ' + out.toLowerCase();
  if (suf)  out = out + ' ' + suf.toLowerCase();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/* Стоимость предмета: суммарная по базе + префиксу + суффиксу. */
function itemTotalCost(item) {
  if (!item) return 0;
  let cost = (item.baseCost | 0) || 0;
  if (item.prefix && AFFIXES[item.prefix]) cost += AFFIXES[item.prefix].costPoints | 0;
  if (item.suffix && AFFIXES[item.suffix]) cost += AFFIXES[item.suffix].costPoints | 0;
  return cost;
}

/* Можно ли добавить аффикс на предмет данного слота?
   Проверки: forbiddenSlots, family-дедуп с уже надетым аффиксом. */
function canAttachAffix(item, affixId) {
  if (!item || !affixId) return false;
  const aff = AFFIXES[affixId];
  if (!aff) return false;
  if (Array.isArray(aff.forbiddenSlots) && aff.forbiddenSlots.includes(item.slotKind)) {
    return false;
  }
  // Camp v1.5-affix-restrictions (09.05.2026): фильтр по weaponType /
  // armorType. Источник — на инстансе предмета (после loot _buildInstance
  // оба проставлены) либо из WEAPONS/ARMORS по baseId.
  if (Array.isArray(aff.forbiddenWeaponTypes) && aff.forbiddenWeaponTypes.length) {
    let wt = item.weaponType;
    if (!wt && item.baseId && typeof WEAPONS !== 'undefined' && WEAPONS[item.baseId]) {
      wt = WEAPONS[item.baseId].weaponType;
    }
    if (wt && aff.forbiddenWeaponTypes.includes(wt)) return false;
  }
  if (Array.isArray(aff.forbiddenArmorTypes) && aff.forbiddenArmorTypes.length) {
    let at = item.armorType;
    if (!at && item.baseId && typeof ARMORS !== 'undefined' && ARMORS[item.baseId]) {
      at = ARMORS[item.baseId].armorType;
    }
    if (at && aff.forbiddenArmorTypes.includes(at)) return false;
  }
  // Проверка family-дедупа.
  const otherForm = aff.form === 'prefix' ? 'suffix' : 'prefix';
  const otherSlotKey = otherForm === 'prefix' ? 'prefix' : 'suffix';
  const otherAffixId = item[otherSlotKey];
  if (otherAffixId && AFFIXES[otherAffixId]) {
    if (AFFIXES[otherAffixId].family === aff.family) return false;
  }
  // Тот же form-слот занят?
  const sameSlotKey = aff.form === 'prefix' ? 'prefix' : 'suffix';
  if (item[sameSlotKey]) return false;  // уже занято
  return true;
}

if (typeof window !== 'undefined') {
  window.AFFIXES = AFFIXES;
  window.itemAffixes = itemAffixes;
  window.itemFullName = itemFullName;
  window.itemTotalCost = itemTotalCost;
  window.canAttachAffix = canAttachAffix;
}
