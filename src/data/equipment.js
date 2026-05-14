/* equipment.js — реестры надеваемых предметов: брони, колец, амулетов.
   Что внутри:
     • ARMORS — реестр брони. Поля каждой записи:
         id (строка-ключ),
         name (русское название),
         icon (эмодзи fallback для plain-text тултипов и слотов без спрайта),
         spriteSrc (путь к pixel-art PNG; на этапе С1 — null, спрайты
            появятся позже, до тех пор UI берёт icon),
         armorType (ключ типа: 'heavy_armor' | 'medium_armor' | 'robe').
            Используется class-локами через CLASSES[id].allowedArmorTypes
            (вводится в S4),
         armorFlat (флэт-снижение физического урона, читается в
            computeIncomingDamage; интегрируется в S4),
         tier (1/2/3 — индекс качества базы),
         costPoints (стоимость в очках сложности; используется в
            cost-fitting генераторе loot.js, появится в S6).
     • RINGS — реестр колец. Поля:
         id, name, icon, spriteSrc, costPoints (всегда 0 — кольцо
            существует только как носитель аффиксов, см. план S5).
     • AMULETS — реестр амулетов. Поля те же, что у RINGS.
     • Хелперы getUnitArmor(unit), getUnitRing(unit), getUnitAmulet(unit) —
       вернут запись из соответствующего реестра по id или null. Аналог
       getUnitWeapon из data/weapons.js.

   Что НЕ внутри:
     • CONSUMABLES — расходники в отдельном файле data/consumables.js.
       У них другая механика (одноразовое применение, активный action),
       и валидно ожидать, что у них будет собственный набор хелперов.
     • PREFIXES/SUFFIXES (аффиксы) — отдельный реестр в data/affixes.js
       (вводится в S2). Аффиксы — самостоятельная сущность, не привязаны
       к конкретной базе.
     • Логика armorFlat в фазе 1 урона — в core/damage.js (S4).
     • UI инвентаря и экипировки между волнами — в render/render-inventory.js
       (вводится в S1, наполняется по ходу фаз).
     • Cost-fitting генератор предметов — в core/loot.js (S6).

   На этапе С1 все реестры объявлены пустыми. Заполняются:
     • S3: WEAPONS получит тиры (это в data/weapons.js).
     • S4: ARMORS получит тиры и armorFlat.
     • S5: RINGS / AMULETS получат стартовые записи (одно «голое» кольцо
       и один «голый» амулет, как носители аффиксов).

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   ARMORS, RINGS, AMULETS, getUnit* попадают в глобальный scope window. */

/* ================================================================
   === БРОНЯ ======================================================
   ================================================================
   С4-предметы (08.05.2026): три armorType × 3 тира.
   • heavy_armor — воин (Кожаный доспех / Кольчуга / Латные доспехи).
   • medium_armor — лучник (Лёгкая куртка / Кожаный нагрудник /
     Усиленный плащ).
   • robe — маг (Мантия ученика / Магическая мантия / Мантия архимага).
   armorFlat скейлится 1/2/3 по тиру; стоимость 2/4/6.
   armorFlat читается в computeIncomingDamage (core/damage.js) фаза 1
   ПОСЛЕ shield_block и ДО armored, только для damageType:'physical'.
   Магия/огонь/яд/прочие типы броню обходят.

   Спрайты: сейчас есть PNG только для heavy-серии и кожаного нагрудника
   (medium tier 2). Для остальных spriteSrc:null — UI берёт icon-эмодзи
   как fallback. Когда пользователь дополнит спрайты — заменить null
   на путь и всё. */
const ARMORS = {
  // ============ heavy_armor (воин) ============
  leather_armor: {
    id: 'leather_armor', name: 'Кожаный доспех', icon: '🛡',
    gender: 'm',
    spriteSrc: 'assets/sprites/leather_armor.png',
    armorType: 'heavy_armor', tier: 1, armorFlat: 1, costPoints: 2
  },
  chain_mail: {
    id: 'chain_mail', name: 'Кольчуга', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/chain_mail.png',
    armorType: 'heavy_armor', tier: 2, armorFlat: 2, costPoints: 4
  },
  plate_armor: {
    id: 'plate_armor', name: 'Латные доспехи', icon: '🛡',
    gender: 'pl',
    spriteSrc: 'assets/sprites/plate_armor.png',
    armorType: 'heavy_armor', tier: 3, armorFlat: 3, costPoints: 6
  },

  // ============ medium_armor (лучник) ============
  light_jacket: {
    id: 'light_jacket', name: 'Лёгкая куртка', icon: '🛡',
    gender: 'f',
    spriteSrc: null,  // спрайт ещё не добавлен
    armorType: 'medium_armor', tier: 1, armorFlat: 1, costPoints: 2
  },
  leather_chestplate: {
    id: 'leather_chestplate', name: 'Кожаный нагрудник', icon: '🛡',
    gender: 'm',
    spriteSrc: 'assets/sprites/leather_chestplate.png',
    armorType: 'medium_armor', tier: 2, armorFlat: 2, costPoints: 4
  },
  reinforced_cloak: {
    id: 'reinforced_cloak', name: 'Усиленный плащ', icon: '🛡',
    gender: 'm',
    spriteSrc: null,
    armorType: 'medium_armor', tier: 3, armorFlat: 3, costPoints: 6
  },

  // ============ robe (маг) ============
  apprentice_robe: {
    id: 'apprentice_robe', name: 'Мантия ученика', icon: '🛡',
    gender: 'f',
    spriteSrc: null,
    armorType: 'robe', tier: 1, armorFlat: 1, costPoints: 2
  },
  magic_robe: {
    id: 'magic_robe', name: 'Магическая мантия', icon: '🛡',
    gender: 'f',
    spriteSrc: null,
    armorType: 'robe', tier: 2, armorFlat: 2, costPoints: 4
  },
  archmage_robe: {
    id: 'archmage_robe', name: 'Мантия архимага', icon: '🛡',
    gender: 'f',
    spriteSrc: null,
    armorType: 'robe', tier: 3, armorFlat: 3, costPoints: 6
  },

  /* Рясы священника (09.05.2026). Отдельный armorType:'priest_robe',
     чтобы маг и священник не путались — у них разные классовые роли.
     Сейчас параметры armorFlat 1/2/3 как у других branches. */
  priest_robe: {
    id: 'priest_robe', name: 'Ряса священника', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/priest_robe.png',
    armorType: 'priest_robe', tier: 1, armorFlat: 1, costPoints: 2
  },
  reinforced_robe: {
    id: 'reinforced_robe', name: 'Укреплённая ряса', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/reinforced_robe.png',
    armorType: 'priest_robe', tier: 2, armorFlat: 2, costPoints: 4
  },
  high_priest_robe: {
    id: 'high_priest_robe', name: 'Ряса первосвященника', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/high_priest_robe.png',
    armorType: 'priest_robe', tier: 3, armorFlat: 3, costPoints: 6
  }
};

/* ================================================================
   === КОЛЬЦА =====================================================
   ================================================================
   С5-предметы (08.05.2026): одно базовое кольцо. Кольца — чистые
   носители аффиксов, без собственных статов и тиров. costPoints: 0;
   полная стоимость инстанса = сумма префикса+суффикса. Минимальный
   возможный дроп кольца = cost 2 (один cheap-affix). Класс-локов нет:
   любой герой может надеть. */
const RINGS = {
  ring_basic: {
    id: 'ring_basic', name: 'Кольцо', icon: '💍',
    gender: 'n',
    spriteSrc: 'assets/sprites/ring.png',
    costPoints: 0
  }
};

/* ================================================================
   === АМУЛЕТЫ ====================================================
   ================================================================
   С5-предметы (08.05.2026): один базовый амулет. Симметрично кольцам:
   чистый носитель аффиксов, без статов/тиров, без класс-локов. */
const AMULETS = {
  amulet_basic: {
    id: 'amulet_basic', name: 'Амулет', icon: '📿',
    gender: 'm',
    spriteSrc: 'assets/sprites/amulet.png',
    costPoints: 0
  }
};

/* Тонкие обёртки симметрично с getUnitWeapon (см. data/weapons.js).
   Возвращают запись реестра или null. Если у юнита в слоте лежит
   объект-инстанс предмета (а не id), возвращаем его как есть — таким
   образом UI и боёвка читают свойства предмета через одну точку
   независимо от того, базовая запись это или сгенерированный инстанс. */
function getUnitArmor(unit) {
  if (!unit || !unit.equipment) return null;
  const e = unit.equipment.armor;
  if (!e) return null;
  if (typeof e === 'string') return ARMORS[e] || null;
  return e;  // инстанс предмета (создаётся loot.js в S6)
}

/* С4-предметы: суммарное флэт-снижение физического урона от брони.
   Используется в core/damage.js → computeIncomingDamage фаза 1.5.
   Источник: armorFlat у надетой брони (если есть). На С4 поле живёт
   только на ARMORS-записи или инстансе с тем же полем. В будущем сюда
   же может прибавиться бонус от аффиксов («Крепкий», +N к броне) —
   пока такого аффикса нет. */
function armorFlatOf(unit) {
  const a = getUnitArmor(unit);
  if (!a) return 0;
  const v = a.armorFlat | 0;
  return v > 0 ? v : 0;
}
function getUnitRing(unit) {
  if (!unit || !unit.equipment) return null;
  const e = unit.equipment.ring;
  if (!e) return null;
  if (typeof e === 'string') return RINGS[e] || null;
  return e;
}
function getUnitAmulet(unit) {
  if (!unit || !unit.equipment) return null;
  const e = unit.equipment.amulet;
  if (!e) return null;
  if (typeof e === 'string') return AMULETS[e] || null;
  return e;
}
