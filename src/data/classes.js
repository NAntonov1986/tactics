/* classes.js — реестр всех классов юнитов и правила прокачки их статов.
   Что внутри:
     • CLASSES — единый реестр. Поля каждой записи:
         name (русское название),
         kind ('hero' | 'monster'),
         unitType (ключ из UNIT_TYPES — living/undead/...),
         visual ({ type: 'sprite', src, symbol }) — что рисовать на поле,
            в портрете и в чипе инициативы; symbol — текстовый fallback
            для plain-text title-тултипов и лога,
         defaultWeapon (id из WEAPONS — что класс носит «из коробки»;
            экипировка может его перекрыть),
         activeSkills ([id из SKILLS] — активы, доступные классу),
         activeSkillTiers ({ skillId → tier }) — НЕОБЯЗАТЕЛЬНО:
            если класс стартует не с базовым тиром какого-то актива
            (см. mage → fireball: 'advanced'),
         passiveSkills ([id из SKILLS] — пассивы, всегда висят),
         ai (id ИИ-политики из AI_POLICIES) — только для kind='monster',
         baseHp (число — стартовое значение, поверх которого работает Vit*2),
         stats ({ str, vit, dex, spd, wis, int, luk } — стартовые значения
            уровня 1; прокачка — в CLASS_PROGRESSIONS).
     • CLASS_PROGRESSIONS — таблица «как класс растёт по уровню».
         { classId(stats, level) → modifiedStats }. Если правила нет —
         статы возвращаются как есть, уровень не влияет.
   Что НЕ внутри:
     • Тиры пассивок по уровню (`passiveSkillTiers`) — пока в монолите
       index.html, рядом со скилл-хелперами; переедет вместе с ними.
     • Тиры активов по уровню — пока заданы статически на классе через
       `activeSkillTiers`, без формулы от уровня.
     • Сами реестры WEAPONS/SKILLS/UNIT_TYPES — в своих data-файлах.
     • Логика создания юнитов из класса (makeUnit) — в монолите, переедет
       в core/state.js (R16).
     • ИИ-политики — переедут в core/ai.js (R9).
   Где править параметры существующего класса: тут, в нужной записи CLASSES.
   Где добавить новый класс: добавить запись в CLASSES, проверить, что
     visual.src указывает на реальный спрайт, defaultWeapon существует в
     WEAPONS, активные/пассивные скиллы — в SKILLS. Если у класса своя
     прогрессия по уровню — добавить функцию в CLASS_PROGRESSIONS.
     См. CODEX.md → «Расширение игры → Новый класс юнита».
   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   CLASSES, CLASS_PROGRESSIONS попадают в глобальный scope window.

   Тонкость с порядком загрузки. Записи CLASSES ссылаются на WEAPONS-id
   через defaultWeapon и на SKILLS-id через activeSkills/passiveSkills,
   но это строки — резолв происходит в момент чтения. Сами реестры WEAPONS
   и SKILLS уже загружены к этому моменту (weapons.js и skills.js идут
   ПЕРЕД classes.js в index.html). UNIT_TYPES — аналогично.
*/

/* ================================================================
   === ДАННЫЕ КЛАССОВ =============================================
   ================================================================
   Каждый класс — запись в CLASSES. visual — данные для рендера
   (в MVP эмодзи, позже может стать спрайтом — см. DESIGN.md).
   defaultWeapon — id оружия из WEAPONS, которое класс носит «из коробки».
   Всё, что касается базовой атаки (дальность/урон/тип), берётся из
   оружия; класс сам по себе больше не хранит baseAttack.
   Стартовые значения stats: см. DESIGN.md, «Производные значения».
   ================================================================ */
const CLASSES = {
  warrior: {
    name: 'Воин',
    kind: 'hero',
    unitType: 'living',
    // type: 'sprite' — основной визуал на поле/в портрете/чипе инициативы.
    // symbol — текстовый fallback для контекстов, где IMG неуместен
    // (например, plain-text title-тултипы и текстовый лог).
    visual: { type: 'sprite', src: 'assets/sprites/warrior.png', symbol: '⚔' },
    defaultWeapon: 'sword',
    /* С3-предметы: класс-локи. allowedWeaponTypes — список weaponType
       (см. WEAPONS), которые этот класс может надеть. Воин — только
       мечи (sword/heavy_sword/legendary_sword все имеют weaponType:'sword').
       Кольца, амулеты, расходники — без класс-локов (любой класс). */
    allowedWeaponTypes: ['sword'],
    /* С4-предметы: allowedArmorTypes — симметрично weapons. Воин носит
       только heavy_armor (Кожаный доспех/Кольчуга/Латные доспехи). */
    allowedArmorTypes: ['heavy_armor'],
    activeSkills: ['charge'],   // С18: Рывок выдан на старте; остальные через DevTools
    passiveSkills: [],
    /* skillPool — Сессия 16: список ВСЕХ навыков, доступных классу при
       прокачке. С18: добавлены 3 навыка воина (charge/shield_block/
       whirlwind). Полный набор воина — после Сессий 19-20. */
    skillPool: ['charge', 'shield_block', 'whirlwind', 'second_wind', 'reinforcement', 'endurance', 'fortify_armor', 'second_attack', 'provoke', 'cover'],
    baseHp: 15,                       // Сессия 7: воин — самый живучий из героев (раньше 10)
    stats: { str: 6, vit: 6, dex: 2, spd: 4, wis: 1, int: 1, luk: 2 },
    /* Прокачка по уровню (Сессия 25, добавлено 06.05.2026):
       main — главные статы класса (70% шанс выпадения «по умолчанию»);
       sec — второстепенные (30% совокупно). Прочие статы НЕ растут
       автоматически. Игрок может вручную поднять любой через выбор +2
       (чётные уровни). См. core/level-up.js → rollLevelUpStat. */
    mainStats: ['str', 'vit'],
    secondaryStats: ['dex', 'spd', 'luk']
  },
  archer: {
    name: 'Лучник',
    kind: 'hero',
    unitType: 'living',
    visual: { type: 'sprite', src: 'assets/sprites/archer.png', symbol: '🏹' },
    defaultWeapon: 'bow',
    allowedWeaponTypes: ['bow'],   // С3-предметы: только луки.
    allowedArmorTypes: ['medium_armor'],  // С4-предметы: средняя броня.
    activeSkills: [],       // пока нет
    passiveSkills: [],
    skillPool: ['poison_arrow', 'fire_arrow', 'long_shot', 'second_shot', 'marksman', 'trap', 'lure', 'camouflage'],   // С24+С21+С22+С23: arrows + long/second_shot + marksman + trap/lure + camouflage.
    baseHp: 10,
    stats: { str: 2, vit: 4, dex: 5, spd: 6, wis: 1, int: 2, luk: 4 },
    mainStats: ['dex', 'spd'],
    secondaryStats: ['vit', 'luk', 'str']
  },
  /* Священник (09.05.2026). 4-й героический класс. Гибрид: ближний бой
     (посох, str-ориентированная атака) + поддержка (исцеление, баффы,
     снятие дебаффов) + анти-нежить/демоны. Mainstats: wis (для маны и
     силы скиллов) + vit (живучесть). Манасть для скиллов идёт от int.
     Все скиллы стоят ману, без cooldown'ов. */
  priest: {
    name: 'Священник',
    kind: 'hero',
    unitType: 'living',
    visual: { type: 'sprite', src: 'assets/sprites/priest.png', symbol: '✝' },
    defaultWeapon: 'priest_staff',
    allowedWeaponTypes: ['priest_staff'],
    allowedArmorTypes: ['priest_robe'],
    activeSkills: ['healing'],
    passiveSkills: [],
    /* Сессия A (09.05.2026): пул содержит ВСЕ 9 запланированных скиллов
       священника, но executor'ы реализованы только для 4: healing /
       blessing / purify_touch / holy_strength. Остальные (resurrection,
       light_wave, holy_shield, evil_slayer, healing_aura) приедут
       сессиями B и C. До этого они не должны выдаваться через level-up
       — фильтр на отсутствие executor'а в pickRandomUnlearnedSkills
       пока нет, поэтому пул специально сужен до уже-реализованных. */
    skillPool: ['healing', 'blessing', 'purify_touch', 'holy_strength', 'resurrection', 'holy_shield', 'evil_slayer', 'light_wave', 'healing_aura'],
    baseHp: 10,
    stats: { str: 4, vit: 4, dex: 2, spd: 3, wis: 4, int: 4, luk: 1 },
    mainStats: ['wis', 'vit'],
    secondaryStats: ['str', 'int', 'spd']
  },
  mage: {
    name: 'Маг',
    kind: 'hero',
    unitType: 'living',
    visual: { type: 'sprite', src: 'assets/sprites/mage.png', symbol: '🧙' },
    defaultWeapon: 'staff',
    allowedWeaponTypes: ['staff'],   // С3-предметы: только жезлы.
    allowedArmorTypes: ['robe'],     // С4-предметы: мантии.
    activeSkills: ['fireball'],
    /* Тестовая выдача: маг стартует не с «базовым», а с «продвинутым»
       тиром фаербола (мана та же, формула та же, но плюс «Горение» на 3
       хода каждой цели в зоне). Чтобы вернуть к базовому — убрать запись
       или поменять на 'basic'. Карта активных тиров читается в makeUnit
       (`unit.skills[i].tier`); на самом верхнем уровне SKILLS никаких
       изменений нет. */
    activeSkillTiers: { fireball: 'advanced' },
    passiveSkills: [],
    /* skillPool (Сессия 16) — ВСЕ 13 навыков, которые маг может
       выучить при прокачке. Стартовый набор (activeSkills + activeSkillTiers)
       — это лишь подмножество. Когда появится система уровней, игрок будет
       выбирать из этого пула, что выдать в свободные слоты. Источник
       правды: SKILLS[id].classId === 'mage' (см. data/skills.js). Этот
       массив дублирует фильтр для UI/DevTools, чтобы не пересчитывать
       по SKILLS на каждый рендер. */
    skillPool: ['fireball', 'ice_arrow', 'magic_arrow', 'lightning', 'chain_lightning',
                'prismatic_sphere', 'teleport', 'fire_shield', 'mana_focus', 'purify',
                'mana_regen', 'crushing_magic', 'mana_absorb'],
    baseHp: 5,                        // Сессия 7: маг — самый хрупкий (раньше 10)
    stats: { str: 1, vit: 3, dex: 2, spd: 3, wis: 6, int: 6, luk: 3 },
    mainStats: ['wis', 'int'],
    secondaryStats: ['luk', 'vit', 'spd']
  },
  zombie: {
    name: 'Зомби',
    kind: 'monster',
    unitType: 'undead',
    /* Метаданные монстра (правка 06.05.2026, задел под систему миссий):
       • group         — фракционная принадлежность. Используется будущей
                         логикой состава волн (mixed-волны разных групп) и
                         взаимодействий «дружат / враждуют». У зомби —
                         одноимённая с unitType. У будущих волков, например,
                         unitType='living', group='wolves'.
       • baseDifficulty — минимальный номер волны, на которой этот монстр
                         может появиться. Personal level считается как
                         max(1, wave.number - baseDifficulty + 1) — на своей
                         «первой» волне монстр имеет персональный уровень 1,
                         а его боевая мощь определяется базовыми статами +
                         CLASS_PROGRESSIONS[id](level=1). Идея: позже-
                         появляющийся монстр должен быть сильнее, чем
                         прокачанный до той же волны базовый — это
                         регулируется его базовыми stats и формулой
                         прокачки. У зомби baseDifficulty=1 (стартовый
                         враг). У условного каменного голема может быть 20.
       • isLeader      — true для мини-боссов / вожаков своей группы
                         (волк-вожак, зомби-некромант). Сейчас не влияет на
                         механику, задел под состав волн и UI-индикатор. */
    group: 'undead',
    baseDifficulty: 1,
    isLeader: false,
    visual: { type: 'sprite', src: 'assets/sprites/zombie.png', symbol: '🧟' },
    defaultWeapon: 'claws',
    activeSkills: [],
    passiveSkills: ['corpse_poison'],  // тир стартово Базовый, повышается по уровню
    skillPool: ['corpse_poison'],      // Сессия 16: пока единственный навык класса
    ai: 'zombie',                      // имя ИИ-политики (см. AI_POLICIES)
    /* Aggro-радиус (Сессия aggro, 04.05.2026): пока зомби не увидел
       героя в этом радиусе (Чебышев), он находится в состоянии
       'sleeping' и ходит по idleBehavior. Подробнее — core/aggro.js. */
    aggroRadius: 5,
    idleBehavior: 'wander',            // 'wander' = случайная клетка в радиусе движения
    baseHp: 12,                        // Балансная правка 08.05.2026: 10 → 12 (компенсация отсутствия групповой синергии относительно волков).
    // Стартовые значения уровня 1. Прокачка с уровнем — в applyLevelProgression.
    stats: { str: 4, vit: 5, dex: 2, spd: 2, wis: 0, int: 1, luk: 1 },  // Vit 4 → 5 (балансная правка 08.05.2026).
    // Прокачка зомби: описана в applyZombieProgression(level).
  },
  wolf: {
    name: 'Волк',
    kind: 'monster',
    unitType: 'living',
    group: 'wolves',
    baseDifficulty: 1,
    isLeader: false,
    visual: { type: 'sprite', src: 'assets/sprites/wolf.png', symbol: '🐺' },
    defaultWeapon: 'wolf_fangs',
    activeSkills: [],
    passiveSkills: ['joint_hunt', 'wolf_howl'],
    skillPool: ['joint_hunt', 'wolf_howl'],
    ai: 'wolf',
    aggroRadius: 6,
    idleBehavior: 'wander',
    baseHp: 6,
    stats: { str: 4, vit: 4, dex: 4, spd: 4, wis: 2, int: 2, luk: 1 }
  },
  wolf_alpha: {
    name: 'Волк-вожак',
    kind: 'monster',
    unitType: 'living',
    group: 'wolves',
    baseDifficulty: 5,
    isLeader: true,
    visual: { type: 'sprite', src: 'assets/sprites/wolf_alpha.png', symbol: '🐺' },
    defaultWeapon: 'wolf_fangs',
    activeSkills: [],
    passiveSkills: ['joint_hunt', 'wolf_howl', 'pack_leader'],
    skillPool: ['joint_hunt', 'wolf_howl', 'pack_leader'],
    ai: 'wolf_alpha',
    aggroRadius: 6,
    idleBehavior: 'wander',
    baseHp: 10,
    stats: { str: 9, vit: 9, dex: 4, spd: 6, wis: 2, int: 2, luk: 1 }
  },
  skeleton_warrior: {
    /* Скелет воин (09.05.2026). Меч (defaultWeapon='sword') — базовое
       оружие героя-воина. Пассивка «Костлявый» (-30/35/40% от ranged).
       Активная «Вторая атака» — общий навык воина (second_attack), AI
       пытается её применить после первого удара, если рядом ещё есть
       цель. AI-политика skeleton_warrior — копия zombie с пост-атакой
       второй атаки (см. core/ai.js). */
    name: 'Скелет воин',
    kind: 'monster',
    unitType: 'undead',
    group: 'undead',
    baseDifficulty: 1,
    isLeader: false,
    visual: { type: 'sprite', src: 'assets/sprites/skeleton_warrior.png', symbol: '💀' },
    defaultWeapon: 'sword',
    activeSkills: ['second_attack'],
    passiveSkills: ['bony'],
    skillPool: ['bony', 'second_attack'],
    ai: 'skeleton_warrior',
    aggroRadius: 5,
    idleBehavior: 'wander',
    baseHp: 8,
    stats: { str: 4, vit: 4, dex: 2, spd: 4, wis: 1, int: 1, luk: 1 }
  },
  /* Призрак (12.05.2026). Лидер группы «нежить» (group:undead) с
     baseDifficulty:5 — появляется только в волнах сложности ≥5. По
     спеке заказчика начиная с 5-го уровня в группе нежить ОБЯЗАТЕЛЬНО
     есть 1 лидер. Источник правды о лидере группы — WAVE_GROUPS в
     core/state.js (поле leader:'ghost'); spawnGroupWave уже умеет
     добавлять лидера, если waveNumber ≥ baseDifficulty.

     Атака: ближний бой (Призрачные когти, range:1), но magic damageType
     (не блокируется fire_shield — фильтр fire/frost). База 3 + Сила/2 —
     при стартовой Силе 6 это стабильно 6 урона за удар; на 10-й волне
     personalLevel=6 → Сила 11 → 8 урона, ничего экстраординарного.
     Расчёт хорошо ложится в зомби-формулу прокачки.

     Пассивка ghostly: -60% физического урона (баланс 12.05.2026 — было
     80%, снижено по аргументу «нежить разобщена, лидер не должен быть
     непробиваемым»). Магия/огонь/стихии/святой проходят полностью.
     Священники со «Святой силой» / «Истребителем зла» наносят ему
     повышенный святой урон — это ОСОЗНАННЫЙ контр.

     Активка ghostly_scream: one-shot per battle, бесплатно. Будит всю
     нежить и стопает героев на 1 ход. AI применяет в первой же фазе
     своего хода, ПОСЛЕ чего может бить (доп-фаза атаки). */
  ghost: {
    name: 'Призрак',
    kind: 'monster',
    unitType: 'undead',
    group: 'undead',
    baseDifficulty: 5,
    isLeader: true,
    visual: { type: 'sprite', src: 'assets/sprites/ghost.png', symbol: '👻' },
    defaultWeapon: 'ghost_claws',
    activeSkills: ['ghostly_scream'],
    passiveSkills: ['ghostly'],
    skillPool: ['ghostly', 'ghostly_scream'],
    ai: 'ghost',
    aggroRadius: 6,
    idleBehavior: 'wander',
    baseHp: 10,
    stats: { str: 6, vit: 6, dex: 6, spd: 6, wis: 3, int: 3, luk: 3 }
  },
  skeleton_archer: {
    /* Скелет лучник (09.05.2026). Лук (defaultWeapon='bow') — базовое
       оружие лучника. «Костлявый» (как и скелет воин). Активная —
       «Отравленная стрела» (poison_arrow). AI-политика skeleton_archer —
       kiter: применяет poison_arrow на себя в фазе подготовки, держит
       дистанцию ровно по weapon.range, отступает если враг подошёл
       вплотную (см. core/ai.js). */
    name: 'Скелет лучник',
    kind: 'monster',
    unitType: 'undead',
    group: 'undead',
    baseDifficulty: 1,
    isLeader: false,
    visual: { type: 'sprite', src: 'assets/sprites/skeleton_archer.png', symbol: '💀' },
    defaultWeapon: 'bow',
    activeSkills: ['poison_arrow'],
    passiveSkills: ['bony'],
    skillPool: ['bony', 'poison_arrow'],
    ai: 'skeleton_archer',
    aggroRadius: 6,
    idleBehavior: 'wander',
    baseHp: 4,
    stats: { str: 2, vit: 3, dex: 4, spd: 4, wis: 1, int: 1, luk: 1 }
  }
};

/* Применить уровень к статам класса и вернуть прокачанный снимок.
   Все классы получают одинаковую структуру, конкретные правила прокачки
   лежат в CLASS_PROGRESSIONS[classId](stats, level). Если правило не задано —
   статы возвращаются как есть (уровень на них не влияет). */
const CLASS_PROGRESSIONS = {
  zombie(stats, level) {
    // Копируем, чтобы не портить базовые определения класса.
    const s = { ...stats };
    // Каждый уровень выше 1-го: +1 Силы и +1 Живучести.
    const above = Math.max(0, level - 1);
    s.str += above;
    s.vit += above;
    // Каждый 3-й уровень (3, 6, 9, …): +1 Скорости.
    s.spd += Math.floor(level / 3);
    return s;
  },
  wolf(stats, level) {
    const s = { ...stats };
    const above = Math.max(0, level - 1);
    s.str += above;
    s.vit += above;
    s.spd += Math.floor(level / 3);
    return s;
  },
  wolf_alpha(stats, level) {
    const s = { ...stats };
    const above = Math.max(0, level - 1);
    s.str += above;
    s.vit += above;
    s.spd += Math.floor(level / 3);
    return s;
  },
  /* Скелет воин (09.05.2026): +1 Силы и Живучести каждый уровень выше
     1-го, +1 Скорости каждый 3-й. Копия zombie-progression. */
  skeleton_warrior(stats, level) {
    const s = { ...stats };
    const above = Math.max(0, level - 1);
    s.str += above;
    s.vit += above;
    s.spd += Math.floor(level / 3);
    return s;
  },
  /* Скелет лучник (09.05.2026): +1 Ловкости и Живучести каждый уровень
     выше 1-го, +1 Скорости каждый 3-й. Сила НЕ растёт — лучник колет
     луком из dex (см. weapon.formula bow). */
  skeleton_archer(stats, level) {
    const s = { ...stats };
    const above = Math.max(0, level - 1);
    s.dex += above;
    s.vit += above;
    s.spd += Math.floor(level / 3);
    return s;
  },
  /* Призрак (12.05.2026): +1 Силы и Живучести каждый уровень выше 1-го,
     +1 Скорости каждый 3-й уровень. Та же формула, что у zombie/
     skeleton_warrior/wolf — мощь растёт прямолинейно. Mудрость/
     Интеллект/Удача не растут — это «специалистские» статы, у Призрака
     они есть как задел под будущие магические взаимодействия. */
  ghost(stats, level) {
    const s = { ...stats };
    const above = Math.max(0, level - 1);
    s.str += above;
    s.vit += above;
    s.spd += Math.floor(level / 3);
    return s;
  }
};
