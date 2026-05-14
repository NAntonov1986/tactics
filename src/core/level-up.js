/* level-up.js (core/) — система прокачки героев между волнами (Сессия 25,
   расширение 06.05.2026: старт без скиллов, MAX_SKILLS=5, фазы улучшения).

   Правила прокачки (источник правды для UI и state):
     • На СТАРТЕ ИГРЫ герои создаются с уровнем 0 и БЕЗ скиллов
       (activeSkillsOverride: [], passiveSkillsOverride: []). На первой
       волне state.js запускает «инициальный» level-up 0→1 для каждого
       героя — игрок выбирает первый скилл каждого героя.
     • Дальше каждая ПРОЙДЕННАЯ волна даёт +1 уровень всем выжившим.
     • Чётные уровни (2, 4, 6, ...) = выбор +2 к одной из 7 характеристик.
     • Нечётные уровни (1, 3, 5, ...) = выбор навыка по фазам:
         ФАЗА 1 (изучение). Известных <5 → выбор из случайных
           непознанных скиллов пула, фильтр по полноте слотов:
             - если активных слотов 4/4 → только пассивные;
             - если пассивных слотов 4/4 → только активные;
             - иначе пул из обеих категорий.
           Карточек до 4; меньше — если пул мельче.
         ФАЗА 2 (basic→advanced). Известных = 5 и есть хотя бы один
           basic-скилл → выбор из всех basic, до 4 карточек случайных
           (если basic <5, иначе все).
         ФАЗА 3 (advanced→elite). Все basic уже в advanced, есть
           advanced → выбор из всех advanced, до 4 случайных.
         ФАЗА 4 (full-elite stat-bonus). Все 5 скиллов в elite →
           каждый нечётный уровень превращается в stat-выбор с +2
           (т.е. 7 кнопок статов, как в чётный уровень). Это «терминальный»
           режим, без скилл-улучшений.
     • Слотов на инстансе: 4 активных + 4 пассивных. MAX_SKILLS=5 даёт
       любую комбинацию от 4А+1П до 1А+4П (4А+4П невозможно, потому что
       новых не выдаём после 5).
     • Тиры цепочкой: basic → advanced → elite. Без skip.
     • Override-поля — единственный источник правды о скиллах юнита.
       Если override отсутствует — fallback на CLASSES[id].activeSkills/
       passiveSkills. На старте новой игры override инициализирован
       пустым массивом, потому что героев решили дать «чистыми».

   Что внутри:
     • MAX_SKILLS — константа 5, потолок для фазы 1 (изучение).
     • TIER_CHAIN — ['basic','advanced','elite'].
     • rollLevelUpStat(unit) — авто +1 при applyLevelBump (70% main,
       30% secondary).
     • applyLevelBump(unit) — level++, +1 к статам из ролла.
     • applyStatChoice(unit, stat, amount=2) — +amount к выбранному
       стату. amount=2 в обоих stat-фазах (чётный уровень и full-elite
       stat-bonus); параметр оставлен для будущей дифференциации.
     • learnNewSkill(unit, skillId) — выдать в первый свободный слот.
     • upgradeSkillTier(unit, skillId) — basic→advanced→elite.
     • getLearnedSkills(unit) — { active, passive } нормализованный.
     • getUpgradableSkillsByTier(unit, fromTier) — выученные, у которых
       текущий тир = fromTier. Используется для фаз 2 и 3.
     • pickRandomUnlearnedSkills(unit, n=4) — n случайных непознанных
       из skillPool, фильтрация по полноте слотов.
     • pickRandomUpgradeCandidates(unit, fromTier, n=4) — n случайных
       выученных скиллов с текущим тиром = fromTier.
     • getLevelUpKind(unit, level) — 'stats' | 'skills-new' |
       'skills-upgrade-basic' | 'skills-upgrade-advanced' | 'stat-bonus'.
       Внимание: теперь принимает unit, потому что фаза зависит от
       состава известных скиллов, не только чётности уровня.

   Что НЕ внутри:
     • Очередь апов между волнами — `core/state.js`.
     • UI окошка прокачки — `render/render-level-up.js`.
     • DevTools «Победа волны» — `core/state.js` (forceWaveVictory).

   Порядок загрузки: подключается среди core/* в index.html, ссылается
   на CLASSES (data/classes.js, загружено раньше) и SKILLS (data/skills.js,
   тоже раньше). state — глобал, читается через script-scope. */

/* Цепочка тиров. Используется в upgradeSkillTier и в UI для рендера
   стрелки «уровень повышен». */
const TIER_CHAIN = ['basic', 'advanced', 'elite'];

/* Максимальное число выученных навыков на героя (правка 06.05.2026,
   было 4). Любое распределение [4A+1P … 1A+4P]. После достижения
   нечётный уровень переходит в фазу улучшения. */
const MAX_SKILLS = 5;

/* getLevelUpKind(unit, level) — что показать игроку при апе на этот
   уровень. Возвращает один из строковых kind'ов:
     'stats'                  — чётный уровень: выбор +2 к стату из 7;
     'skills-new'             — нечётный, фаза 1: изучение нового скилла;
     'skills-upgrade-basic'   — нечётный, фаза 2: basic → advanced;
     'skills-upgrade-advanced'— нечётный, фаза 3: advanced → elite;
     'stat-bonus'             — нечётный, фаза 4 (terminal): +2 к стату
                                как в чётный уровень (фолбэк, когда все
                                5 скиллов уже в elite).

   Правила (правка 06.05.2026):
     • Уровень 1 теперь ВАЛИДНЫЙ — это стартовый level-up 0→1 при
       старте первой волны. Возвращает 'skills-new' (или фазу выше,
       если у героя каким-то образом уже есть скиллы).
     • Чётный → 'stats'.
     • Нечётный → одна из четырёх скилл-фаз в зависимости от состава
       выученных: пока есть basic (и known=MAX_SKILLS) — basic-фаза,
       и т.д. Логика «есть basic → апаем basic» гарантирует, что
       advanced-фаза начнётся только когда все basic стали advanced.
     • Если на нечётном по состоянию героя ничего не подходит из
       скилл-фаз и пул пуст (теоретический edge для классов с маленьким
       пулом ≤5) — досрочно переходим к улучшению basic (обычно сразу
       же сработает) или к stat-bonus (если все улучшены).

   Принимает unit (нужен для проверки состава скиллов). level — это
   уровень ПОСЛЕ инкремента (уже applyLevelBump'нутый). */
function getLevelUpKind(unit, level) {
  if (!Number.isFinite(level) || level < 1) return null;
  if (level % 2 === 0) return 'stats';
  // Нечётный: смотрим на состав скиллов героя.
  const learned = getLearnedSkills(unit);
  const total = learned.active.length + learned.passive.length;
  if (total < MAX_SKILLS) {
    // Фаза 1: изучение. Но! Если пул новых скиллов пуст (например,
    // mini-класс с 4 скиллами) — досрочно переходим к улучшениям.
    const candidates = pickRandomUnlearnedSkills(unit, 1);
    if (candidates.length > 0) return 'skills-new';
    // Пул иссяк — пробуем апать.
  }
  // Фаза 2: есть basic → апаем до advanced.
  const allEntries = [
    ...learned.active.map(s => ({ ...s, kind: 'active' })),
    ...learned.passive.map(s => ({ ...s, kind: 'passive' }))
  ];
  if (allEntries.some(s => s.tier === 'basic')) return 'skills-upgrade-basic';
  // Фаза 3: есть advanced → апаем до elite.
  if (allEntries.some(s => s.tier === 'advanced')) return 'skills-upgrade-advanced';
  // Фаза 4: всё в elite (или скиллов нет совсем — теоретический edge).
  // Терминальный stat-bonus: +2 к стату на нечётных уровнях.
  return 'stat-bonus';
}

/* rollLevelUpStat(unit) — кидает «что вырастёт +1 автоматически».
   70% main / 30% secondary. Возвращает один из 7 ключей stats. Если
   у класса нет mainStats/secondaryStats — возвращает 'luk' как
   нейтральный fallback (никто не должен сюда попадать, но defensive). */
function rollLevelUpStat(unit) {
  const cls = CLASSES[unit.classId];
  const main = (cls && Array.isArray(cls.mainStats)) ? cls.mainStats : [];
  const sec  = (cls && Array.isArray(cls.secondaryStats)) ? cls.secondaryStats : [];
  // Если нет ни main, ни sec — крайний fallback.
  if (!main.length && !sec.length) return 'luk';
  // Если есть только один из массивов — берём из него.
  if (!sec.length) return main[Math.floor(Math.random() * main.length)];
  if (!main.length) return sec[Math.floor(Math.random() * sec.length)];
  const roll = Math.random();
  const pool = (roll < 0.70) ? main : sec;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* applyLevelBump(unit) — основной вход прокачки.
   1) Инкрементирует level.
   2) Кидает stat-ролл, +1 к выпавшей характеристике.
   Возвращает { level, stat } — для UI шапки окна апа. */
function applyLevelBump(unit) {
  if (!unit) return null;
  unit.level = (unit.level | 0) + 1;
  if (!unit.stats) unit.stats = {};
  const stat = rollLevelUpStat(unit);
  unit.stats[stat] = (unit.stats[stat] | 0) + 1;
  return { level: unit.level, stat };
}

/* applyStatChoice(unit, stat, amount) — +amount к выбранному стату.
   amount по умолчанию 2 (используется и в обычном чётном level-up,
   и в фазе stat-bonus после full-elite). Параметр оставлен явным для
   будущей дифференциации (например, режим «каждый второй уровень — +1»
   как балансная подкрутка). */
const VALID_STATS = new Set(['str', 'vit', 'dex', 'spd', 'wis', 'int', 'luk']);
function applyStatChoice(unit, stat, amount) {
  if (!unit || !VALID_STATS.has(stat)) return;
  if (!unit.stats) unit.stats = {};
  const inc = Number.isFinite(amount) ? amount : 2;
  unit.stats[stat] = (unit.stats[stat] | 0) + inc;
}

/* getLearnedSkills(unit) — нормализованный взгляд на «что у юнита
   сейчас» (с учётом override-ов). Возвращает:
     {
       active:  [{ id, tier, slot }, ...],
       passive: [{ id, tier, slot }, ...]
     }
   slot — индекс в соответствующем массиве (0..3). null-слоты пропущены.
   Используется UI и pickRandomUnlearnedSkills для построения «выучено». */
function getLearnedSkills(unit) {
  const out = { active: [], passive: [] };
  if (!unit) return out;
  const cls = CLASSES[unit.classId] || {};
  // Активы.
  const activeIds = Array.isArray(unit.activeSkillsOverride)
    ? unit.activeSkillsOverride
    : (cls.activeSkills || []);
  for (let i = 0; i < activeIds.length; i++) {
    const sid = activeIds[i];
    if (!sid) continue;
    out.active.push({ id: sid, tier: getActiveSkillTier(unit, sid), slot: i });
  }
  // Пассивы.
  const passiveIds = Array.isArray(unit.passiveSkillsOverride)
    ? unit.passiveSkillsOverride
    : (cls.passiveSkills || []);
  for (let i = 0; i < passiveIds.length; i++) {
    const sid = passiveIds[i];
    if (!sid) continue;
    out.passive.push({ id: sid, tier: getPassiveSkillTier(unit, sid), slot: i });
  }
  return out;
}

/* getUpgradableSkillsByTier(unit, fromTier) — выученные с текущим тиром
   = fromTier. Используется фазой 2 ('basic') и фазой 3 ('advanced').
   Возвращает плоский { id, tier, kind, slot }. */
function getUpgradableSkillsByTier(unit, fromTier) {
  const learned = getLearnedSkills(unit);
  const out = [];
  for (const s of learned.active) {
    if (s.tier === fromTier) out.push({ ...s, kind: 'active' });
  }
  for (const s of learned.passive) {
    if (s.tier === fromTier) out.push({ ...s, kind: 'passive' });
  }
  return out;
}

/* pickRandomUpgradeCandidates(unit, fromTier, n=4) — n случайных
   выученных скиллов с текущим тиром = fromTier. Если кандидатов меньше
   n — возвращаем сколько есть. Используется UI/state для построения
   choices в фазах 2 и 3. */
function pickRandomUpgradeCandidates(unit, fromTier, n) {
  if (!Number.isFinite(n) || n < 1) n = 4;
  const candidates = getUpgradableSkillsByTier(unit, fromTier);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, n);
}

/* pickRandomUnlearnedSkills(unit, n=4) — случайные неизученные
   из CLASSES[id].skillPool. Фильтруется по свободным слотам:
     • если активные слоты заполнены (4/4) — исключаем kind:'active';
     • аналогично для passive.
   Если кандидатов меньше n — возвращаем сколько есть. */
function pickRandomUnlearnedSkills(unit, n) {
  if (!unit) return [];
  if (!Number.isFinite(n) || n < 1) n = 4;
  const cls = CLASSES[unit.classId] || {};
  const pool = Array.isArray(cls.skillPool) ? cls.skillPool : [];
  const learned = getLearnedSkills(unit);
  const learnedSet = new Set([
    ...learned.active.map(s => s.id),
    ...learned.passive.map(s => s.id),
  ]);
  const activeFull = learned.active.length >= 4;
  const passiveFull = learned.passive.length >= 4;
  const candidates = pool.filter(sid => {
    if (learnedSet.has(sid)) return false;
    const sk = SKILLS[sid];
    if (!sk) return false;
    if (sk.kind === 'active' && activeFull) return false;
    if (sk.kind === 'passive' && passiveFull) return false;
    return true;
  });
  // Fisher-Yates.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, n);
}

/* learnNewSkill(unit, skillId) — выдаёт навык в первый свободный
   слот соответствующего kind'а. Тир — basic. Если kind активный и
   все 4 слота заняты (или kind пассивный и заняты пассивные слоты) —
   тихий no-op (UI не должен такого допускать).

   Активы: пишем в unit.activeSkillsOverride[slot] и unit.skills[slot]
   синхронно (источник правды для тира — unit.skills, см.
   getActiveSkillTier).
   Пассивы: unit.passiveSkillsOverride[slot] + tier через
   passiveSkillTiersOverride[skillId]. */
function learnNewSkill(unit, skillId) {
  const sk = SKILLS[skillId];
  if (!unit || !sk) return false;
  const cls = CLASSES[unit.classId] || {};
  if (sk.kind === 'active') {
    // Подготовить override-массив.
    if (!Array.isArray(unit.activeSkillsOverride)) {
      unit.activeSkillsOverride = (cls.activeSkills || []).slice();
    }
    if (!Array.isArray(unit.skills)) unit.skills = [];
    // Найти первый null-слот, иначе append.
    let slot = unit.activeSkillsOverride.findIndex(x => !x);
    if (slot < 0) {
      if (unit.activeSkillsOverride.length >= 4) return false;
      slot = unit.activeSkillsOverride.length;
      unit.activeSkillsOverride.push(null);
    }
    unit.activeSkillsOverride[slot] = skillId;
    while (unit.skills.length <= slot) unit.skills.push(null);
    unit.skills[slot] = { id: skillId, tier: 'basic' };
    return true;
  }
  if (sk.kind === 'passive') {
    if (!Array.isArray(unit.passiveSkillsOverride)) {
      unit.passiveSkillsOverride = (cls.passiveSkills || []).slice();
    }
    let slot = unit.passiveSkillsOverride.findIndex(x => !x);
    if (slot < 0) {
      if (unit.passiveSkillsOverride.length >= 4) return false;
      slot = unit.passiveSkillsOverride.length;
      unit.passiveSkillsOverride.push(null);
    }
    unit.passiveSkillsOverride[slot] = skillId;
    if (!unit.passiveSkillTiersOverride) unit.passiveSkillTiersOverride = {};
    unit.passiveSkillTiersOverride[skillId] = 'basic';
    return true;
  }
  return false;
}

/* upgradeSkillTier(unit, skillId) — повышает тир выученного навыка
   по цепочке basic → advanced → elite. Если skill не выучен или уже
   elite — no-op (вернёт false). При успехе — true.

   Активы: пишем в unit.skills[slot].tier (тот же slot из
   activeSkillsOverride). Пассивы: passiveSkillTiersOverride[skillId]. */
function upgradeSkillTier(unit, skillId) {
  if (!unit || !skillId) return false;
  const sk = SKILLS[skillId];
  if (!sk) return false;
  if (sk.kind === 'active') {
    const learned = getLearnedSkills(unit);
    const entry = learned.active.find(s => s.id === skillId);
    if (!entry) return false;
    const idx = TIER_CHAIN.indexOf(entry.tier);
    if (idx < 0 || idx >= TIER_CHAIN.length - 1) return false;
    const nextTier = TIER_CHAIN[idx + 1];
    if (!Array.isArray(unit.skills)) unit.skills = [];
    while (unit.skills.length <= entry.slot) unit.skills.push(null);
    unit.skills[entry.slot] = { id: skillId, tier: nextTier };
    return true;
  }
  if (sk.kind === 'passive') {
    const cur = getPassiveSkillTier(unit, skillId);
    const idx = TIER_CHAIN.indexOf(cur);
    if (idx < 0 || idx >= TIER_CHAIN.length - 1) return false;
    const nextTier = TIER_CHAIN[idx + 1];
    if (!unit.passiveSkillTiersOverride) unit.passiveSkillTiersOverride = {};
    unit.passiveSkillTiersOverride[skillId] = nextTier;
    return true;
  }
  return false;
}
