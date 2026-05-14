/* skills.js — реестр всех навыков и эффектов в игре.
   Что внутри:
     • SKILLS — единый реестр. Ключи трёх «семантических» типов:
         kind: 'active'  — активный навык (фаербол): kастуется юнитом,
                            тратит ману, имеет тиры (basic/advanced/elite),
                            формулу урона, дальность, область, тип доставки.
         kind: 'passive' — пассивка (corpse_poison): висит на классе,
                            триггерится по событию (onDealDamage и т.п.),
                            имеет тиры с параметрами эффекта.
         kind: 'effect'  — статус-эффект (burning/poisoned/stunned/immobilized):
                            висит на юните, имеет хуки по фазам
                            (onTurnStart) и/или фильтр-семантику
                            (immobilized — проверяется в core/movement).
       Тир-зависимые поля живут в `tiers[tier]` и сливаются с верхним
       уровнем через effectiveSkillParams() (остаётся в монолите —
       переедет вместе с остальными скилл-хелперами).
     • Поле `description` — НЕ универсальное. Читается UI'ем только для
       статус-эффектов (kind:'effect' → render-panel.js, чип эффекта на
       цели) и для записей-«гибридов», у которых skill.id === effectId
       (сейчас это только corpse_poison). Для kind:'active' и kind:'passive'
       тултип формируется в render-panel.js из `tiers[tier]` напрямую —
       статичная строка не может подставить тир-зависимые числа, а
       расхождение между description и поведением (как было у mana_absorb)
       тихо вводит игрока в заблуждение. У новых активок и пассивок поле
       `description` НЕ ДОБАВЛЯЕМ, тултип пишем в render-panel.js.
     • SKILL_TIER_LABELS — человекочитаемые ярлыки тиров для UI.
   Что НЕ внутри:
     • Логика срабатывания пассивок / диспатчер эффектов
       (triggerOnDealDamagePassives, applySkillEffectDef,
       effectiveSkillParams, getActiveSkillTier, getUnitSkillParams) —
       пока в монолите index.html. Они переедут в src/core/effects.js
       (R12) и/или src/core/skills.js на более позднем шаге.
     • Apply-хелперы статус-эффектов (applyBurning / applyPoisoned /
       applyStunned / applyImmobilized) — пока в монолите, переедут в
       src/core/effects.js (R12).
     • Хелперы боя для активных навыков (executeFireball) живут
       в src/core/combat.js (R14).
     • Привязка «у какого класса какие навыки» — на классе через
       CLASSES[id].activeSkills / passives (см. src/data/classes.js, R8).
   Где править параметры существующего навыка: тут, в нужной записи SKILLS
     (изменение формулы фаербола, длительности горения, манны и т.п.).
   Где добавить новый навык: добавить запись в SKILLS, проверить, что
     spriteSrc указывает на реальный файл; для активных — добавить
     `executeXxx` в core/combat.js, режим прицеливания в ui/input.js
     (см. CODEX.md → «Расширение игры → Новый активный навык»).
   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   SKILLS, SKILL_TIER_LABELS попадают в глобальный scope window.

   Тонкость с порядком загрузки. onTurnStart-хуки эффектов внутри SKILLS
   ссылаются на CLASSES, computeIncomingDamage, applyDamage, log — все они
   ещё в монолите index.html, который грузится ПОСЛЕ skills.js. Это работает,
   потому что JavaScript разрешает имена в функциях в момент ВЫЗОВА, а не
   определения. К моменту первого тика статус-эффекта inline-блок уже
   выполнен и все эти глобалы существуют. (Тот же приём, что в weapons.js.)
*/

/* ================================================================
   === НАВЫКИ =====================================================
   ================================================================ */
const SKILLS = {
  fireball: {
    name: 'Огненный шар',
    classId: 'mage',
    flavor: 'Бросает в указанную клетку сгусток огня, который взрывается и наносит урон по площади.',
    icon: '🔥',
    // spriteSrc — pixel-art иконка для слота навыка и для оверлея на
    // эпицентре взрыва (см. spawnFireballBlast). Эмодзи 🔥 остаётся как
    // fallback в plain-text title-тултипах и в логе.
    spriteSrc: 'assets/sprites/fireball.png',
    kind: 'active',
    range: 4,
    area: { type: 'square', size: 3 },  // 3×3 вокруг целевой клетки
    delivery: 'aoe',
    damageType: 'fire',
    canCrit: true,
    hitsFriendlies: true,
    // NB: «не более 1 раза за ход» было у самого скилла; теперь это общее
    // правило на все активные навыки (u.skillsUsedThisTurn.length > 0 —
    // блокирует все последующие касты в этом ходу), так что отдельный
    // флаг больше не нужен.
    consumesBasicAttack: false,  // отдельное действие
    /* Тир-зависимые поля (manaCost, formula, applyEffect) теперь живут
       в tiers[tier], а не на верхнем уровне. Чтение — через
       effectiveSkillParams(skill, tier): возвращает merged-объект
       (верхний уровень ⊕ поля выбранного тира). Это тот же шаблон,
       которым в дальнейшем будут пользоваться все новые активные
       навыки (см. сессии 8–14 в DESIGN). */
    tiers: {
      basic: {
        manaCost: 8,
        // База 3 + ⌊Мудр/2⌋. У мага Мудр=6 → 6 урона на цель; крит ×2 → 12.
        formula: { base: 3, stat: 'wis', divisor: 2 }
      },
      advanced: {
        manaCost: 8,
        formula: { base: 3, stat: 'wis', divisor: 2 },
        // Накладывает «Горит» на каждую попавшую цель независимо. На
        // союзников и самого мага в зоне — тоже (frendly fire осознан).
        applyEffect: { id: 'burning', duration: 3 },
        // Per-tier flavor (Сессия 12+): advanced/elite отличаются от
        // basic поджигом задетых целей — это отражено в художественном
        // описании; верхний flavor остаётся как «дефолт для basic».
        flavor: 'Бросает в указанную клетку сгусток огня, который взрывается и наносит урон по площади. Поджигает задетые цели.'
      },
      elite: {
        manaCost: 8,
        formula: { base: 5, stat: 'wis', divisor: 2 },
        applyEffect: { id: 'burning', duration: 5 },
        flavor: 'Бросает в указанную клетку сгусток огня, который взрывается и наносит урон по площади. Поджигает задетые цели.'
      }
    }
  },
  ice_arrow: {
    /* Сессия 9: одиночная стрела frost-урона. Базовый — без эффекта;
       advanced/elite дополнительно навешивают на цель «Замедлен» с
       силой = ПРОЦЕНТ от базовой Spd цели (advanced 30%, elite 60%,
       округление вверх) на 1 ход. Правка 06.05.2026: ушли с фикс. -2/-4
       на проценты — фикс. слишком слаб против быстрых целей с высокой
       прокачкой Spd, проценты масштабируются с целью. Считается процент
       в applySkillEffectDef (см. core/skills.js → case 'slowed') от
       target.stats.spd (базовой, не эффективной — устойчивее к стаку).

       Иммунитет цели к морозному урону блокирует ВЫБОР цели в режиме
       прицеливания (см. computeRangedTargets и canActivateSkill).
       Иммунных классов пока нет — задел.

       Привязка к классу мага здесь НЕ делается: это Сессия 16 (skillPool
       класса). До тех пор тестируется через override — DevTools → выдать
       в слот → каст из нижней панели работает (render-panel.js теперь
       читает activeSkillsOverride). */
    name: 'Ледяная стрела',
    classId: 'mage',
    flavor: 'Запускает в цель ледяную стрелу.',
    icon: '❄️',
    spriteSrc: 'assets/sprites/skills/ice_arrow.png',
    kind: 'active',
    range: 4,
    delivery: 'ranged',  // single-target ranged, не aoe — общий single-target overlay
    damageType: 'frost',
    canCrit: true,
    hitsFriendlies: false,    // у single-target цель — только враг (computeRangedTargets фильтрует team)
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 6, formula: { base: 3, stat: 'wis', divisor: 2 } },
      advanced: { manaCost: 6, formula: { base: 4, stat: 'wis', divisor: 2 },
                  applyEffect: { id: 'slowed', percent: 30, duration: 1 },
                  flavor: 'Запускает в цель ледяную стрелу, замедляющую её на 30% от базовой Скорости.' },
      elite:    { manaCost: 6, formula: { base: 5, stat: 'wis', divisor: 2 },
                  applyEffect: { id: 'slowed', percent: 60, duration: 1 },
                  flavor: 'Запускает в цель ледяную стрелу, замедляющую её на 60% от базовой Скорости.' }
    }
  },
  magic_arrow: {
    /* Сессия 9: одиночная стрела magic-урона. Формула без базы — урон
       полностью от Мудрости через дробный divisor (1.5 / 1.25 / 1).
       Math.floor в calcFormulaDamage уже корректно обрабатывает дробный
       делитель (6/1.5 = 4, 6/1.25 = 4 — floor(4.8), 6/1 = 6), отдельной
       правки формулы не потребовалось. Эффекта тира нет. Иммунитет цели
       к магическому урону блокирует выбор цели — задел. */
    name: 'Магическая стрела',
    classId: 'mage',
    flavor: 'Сплетает из чистой маны направленный снаряд, бьющий цель магическим уроном.',
    icon: '✨',
    spriteSrc: 'assets/sprites/skills/magic_arrow.png',
    kind: 'active',
    range: 4,
    delivery: 'ranged',
    damageType: 'magic',
    canCrit: true,
    hitsFriendlies: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 6, formula: { base: 0, stat: 'wis', divisor: 1.5  } },
      advanced: { manaCost: 6, formula: { base: 0, stat: 'wis', divisor: 1.25 } },
      elite:    { manaCost: 6, formula: { base: 0, stat: 'wis', divisor: 1    } }
    }
  },
  lightning: {
    /* Сессия 10: линейная АоЕ (новая форма доставки). Прицел — одна из
       4 СМЕЖНЫХ к магу клеток (вверх/вниз/влево/вправо); линия идёт ОТ
       выбранной клетки прицеливания «от мага» длиной lineLength клеток
       (5/7/9 по тиру), сама клетка прицеливания — первая в линии.
       Урон одинаковый для всех в линии (один ролл крита на каст, как у
       фаербола). Hits-Friendlies: бьёт всех на линии, включая союзников
       (магу — нет, его клетка не в линии).

       Elite-тир дополнительно навешивает «Оглушение» на 1 ход на каждого
       пораженного с независимым роллом 15% (через def.chance в
       applyEffect — см. core/skills.js applySkillEffectDef). Цель,
       иммунная к electric, ролл всё равно проходит — applyEffect просто
       не сработает (apply*-хелперы статуса не имеют электр-фильтра, но
       это согласовано: статус «Оглушение» — это не электрический урон).

       Поле `area` намеренно отсутствует: линия — отдельная форма AoE,
       не квадрат. Зону поражения считает computeLightningLine
       (core/combat.js) на основе lineLength + направления. */
    name: 'Молния',
    classId: 'mage',
    flavor: 'Создаёт разряд молнии, поражающий все цели по прямой линии.',
    icon: '⚡',
    spriteSrc: 'assets/sprites/skills/lightning.png',
    kind: 'active',
    delivery: 'aoe',     // линия — это форма AoE (не single-target)
    damageType: 'electric',
    canCrit: true,
    hitsFriendlies: true,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8, formula: { base: 4, stat: 'wis', divisor: 2 }, lineLength: 5 },
      advanced: { manaCost: 8, formula: { base: 5, stat: 'wis', divisor: 2 }, lineLength: 7 },
      elite:    { manaCost: 8, formula: { base: 6, stat: 'wis', divisor: 2 }, lineLength: 9,
                  applyEffect: { id: 'stunned', duration: 1, chance: 15 },
                  flavor: 'Создаёт разряд молнии, поражающий все цели по прямой линии с шансом оглушения.' }
    }
  },
  chain_lightning: {
    /* Сессия 11: одиночная цель + N отскоков. Initial — single-target,
       ranged 4, electric. Каждый отскок: от ПОСЛЕДНЕЙ пораженной цели
       ищется ближайший ещё-не-пораженный враг в радиусе 3 манхэттен,
       не иммунный к electric. Тай-брейки: мин. дистанция → мин. Удача
       (эффективная) → случайный. Если кандидатов нет — отскоки
       прекращаются. Один ролл крита на ВЕСЬ каст (включая отскоки).

       Прицеливание initial-цели идёт через universal single-target
       overlay (delivery:\'ranged\'); click → dispatchActiveSkill, который
       по skillId выбирает executeChainLightning. См. core/combat.js
       SINGLE-TARGET RANGED SKILLS блок. */
    name: 'Цепная молния',
    classId: 'mage',
    flavor: 'Бьёт разрядом молнии, способным по цепочке поразить несколько стоящих поблизости противников.',
    icon: '🌩',
    spriteSrc: 'assets/sprites/skills/chain_lightning.png',
    kind: 'active',
    range: 4,
    delivery: 'ranged',
    damageType: 'electric',
    canCrit: true,
    hitsFriendlies: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8, formula: { base: 4, stat: 'wis', divisor: 2 }, bounceCount: 1 },
      advanced: { manaCost: 8, formula: { base: 5, stat: 'wis', divisor: 2 }, bounceCount: 2 },
      elite:    { manaCost: 8, formula: { base: 6, stat: 'wis', divisor: 2 }, bounceCount: 3 }
    }
  },
  prismatic_sphere: {
    /* Сессия 12: одиночная цель, ranged 4, 10 маны. Наносит ТРИ удара
       последовательно по одной цели в порядке electric → frost → fire,
       каждый — отдельный проход через computeIncomingDamage (т.е.
       иммунитет к одному типу обнуляет только свой удар, остальные
       проходят). Один ролл крита на весь каст (как у фаербола / Цепной
       молнии). Если цель умерла после первого/второго удара — оставшиеся
       удары не наносятся (applyDamage сама фильтрует мёртвых; в логе
       пишется только страйк, реально дошедший до цели).

       Прицеливание идёт через универсальный single-target overlay
       (kind:'active', delivery:'ranged'); click → dispatchActiveSkill
       → executePrismaticSphere. Цель, иммунная СРАЗУ КО ВСЕМ ТРЁМ типам
       (electric+frost+fire), отфильтровывается computeRangedTargets
       (расширен поддержкой `strikes`-массива — см. core/combat.js). Если
       иммунна только к 1-2 — выбрать можно, остальные удары пройдут.

       Поле `damageType: 'magic'` оставлено как fallback для UI (строка
       «Тип» в тултипе), реальные типы каждого удара — в `strikes`. */
    name: 'Призматическая сфера',
    classId: 'mage',
    flavor: 'Сфера расщеплённого света бьёт цель тремя ударами разной природы — электричества, холода и огня.',
    icon: '🔮',
    spriteSrc: 'assets/sprites/skills/prismatic_sphere.png',
    kind: 'active',
    range: 4,
    delivery: 'ranged',
    damageType: 'magic',
    strikes: ['electric', 'frost', 'fire'],
    canCrit: true,
    hitsFriendlies: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 10, formula: { base: 1, stat: 'wis', divisor: 3   } },
      advanced: { manaCost: 10, formula: { base: 1, stat: 'wis', divisor: 2.5 } },
      elite:    { manaCost: 10, formula: { base: 1, stat: 'wis', divisor: 2   } }
    }
  },
  fire_shield: {
    /* Сессия 14: активный buff. Цель — сам маг или союзник в манхэттене
       ≤1, расход 8 маны, длительность 3 хода. На цель кладётся эффект
       `fire_shield` с ДВУМЯ числами: `retaliateDmg` (зафиксированный
       при наложении урон ответки атакеру в ближнем бою) и
       `damageReduction` (снижение входящего fire/frost-урона у цели).

       retaliateDmg = `retaliateBase + ⌊wis_кастера/3⌋`. Это считается
       В МОМЕНТ наложения и сохраняется на экземпляре эффекта — потом
       НЕ пересчитывается при изменении Мудрости кастера или её снятии.
       damageReduction — фиксированный по тиру, читается напрямую из
       эффекта в `computeIncomingDamage` (см. core/damage.js).

       Стак (повторное наложение): полностью переписываем эффект новыми
       значениями (включая duration). Семантика «надевают новый щит —
       старый снимают», как у предметов экипировки. Это отличается от
       burning/slowed (там длительности суммируются), но осознано: щит
       — буфф, а не DoT, и игрок ожидает прозрачной семантики обновления.

       Прицеливание — собственная ветка в render-overlay.js
       (state.mode === 'fire_shield'): подсвечиваются сам маг + союзники
       в манхэттене ≤1 (.buff-target, янтарный). delivery:'self_buff'
       исключает скилл из универсальной single-target ranged ветки. */
    name: 'Огненный щит',
    classId: 'mage',
    flavor: 'Окружает цель огненной аурой, обжигающей атакующего в ближнем бою и ослабляющей входящий огненный и ледяной урон.',
    icon: '🔥',
    spriteSrc: 'assets/sprites/skills/fire_shield.png',
    kind: 'active',
    range: 1,
    delivery: 'self_buff',
    damageType: 'fire',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8, duration: 3, retaliateBase: 2, damageReduction: 2 },
      advanced: { manaCost: 8, duration: 3, retaliateBase: 4, damageReduction: 3 },
      elite:    { manaCost: 8, duration: 3, retaliateBase: 6, damageReduction: 4 }
    }
  },
  teleport: {
    /* Сессия 13: self-move skill. Активный, movesUser:true (значит
       canActivateSkill блокирует каст под «Обездвижен» через canUnitMove).
       5/5/3 маны и дальность 10/15/20 кл. — обе величины тир-зависимые
       (manaCost и range живут в tiers[tier], merged-параметры читаются
       через getUnitSkillParams).

       Дистанция считается манхэттеном БЕЗ учёта блокеров: можно
       телепортироваться «сквозь» юнитов и надгробия. Целевая клетка
       должна быть свободной — ни живого юнита, ни надгробия (через
       unitAt/graveAt из movement.js). Клетка самого мага исключается
       (трата маны без перемещения нелогична).

       НЕ ставит actionsUsedThisTurn.move = true — телепорт это НЕ
       обычное движение, а отдельное действие, расходующее только слот
       активного скилла (общее правило «один активный навык за ход»
       срабатывает через u.skillsUsedThisTurn.push). Обычное движение
       на этот ход остаётся доступным (можно телепортнуться, потом
       пройти ещё moveRange шагов).

       Прицеливание — отдельная ветка в render-overlay.js (state.mode
       === 'teleport'): подсвечиваются ВСЕ валидные пустые клетки в
       манхэттене ≤ range, click → executeTeleport(row, col). Не идёт
       через универсальный single-target overlay, поэтому условие той
       ветки ужесточено до delivery === 'ranged' (вместо !== 'aoe'). */
    name: 'Телепорт',
    classId: 'mage',
    flavor: 'Переносит заклинателя на указанную незанятую клетку на поле боя.',
    icon: '✨',
    spriteSrc: 'assets/sprites/skills/teleport.png',
    kind: 'active',
    delivery: 'teleport',
    movesUser: true,
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 5, range: 10 },
      advanced: { manaCost: 5, range: 15 },
      elite:    { manaCost: 3, range: 20 }
    }
  },
  mana_focus: {
    /* Сессия 15: активный self-buff. Концентрирует ману мага на
       N ходов, повышая Мудрость на +4/+6/+8 (basic/advanced/elite).
       Эффект `mana_focus` хранит `statMods: { wis: +bonus }` —
       читается общей веткой effectiveStats / statBreakdown
       (`core/stats-calc.js`), как у Замедления (там statMods.spd).
       Через эту же ветку повышенная Мудрость пробрасывается в формулы
       НОВЫХ кастов (фаербол, молния, призматическая сфера и т. п.).

       ВАЖНО: уже наложенные заклинания НЕ пересчитываются. Огненный
       щит, чьё `retaliateDmg` зафиксировано в момент наложения, своих
       чисел не меняет — это и есть желаемое поведение. Если нужно
       апнуть силу щита, ставь mana_focus ДО fire_shield.

       delivery:'self_buff' + range:0 — overlay подсветит ровно одну
       клетку самого мага. canCrit:false — крит для буффа не катается.
       Стак: повторное наложение полностью переписывает поля (как у
       fire_shield) — «новая концентрация перезапускает»; не суммируем
       длительности и не максимизируем bonus, чтобы UX был прозрачным. */
    name: 'Концентрация маны',
    classId: 'mage',
    flavor: 'Концентрирует ману мага, временно увеличивая силу его заклинаний и магического оружия.',
    icon: '💎',
    spriteSrc: 'assets/sprites/skills/mana_focus.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 6, duration: 5,  wisBonus: 4 },
      advanced: { manaCost: 6, duration: 8,  wisBonus: 6 },
      elite:    { manaCost: 6, duration: 12, wisBonus: 8 }
    }
  },
  purify: {
    /* Сессия 15: активный single-target скилл-снятие. Цель — ЛЮБОЙ
       живой юнит (сам маг, союзник, ВРАГ) в манхэттене ≤4. Снимает
       ВСЕ эффекты с цели — и баффы, и дебаффы (намеренно: игрок
       выбирает цель, с врага сбрасывает баффы, с союзника дебаффы).

       delivery:'cleanse' — отдельная ветка прицеливания в render-
       overlay (бирюзовая подсветка `.cleanse-target`). НЕ ходит через
       универсальную single-target ranged ветку, потому что та фильтрует
       только врагов (cleanse целит и в союзников). canCrit:false —
       у скилла нет урона.

       Если на цели нет эффектов — каст всё равно проходит, мана
       списывается, в логе пишется «снимать нечего» (это согласуется
       с фаерболом в пустую клетку: игрок сам отвечает за выбор цели).

       Тир-зависимым является только manaCost (8/6/4); range у всех
       тиров одинаков (4). */
    name: 'Очищение',
    classId: 'mage',
    flavor: 'Снимает с цели все наложенные эффекты, позитивные и негативные.',
    icon: '✨',
    spriteSrc: 'assets/sprites/skills/purify.png',
    kind: 'active',
    range: 4,
    delivery: 'cleanse',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8 },
      advanced: { manaCost: 6 },
      elite:    { manaCost: 4 }
    }
  },
  charge: {
    /* Сессия 18: «Рывок» воина. Активный, single-target по КЛЕТКЕ
       (не по юниту). Телепортирует на пустую клетку в радиусе =
       ⌈moveRange × {0.5, 0.75, 1.0}⌉ (basic/advanced/elite). Без маны,
       без условия на проходимость пути — рывок «перепрыгивает» юнитов
       и деревья. Целевая клетка должна быть свободна. НЕ расходует
       обычное движение этого хода (можно сделать рывок и потом
       пройти ещё `moveRange` шагов).

       delivery:'leap' — отдельная ветка прицеливания в render-overlay
       (красноватая подсветка, отличается от телепорта мага). Сам
       executor — executeCharge, аналогичен executeTeleport: проверка
       свободной клетки + перенос u.row/u.col + applyCooldown.

       Дальность считается ДИНАМИЧЕСКИ от moveRangeOf(u) — это значит,
       что на ход с дебаффом скорости рывок «короче». Это согласовано
       с базовым движением (тот же moveRangeOf), и кажется естественно. */
    name: 'Рывок',
    classId: 'warrior',
    flavor: 'Позволяет сделать дополнительное передвижение.',
    icon: '💨',
    spriteSrc: 'assets/sprites/skills/charge.png',
    kind: 'active',
    delivery: 'leap',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, rangeMul: 0.5,  cooldown: 5 },
      advanced: { manaCost: 0, rangeMul: 0.75, cooldown: 5 },
      elite:    { manaCost: 0, rangeMul: 1.0,  cooldown: 5 }
    }
  },
  shield_block: {
    /* Сессия 18: «Блок щитом». Активный self-buff, кулдаун 4. Накладывает
       на самого воина эффект `shield_block` с `damageReduction` 3/5/7
       (basic/advanced/elite). Эффект СНИМАЕТСЯ В НАЧАЛЕ СЛЕДУЮЩЕГО ХОДА
       НОСИТЕЛЯ через новый механизм `expiresAt:'turnStart'` (см.
       core/effects.js → expireTurnStartEffects, beginTurn в core/turn.js).

       Логика снижения — в фазе 1 computeIncomingDamage (core/damage.js):
       `incoming = max(0, incoming - reduction)` для ЛЮБОГО damageType
       (физика, стихии). damageType:'special' игнорирует фазу 1 целиком
       по правилу из С17, поэтому щит не блокирует спец-урон.

       delivery:'self_buff' + range:0 → подсветится только клетка воина,
       клик кастует. Без маны (это технически не buff с ресурсом,
       а быстрая стойка).

       Эффект имеет `expiresAt:'turnStart'` и не имеет `remaining`.
       НЕ тикает в tickEffectsAtTurnEnd — снимается отдельным механизмом. */
    name: 'Блок щитом',
    classId: 'warrior',
    flavor: 'Воин прикрывается щитом, что позволяет снизить входящий урон.',
    icon: '🛡',
    spriteSrc: 'assets/sprites/skills/shield_block.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      // Баланс 04.05.2026: cooldown 4 → 5 (синхронизирован с Рывком),
      // подтверждено пользователем после теста.
      basic:    { manaCost: 0, cooldown: 5, damageReduction: 3 },
      advanced: { manaCost: 0, cooldown: 5, damageReduction: 5 },
      elite:    { manaCost: 0, cooldown: 5, damageReduction: 7 }
    }
  },
  whirlwind: {
    /* Сессия 18: «Круговой удар». Активный self-AoE по 8 СМЕЖНЫМ
       клеткам (3×3 минус центр). Урон каждому = `floor(weaponDmg(u)
       * tierMul)`, минимум 1 (по правилу пользователя). damageType
       берётся с экипированного оружия (для меча/булавы — physical).
       Кулдаун 3. consumesBasicAttack:false — обычная атака на этот
       ход остаётся.

       Крит — ОТДЕЛЬНЫЙ ролл на каждую цель (как у фаербола). Под
       elite-тиром (mul=1.0) с базовым уроном меча 5 — каждая цель
       получает 5; со str-баффом и критом — больше.

       delivery:'self_aoe' → новая ветка overlay: подсвечивает 8
       смежных клеток (.whirlwind-target), любой клик кастует. Без
       выбора центра — эпицентр всегда на воине. */
    name: 'Круговой удар',
    classId: 'warrior',
    flavor: 'Удар по всем соседним с воином целям.',
    icon: '🌀',
    spriteSrc: 'assets/sprites/skills/whirlwind.png',
    kind: 'active',
    range: 1,
    delivery: 'self_aoe',
    canCrit: true,
    consumesBasicAttack: false,
    tiers: {
      // Баланс 04.05.2026: cooldown 3 → 5 (синхронизирован с Рывком),
      // подтверждено пользователем после теста.
      basic:    { manaCost: 0, cooldown: 5, damageMul: 0.5  },
      advanced: { manaCost: 0, cooldown: 5, damageMul: 0.75 },
      elite:    { manaCost: 0, cooldown: 5, damageMul: 1.0  }
    }
  },
  second_wind: {
    /* Сессия 19: «Второе дыхание». Активный self-heal, raz za волну
       (НЕ cooldown — отдельный флаг unit.usedThisWave[skillId]=true,
       сбрасывается на startNextWave). Лечение = ⌈healPct × maxHpOf(u)⌉,
       не выше maxHp. canCrit:false — лечение не критует. delivery:
       'self_buff', range:0 → подсветится только клетка воина. */
    name: 'Второе дыхание',
    classId: 'warrior',
    flavor: 'Восполняет утраченное здоровье.',
    icon: '💗',
    spriteSrc: 'assets/sprites/skills/second_wind.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    onceWave: true,                  // canActivateSkill учитывает unit.usedThisWave
    tiers: {
      basic:    { manaCost: 0, healPct: 0.30 },
      advanced: { manaCost: 0, healPct: 0.50 },
      elite:    { manaCost: 0, healPct: 0.70 }
    }
  },
  reinforcement: {
    /* Сессия 19: «Укрепление». Пассивный, trigger:'onTakeDamage'. За
       КАЖДОЕ получение урона (если incoming > 0) добавляется
       gainPerHit (1/2/3) к стакам эффекта `reinforcement` на цели.
       Стаки висят до НАЧАЛА следующего хода носителя — через тот же
       механизм expiresAt:'turnStart' (см. С18 expireTurnStartEffects).
       В фазе 1 computeIncomingDamage (после shield_block, до armored)
       стаки снижают входящий урон на свою сумму, max(0, ...) — может
       полностью обнулить (это особый случай: нарастающая упругость
       плоти; обычные fire_shield/shield_block ниже 1 не опускают).

       Источник правды для триггера — collectPassivesByTrigger в
       core/skills.js (расширена для onTakeDamage). Применение стака —
       applyReinforcementStack в core/effects.js. */
    name: 'Укрепление',
    classId: 'warrior',
    flavor: 'Каждое полученное ранение укрепляет защиту до начала следующего хода.',
    icon: '🛡',
    spriteSrc: 'assets/sprites/skills/reinforcement.png',
    kind: 'passive',
    trigger: 'onTakeDamage',
    tiers: {
      basic:    { gainPerHit: 1 },
      advanced: { gainPerHit: 2 },
      elite:    { gainPerHit: 3 }
    }
  },
  endurance: {
    /* Сессия 19: «Стойкость». Пассивный модификатор, читается в фазе 1
       computeIncomingDamage (после reinforcement, до armored). Срабатывает
       ТОЛЬКО на DoT-тики (когда caller передаёт opts.isDoTTick:true) —
       сейчас это burning и poisoned (см. SKILLS.burning/poisoned.onTurnStart,
       они переданы opts). Снижает урон тика на reduction (2/4/6),
       max(0, incoming - reduction) — может обнулить полностью (по
       спеке: «DoT, который ты не почувствовал, не наносит и не
       разменивает себя на 1 урон»).

       НЕ событийный триггер, а маркер-модификатор (как crushing_magic).
       Trigger:'damageTickMod' оставлен для семантики и будущей
       инфраструктуры; ветка в computeIncomingDamage читает напрямую
       passiveSkillsOf(target). */
    name: 'Стойкость',
    classId: 'warrior',
    flavor: 'Снижает урон от наложенных негативных эффектов.',
    icon: '🪨',
    spriteSrc: 'assets/sprites/skills/endurance.png',
    kind: 'passive',
    trigger: 'damageTickMod',
    tiers: {
      basic:    { reduction: 2 },
      advanced: { reduction: 4 },
      elite:    { reduction: 6 }
    }
  },
  fortify_armor: {
    /* Сессия 19: «Укрепить броню». Активный self-buff, кулдаун 5/5/5.
       Применяет к самому воину applyArmored(self, 3/5/7). Поведение
       armored — фаза 2 computeIncomingDamage, расход 1-в-1 за счёт
       charges; стак — СУММИРУЕТСЯ (правка 07.05.2026: раньше был max,
       упирался в потолок тира; теперь повторный каст добавляет N
       зарядов поверх текущих, кулдаун 5 ходов ограничивает частоту). */
    name: 'Укрепить броню',
    classId: 'warrior',
    flavor: 'Укрепляет свою броню, снижая получаемый урон.',
    icon: '🪖',
    spriteSrc: 'assets/sprites/skills/fortify_armor.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, charges: 3 },
      advanced: { manaCost: 0, cooldown: 5, charges: 5 },
      elite:    { manaCost: 0, cooldown: 5, charges: 7 }
    }
  },
  second_attack: {
    /* Сессия 20: «Вторая атака». Активный self-buff, кулдаун 4. Требует
       уже использованной атаки (`requireUsedAttack:true`). Сбрасывает
       `actionsUsedThisTurn.attack = false` → игрок может атаковать ещё раз.

       Тиры:
       - Базовый: ДОПОЛНИТЕЛЬНО требует не-использованного движения
         (requireUnusedMove) и проставляет movedThisTurn после каста
         (consumesMove:true). «Жертвует движением для ещё одной атаки».
       - Продвинутый: без требования к движению, без расхода. «Просто
         вторая атака».
       - Элитный: то же что продвинутый + накладывает на воина
         second_attack_buff со statMods:{str:+6, luk:+6},
         expiresAt:'nextAttack' (правка С24: бафф спадает после первой
         же атаки носителя, а не «до конца хода» — иначе он мог покрыть
         несколько атак, что не соответствует дизайну).
       */
    name: 'Вторая атака',
    classId: 'warrior',
    flavor: 'Жертвует движением для ещё одной атаки.',
    icon: '⚔',
    spriteSrc: 'assets/sprites/skills/second_attack.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    requireUsedAttack: true,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, requireUnusedMove: true, consumesMove: true,
                  flavor: 'Жертвует движением для ещё одной атаки.' },
      advanced: { manaCost: 0, cooldown: 5,
                  flavor: 'Вторая атака за ход.' },
      elite:    { manaCost: 0, cooldown: 5, applySelfBuff: 'second_attack_buff',
                  flavor: 'Усиленная вторая атака за ход.' }
    }
  },
  provoke: {
    /* Сессия 20: «Провокация». Активный AoE-аура (self_aura), кулдаун 5.
       Радиус действия = aura R (3/4/5) — манхэттенский. На каждого
       ВРАЖЕСКОГО юнита в зоне накладывается эффект `provoked` с
       forcedTarget=u.id и expiresAt:'forcedMove'. Эффект снимается
       AI-юнитом после совершения «вынужденного движения к источнику»
       (один шаг или атака — см. core/ai.js → consumeForcedMoveEffects).

       Перезапись: новая Провокация полностью перезаписывает предыдущую
       (forcedTarget меняется, длительность сбрасывается). Это явное
       правило пользователя.

       Тиры различаются ТОЛЬКО радиусом (3/4/5). Бонусной брони на воина
       больше нет (правка 05.05.2026 — «достаточно и просто самой
       провокации», `armorCharges` убран из всех тиров; ветка
       applyArmored в executeProvoke больше не срабатывает, но оставлена
       no-op-чувствительной к params для безопасности). */
    name: 'Провокация',
    classId: 'warrior',
    flavor: 'Притягивает к себе внимание врагов поблизости.',
    icon: '💢',
    spriteSrc: 'assets/sprites/skills/provoke.png',
    kind: 'active',
    delivery: 'self_aura',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, range: 3 },
      advanced: { manaCost: 0, cooldown: 5, range: 4 },
      elite:    { manaCost: 0, cooldown: 5, range: 5 }
    }
  },
  cover: {
    /* Сессия 20: «Прикрыть». Активный single-target. Меняется местами
       с целью (телепорт-свап). Не расходует движение воина. Запрет если
       у любого участника висит `immobilized`.

       Дальность: 1/2/2 (basic/advanced/elite, манхэттен).
       Цель: basic/advanced — только союзник; elite — любой живой юнит
       (allowEnemies:true).

       AoE-объекты на клетках НЕ триггерятся — это телепорт, не «вход
       на клетку» (в Сессии 22 это будет важно для капканов). */
    name: 'Прикрыть',
    classId: 'warrior',
    flavor: 'Поменяться местами с союзником поблизости.',
    icon: '🤝',
    spriteSrc: 'assets/sprites/skills/cover.png',
    kind: 'active',
    delivery: 'cover',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 3, range: 1,
                  flavor: 'Поменяться местами с союзником поблизости.' },
      advanced: { manaCost: 0, cooldown: 3, range: 2,
                  flavor: 'Поменяться местами с союзником поблизости.' },
      elite:    { manaCost: 0, cooldown: 3, range: 2, allowEnemies: true,
                  flavor: 'Поменяться местами с союзником или врагом поблизости.' }
    }
  },
  second_attack_buff: {
    /* Сессия 20 + правка С24: эффект элитной «Второй атаки». Бафф со
       statMods (+6 Сила, +6 Удача). expiresAt:'nextAttack' — спадает
       сразу после первой же атаки носителя (раньше был 'turnStart',
       мог покрывать несколько атак). По ходам не тикает. */
    name: 'Подъём (Вторая атака)',
    icon: '⚔',
    spriteSrc: 'assets/sprites/skills/second_attack.png',
    kind: 'effect',
    polarity: 'buff',
    description: 'Сила и Удача +6 на следующую атаку.'
  },
  provoked: {
    /* Сессия 20: эффект Провокации на враге. Заставляет AI выбирать
       источник (forcedTarget) как цель атаки/движения. Снимается в AI
       после первого «вынужденного действия» (шаг или атака) через
       expiresAt:'forcedMove' (см. core/ai.js → consumeForcedMoveEffects). */
    name: 'Спровоцирован',
    icon: '💢',
    spriteSrc: 'assets/sprites/skills/provoke.png',
    kind: 'effect',
    polarity: 'debuff',
    description: 'Цель этого юнита заменена на источник провокации; снимается после его шага или атаки.'
  },
  poison_arrow: {
    /* Сессия 24 (внеочередная): «Отравленная стрела» лучника. Активный
       self-buff, кулдаун 5. Накладывает на лучника эффект
       `poison_arrow_buff` со `expiresAt:'nextAttack'` и
       `applyOnHit:{ id:'poisoned', duration }`. Бафф висит до первой
       атаки носителя — на этой атаке `consumeNextAttackEffects` (см.
       core/effects.js, вызывается из executeAttack) снимет эффект и
       применит applyOnHit к цели. По ходам не тикает — может висеть
       сколько угодно ходов до атаки.

       duration по тиру: 3/5/7. */
    name: 'Отравленная стрела',
    classId: 'archer',
    flavor: 'Отравить следующий выстрел.',
    icon: '🧪',
    spriteSrc: 'assets/sprites/skills/poison_arrow.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, poisonDuration: 3 },
      advanced: { manaCost: 0, cooldown: 5, poisonDuration: 5 },
      elite:    { manaCost: 0, cooldown: 5, poisonDuration: 7 }
    }
  },
  fire_arrow: {
    /* Сессия 24: «Горящая стрела» лучника. Зеркало poison_arrow,
       только применяет `burning` через applyOnHit. Те же CD/duration. */
    name: 'Горящая стрела',
    classId: 'archer',
    flavor: 'Поджечь следующий выстрел.',
    icon: '🔥',
    spriteSrc: 'assets/sprites/skills/fire_arrow.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, burnDuration: 3 },
      advanced: { manaCost: 0, cooldown: 5, burnDuration: 5 },
      elite:    { manaCost: 0, cooldown: 5, burnDuration: 7 }
    }
  },
  poison_arrow_buff: {
    /* Сессия 24: эффект «Отравленная стрела» на лучнике. expiresAt:
       'nextAttack' — снимается после первой атаки носителя (см.
       core/effects.js → consumeNextAttackEffects). На атаке через
       applyOnHit накладывает на цель `poisoned` с duration. По ходам
       НЕ тикает — может висеть сколько угодно ходов до атаки. */
    name: 'Отравленная стрела готова',
    icon: '🧪',
    spriteSrc: 'assets/sprites/skills/poison_arrow.png',
    kind: 'effect',
    polarity: 'buff',
    description: 'Следующая атака наложит «Отравлен» на цель.'
  },
  fire_arrow_buff: {
    /* Сессия 24: эффект «Горящая стрела». Зеркало poison_arrow_buff,
       применяет `burning`. */
    name: 'Горящая стрела готова',
    icon: '🔥',
    spriteSrc: 'assets/sprites/skills/fire_arrow.png',
    kind: 'effect',
    polarity: 'buff',
    description: 'Следующая атака наложит «Горение» на цель.'
  },
  long_shot: {
    /* Сессия 21: «Дальний выстрел» лучника. Активный self-buff,
       кулдаун 5/5/5. Накладывает на лучника эффект `long_shot_buff`
       со `statMods: { weaponRangeBonus: +2/+3/+4 }` и `expiresAt:
       'turnEnd'` — бафф срабатывает строго в этом ходу, после чего
       спадает. Рассчитан паттерн «каст → длинная атака в этот же ход».

       weaponRangeBonus — это НЕ обычный стат (не входит в str/dex/...).
       Отдельный модификатор оружейной дистанции, читается через
       weaponRangeOf(unit) в weapons.js (общий для UI/боя/AI). В
       effectiveStats не попадает — у него нет смысла вне расчёта
       дальности атаки. */
    name: 'Дальний выстрел',
    classId: 'archer',
    flavor: 'Удлинить дальность следующего выстрела в этом ходу.',
    icon: '🎯',
    spriteSrc: 'assets/sprites/skills/long_shot.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, weaponRangeBonus: 2 },
      advanced: { manaCost: 0, cooldown: 5, weaponRangeBonus: 3 },
      elite:    { manaCost: 0, cooldown: 5, weaponRangeBonus: 4 }
    }
  },
  long_shot_buff: {
    /* Сессия 21: эффект «Дальний выстрел» на лучнике. expiresAt:
       'turnEnd' — спадает в endTurn носителя через
       expireTurnEndEffects (зеркало expireTurnStartEffects из С18).
       statMods.weaponRangeBonus читается weaponRangeOf(u) во время
       выбора целей и подсветки клеток атаки. */
    name: 'Дальний выстрел',
    icon: '🎯',
    spriteSrc: 'assets/sprites/skills/long_shot.png',
    kind: 'effect',
    polarity: 'buff',
    description: 'Дальность атаки увеличена до конца хода.'
  },
  second_shot: {
    /* Сессия 21: «Второй выстрел» лучника. Зеркало «Второй атаки»
       воина (см. SKILLS.second_attack, С20). Активный self-buff,
       кулдаун 5/5/5. Требует уже использованной атаки
       (requireUsedAttack:true). Сбрасывает actionsUsedThisTurn.attack.

       Тиры идентичны воиновской логике:
       - Базовый: requireUnusedMove + consumesMove (жертвует движением).
       - Продвинутый: без требований к движению, без расхода.
       - Элитный: то же что продвинутый + applySelfBuff:'second_shot_buff'
         со statMods:{ dex:+6, luk:+6 }, expiresAt:'nextAttack' (бафф
         спадает после первой же атаки — по той же причине, что у
         second_attack_buff после правки С24).

       Общий хелпер enableExtraAttack(u, params, buffApplier) в
       core/combat.js — единая точка для обоих скиллов. */
    name: 'Второй выстрел',
    classId: 'archer',
    flavor: 'Жертвует движением для ещё одного выстрела.',
    icon: '🏹',
    spriteSrc: 'assets/sprites/skills/second_shot.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    requireUsedAttack: true,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, requireUnusedMove: true, consumesMove: true,
                  flavor: 'Жертвует движением для ещё одного выстрела.' },
      advanced: { manaCost: 0, cooldown: 5,
                  flavor: 'Второй выстрел за ход.' },
      elite:    { manaCost: 0, cooldown: 5, applySelfBuff: 'second_shot_buff',
                  flavor: 'Усиленный второй выстрел за ход.' }
    }
  },
  second_shot_buff: {
    /* Сессия 21: эффект элитного «Второго выстрела». Зеркало
       second_attack_buff из С24, с тем же expiresAt:'nextAttack'
       (снимается после первой же атаки носителя через
       consumeNextAttackEffects). statMods читаются общим путём в
       effectiveStats. dex+6 повышает урон лучника (formula bow:
       1 + dex/2), luk+6 повышает шанс крита. */
    name: 'Подъём (Второй выстрел)',
    icon: '🏹',
    spriteSrc: 'assets/sprites/skills/second_shot.png',
    kind: 'effect',
    polarity: 'buff',
    description: 'Ловкость и Удача +6 на следующую атаку.'
  },
  trap: {
    /* Сессия 22: «Капкан» лучника. Активный, целевая клетка в радиусе
       установки (манхэттен), кулдаун 5/5/5. Ставит на клетку объект
       `{ kind:'trap', payload:{ dmg } }` через addObject в core/state.js.

       Клетка должна быть свободна: ни живого юнита, ни надгробия, ни
       другого объекта (общее правило: на надгробии нельзя размещать
       ничего поверх).

       Срабатывание: triggerObjectsOnPathStep в core/movement.js — на
       любом шаге пути, независимо от команды (свой/чужой/нейтральный
       все ловятся). Жертва получает payload.dmg физического урона и
       applyImmobilized(victim, 2) — чтобы гарантированно пропустить
       движение на свой следующий ход (балансная правка 05.05.2026).
       Объект удаляется. Движение жертвы прерывается через canUnitMove-
       проверку в executeMove (которая видит свежий immobilized).

       Тиры:
       - Базовый: радиус установки 1, dmg=5.
       - Продвинутый: радиус 3, dmg=5.
       - Элитный: радиус 3, dmg=5+⌊dex_кастера/2⌋ (зафиксирован в момент
         установки, dex берётся через effectiveStats; payload.dmg НЕ
         пересчитывается при изменении ловкости установившего).

       AI капканы НЕ обходит при поиске пути — сознательное упрощение.
    */
    name: 'Капкан',
    classId: 'archer',
    flavor: 'Установить капкан на пустую клетку — ловит любого, кто на неё ступит.',
    icon: '🪤',
    spriteSrc: 'assets/sprites/skills/trap.png',
    kind: 'active',
    delivery: 'place_object',
    placeObjectKind: 'trap',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, range: 1, dmg: 5 },
      advanced: { manaCost: 0, cooldown: 5, range: 3, dmg: 5 },
      elite:    { manaCost: 0, cooldown: 5, range: 3, dmgFromDex: true, dmgBase: 5 }
    }
  },
  lure: {
    /* Сессия 22: «Приманка» лучника. Активный, целевая клетка в радиусе
       установки (манхэттен), кулдаун 5/5/5. Ставит на клетку объект
       `{ kind:'lure', payload:{ lureRadius, applyOnPickup? } }`.

       Клетка должна быть свободна (см. trap про правила).

       AI-эффект: каждый вражеский AI-юнит, чья текущая позиция в
       манхэттене ≤ lureRadius от приманки и кто сейчас не на её клетке,
       на своём ходу ОБЯЗАН двигаться к приманке (вместо обычной цели).
       Атака приоритетнее: если в радиусе атаки есть подходящая цель —
       AI атакует её, потом уже движется (если движение осталось) к лурe.
       Приманка работает на всех в радиусе одновременно (не только
       «первый по инициативе» — пользователь явно подтвердил 05.05.2026).

       Срабатывание: triggerObjectsOnMoveEnd в core/movement.js — ТОЛЬКО
       при ЗАВЕРШЕНИИ ПОЛНОГО хода жертвы на клетке приманки (не на
       промежуточном шаге; пользователь явно подтвердил 05.05.2026).
       Объект удаляется. Для элитного — дополнительно applyOnPickup на
       жертву (poisoned, 4 хода).

       Тиры:
       - Базовый:    радиус установки 1, lureRadius 2.
       - Продвинутый: радиус установки 3, lureRadius 3.
       - Элитный:    радиус установки 3, lureRadius 3, applyOnPickup
                     {id:'poisoned', duration:4}.
    */
    name: 'Приманка',
    classId: 'archer',
    flavor: 'Установить приманку — враги в радиусе обязаны идти к ней.',
    icon: '🎣',
    spriteSrc: 'assets/sprites/skills/lure.png',
    kind: 'active',
    delivery: 'place_object',
    placeObjectKind: 'lure',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5, range: 1, lureRadius: 2 },
      advanced: { manaCost: 0, cooldown: 5, range: 3, lureRadius: 3 },
      elite:    { manaCost: 0, cooldown: 5, range: 3, lureRadius: 3,
                  applyOnPickup: { id: 'poisoned', duration: 4 } }
    }
  },
  camouflage: {
    /* Сессия 23: «Маскировка» лучника. Активный self-buff, кулдаун 5/5/5.
       Запись в SKILLS одна — она же служит источником name/icon/spriteSrc
       для одноимённого эффекта на юните (паттерн mana_focus / fire_shield;
       чип эффекта в UI рисуется по SKILLS[unit.effects[i].id], независимо
       от kind записи). Активный навык и эффект различаются по контексту
       (canActivateSkill смотрит на kind:active; рендер эффектов —
       на unit.effects[i]).

       Накладывает на лучника эффект camouflage с expiresAt:turnStart —
       снимается в начале СЛЕДУЮЩЕГО собственного хода через
       expireTurnStartEffects (стандартная инфра, см. С18). Между концом
       текущего хода и стартом следующего носитель невидим для AI: AI не
       выбирает его как цель атаки/движения и считает его клетку
       непроходимой при BFS-поиске пути.

       Тиры (БАЛАНС 06.05.2026 — переделан под «не сжирает ход и не
       требует чистых действий, длительность по тиру»):
       - Базовый: длительность = до начала следующего своего хода
         (expiresAt:turnStart, без remaining). Покрывает ровно один
         AI-раунд после применения.
       - Продвинутый: remaining=3. Тикает в конце каждого своего хода;
         снимается в конце 3-го (т.е. покрывает текущий + два следующих
         AI-раунда).
       - Элитный: remaining=5. То же что advanced, но 5 тиков.
       Все тиры: НЕ требуют не-использованных атаки/движения, НЕ
       завершают ход.

       Условия снятия камуфляжа (ПОДТВЕРЖДЕНО пользователем 06.05.2026):
       1. Истечение через expiresAt:turnStart (на следующем своём ходу).
       2. После собственной атаки носителя — снимается в executeAttack
          ПОСЛЕ фактического удара.
       3. При собственном движении носителя (любом — добровольном или
          принудительном через lure/cover) — снимается в конце executeMove.
          Унификация: вместо отдельного флага forced снимаем при ЛЮБОМ
          executeMove. Дизайнерское обоснование: «юнит должен быть
          неподвижным для незаметности».
       4. Через purify (cleanse) — автоматически: cleanse перебирает все
          эффекты и удаляет camouflage наряду с прочими.

       Что НЕ снимает камуфляж (ПОДТВЕРЖДЕНО пользователем 06.05.2026):
       1. AoE-урон (фаербол, цепная молния, призматическая сфера) —
          юнит получает урон и накладываемые эффекты, но камуфляж
          сохраняется. Это сознательный компромисс: камуфляж — щит от
          ПРИЦЕЛЬНОГО выбора, а не от случайно попавшего взрыва.
       2. DoT-тики (poisoned/burning) — урон от висящих ранее эффектов
          не «разоблачает». Прямой следствие правила выше + общего
          правила «applyDamage не трогает камуфляж».
       3. Лечение/cover/щит от союзника — это не урон и не атака. */
    name: 'Маскировка',
    classId: 'archer',
    flavor: 'Стать невидимым для AI до своего следующего хода. Любое движение или атака разоблачает.',
    icon: '🍃',
    spriteSrc: 'assets/sprites/skills/camouflage.png',
    /* description (С23): читается render-panel.js → effects-list при сборке
       тултипа чипа эффекта (строка `if (sk && sk.description) tLines.push(...)`).
       Для тултипа слота активного навыка не показывается — там используется
       `flavor` (см. ветку renderActiveSlot в render-panel.js). */
    description: 'Враги не видят замаскированного юнита, пока он не совершит действие. Любое движение, атака или активный навык снимают маскировку.',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 0, cooldown: 5,
                  flavor: 'Маскировка до начала следующего хода.' },
      advanced: { manaCost: 0, cooldown: 5, duration: 3,
                  flavor: 'Маскировка на 3 хода (текущий и следующий).' },
      elite:    { manaCost: 0, cooldown: 5, duration: 5,
                  flavor: 'Маскировка на 5 ходов.' }
    }
  },
  marksman: {
    /* Сессия 21: «Меткий стрелок» лучника. Пассивная прибавка к крит-
       шансу. Читается напрямую в critChanceOf (core/stats-calc.js) —
       по аналогии с crushing_magic. Прибавляется ДО общего clamp'а в
       [-100, 100], так что в комбинации с очень высокой Удачей
       упирается в потолок 100% (а не суммарно >100%).

       Без trigger'а — это статический модификатор, не событийный. */
    name: 'Меткий стрелок',
    classId: 'archer',
    flavor: 'Лучник стреляет точнее. Шанс крита повышается.',
    icon: '🎯',
    spriteSrc: 'assets/sprites/skills/marksman.png',
    kind: 'passive',
    description: 'Повышает шанс крита.',
    tiers: {
      basic:    { bonus: 5  },
      advanced: { bonus: 10 },
      elite:    { bonus: 15 }
    }
  },
  corpse_poison: {
    // Пассивка зомби. Срабатывает на цель, которая получила урон от носителя —
    // накладывается одноимённый эффект длительности 2 с силой по тиру.
    name: 'Трупный яд',
    classId: 'zombie',
    flavor: 'Разлагающаяся плоть носителя при ударе впрыскивает в жертву ядовитую слизь.',
    icon: '☠',
    // spriteSrc — общая pixel-art иконка для слота пассивки у зомби
    // и для чипа статус-эффекта на цели в секции «Воздействия».
    spriteSrc: 'assets/sprites/skills/corpse_poison.png',
    kind: 'passive',
    trigger: 'onDealDamage',
    description: 'Уменьшает все характеристики цели, кроме Удачи.',
    // Общие поля эффекта (id, сам тип дебаффа)
    effectId: 'corpse_poison',
    /* Балансная правка (07.05.2026): фиксированный statMod (-1/-2/-3 ко
       всем статам) на поздних уровнях терялся в шуме (зомби 20+ ур. с
       Силой 23 практически не страдал от элитного -3 → ~13%). Перевели
       на проценты от БАЗОВОЙ величины каждого стата:
         basic    -10%, advanced -20%, elite -30% (округление ВВЕРХ).
       Расчёт делает applyCorpsePoison (см. core/effects.js): для каждого
       стата кроме Удачи кладётся `statMods[k] = -ceil(base[k] * pct/100)`.
       Округление вверх — в пользу более жёсткого дебаффа («1.5 → 2»),
       чтобы яд оставался ощутимым на низких базовых значениях. Удача,
       как и раньше, не затрагивается (задел на механику «удача
       выбивает из-под яда»).
       Балансная правка (08.05.2026): проценты подняты до 15/25/35
       — зомби в одиночку слабее волков, дебафф должен сильнее «кусать»,
       чтобы компенсировать отсутствие групповой синергии. */
    tiers: {
      basic:    { statPercent: 15, duration: 2 },
      advanced: { statPercent: 25, duration: 2 },
      elite:    { statPercent: 35, duration: 2 }
    }
  },

  /* === Сессия 7: пассивки мага (каркас) ============================
     Записи добавлены, инфраструктура хуков готова, ХУКИ НИКОМУ ПОКА
     НЕ ВЫДАНЫ (CLASSES.mage.passiveSkills остаётся пустым). Это
     осознанный шаг: после Сессии 7 идёт сессия выдачи навыков всем
     классам и сразу за ней — система прокачки. До этого пассивки
     лежат как данные, проверяются через console.assert и точечный
     вызов из консоли (`u.passiveSkills = ['mana_regen']`).

     spriteSrc у всех трёх — пока null. PNG лежат в `C:\Проекты\Спрайты`,
     путь будет дан после Сессии 7; до тех пор иконку рисует UI как
     эмодзи-fallback из поля `icon` (см. render-panel.js → secondary
     ветка слота: если sprite пуст — берётся icon как text).
     ================================================================ */

  mana_regen: {
    // Пассивка: «Восполнение маны».
    // Триггер `onTurnEnd` носителя — в конце собственного хода юнит
    // получает +amount маны, не выше maxMana, и только пока за текущую
    // волну восстановлено суммарно меньше cap. Счётчик
    // `unit.passives.manaRegen.restored` сбрасывается при `startNextWave`.
    name: 'Восполнение маны',
    classId: 'mage',
    flavor: 'Маг ускоренно восстанавливает затраченную ману.',
    icon: '💧',
    spriteSrc: 'assets/sprites/skills/mana_regen.png',
    kind: 'passive',
    trigger: 'onTurnEnd',
    // Описание для тултипа собирается на лету в render-panel.js из tierData
    // (см. ветку `if (sid === 'mana_regen')`). Поле `description` тут
    // намеренно отсутствует — для kind:'passive' оно UI'ем не читается,
    // а статичная строка не может вставить tier-зависимые числа.
    tiers: {
      basic:    { amount: 1, capPerWave: 10 },
      advanced: { amount: 2, capPerWave: 15 },
      elite:    { amount: 3, capPerWave: 20 }
    }
  },
  crushing_magic: {
    // Пассивка: «Сокрушающая магия».
    // Не триггер, а МОДИФИКАТОР шанса крита. Если у юнита висит эта
    // пассивка, `critChanceOf(u)` добавляет `floor(effectiveStats.wis * mult)`
    // к базовому luk-у. Потолок 100%. Половинку «отрицательная Удача →
    // шанс промаха» (см. DESIGN.md) реализуем в Сессии 8 в одной точке
    // с этой логикой — чтобы они не разошлись.
    name: 'Сокрушающая магия',
    classId: 'mage',
    flavor: 'Заклинатель находит уязвимые точки противника, увеличивая шанс критических ударов.',
    icon: '💥',
    spriteSrc: 'assets/sprites/skills/crushing_magic.png',
    kind: 'passive',
    trigger: 'critChanceMod',        // не «событие», а маркер «читать в critChanceOf»
    // Описание для тултипа — в render-panel.js (формула с tier-mult).
    // Поле `description` тут не нужно (см. mana_regen выше).
    tiers: {
      basic:    { mult: 1.0 },        // +⌊Мудрость⌋
      advanced: { mult: 1.5 },        // +⌊Мудрость*1.5⌋
      elite:    { mult: 2.0 }         // +⌊Мудрость*2⌋
    }
  },
  mana_absorb: {
    // Пассивка: «Поглощение маны».
    // Триггер `onManaSpent` — после фактического вычета маны на каст
    // активного навыка (сейчас единственный источник — фаербол; будущие
    // активки тоже будут звать `triggerOnManaSpent` после `u.mana -= cost`).
    // Если spent ≥ 1 и пассивка висит — heal на heal-amount, не выше maxHp.
    // Если spent === 0 — не срабатывает.
    name: 'Поглощение маны',
    classId: 'mage',
    flavor: 'Каждая израсходованная капля маны возвращается жизненной силой.',
    icon: '🩸',
    spriteSrc: 'assets/sprites/skills/mana_absorb.png',
    kind: 'passive',
    trigger: 'onManaSpent',
    // Описание для тултипа — в render-panel.js. ПРИМЕЧАНИЕ: лечение
    // плоское (`tierData.heal`), не пропорциональное spent — формулировка
    // тултипа отражает реальное поведение. Прежнее поле `description`
    // говорило «пропорционально потраченной мане» и расходилось с кодом —
    // удалено намеренно, чтобы не создавать тихого вранья в данных.
    tiers: {
      basic:    { heal: 5  },
      advanced: { heal: 10 },
      elite:    { heal: 15 }
    }
  },
  /* --- Generic status effects --------------------------------------
     Три базовых статуса с триггером onTurnStart. Источников (скиллов/
     оружия), которые бы их накладывали, пока нет — это только данные и
     хуки. Накладываются через applyBurning / applyPoisoned /
     applyStunned (см. ниже). Правила стакинга: повторное применение
     того же эффекта складывает длительности (existing.remaining += new).
     DoT от Горит/Отравлен — стабильный, без ролла крита (решение
     пользователя).
  */
  armored: {
    /* Сессия 17 + правка 04.05.2026: эффект «Бронирован». Не имеет
       длительности — спадает, когда charges <= 0 (см. computeIncomingDamage
       фаза 2 в core/damage.js). Стак — «лучшая броня вытесняет худшую»
       (applyArmored в core/effects.js). Запись в SKILLS нужна только для
       UI-чипа (spriteSrc, name, icon). Логика — в effects.js/damage.js. */
    name: 'Бронирован',
    icon: '🛡',
    spriteSrc: 'assets/sprites/status/armored.png',
    kind: 'effect',
    polarity: 'buff',
    description: 'Вычитает число зарядов из входящего урона. Каждое получение урона расходует 1 заряд. Снимается, когда зарядов не остаётся.'
  },
  burning: {
    name: 'Горит',
    icon: '🔥',
    spriteSrc: 'assets/sprites/status/burning.png',
    kind: 'effect',
    polarity: 'debuff',
    damageType: 'fire',
    description: 'В начале хода наносит огненный урон, равный текущей длительности.',
    onTurnStart(unit, eff) {
      if (!unit || !unit.alive) return;
      const baseDmg = eff.remaining | 0;
      if (baseDmg <= 0) return;
      const cls = CLASSES[unit.classId];
      // Огонь сейчас никаких типовых модификаторов не получает, но
      // прогоняем через единую функцию — на случай, когда добавим
      // «нежить горит лучше» и т.п., чтобы не править место точечно.
      // Сессия 19: opts.isDoTTick:true — для пассивки «Стойкость» (endurance)
      // в фазе 1 computeIncomingDamage (снижает только тики DoT, не обычные удары).
      const { dmg, note } = computeIncomingDamage(unit, baseDmg, 'fire', { isDoTTick: true });
      const noteSuffix = note ? ` (${note})` : '';
      log(`${cls.name} (${unit.team}) — Горит: ${dmg} ${DAMAGE_TYPES.fire.label} урона${noteSuffix}`, 'damage');
      // source = null: урон от эффекта, а не от юнита-противника.
      // Значит triggerOnDealDamagePassives не сработает и ход ядов
      // по цепочке не раскрутится.
      applyDamage(unit, dmg, null);
    }
  },
  poisoned: {
    name: 'Отравлен',
    icon: '🧪',
    spriteSrc: 'assets/sprites/status/poisoned.png',
    kind: 'effect',
    polarity: 'debuff',
    damageType: 'poison',
    description: 'В начале хода наносит ядовитый урон, равный текущей длительности.',
    onTurnStart(unit, eff) {
      if (!unit || !unit.alive) return;
      const baseDmg = eff.remaining | 0;
      if (baseDmg <= 0) return;
      const cls = CLASSES[unit.classId];
      // Здесь модификатор реален: иммунные типы получат 0 — но обычно
      // applyPoisoned их даже не пускает в этот эффект. Дублируем фильтр
      // на стороне урона как страховку: если когда-нибудь источник
      // обойдёт apply-хелпер (загрузка из сейва, дебаг, etc.) — урон
      // всё равно не пройдёт.
      // Сессия 19: opts.isDoTTick:true — для «Стойкости».
      const { dmg, note } = computeIncomingDamage(unit, baseDmg, 'poison', { isDoTTick: true });
      const noteSuffix = note ? ` (${note})` : '';
      log(`${cls.name} (${unit.team}) — Отравлен: ${dmg} ${DAMAGE_TYPES.poison.label} урона${noteSuffix}`, 'damage');
      applyDamage(unit, dmg, null);
    }
  },
  stunned: {
    name: 'Оглушен',
    icon: '💫',
    spriteSrc: 'assets/sprites/status/stunned.png',
    kind: 'effect',
    polarity: 'debuff',
    description: 'Персонаж пропускает свой ход.',
    onTurnStart(unit, eff) {
      if (!unit || !unit.alive) return;
      // Флаг читается в beginTurn после фазы: если он true, юнит не
      // получает управление и ход уходит в endTurn. Длительность эффекта
      // тикает как обычно в tickEffectsAtTurnEnd, т.е. Оглушение на N
      // гарантированно пропускает N собственных ходов носителя.
      unit.skipTurnThisTurn = true;
      const cls = CLASSES[unit.classId];
      log(`${cls.name} (${unit.team}) — Оглушён: ход пропущен`, 'info');
    }
  },
  immobilized: {
    // «Обездвижен» — точечный аналог стана: ход НЕ пропускается, но
    // юнит не может двигаться (ни кликом по клетке, ни через активный
    // навык, который перемещает кастера — `movesUser: true`). Атака,
    // обычные скиллы (фаербол и т.п.) разрешены — это сознательно. В
    // эмодзи нет «цепи на ноге», ставим 🪤 (ловушка) — узнаваемая
    // ассоциация «застрял на месте».
    name: 'Обездвижен',
    icon: '🪤',
    spriteSrc: 'assets/sprites/status/immobilized.png',
    kind: 'effect',
    polarity: 'debuff',
    description: 'Юнит не может перемещаться: ни базовое движение, ни активные навыки, перемещающие кастера. Атака и остальные скиллы разрешены.'
    // Хука по фазам нет: иммобилизация — пассивный фильтр на стороне
    // движения и активации скиллов (см. canUnitMove / executeMove /
    // enterMode / aiZombieStepMove). Это проще, чем выставлять флаг
    // в onTurnStart — флаги нужно сбрасывать, а проверка-через-эффект
    // самосогласована: эффект висит — нельзя, тикнул в 0 — снова можно.
  },
  slowed: {
    // «Замедлен» — точечный stat-эффект, понижающий Скорость на величину
    // силы (strength). Тиков урона нет, движение и атаки разрешены, но
    // меньше клеток за ход (moveRangeOf считается от ЭФФЕКТИВНОЙ Spd).
    // Сила хранится на экземпляре в `statMods: { spd: -strength }`,
    // statBreakdown читает её через общую ветку «eff.statMods» (см.
    // core/stats-calc.js). Спадает в общем tickEffectsAtTurnEnd —
    // собственного onTurnStart-хука нет (модификатор пассивный).
    // Накладывается через applySlowed (см. core/effects.js) и через
    // applySkillEffectDef для тиров активных скиллов с одним из
    // двух форматов:
    //   `applyEffect: { id: 'slowed', strength: N, duration: D }`     — фикс. сила;
    //   `applyEffect: { id: 'slowed', percent: N, duration: D }`      — процент от
    //   базовой Spd цели (округление вверх). Применяется в Ледяной стреле
    //   (advanced 30%, elite 60%, см. ice_arrow). Расчёт процента — в
    //   диспатчере applySkillEffectDef (core/skills.js); сам applySlowed
    //   работает уже с готовым strength.
    name: 'Замедлен',
    icon: '🐌',
    spriteSrc: 'assets/sprites/status/slowed.png',
    kind: 'effect',
    polarity: 'debuff',
    description: 'Снижает Скорость цели на величину силы эффекта.'
  },
  /* === Сессия волков: пассивки группы 'wolves' ====================
     joint_hunt: trigger='onDealDamage'. ПРЕ-эффект (бонус урона по числу
       стаков `joint_hunt_marks` на цели) применяется в executeAttack
       через getJointHuntDamageBonus(attacker, target). ПОСТ-эффект
       (накладывание +N стаков) применяется в triggerOnDealDamagePassives
       (core/damage.js → ветка 'joint_hunt' → applyJointHuntStack).
       Стаки на цели хранятся в эффекте joint_hunt_marks (см. ниже).

     wolf_howl: trigger='onTurnStart'. Если носитель в режиме aggro —
       все юниты группы 'wolves' той же команды переходят из 'sleeping'
       в 'active'. Продвинутая/Элитная: тем, кого реально перевели,
       выдаётся бафф +2/+4 spd с expiresAt:'turnEnd' (снимется в конце
       ИХ следующего хода) и пересчитывается state.initiativeOrder
       для остатка раунда (refreshInitiativeAfterCurrent в core/skills.js).
       Реализация — в core/skills.js → triggerPassivesAtTurnStart, ветка
       'wolf_howl'.

     pack_leader: статичная аура. Реализована вне triggerName-хуков —
       refreshPackLeaderAuras в core/skills.js пересобирает эффект
       `pack_leader_aura` на всех wolves в радиусе Чебышева 5 от любого
       живого лидера группы той же команды. Вызывается в beginTurn ДО
       expireTurnStartEffects, после смерти лидера и после движения
       (cleanup leans on per-turn refresh — небольшой лаг приемлем). */
  bony: {
    /* Пассивка скелетов (09.05.2026). Снижает входящий урон от АТАК
       с delivery:'ranged' на процент по тиру (basic 30 / advanced 35 /
       elite 40). Реализация: ветка 1.6 в core/damage.js → computeIncomingDamage,
       читает opts.delivery (caller передаёт weapon.delivery / params.delivery).
       Применяется ПОСЛЕ всех остальных flat-снижений фазы 1 — итог
       умножается на (1 - reduction/100), затем floor с полом 1.
       Не действует на melee (мечи/когти), aoe (фаербол), special.
       Не trigger'ится — статический модификатор. */
    name: 'Костлявый',
    classId: 'skeleton_warrior',  // условно один из скелетов; classId нужен только для UI-фильтра учебников
    flavor: 'Кости плохо держат стрелы и магические дротики — дальние атаки скользят по рёбрам.',
    icon: '🦴',
    spriteSrc: 'assets/sprites/skills/bony.png',
    kind: 'passive',
    description: 'Снижает урон от дальних атак.',
    tiers: {
      basic:    { reduction: 30 },
      advanced: { reduction: 35 },
      elite:    { reduction: 40 }
    }
  },
  /* === Скиллы священника (Сессия A, 09.05.2026) ====================
     Все стоят ману, без cooldown. delivery согласно поведению:
       healing/blessing/purify_touch — single-target ranged (используем
         existing single-target overlay в render-overlay.js, фильтр на
         союзника/врага задаётся в executor + computeRangedTargets).
       holy_strength — self_buff (отдельная ветка, как mana_focus). */

  healing: {
    name: 'Исцеление',
    classId: 'priest',
    flavor: 'Исцеляет раны.',
    icon: '✨',
    spriteSrc: 'assets/sprites/skills/healing.png',
    kind: 'active',
    range: 3,
    delivery: 'ranged',
    damageType: 'holy',          // фильтрация цели в computeRangedTargets разрешит и союзников через targetingMode
    canCrit: false,
    targetingMode: 'ally_self',  // 09.05.2026: новое поле — кому скилл может попасть; см. computeRangedTargets
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8, healBase: 2 },
      advanced: { manaCost: 8, healBase: 6 },
      elite:    { manaCost: 8, healBase: 10 }
    }
  },

  blessing: {
    name: 'Благословение',
    classId: 'priest',
    flavor: 'Благословляет союзников, даря им удачу. Либо отводит удачу от нежити и демонов.',
    icon: '☀',
    spriteSrc: 'assets/sprites/skills/blessing.png',
    kind: 'active',
    range: 3,
    delivery: 'ranged',
    damageType: 'holy',
    canCrit: false,
    targetingMode: 'ally_self_or_undead_demon',  // союзник/себя ИЛИ враждебная нежить/демон
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 6, lukDelta: 10, duration: 7 },
      advanced: { manaCost: 6, lukDelta: 20, duration: 7 },
      elite:    { manaCost: 6, lukDelta: 30, duration: 7 }
    }
  },

  purify_touch: {
    name: 'Очищающее касание',
    classId: 'priest',
    flavor: 'Наложением рук снимает все негативные эффекты.',
    icon: '🤲',
    spriteSrc: 'assets/sprites/skills/purify_touch.png',
    kind: 'active',
    range: 1,                     // basic/advanced — 1; elite повышает до 2 (см. tiers.elite.range)
    delivery: 'ranged',
    damageType: 'holy',
    canCrit: false,
    targetingMode: 'ally_self',
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8, range: 1, immunityDuration: 0 },
      advanced: { manaCost: 8, range: 1, immunityDuration: 1 },  // immunityDuration > 0 → накладывается purify_immunity до начала след. хода
      elite:    { manaCost: 8, range: 2, immunityDuration: 1 }
    }
  },

  holy_strength: {
    name: 'Святая сила',
    classId: 'priest',
    flavor: 'Придаёт силу для борьбы со злом.',
    icon: '⚒',
    spriteSrc: 'assets/sprites/skills/holy_strength.png',
    kind: 'active',
    range: 0,
    delivery: 'self_buff',
    damageType: 'holy',
    canCrit: false,
    targetingMode: 'self',
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8, duration: 3, strBonus: 6,  stunChance: 10 },
      advanced: { manaCost: 8, duration: 3, strBonus: 9,  stunChance: 20 },
      elite:    { manaCost: 8, duration: 3, strBonus: 12, stunChance: 30 }
    }
  },

  /* Эффекты-инстансы священника. Декларация в реестре нужна для UI
     (имя/иконка чипа, polarity для цвета рамки) и для будущих фильтров. */
  /* Воскрешение (Сессия B, 10.05.2026). Активный, цель — НАДГРОБИЕ
     союзного героя в манхэттене ≤1. Возвращает к жизни с tier-зависимыми
     ресурсами. Воскрешённый пропускает СВОЙ ближайший ход (флаг
     resurrectedSkipNext=true; срабатывает в beginTurn). 15 маны. */
  resurrection: {
    name: 'Воскрешение',
    classId: 'priest',
    flavor: 'Возвращает к жизни павших союзников.',
    icon: '⚱',
    spriteSrc: 'assets/sprites/skills/resurrection.png',
    kind: 'active',
    range: 1,
    delivery: 'grave_target',  // новый mode: клик по могиле, не по живому юниту
    damageType: 'holy',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 15, hpPercent: 0,  manaPercent: 0  },  // 1 HP, 0 mana
      advanced: { manaCost: 15, hpPercent: 10, manaPercent: 10 },
      elite:    { manaCost: 15, hpPercent: 30, manaPercent: 30 }
    }
  },

  /* Священная броня (Сессия B, 10.05.2026). Активный buff на союзника
     или себя (только elite). Накладывает holy_shield_buff с damageCap=1
     до начала следующего хода цели. expiresAt:'turnStart'. */
  holy_shield: {
    name: 'Священная броня',
    classId: 'priest',
    flavor: 'Накладывает святую защиту, оберегающую от урона.',
    icon: '🛡',
    spriteSrc: 'assets/sprites/skills/holy_shield.png',
    kind: 'active',
    delivery: 'self_buff',
    damageType: 'holy',
    canCrit: false,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 15, range: 1, allowSelf: false },
      advanced: { manaCost: 15, range: 3, allowSelf: false },
      elite:    { manaCost: 15, range: 3, allowSelf: true  }
    }
  },

  /* Истребитель зла (Сессия B, 10.05.2026). Пассивка. Двусторонний
     модификатор урона по нежити/демонам:
       — носитель получает на N% МЕНЬШЕ урона от атак undead/demon
         (срабатывает в computeIncomingDamage через opts.source);
       — носитель наносит на N% БОЛЬШЕ урона по undead/demon
         (срабатывает в executeAttack damage calc до computeIncomingDamage).
     Тиры: 15% / 30% / 50%. */
  evil_slayer: {
    name: 'Истребитель зла',
    classId: 'priest',
    flavor: 'Священник специализируется на борьбе с нежитью и демонами.',
    icon: '☩',
    spriteSrc: 'assets/sprites/skills/evil_slayer.png',
    kind: 'passive',
    description: 'Меньше получает и больше наносит урон по нежити и демонам.',
    tiers: {
      basic:    { reductionPercent: 15, bonusPercent: 15 },
      advanced: { reductionPercent: 30, bonusPercent: 30 },
      elite:    { reductionPercent: 50, bonusPercent: 50 }
    }
  },

  /* Эффект-инстанс «Священная броня». На цели висит до начала её
     следующего хода (expiresAt:'turnStart'). damageCap=1 — финальная
     фаза computeIncomingDamage кэпает входящий урон. */
  /* Волна света (Сессия C, 11.05.2026). Активный AoE вокруг кастера.
     delivery:'self_aoe' — новый тип: цель не выбирается, кастер сам в
     центре; область — манхэттенский радиус params.range. Бьёт ТОЛЬКО
     по unitType ∈ {undead, demon}. На каждой попавшей цели — урон
     `damageBase + ⌊wis/wisDivisor⌋` + накладывается «Напуган» на 1 ход.
     UI: render-overlay рисует подсвеченный радиус, клик на клетку
     кастера (или любую в радиусе) подтверждает каст. */
  light_wave: {
    name: 'Волна света',
    classId: 'priest',
    flavor: 'Испускает вокруг себя волну света, ранящую и отпугивающую нежить и демонов.',
    icon: '🌟',
    spriteSrc: 'assets/sprites/skills/light_wave.png',
    kind: 'active',
    delivery: 'self_aoe',
    damageType: 'holy',
    canCrit: true,
    consumesBasicAttack: false,
    tiers: {
      basic:    { manaCost: 8, range: 3, damageBase: 2, wisDivisor: 2,   frightenedDuration: 1 },
      advanced: { manaCost: 8, range: 4, damageBase: 2, wisDivisor: 2,   frightenedDuration: 1 },
      elite:    { manaCost: 8, range: 4, damageBase: 2, wisDivisor: 1.5, frightenedDuration: 1 }
    }
  },

  /* Исцеляющая аура (Сессия C, 11.05.2026). Пассивка-аура. В начале
     СВОЕГО хода каждый живой союзник на смежной (Чебышев=1, 8 направлений)
     клетке от носителя пассивки получает +N HP (по тиру), но не выше
     maxHp. Не действует на механизмы.
     Триггер реализован в core/turn.js → beginTurn() ПОСЛЕ
     triggerEffectsAtTurnStart, через хелпер triggerHealingAuraForUnit
     в core/effects.js. */
  healing_aura: {
    name: 'Исцеляющая аура',
    classId: 'priest',
    flavor: 'Испускает ауру, исцеляющую стоящих вплотную союзников.',
    icon: '💚',
    spriteSrc: 'assets/sprites/skills/healing_aura.png',
    kind: 'passive',
    description: 'Соседние союзники в начале своего хода восстанавливают HP.',
    tiers: {
      basic:    { healAmount: 2 },
      advanced: { healAmount: 4 },
      elite:    { healAmount: 6 }
    }
  },

  holy_shield_buff: {
    name: 'Священная броня',
    icon: '🛡',
    spriteSrc: 'assets/sprites/skills/holy_shield.png',
    kind: 'effect',
    polarity: 'buff'
  },

  blessing_buff: {
    name: 'Благословение',
    icon: '☀',
    spriteSrc: 'assets/sprites/skills/blessing.png',
    kind: 'effect',
    polarity: 'buff',
  },
  blessing_curse: {
    name: 'Проклятие удачи',
    icon: '☀',
    spriteSrc: 'assets/sprites/skills/blessing.png',
    kind: 'effect',
    polarity: 'debuff',
  },
  holy_strength_buff: {
    name: 'Святая сила',
    icon: '⚒',
    spriteSrc: 'assets/sprites/skills/holy_strength.png',
    kind: 'effect',
    polarity: 'buff',
  },
  purify_immunity: {
    name: 'Святая защита от порчи',
    icon: '🤲',
    spriteSrc: 'assets/sprites/skills/purify_touch.png',
    kind: 'effect',
    polarity: 'buff',
  },

  joint_hunt: {
    name: 'Совместная охота',
    classId: 'wolf',
    flavor: 'Каждый укус метит жертву; следующий волк, добравшийся до неё, бьёт сильнее.',
    icon: '🐾',
    spriteSrc: 'assets/sprites/skills/joint_hunt.png',
    kind: 'passive',
    trigger: 'onDealDamage',
    effectId: 'joint_hunt_marks',
    description: 'При атаке прибавляет к урону число висящих на цели стаков «Совместной охоты». После удара накладывает +N стаков (по тиру). В начале хода жертвы стаки уменьшаются на 50% (округление вниз).',
    tiers: {
      basic:    { stacksGain: 1 },
      advanced: { stacksGain: 2 },
      elite:    { stacksGain: 3 }
    }
  },
  wolf_howl: {
    name: 'Волчий вой',
    classId: 'wolf',
    flavor: 'Воющий волк поднимает всю стаю на ноги.',
    icon: '🌕',
    spriteSrc: 'assets/sprites/skills/wolf_howl.png',
    kind: 'passive',
    trigger: 'onTurnStart',
    description: 'В начале своего хода (если носитель в режиме агро) переводит спящих сородичей в режим агро. На продвинутом тире пробуждённые получают +2 к Скорости до конца их следующего хода (и инициатива пересчитывается). На элитном — +4.',
    tiers: {
      basic:    { spdBuff: 0 },
      advanced: { spdBuff: 2 },
      elite:    { spdBuff: 4 }
    }
  },
  pack_leader: {
    name: 'Лидер стаи',
    classId: 'wolf_alpha',
    flavor: 'Присутствие вожака пробуждает в стае ярость.',
    icon: '👑',
    spriteSrc: 'assets/sprites/skills/pack_leader.png',
    kind: 'passive',
    trigger: 'aura',
    description: 'Все ПОДЧИНЁННЫЕ юниты группы «Волки» в радиусе 5 клеток получают усиление «Лидер рядом»: +30% Силы (округление вверх от базовой Силы). Сам вожак ауру не получает. Усиление спадает при выходе из радиуса или гибели лидера.',
    tiers: {
      basic:    { radius: 5, strPercent: 30 },
      advanced: { radius: 5, strPercent: 30 },
      elite:    { radius: 5, strPercent: 30 }
    }
  },
  /* === Сессия Призрак (12.05.2026) ================================
     Призрак — лидер группы «нежить» (group:undead) с baseDifficulty:5.
     Его коробка навыков:
       • ghostly         — пассивка; снижает входящий ФИЗИЧЕСКИЙ урон
                            на 80% (фильтр damageType==='physical', !isDoTTick).
                            Подключена в core/damage.js → computeIncomingDamage,
                            фаза 1.8 (после bony/evil_slayer). Не trigger'ится —
                            статический модификатор. Магия, огонь, мороз,
                            электричество, святой, яд — не снижаются (но яд
                            и так обнуляется иммунитетом нежити фазы 3).
       • ghostly_scream  — активный «крик»: один раз за бой, бесплатно.
                            Переводит всю нежить (unitType==='undead' и
                            aggroState==='sleeping') в active; накладывает
                            «Оглушён» на 1 ход на каждого героя на доске
                            (CLASSES[id].kind==='hero'). Реализация —
                            executeGhostlyScream в core/combat.js, регистрация
                            в SKILL_EXECUTORS. AI-only: героям не выдаётся
                            (классов с этим скиллом среди героев нет).
     Прокачка пассивки тиров не имеет — фиксированно 80% reduction.
  */
  ghostly: {
    /* Баланс 12.05.2026: reduction снижен с 80% до 60% по обсуждению с
       заказчиком. Аргументация — нежить как группа разобщена (нет
       аналогов wolf_howl / pack_leader, синергий между классами почти
       нет), поэтому одиночный лидер не должен быть «непробиваемым»
       контром для физ-классов. При 60% воин с базовым уроном 5 наносит
       2 урона (floor(5*0.4)=2) — это втрое меньше базового, но не
       упирается в пол 1, и партия без мага всё ещё может его разобрать. */
    name: 'Призрачность',
    classId: 'ghost',
    flavor: 'Полупрозрачная плоть призрака слабо реагирует на сталь и стрелы — большая часть ударов проходит почти сквозь него.',
    icon: '👻',
    spriteSrc: 'assets/sprites/skills/ghostly.png',
    kind: 'passive',
    description: 'Снижает получаемый физический урон на 60%.',
    tiers: {
      basic:    { reduction: 60 },
      advanced: { reduction: 60 },
      elite:    { reduction: 60 }
    }
  },
  ghostly_scream: {
    /* Активный «крик», один раз за бой (onceWave:true). delivery:'self_cast' —
       новая короткая ветка self-only без подсветки клеток: AI применяет
       executeGhostlyScream напрямую через targetId=u.id, режим прицеливания
       игроку не нужен (скилла нет ни у одного героя). manaCost:0 —
       canActivateSkill пропустит при mana=0.

       НЕ consumesBasicAttack — Призрак после крика может в этом же ходу
       атаковать (пункт 2 AI-политики). Доп-фаза атаки (пункт 3) тоже
       подхватывает: skillsUsedThisTurn блокирует только повторный каст
       активки, не базовую атаку. */
    name: 'Призрачный крик',
    classId: 'ghost',
    flavor: 'Леденящий вопль раздаётся над полем боя — мёртвые отзываются, живые цепенеют.',
    icon: '😱',
    spriteSrc: 'assets/sprites/skills/ghostly_scream.png',
    kind: 'active',
    delivery: 'self_cast',     // self-only, без overlay; AI кастует executeGhostlyScream напрямую
    damageType: 'magic',       // декоративно для тултипа; урон скилл не наносит
    canCrit: false,
    consumesBasicAttack: false,
    onceWave: true,            // один раз за бой; флаг сбрасывается в startNextWave
    targetingMode: 'self',
    tiers: {
      basic:    { manaCost: 0, stunDuration: 1 },
      advanced: { manaCost: 0, stunDuration: 1 },
      elite:    { manaCost: 0, stunDuration: 1 }
    }
  },
  joint_hunt_marks: {
    /* Стаки «Совместной охоты» на жертве — отдельный статус-эффект,
       НЕ тикает по длительности. На экземпляре эффекта хранится `stacks`
       (натуральное число). В начале хода носителя `onTurnStart` делит
       stacks на 2 с округлением вниз; если результат 0 — эффект снимается.
       Механика истечения через remaining НЕ используется (на экземпляре
       remaining не выставляется → tickEffectsAtTurnEnd оставляет его
       нетронутым: NaN-1 = NaN, NaN <= 0 false → kept).

       Apply-хелпер: applyJointHuntStack(target, stacksGain, sourceTier)
       в core/effects.js. Бонус урона читается напрямую из stacks через
       getJointHuntDamageBonus(attacker, target) в core/combat.js. */
    name: 'Совместная охота',
    icon: '🐾',
    spriteSrc: 'assets/sprites/skills/joint_hunt.png',
    kind: 'effect',
    polarity: 'debuff',
    description: 'Стаки совместной охоты. Каждый стак увеличивает урон от носителя пассивки «Совместная охота» на 1. В начале своего хода жертвы стаки делятся пополам (округление вниз), при результате 0 — эффект снимается.',
    onTurnStart(unit, eff) {
      if (!unit || !eff) return;
      const before = Math.max(0, eff.stacks | 0);
      if (before <= 0) {
        // Защитная ветка — стака нет, снимаем сразу.
        unit.effects = (unit.effects || []).filter(e => e !== eff);
        return;
      }
      const after = Math.floor(before / 2);
      const cls = CLASSES[unit.classId];
      const who = cls ? `${cls.name} (${unit.team})` : unit.id;
      if (after <= 0) {
        unit.effects = (unit.effects || []).filter(e => e !== eff);
        log(`${who} — «Совместная охота» спадает (был 1 стак)`, 'info');
      } else {
        eff.stacks = after;
        log(`${who} — «Совместная охота»: ${before} → ${after} стак.`, 'info');
      }
    }
  },
  pack_leader_aura: {
    /* Эффект-аура. На экземпляре хранится `statMods: { str: +N }` —
       N = ceil(базовая Сила цели * 0.30). Не тикает (нет remaining),
       не наследуется по длительности — каждый поворот хода
       refreshPackLeaderAuras (core/skills.js) пересчитывает эффект
       (создаёт / обновляет N / снимает) на основании текущего
       расположения живых лидеров.

       Source-of-truth — refreshPackLeaderAuras. Прямого apply-хелпера
       нет: эффект не должен накладываться вручную из других мест,
       чтобы не разойтись с per-turn пересчётом. */
    name: 'Лидер рядом',
    icon: '👑',
    spriteSrc: 'assets/sprites/skills/pack_leader.png',
    kind: 'effect',
    polarity: 'buff',
    description: 'Лидер стаи рядом — Сила увеличена на 30% (округление вверх от базовой Силы). Спадает при выходе из радиуса 5 клеток или гибели лидера.'
  },
  frightened: {
    /* «Напуган» — контрольный эффект страха. В начале своего хода юнит
       принудительно тратит движение на отступление: ищется самая
       удалённая (по манхэттену) от ближайших враждебных юнитов клетка из
       всех reachable; среди равноудалённых выбирается случайная.
       Если reachable пуст или текущая клетка уже самая дальняя —
       движение пропускается, ход НЕ теряется (атака и навыки разрешены).

       Длительность поддерживает обе формы:
         • duration: N (N>=1) — стандартная (ticks в tickEffectsAtTurnEnd).
           N=1 ≈ «до конца следующего хода» (одна вынужденная фаза бега
           на ближайшем своём ходу, потом выдох).
         • expiresAt: 'turnEnd' — снимается в конце ТЕКУЩЕГО хода
           носителя (если эффект применил САМ источник в свой ход — это
           вариант, когда страх должен спасть до следующего хода жертвы).
           Не используется внутриигровыми источниками сейчас, задел.

       Иммунитет: юниты с unitType==='mechanism' (см. UNIT_TYPES в
       data/unit-types.js) не подвержены страху — applyFrightened фильтрует
       их на входе и эффект вообще не накладывается (как «Отравлен» для
       нежити). Уже наложенный эффект на цели, чей unitType сменился на
       mechanism (полиморф / превращение в голема в будущем), не снимается
       автоматически — это будет отдельная Сессия по «реактивным иммунитетам».

       Принудительное движение использует executeFrightenedMove
       (core/movement.js): помечает actionsUsedThisTurn.move = true, шагает
       пошагово через playMoveAnimation, может зацепить капкан/приманку
       по дороге (общие триггеры объектов). После принудительного шага
       ИИ видит «движение уже потрачено» и переходит к атаке/skip; игрок
       видит заблокированную кнопку Move и может атаковать/кастовать. */
    name: 'Напуган',
    icon: '😱',
    spriteSrc: 'assets/sprites/status/frightened.png',
    kind: 'effect',
    polarity: 'debuff',
    description: 'В начале своего хода юнит принудительно отбегает на самую удалённую клетку от ближайших врагов. После этого может атаковать и применять навыки. Механизмы невосприимчивы.',
    onTurnStart(unit, eff) {
      if (!unit || !unit.alive) return;
      if (typeof executeFrightenedMove === 'function') {
        executeFrightenedMove(unit, eff);
      }
    }
  }
};

/* Удобный человекочитаемый ярлык тира (для UI). */
const SKILL_TIER_LABELS = {
  basic: 'Базовый',
  advanced: 'Продвинутый',
  elite: 'Элитный'
};
