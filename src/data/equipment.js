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
         per-class свойство (см. шапку ARMORS ниже): heavy_armor →
            armoredOnSpawn, medium_armor → attackDamageBonus,
            robe → manaDiscount, priest_robe → incomingReduction
            (балансная правка 14.05.2026 заменила общий armorFlat),
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
     • Логика per-class свойств брони — в core/damage.js (incomingReduction),
       core/state.js startMission (armoredOnSpawn), data/weapons.js
       weaponDamage (attackDamageBonus), core/skills.js getUnitSkillParams
       (manaDiscount).
     • UI инвентаря и экипировки между волнами — в render/render-inventory.js
       (вводится в S1, наполняется по ходу фаз).
     • Cost-fitting генератор предметов — в core/loot.js (S6).

   На этапе С1 все реестры объявлены пустыми. Заполняются:
     • S3: WEAPONS получит тиры (это в data/weapons.js).
     • S4: ARMORS получил тиры и per-class свойства (правка 14.05.2026,
       раньше был armorFlat).
     • S5: RINGS / AMULETS получат стартовые записи (одно «голое» кольцо
       и один «голый» амулет, как носители аффиксов).

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   ARMORS, RINGS, AMULETS, getUnit* попадают в глобальный scope window. */

/* ================================================================
   === БРОНЯ ======================================================
   ================================================================
   Балансная правка 14.05.2026: одинаковый для всех armorFlat заменён
   на per-class свойства. Стоимости тиров переведены с 2/4/6 на 3/6/9.

   • heavy_armor (воин) — `armoredOnSpawn: 4/6/8`. При startMission воин
     с надетой тяжёлой бронёй получает свежий эффект `armored` с N
     зарядами (расходуются в фазе 2 computeIncomingDamage). Между
     миссиями стэк не переносится — броня «перезаряжается» в лагере.
   • medium_armor (лучник) — `attackDamageBonus: 1/2/3`. Прибавляется
     к weapon.damage через equipmentSpecialSum в weaponDamage. Бонус
     попадает в БАЗОВУЮ часть удара ⇒ удваивается критом (симметрично
     damage-аффиксу оружия). Действует на все атаки, идущие через
     weaponDamage (базовый выстрел и все скиллы лучника).
   • robe (маг) — `manaDiscount: 1/2/3`. Уменьшает manaCost любого
     активного навыка в effectiveSkillParams; пол min(1) — бесплатных
     кастов не бывает.
   • priest_robe (священник) — `incomingReduction: 1/2/3`. Флэт-минус
     к ЛЮБОМУ входящему урону, ВКЛЮЧАЯ DoT-тики; считается отдельной
     фазой в computeIncomingDamage (до armored), минимум 1. */
const ARMORS = {
  // ============ heavy_armor (воин) ============
  leather_armor: {
    id: 'leather_armor', name: 'Кожаный доспех', icon: '🛡',
    gender: 'm',
    spriteSrc: 'assets/sprites/leather_armor.png',
    armorType: 'heavy_armor', tier: 1, armoredOnSpawn: 4, costPoints: 3
  },
  chain_mail: {
    id: 'chain_mail', name: 'Кольчуга', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/chain_mail.png',
    armorType: 'heavy_armor', tier: 2, armoredOnSpawn: 6, costPoints: 6
  },
  plate_armor: {
    id: 'plate_armor', name: 'Латные доспехи', icon: '🛡',
    gender: 'pl',
    spriteSrc: 'assets/sprites/plate_armor.png',
    armorType: 'heavy_armor', tier: 3, armoredOnSpawn: 8, costPoints: 9
  },

  // ============ medium_armor (лучник) ============
  light_jacket: {
    id: 'light_jacket', name: 'Лёгкая куртка', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/light_jacket.png',
    armorType: 'medium_armor', tier: 1, attackDamageBonus: 1, costPoints: 3
  },
  leather_chestplate: {
    id: 'leather_chestplate', name: 'Кожаный нагрудник', icon: '🛡',
    gender: 'm',
    spriteSrc: 'assets/sprites/leather_chestplate.png',
    armorType: 'medium_armor', tier: 2, attackDamageBonus: 2, costPoints: 6
  },
  reinforced_cloak: {
    id: 'reinforced_cloak', name: 'Костюм рейнджера', icon: '🛡',
    gender: 'm',
    spriteSrc: 'assets/sprites/reinforced_cloak.png',
    armorType: 'medium_armor', tier: 3, attackDamageBonus: 3, costPoints: 9
  },

  // ============ robe (маг) ============
  apprentice_robe: {
    id: 'apprentice_robe', name: 'Мантия ученика', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/apprentice_robe.png',
    armorType: 'robe', tier: 1, manaDiscount: 1, costPoints: 3
  },
  magic_robe: {
    id: 'magic_robe', name: 'Магическая мантия', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/magic_robe.png',
    armorType: 'robe', tier: 2, manaDiscount: 2, costPoints: 6
  },
  archmage_robe: {
    id: 'archmage_robe', name: 'Мантия архимага', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/archmage_robe.png',
    armorType: 'robe', tier: 3, manaDiscount: 3, costPoints: 9
  },

  // ============ priest_robe (священник) ============
  priest_robe: {
    id: 'priest_robe', name: 'Ряса священника', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/priest_robe.png',
    armorType: 'priest_robe', tier: 1, incomingReduction: 1, costPoints: 3
  },
  reinforced_robe: {
    id: 'reinforced_robe', name: 'Укреплённая ряса', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/reinforced_robe.png',
    armorType: 'priest_robe', tier: 2, incomingReduction: 2, costPoints: 6
  },
  high_priest_robe: {
    id: 'high_priest_robe', name: 'Ряса первосвященника', icon: '🛡',
    gender: 'f',
    spriteSrc: 'assets/sprites/high_priest_robe.png',
    armorType: 'priest_robe', tier: 3, incomingReduction: 3, costPoints: 9
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
