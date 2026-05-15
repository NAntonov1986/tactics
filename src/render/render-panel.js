/* render-panel.js (render/) — портретная и нижняя панель юнита.

   Что внутри:
     • `renderPortraitPanel()` — небольшая панель в углу поля с большим
       портретом выбранного юнита, его именем (с бейджем уровня),
       подписью команды (для героев) или «Противник» (для монстров),
       и парой полосок-индикаторов «HP X/Y» / «Мана X/Y». Если
       выбранного юнита нет — placeholder «Выберите юнита».
     • `renderBottomPanel()` — большая нижняя панель действий и
       характеристик. 5 секций:
         1) **Действия**: «Атака»/«Движение»/«Конец хода». Состояния
            кнопок: `disabled` (если юнит не active или действие уже
            использовано), `mode-active` (режим включён на этой кнопке),
            `action-used` (использовано/блокировано). Tooltip атаки —
            многострочный разбор «оружие + формула + урон + дальность
            + крит». Tooltip движения — «обездвижен» / «уже ходил».
         2) **Активные навыки**: 4 слота (реальные навыки класса +
            пустые до 4). Каждый slot — pixel-art спрайт или эмодзи;
            tooltip формата «Имя · тир · мана · дальность · область
            · тип урона · формула · подстановка статов · итог · эффект
            тира». Слот кликается, если: юнит active, в этом ходу не
            был применён НИ ОДИН активный навык, хватает маны, не
            обездвижен (для скиллов с `movesUser`).
         3) **Пассивные навыки**: 4 слота с тиром по уровню (через
            `passiveSkillTiers`). Tooltip — описание срабатывания и
            эффекта. Кликов нет (пассивы триггерятся сами).
         4) **Экипировка**: 5 слотов (weapon/armor/amulet/ring/consumable).
            Сейчас в MVP реален только weapon (читается через
            `getUnitWeapon`); остальные — заглушки с tooltip-ом
            «слот пуст».
         5) **Воздействия**: статус-эффекты на юните. Чипы 48×48 с
            pixel-art иконкой и бейджем длительности. Tooltip:
            «Имя / Описание / [для stat-mod] Все характеристики
            (кроме Удачи): −N / Осталось N ход.».
         6) **Характеристики**: эффективные значения (через
            `statBreakdown`). Каждая ячейка — иконка + значение
            (с подсветкой `stat-debuffed`/`stat-buffed`). Tooltip:
            «Стат / База / Каждый модификатор отдельной строкой
            ± / Итого». Размещение определяется CSS через `stat-<key>`.

       Если выбранного юнита нет — placeholder через всю ширину панели.

   Зачем рендерить ВСЁ панель целиком на каждом render()? Кнопки и
   слоты содержат вычисляемые состояния (mode-active, action-used,
   no-mana, used) — простой полный ререндер дешевле, чем точечно
   синхронизировать классы. Click-обработчики на кнопках действий
   и слотах активов делегируются с `#bottomPanel` (см. init() в
   `core/state.js`), поэтому пересоздание DOM не теряет реактивность.

   Что НЕ внутри:
     • Расчёт эффективных статов (`effectiveStats`/`statBreakdown`) —
       `core/stats-calc.js` (R10).
     • Подписи стат (`STAT_LABELS`/`STAT_ICONS`/`STAT_ORDER`) —
       `data/stats.js` (R5).
     • Скилл-тир-хелперы (`getActiveSkillTier`/`getUnitSkillParams`/
       `passiveSkillTiers`) — `core/skills.js` (R12.5).
     • Описание оружия/формул (`weaponDamage`/`weaponFormulaText`/
       `describeFormula`/`describeFormulaBreakdown`) — `core/stats-calc.js`,
       `data/weapons.js` (через тонкие обёртки).
     • Делегирование click-ов с кнопок и слотов навыков — `init()`
       в `core/state.js` (R16).

   Где править:
     • Новая секция в нижней панели — добавить блок `<div class="section">…`
       в `panel.innerHTML` шаблоне + CSS в `styles/panel.css`.
     • Новые поля в tooltip оружия/скилла — массивы `lines`/`titleLines`.
     • Новый тип эффекта в Воздействиях (например, эффект с числовым
       параметром — «лечение N HP/ход») — добавить ветку в `effectsHtml`
       + поле в `SKILLS[id]` + соответствующий apply-хелпер в effects.js.

   Внешние имена через script-scope (резолв при вызове):
   `state` (core/state); `getUnit` (core/state); `CLASSES` (data/classes);
   `SKILLS` (data/skills); `STAT_LABELS`, `STAT_ICONS`, `STAT_ORDER`
   (data/stats); `maxHpOf`, `maxManaOf`, `effectiveStats`, `statBreakdown`,
   `critChanceOf`, `calcFormulaDamage`, `describeFormula` (core/stats-calc);
   `getUnitWeapon`, `weaponDamage`, `weaponFormulaText` (data/weapons);
   `describeDamage` (data/damage-types); `canUnitMove` (core/effects);
   `getActiveSkillTier`, `getUnitSkillParams`, `passiveSkillTiers`
   (core/skills); `classVisualHtml` (render/render). */

/* С2-предметы (07.05.2026): универсальный читатель слота экипировки.
   Возвращает объект-предмет (инстанс или запись из реестра базы) для
   нужного слота, либо null если пусто. Слот weapon — особый: id-string
   разворачивается через WEAPONS, инстанс возвращается как есть.
   Прочие слоты (armor/amulet/ring/consumable) на С2 хранят либо null,
   либо инстанс предмета. Когда S4-S5 наполнят реестры базами,
   id-string для них тоже будет работать через ARMORS/RINGS/AMULETS/
   CONSUMABLES. */
function readEquipmentEntry(unit, slotKey) {
  if (!unit || !unit.equipment) return null;
  const e = unit.equipment[slotKey];
  if (!e) return null;
  if (typeof e === 'string') {
    if (slotKey === 'weapon')     return (typeof WEAPONS    !== 'undefined') ? (WEAPONS[e]    || null) : null;
    if (slotKey === 'armor')      return (typeof ARMORS     !== 'undefined') ? (ARMORS[e]     || null) : null;
    if (slotKey === 'amulet')     return (typeof AMULETS    !== 'undefined') ? (AMULETS[e]    || null) : null;
    if (slotKey === 'ring')       return (typeof RINGS      !== 'undefined') ? (RINGS[e]      || null) : null;
    if (slotKey === 'consumable') return (typeof CONSUMABLES!== 'undefined') ? (CONSUMABLES[e]|| null) : null;
    return null;
  }
  return e;  // инстанс — возвращаем напрямую
}

/* Локальная таблица человеко-читаемых имён характеристик для тултипов
   слотов экипировки. Регулярные статы + спец-ключи аффиксов
   (damage / hp_regen / mana_regen). Используется только при
   рендере слотов экипировки в нижней панели. */
const PANEL_STAT_LABELS = {
  str: 'Сила', vit: 'Живучесть', dex: 'Ловкость', spd: 'Скорость',
  wis: 'Мудрость', int: 'Интеллект', luk: 'Удача',
  damage: 'Базовый урон', hp_regen: 'Рег. HP/ход', mana_regen: 'Рег. маны/ход'
};

function renderPortraitPanel() {
  const panel = document.getElementById('portraitPanel');
  const u = state.selectedUnitId ? getUnit(state.selectedUnitId) : null;

  if (!u) {
    panel.innerHTML = '<div class="placeholder-panel">Выберите юнита</div>';
    return;
  }
  const cls = CLASSES[u.classId];
  // Для монстров показываем «сторону врагов», для героев — команду/цвет.
  const teamLabel = cls.kind === 'monster'
    ? 'Противник'
    : (u.team === 'A' ? 'Команда A (красные)' : 'Команда B (синие)');
  // pct для CSS-переменной --ft-bar-pct (fantasy.css рисует заливку
  // .bar::before линейным градиентом 0..pct*100% → цвет, дальше → тень).
  // Без inline-style переменная остаётся в дефолте 1 — полоска вечно
  // полная. Clamp [0..1] на случай overheal/overmana будущих фич.
  const hpMax   = maxHpOf(u);
  const manaMax = maxManaOf(u);
  const hpPct   = hpMax   > 0 ? Math.max(0, Math.min(1, u.hp   / hpMax))   : 0;
  const manaPct = manaMax > 0 ? Math.max(0, Math.min(1, u.mana / manaMax)) : 0;
  panel.innerHTML = `
    <div class="portrait team-${u.team.toLowerCase()}">${classVisualHtml(cls)}</div>
    <div class="portrait-info">
      <div class="name">${cls.name} <span class="lvl-badge" title="Уровень">ур. ${u.level || 1}</span></div>
      <div class="team-label">${teamLabel}</div>
      <div class="bar" style="--ft-bar-pct: ${hpPct};"><span class="label hp-label">HP</span><span class="value">${u.hp} / ${hpMax}</span></div>
      <div class="bar" style="--ft-bar-pct: ${manaPct};"><span class="label mana-label">Мана</span><span class="value">${u.mana} / ${manaMax}</span></div>
    </div>
  `;
}

function renderBottomPanel() {
  const panel = document.getElementById('bottomPanel');
  const u = state.selectedUnitId ? getUnit(state.selectedUnitId) : null;

  if (!u) {
    panel.innerHTML = '<div class="placeholder-panel" style="grid-column: 1 / -1;">Выберите юнита, чтобы увидеть его панель</div>';
    return;
  }

  const cls = CLASSES[u.classId];
  // isActing — юнит и ходит, и игрок может им управлять (не монстр).
  // Во время хода зомби isPlayerActiveTurn() === false, так что все
  // кнопки и слоты этого юнита автоматически становятся disabled.
  const isActing = (u.id === state.activeUnitId) && isPlayerActiveTurn();
  // Состояния кнопок действий:
  //   - если юнит не ходящий — disabled (просмотр чужой/вражеской панели);
  //   - если действие уже использовано в этом ходу — helper класс action-used + disabled;
  //   - если режим включён на этой кнопке — mode-active подсветка.
  // Исключение: «Конец хода» активен всегда, пока есть чей-то ход —
  // удобно завершать, просматривая другого юнита, без лишних кликов.
  const moveUsed   = u.actionsUsedThisTurn && u.actionsUsedThisTurn.move;
  const attackUsed = u.actionsUsedThisTurn && u.actionsUsedThisTurn.attack;
  // «Обездвижен» отключает кнопку движения так же, как уже использованное
  // движение — disabled + action-used. Тултип ниже поясняет причину.
  const movementBlocked = !canUnitMove(u);
  const moveBtnCls   = 'btn primary' + (state.mode === 'move' && isActing ? ' mode-active' : '') + ((moveUsed || movementBlocked) ? ' action-used' : '');
  const attackBtnCls = 'btn primary' + (state.mode === 'attack' && isActing ? ' mode-active' : '') + (attackUsed ? ' action-used' : '');
  const moveBtnDis   = (!isActing || moveUsed || movementBlocked) ? 'disabled' : '';
  const attackBtnDis = (!isActing || attackUsed) ? 'disabled' : '';
  // «Конец хода» доступен только когда ходит игрок — во время хода
  // зомби кнопка серая, иначе игрок может преждевременно завершить
  // ИИ-ход и сорвать его.
  const endTurnDis   = isPlayerActiveTurn() ? '' : 'disabled';
  // Tooltip кнопки движения. Базово ничего не показываем; если есть причина
  // блокировки — поясняем «почему серая». Приоритет: иммобилизация важнее
  // факта «уже ходил» (если оба истинны — иммобилизация информативнее).
  const moveBtnTitle = movementBlocked
    ? 'Юнит обездвижен — движение недоступно'
    : (moveUsed ? 'В этом ходу уже было движение' : '');

  // Tooltip для кнопки атаки: развёрнутый разбор — формула, подстановка
  // текущих характеристик, итог, тип и крит. Считаем по выбранному
  // юниту (в панели всегда он), а не по active — чтобы видеть, что
  // именно ЭТОТ юнит нанесёт, когда станет ходящим.
  // Формат многострочный: '\n' раскрывается браузером в title.
  const weapon   = getUnitWeapon(u);
  const atkCrit  = critChanceOf(u);
  // Все tooltip'ы с формулами считаем от ЭФФЕКТИВНЫХ статов — тех же,
  // что участвуют в реальной боевой арифметике (см. executeAttack /
  // executeFireball, которые уже прогоняют цель через effectiveStats).
  // Иначе при дебаффах (Трупный яд и т.п.) в интерфейсе продолжал бы
  // светиться «чистый» урон, а по факту шёл урон от урезанных статов.
  const uStatsEff = effectiveStats(u);
  let attackTitle;
  if (weapon) {
    // С2-предметы: 3-й параметр — юнит, для учёта damage-аффиксов в тултипе.
    const total  = weaponDamage(weapon, uStatsEff, u);
    // С21: эффективная дальность учитывает statMods.weaponRangeBonus
    // (Дальний выстрел и пр.). Источник правды — weaponRangeOf.
    const atkRange = (typeof weaponRangeOf === 'function') ? weaponRangeOf(u) : weapon.range;
    const rangeBonus = atkRange - weapon.range;
    const desc   = describeDamage(weapon.delivery, weapon.damageType);
    const rangeLine = (rangeBonus > 0)
      ? `Дальность: ${atkRange} кл. (база ${weapon.range} + ${rangeBonus} от баффа)`
      : `Дальность: ${atkRange} кл.`;
    // С2-предметы: имя оружия с аффиксами, если это инстанс.
    const weaponDisplayName = (typeof itemFullName === 'function' && (weapon.prefix || weapon.suffix))
      ? itemFullName(weapon)
      : weapon.name;
    // С3-предметы: damage-бонус от аффиксов (Жестокий/Удара/...) показываем
    // отдельной строкой формулы, чтобы игрок видел, откуда лишние +N урона.
    // Источник — equipmentSpecialSum(u, 'damage'); сумма по всем слотам.
    // Сейчас аффикс damage может выпасть только на оружии (forbiddenSlots
    // для armor/ring/amulet/consumable), но суммируем универсально на
    // случай будущих расширений.
    const dmgBonus = (typeof equipmentSpecialSum === 'function')
      ? equipmentSpecialSum(u, 'damage') : 0;
    // Балансная правка 14.05.2026: medium_armor (лучник) даёт
    // attackDamageBonus 1/2/3 от базы. Показываем отдельной частью
    // строки формулы, чтобы игрок видел, что именно броня прибавляет.
    const armorAttackBonus = (typeof equipmentSpecialSum === 'function')
      ? equipmentSpecialSum(u, 'attackDamageBonus') : 0;
    const formulaParts = [`Формула: ${weaponFormulaText(weapon)}`];
    if (dmgBonus > 0) formulaParts.push(`+ ${dmgBonus} (аффиксы оружия)`);
    if (armorAttackBonus > 0) formulaParts.push(`+ ${armorAttackBonus} (броня)`);
    const formulaLine = formulaParts.join(' ');
    const lines = [
      `Атака — оружие «${weaponDisplayName}»`,
      formulaLine,
      `Урон: ${total} (${desc})`,
      rangeLine,
      `Крит: ${atkCrit}% — удваивает урон`
    ];
    attackTitle = lines.join('\n');
  } else {
    attackTitle = 'Атаковать нечем — оружие не экипировано';
  }

  // Активные навыки: рендерим слоты под реальные навыки класса + пустые до 4.
  // Слот становится кликабельным, если юнит ходит, хватает маны и в этом
  // ходу юнит ещё НЕ применял ни одного активного навыка (общее правило:
  // один активный навык за ход — любой активный скилл блокирует все
  // активные, включая сам себя, до следующего хода).
  const anyActiveUsedThisTurn = u.skillsUsedThisTurn.length > 0;
  const activeSlots = [];
  const skillCount = 4;
  // Источник списка активок — override на инстансе (DevTools / будущая
  // прокачка) перекрывает CLASSES[id].activeSkills. Симметрия с тем, как
  // passiveSourceList ниже читает passiveSkillsOf. До Сессии 9 слот тянул
  // ТОЛЬКО classes.activeSkills, поэтому DevTools-выданная активка не
  // отображалась; сейчас отображается одинаково с пассивкой.
  const activeSourceList = Array.isArray(u.activeSkillsOverride)
    ? u.activeSkillsOverride
    : (cls.activeSkills || []);
  for (let i = 0; i < skillCount; i++) {
    const skillId = activeSourceList[i];
    if (skillId) {
      const s = SKILLS[skillId];
      // Параметры активного скилла берём с учётом ТИРА конкретного юнита.
      // Базовые описательные поля (name, icon, area, delivery, damageType,
      // canCrit, hitsFriendlies, range, spriteSrc) — на верхнем уровне SKILLS,
      // тир-зависимые (manaCost, formula, applyEffect и т. п.) — в tiers[tier].
      // Slot-aware tier: если в `unit.skills[i]` лежит запись того же
      // скилла с собственным тиром — читаем оттуда. Это позволяет
      // одному и тому же id жить в разных слотах с разными тирами
      // (DevTools-выдача basic в слот 1 + elite в слот 3 показывает
      // правильные параметры в каждом тултипе и кастует тем тиром,
      // что в слоте). Передача `i` в getUnitSkillParams делает то же
      // самое для merged-параметров скилла.
      const slotEntry = (Array.isArray(u.skills) && u.skills[i]) ? u.skills[i] : null;
      const sParams = getUnitSkillParams(u, skillId, i);
      const tierKey = (slotEntry && slotEntry.id === skillId && slotEntry.tier)
        ? slotEntry.tier
        : getActiveSkillTier(u, skillId);
      const used    = anyActiveUsedThisTurn;
      const noMana  = (sParams.manaCost || 0) > u.mana;
      const blockedByImmob = !!(sParams.movesUser && movementBlocked);
      // Сессия 17: кулдаун. cdLeft — оставшееся число ходов отдыха
      // (источник правды — unit.cooldowns[skillId], тикает в endTurn).
      const cdLeft = (u.cooldowns && (u.cooldowns[skillId] | 0)) || 0;
      const onCooldown = cdLeft > 0;
      // Сессия 17: requireUnusedAttack/Move (задел C18+).
      const needAttack = !!(sParams.requireUnusedAttack && u.actionsUsedThisTurn && u.actionsUsedThisTurn.attack);
      const needMove   = !!(sParams.requireUnusedMove   && u.actionsUsedThisTurn && u.actionsUsedThisTurn.move);
      // Сессия 19: onceWave (Второе дыхание) — флаг u.usedThisWave[skillId].
      const onceUsed = !!(sParams.onceWave && u.usedThisWave && u.usedThisWave[skillId]);
      const canCast = isActing && !used && !noMana && !blockedByImmob && !onCooldown && !needAttack && !needMove && !onceUsed;
      const isModeOn = isActing && state.mode === skillId;
      const slotCls =
        'slot filled' +
        (canCast ? ' skill-active' : '') +
        (isModeOn ? ' mode-on' : '') +
        (used ? ' used' : '') +
        (noMana ? ' no-mana' : '') +
        (blockedByImmob ? ' action-used' : '') +
        (onCooldown ? ' cooldown-locked' : '') +
        (onceUsed ? ' wave-used' : '');
      // Tooltip — многострочный (браузер сам разобьёт по \n).
      // Если у скилла есть formula — расписываем её так же, как для оружия:
      // «База N + Стата/Делитель», затем подстановка текущих характеристик
      // и итоговый урон. Для скиллов с фиксированным уроном (если такие
      // появятся) просто выводим число.
      const skillTypeDesc = (sParams.delivery && sParams.damageType)
        ? describeDamage(sParams.delivery, sParams.damageType)
        : null;
      // Подпись тира (basic/advanced/elite) — для понимания, какой именно
      // вариант скилла сейчас доступен у этого юнита (даёт ли он Burning и т.п.).
      const tierLabelMap = { basic: 'базовый', advanced: 'продвинутый', elite: 'элитный' };
      const tierLabel = tierLabelMap[tierKey] || tierKey;
      const titleLines = [`${sParams.name} · тир: ${tierLabel}`];
      // Художественное описание: одна короткая фраза под именем, до сухих
      // цифр. Источник — поле `flavor` (для активов) или `description`
      // (фоллбек, на случай старых записей). Помогает игроку понять, что
      // вообще делает навык, до разбора формул и тиров.
      const flavorText = sParams.flavor || sParams.description;
      if (flavorText) titleLines.push(flavorText);
      // Сухая статистика «Мана · Перезарядка · Дальность · Область» —
      // собираем как массив частей и склеиваем через ` · `, пропуская
      // отсутствующие. Правила:
      //   - Мана: показываем ТОЛЬКО если manaCost > 0 (у бесплатных навыков
      //     воина «Мана: 0» бесполезный шум — С18 03.05.2026).
      //   - Перезарядка (Сессия 17/18): показываем если tierData.cooldown > 0.
      //     Для большинства маг-скиллов 0; для воина — реальный CD.
      //   - Дальность: range:0 → self-only (mana_focus, shield_block) — не
      //     показываем «Дальность: 0 кл.».
      //   - Область: только если есть area (фаербол).
      const statParts = [];
      if (typeof sParams.manaCost === 'number' && sParams.manaCost > 0) {
        statParts.push(`Мана: ${sParams.manaCost}`);
      }
      if (typeof sParams.cooldown === 'number' && sParams.cooldown > 0) {
        statParts.push(`Перезарядка: ${sParams.cooldown} ход(ов)`);
      }
      if (typeof sParams.range === 'number' && sParams.range > 0) {
        statParts.push(`Дальность: ${sParams.range} кл.`);
      }
      if (sParams.area) {
        statParts.push(`Область: ${sParams.area.size}×${sParams.area.size} клеток`);
      }
      if (statParts.length) titleLines.push(statParts.join(' · '));
      // Для self_buff (Огненный щит), teleport (Телепорт), cleanse
      // (Очищение) и grave_target (Воскрешение) строка «Тип» не имеет
      // смысла: при касте урона нет, тип ответки/снижения и так
      // расписан в эффект-чипе цели. Прячем.
      const _isAttackDeliv = (d) => d !== 'self_buff' && d !== 'teleport'
        && d !== 'cleanse' && d !== 'grave_target' && d !== 'self_aoe';
      if (skillTypeDesc && _isAttackDeliv(sParams.delivery)) {
        titleLines.push(`Тип: ${skillTypeDesc}`);
      }
      // Описание урона — формат различается для AoE и single-target.
      // У AoE упоминаем «область» (×2 крита по всей зоне, и адресат урона
      // — «каждой цели в области»). У single-target пишем коротко («целью»).
      const isAoeSkill = sParams.delivery === 'aoe';
      const critOnAreaSuffix = isAoeSkill ? ' (×2 на всю область)' : '';
      const targetClause = isAoeSkill ? ' каждой цели в области' : ' целью';
      if (sParams.formula) {
        const baseDmg = calcFormulaDamage(sParams.formula, uStatsEff);
        titleLines.push(`Формула: ${describeFormula(sParams.formula)}`);
        titleLines.push(
          `Урон: ${baseDmg}${sParams.canCrit ? ` · крит ${baseDmg * 2}${critOnAreaSuffix}` : ''}${targetClause}`
        );
      } else if (typeof sParams.damage === 'number') {
        titleLines.push(`Формула: фиксированно ${sParams.damage}${sParams.canCrit ? ` (при крите ×2${isAoeSkill ? ' на всю область' : ''})` : ''}`);
        titleLines.push(`Урон: ${sParams.damage}${sParams.canCrit ? ` · крит ${sParams.damage * 2}` : ''}${targetClause}`);
      }
      // Сессия 10: линейная АоЕ (lineLength) — отдельная строка про длину.
      if (typeof sParams.lineLength === 'number') {
        titleLines.push(`Линия: ${sParams.lineLength} кл. от прицела «от мага»`);
      }
      // Сессия 11: цепная молния (bounceCount) — отдельная строка про отскоки.
      if (typeof sParams.bounceCount === 'number') {
        titleLines.push(`Отскоки: до ${sParams.bounceCount} (по ближайшим врагам в радиусе 3)`);
      }
      // Сессия 12: призматическая сфера (strikes) — несколько ударов разных
      // типов по одной цели. Подписываем в человекочитаемом виде, чтобы
      // игрок понимал и порядок страйков, и количество. Иммунитет цели к
      // одному из типов обнуляет только свой удар (см. executePrismaticSphere).
      if (Array.isArray(sParams.strikes) && sParams.strikes.length) {
        // С24-рефактор: подписи страйков читаются из DAMAGE_TYPES[s].short
        // (раньше дублировалась локальная карта strikeNames). Если новый тип
        // урона не имеет short — fallback на label, потом на сам ключ.
        const labels = sParams.strikes.map(s => {
          const t = DAMAGE_TYPES[s];
          return (t && t.short) || (t && t.label) || s;
        });
        titleLines.push(`Удары: ${sParams.strikes.length} (${labels.join(' → ')}) — каждый по формуле выше`);
        titleLines.push('Иммунитет к одному из типов обнуляет только свой удар');
      }
      // Сессия 18: rangeMul (Рывок воина) — динамическая дальность, считается
      // от moveRangeOf(u). Показываем фактическое число клеток для текущего
      // юнита, а также формулу — чтобы игрок понимал, как баффы скорости
      // влияют. Если в будущем появится скилл с rangeMul у мага — тоже
      // отработает автоматически.
      if (typeof sParams.rangeMul === 'number' && typeof chargeRange === 'function' && skillId === 'charge') {
        const rng = chargeRange(u, i);
        titleLines.push(`Дальность рывка: ${rng} кл. (⌈Скор-движение × ${sParams.rangeMul}⌉)`);
      }
      // Сессия 14/18: damageReduction — снижение входящего урона. Используется
      // и Огненным щитом (только fire/frost), и Блоком щитом (любой тип кроме
      // special). Подписываем общим текстом, конкретику делает caller через
      // отдельный flavor/applyEffect.
      if (typeof sParams.damageReduction === 'number' && sParams.damageReduction > 0) {
        const scope = (skillId === 'fire_shield')
          ? 'входящего огненного и ледяного урона'
          : 'входящего урона';
        titleLines.push(`Снижение ${scope}: −${sParams.damageReduction} (но не ниже 1)`);
      }
      // Длительность баффов на основе damageReduction. Для shield_block
      // используется механизм expiresAt:'turnStart' (длительности нет —
      // живёт ровно до начала следующего своего хода). Для fire_shield —
      // обычная длительность в ходах (tierData.duration).
      if (skillId === 'shield_block') {
        titleLines.push('Действует до начала следующего хода');
      } else if (skillId === 'fire_shield' && typeof sParams.duration === 'number') {
        titleLines.push(`Действует ${sParams.duration} ход(а)`);
      }
      // Camp v1.5 (09.05.2026): ответный урон Огненного щита. Фиксируется
      // при наложении как `retaliateBase + ⌊Wis_кастера/3⌋` (см.
      // executeFireShield в core/combat.js). В тултипе показываем
      // прогноз для ТЕКУЩЕЙ Мудрости носителя панели — это и есть
      // потенциальный кастер. Источник эффективной Wis — uStatsEff
      // (учтены висящие баффы/дебаффы статов).
      if (skillId === 'fire_shield' && typeof sParams.retaliateBase === 'number') {
        const wisNow = (uStatsEff && uStatsEff.wis | 0) || 0;
        const ret = (sParams.retaliateBase | 0) + Math.floor(wisNow / 3);
        titleLines.push(`Ответка по атакующему в ближнем бою: ${ret} огня (${sParams.retaliateBase | 0} + ⌊${wisNow}/3⌋)`);
      }
      // Camp v1.5-priest (09.05.2026): конкретные числа скиллов священника.
      if (skillId === 'healing') {
        const baseHeal = (sParams.healBase | 0);
        const wisNow = (uStatsEff && uStatsEff.wis | 0) || 0;
        const total = baseHeal + Math.floor(wisNow / 2);
        titleLines.push(`Лечение: ${total} HP (${baseHeal} + ⌊${wisNow}/2⌋)`);
        titleLines.push('Не действует на механизмы');
      }
      if (skillId === 'blessing') {
        const luk = (sParams.lukDelta | 0);
        const dur = (sParams.duration | 0);
        titleLines.push(`На союзника/себя: +${luk} к Удаче на ${dur} ход.`);
        titleLines.push(`На враждебную нежить/демона: −${luk} к Удаче на ${dur} ход.`);
      }
      if (skillId === 'purify_touch') {
        titleLines.push('Снимает с цели все негативные эффекты');
        const immDur = (sParams.immunityDuration | 0);
        if (immDur > 0) {
          titleLines.push('Дополнительно: «Святая защита от порчи» до начала следующего хода цели');
        }
      }
      if (skillId === 'holy_strength') {
        const str = (sParams.strBonus | 0);
        const stun = (sParams.stunChance | 0);
        const dur = (sParams.duration | 0);
        titleLines.push(`Бонус: +${str} к Силе на ${dur} ход.`);
        titleLines.push(`При базовой атаке: ${stun}% шанс оглушить нежить/демона на 1 ход.`);
      }
      if (skillId === 'resurrection') {
        const hp = (sParams.hpPercent | 0);
        const mp = (sParams.manaPercent | 0);
        titleLines.push('Цель: надгробие союзного героя в радиусе 1');
        if (hp === 0 && mp === 0) titleLines.push('Воскрешает с 1 HP и 0 маны');
        else titleLines.push(`Воскрешает с ${hp}% maxHP и ${mp}% maxMana`);
        titleLines.push('Воскрешённый пропускает свой ближайший ход');
      }
      if (skillId === 'holy_shield') {
        const r = (sParams.range | 0);
        titleLines.push(`Цель: союзник в радиусе ${r}${sParams.allowSelf ? ' (можно на себя)' : ''}`);
        titleLines.push('Эффект: входящий урон ≤ 1 до начала следующего хода цели');
      }
      if (skillId === 'light_wave') {
        const r = (sParams.range | 0);
        const dur = (sParams.frightenedDuration | 0) || 1;
        const wis = (uStatsEff && uStatsEff.wis | 0) || 0;
        const div = (typeof sParams.wisDivisor === 'number' && sParams.wisDivisor > 0) ? sParams.wisDivisor : 2;
        const dmg = (sParams.damageBase | 0) + Math.floor(wis / div);
        titleLines.push(`Бьёт всех в радиусе ${r} клеток вокруг кастера`);
        titleLines.push('Цели: только нежить и демоны (союзники и прочие враги не задеваются)');
        titleLines.push(`Урон: ${dmg} (${sParams.damageBase | 0}+⌊${wis}/${div}⌋) каждой цели`);
        titleLines.push(`Эффект на цели: «Напуган» на ${dur} ход.`);
      }
      // Аудит 05.05.2026: для mana_focus выводим tier-зависимый бонус
      // Мудрости и длительность — иначе игрок не видит, на сколько
      // вырастет статистика и насколько надолго (все остальные
      // self-buff'ы расписаны явно).
      if (skillId === 'mana_focus') {
        if (typeof sParams.wisBonus === 'number' && sParams.wisBonus > 0) {
          titleLines.push(`Бонус: Мудрость +${sParams.wisBonus}`);
        }
        if (typeof sParams.duration === 'number' && sParams.duration > 0) {
          titleLines.push(`Действует ${sParams.duration} ход(а)`);
        }
      }
      // Сессия 19: специфика воин-навыков по полям тира.
      if (typeof sParams.healPct === 'number' && sParams.healPct > 0) {
        const maxHp = (typeof maxHpOf === 'function') ? maxHpOf(u) : 0;
        const heal = Math.ceil(maxHp * sParams.healPct);
        const pct = Math.round(sParams.healPct * 100);
        titleLines.push(`Лечение: ${heal} HP (${pct}% от максимума)`);
        if (sParams.onceWave) titleLines.push('Можно использовать один раз за битву');
      }
      if (typeof sParams.charges === 'number' && sParams.charges > 0 && skillId === 'fortify_armor') {
        titleLines.push(`Заряды брони: ${sParams.charges} (поглощает урон 1-в-1, до исчерпания)`);
      }
      // Сессия 18: damageMul (Круговой удар) — множитель урона от обычного
      // удара оружием. Считаем фактическое число для текущего оружия. Берём
      // тот же weaponDamage от effective stats, что используется в executeWhirlwind.
      if (typeof sParams.damageMul === 'number' && skillId === 'whirlwind') {
        const w = (typeof getUnitWeapon === 'function') ? getUnitWeapon(u) : null;
        if (w) {
          const baseDmg = weaponDamage(w, uStatsEff, u);
          const perTarget = Math.max(1, Math.floor(baseDmg * sParams.damageMul));
          titleLines.push(`Урон по каждой цели: ${perTarget} (⌊${baseDmg} (оружие) × ${sParams.damageMul}⌋, минимум 1)`);
        }
      }
      // С20: подробности по полям тиров для воин-навыков второй порции.
      if (skillId === 'second_attack') {
        titleLines.push('Условие: уже использована обычная атака');
        if (sParams.requireUnusedMove) titleLines.push('Условие: не использовано движение в этом ходу');
        if (sParams.consumesMove) titleLines.push('Эффект: расходует движение в этом ходу');
        if (sParams.applySelfBuff === 'second_attack_buff') {
          titleLines.push('Бонус: Сила +6, Удача +6 на следующую атаку');
        }
      }
      if (skillId === 'provoke') {
        // Радиус намеренно не дублируем — он уже выведен в общей строке
        // статистики как «Дальность» (правка 05.05.2026, по аналогии с
        // cover ниже). Бонус брони (armorCharges) убран в той же правке —
        // тиры провокации теперь различаются только радиусом.
        titleLines.push('Эффект: на врагов в радиусе — «Спровоцирован». Сбрасывается, когда враг атакует или движется к воину.');
      }
      if (skillId === 'cover') {
        // Дальность намеренно не дублируем — она уже выведена в общей
        // строке статистики (statParts «Перезарядка · Дальность · …»),
        // повтор «(манхэттен)» — лишний шум для игрока (правка 05.05.2026).
        titleLines.push(sParams.allowEnemies
          ? 'Цель: любой живой юнит (включая врагов)'
          : 'Цель: только союзник');
        titleLines.push('Эффект: меняется местами с целью (телепорт-свап, не движение)');
        titleLines.push('Запрет: если у воина или цели висит «Обездвижен»');
      }
      // С24: poison_arrow / fire_arrow — выводим длительность накладываемого эффекта.
      if (skillId === 'poison_arrow' && typeof sParams.poisonDuration === 'number') {
        titleLines.push(`Эффект на цели: «Отравлен» на ${sParams.poisonDuration} ход.`);
        titleLines.push('Накладывается на следующую атаку лучника (висит до первой атаки)');
      }
      if (skillId === 'fire_arrow' && typeof sParams.burnDuration === 'number') {
        titleLines.push(`Эффект на цели: «Горит» на ${sParams.burnDuration} ход.`);
        titleLines.push('Накладывается на следующую атаку лучника (висит до первой атаки)');
      }
      // С21: long_shot — описание прибавки к дальности.
      if (skillId === 'long_shot' && typeof sParams.weaponRangeBonus === 'number') {
        titleLines.push(`Бонус: +${sParams.weaponRangeBonus} к дальности атаки до конца хода`);
        titleLines.push('Каст не расходует базовую атаку — стрелять можно сразу после применения');
      }
      // С22: trap — фиксированный или dex-зависимый урон + immobilized.
      if (skillId === 'trap') {
        if (sParams.dmgFromDex) {
          // Элита: dmgBase + ⌊dex/2⌋. Считаем фактическое значение для текущего юнита.
          const dex = (uStatsEff && uStatsEff.dex) || 0;
          const dmg = (sParams.dmgBase | 0) + Math.floor(dex / 2);
          titleLines.push(`Урон ловушки: ${dmg} физ. (база ${sParams.dmgBase | 0} + ⌊${dex}/2⌋)`);
        } else if (typeof sParams.dmg === 'number') {
          titleLines.push(`Урон ловушки: ${sParams.dmg} физ.`);
        }
        titleLines.push('Эффект: «Обездвижен» на 2 хода + прерывает движение жертвы');
        titleLines.push('Срабатывает на любого, кто шагнул на клетку (свой/чужой)');
      }
      // С22: lure — радиус действия + опциональный applyOnPickup.
      if (skillId === 'lure') {
        if (typeof sParams.lureRadius === 'number') {
          titleLines.push(`Радиус действия: ${sParams.lureRadius} кл.`);
        }
        titleLines.push('Враги в радиусе обязаны идти к приманке');
        if (sParams.applyOnPickup && sParams.applyOnPickup.id) {
          const onPickup = sParams.applyOnPickup;
          const names = { poisoned: 'Отравлен', burning: 'Горит', stunned: 'Оглушён', immobilized: 'Обездвижен' };
          const nm = names[onPickup.id] || onPickup.id;
          titleLines.push(`Эффект на подобравшего: «${nm}» на ${onPickup.duration | 0} ход.`);
        }
      }
      // С21: second_shot — зеркало second_attack.
      if (skillId === 'second_shot') {
        titleLines.push('Условие: уже использована обычная атака');
        if (sParams.requireUnusedMove) titleLines.push('Условие: не использовано движение в этом ходу');
        if (sParams.consumesMove) titleLines.push('Эффект: расходует движение в этом ходу');
        if (sParams.applySelfBuff === 'second_shot_buff') {
          titleLines.push('Бонус: Ловкость +6, Удача +6 на следующую атаку');
        }
      }
      // Дополнительный эффект тира — расписываем на отдельной строке, чтобы
      // игрок видел разницу advanced/elite относительно basic. Поле формата
      // `{ id, duration, strength?, percent?, chance? }`:
      //   strength — фикс. сила (slowed-фикс., chilled-варианты — задел);
      //   percent  — процент от базового стата цели, считается в момент
      //              каста (slowed: -% от базовой Spd; см. ice_arrow);
      //   chance   — независимый ролл шанса в % (С10: elite-Молния → stunned/15%).
      // Single-target пишет «по цели», AoE — «каждой цели в области».
      if (sParams.applyEffect && sParams.applyEffect.id) {
        // С24-рефактор: имя эффекта читается из SKILLS[id].name (а не из
        // дублирующей карты). Имена в SKILLS — «Горит», «Отравлен» и т.п.
        // (форма «уже-горящего носителя»), что согласуется с подписью чипа
        // и логом. Если запись скилла не найдена — fallback на сам id.
        const _effSk = SKILLS[sParams.applyEffect.id];
        const effName = (_effSk && _effSk.name) || sParams.applyEffect.id;
        // Силу выводим в формате процента, если задан percent; иначе —
        // в виде абсолютного числа (старый strength). Для slowed процент
        // означает «−N% Скорости от базы». Для будущих процентных эффектов
        // подпись стата подхватим из `_effSk.percentStatLabel` (если будет
        // задан); сейчас единственный потребитель процентов — slowed,
        // поэтому подпись «Скорости» зашита явно.
        let suffix = '';
        if (typeof sParams.applyEffect.percent === 'number') {
          suffix = sParams.applyEffect.id === 'slowed'
            ? ` (−${sParams.applyEffect.percent}% Скорости)`
            : ` (−${sParams.applyEffect.percent}%)`;
        } else if (typeof sParams.applyEffect.strength === 'number') {
          suffix = ` (сила ${sParams.applyEffect.strength})`;
        }
        const chanceSuffix = (typeof sParams.applyEffect.chance === 'number')
          ? ` (${sParams.applyEffect.chance}% шанс)`
          : '';
        const targetScope = isAoeSkill ? 'каждой цели в области' : 'по цели';
        titleLines.push(`Эффект: «${effName}»${suffix} на ${sParams.applyEffect.duration} ход(а) ${targetScope}${chanceSuffix}`);
      }
      if (sParams.hitsFriendlies) {
        // Текст зависит от формы доставки: у линии (Молния) клетка кастера
        // НЕ входит в зону, упоминать мага некорректно. У AoE-площади
        // (Фаербол) — может, поэтому фраза остаётся прежней.
        if (typeof sParams.lineLength === 'number') {
          titleLines.push('Бьёт всех на линии — включая союзников');
        } else if (sParams.area) {
          titleLines.push('Бьёт всех в зоне — союзников и самого мага тоже');
        } else {
          titleLines.push('Бьёт всех в зоне — включая союзников');
        }
      }
      if (used)   titleLines.push('(в этом ходу уже применён активный навык)');
      if (noMana) titleLines.push('(недостаточно маны)');
      if (blockedByImmob) titleLines.push('(юнит обездвижен — скилл с перемещением недоступен)');
      // Сессия 17: причины «нельзя кастовать» — кулдаун и
      // requireUnusedAttack/Move. Расписываем в тултипе, чтобы игрок
      // видел КОНКРЕТНУЮ причину серого слота.
      if (onCooldown) titleLines.push(`(на откате: ${cdLeft} ход(ов))`);
      if (needAttack) titleLines.push('(сначала нужна не-использованная атака)');
      if (needMove)   titleLines.push('(сначала нужно не-использованное движение)');
      if (onceUsed)   titleLines.push('(уже использовано в этой битве)');
      // В слоте — pixel-art спрайт скилла, если он есть; иначе эмодзи.
      const slotFace = sParams.spriteSrc
        ? `<img src="${sParams.spriteSrc}" alt="${sParams.name.replace(/"/g, '&quot;')}">`
        : sParams.icon;
      activeSlots.push(
        `<div class="${slotCls}" title="${titleLines.join('\n').replace(/"/g, '&quot;')}" data-skill-id="${skillId}" data-skill-slot="${i}">${slotFace}</div>`
      );
    } else {
      activeSlots.push(`<div class="slot"></div>`);
    }
  }

  // Пассивные — показываем реальные пассивки класса (с учётом текущего
  // тира по уровню), пустые слоты добиваем до 4. Пассивки не требуют маны
  // и не «расходуются» — отображаются как просто заполненные слоты с
  // tooltip'ом, описывающим эффект и его срабатывание.
  // Источник списка пассивок — `passiveSkillsOf(u)` (учитывает
  // `unit.passiveSkillsOverride` от DevTools / будущей прокачки). Тир —
  // `getPassiveSkillTier(u, sid)` (тоже override-aware: сначала
  // `unit.passiveSkillTiersOverride[sid]`, иначе таблица по уровню класса).
  const passiveSourceList = (typeof passiveSkillsOf === 'function')
    ? passiveSkillsOf(u)
    : (cls.passiveSkills || []);
  const passiveSlots = [];
  const passiveCount = 4;
  for (let i = 0; i < passiveCount; i++) {
    const sid = passiveSourceList[i];
    if (sid && SKILLS[sid]) {
      const s = SKILLS[sid];
      const tier = (typeof getPassiveSkillTier === 'function')
        ? getPassiveSkillTier(u, sid)
        : 'basic';
      const tierData = (s.tiers && s.tiers[tier]) || {};
      const lines = [`${s.name}`];
      // Художественное описание пассивки — под именем, до «Срабатывает:».
      // Источник — `flavor` (приоритет) или `description` (фоллбек). У
      // пассивок description исторически использовался для эффект-чипа
      // (см. секцию «Воздействия» ниже), но как «человеческий» текст
      // тоже годится — пока пассивка не имеет отдельного flavor.
      const passiveFlavor = s.flavor || s.description;
      if (passiveFlavor) lines.push(passiveFlavor);
      if (s.kind === 'passive') {
        if (sid === 'corpse_poison') {
          lines.push(`Срабатывает: при нанесении урона противнику`);
          // Удача намеренно исключена из перечня дебаффуемых статов —
          // см. _computeCorpsePoisonMods (CORPSE_POISON_STAT_KEYS без 'luk').
          // Описание в тултипе должно совпадать с фактическим поведением.
          // Балансная правка 07.05.2026: процент от базового стата
          // вместо плоского числа (округление вверх).
          const pct = (typeof tierData.statPercent === 'number')
            ? tierData.statPercent
            : Math.abs(tierData.statMod || 0);  // fallback для старых сейвов
          const valLabel = (typeof tierData.statPercent === 'number')
            ? `−${pct}% (округление вверх)`
            : `−${pct}`;
          lines.push(`Эффект: все характеристики цели, кроме Удачи, ${valLabel} на ${tierData.duration || 1} ход`);
        } else if (sid === 'mana_regen') {
          // Триггер `onTurnEnd` — см. core/skills.js → triggerPassivesAtTurnEnd.
          // Лимит `capPerWave` копится per-unit и сбрасывается между волнами;
          // в тултипе показываем оба параметра двумя отдельными строками
          // (формат запрошен пользователем 03.05.2026: чтобы прирост за
          // ход и потолок за сражение читались независимо, без скобок).
          lines.push(`Срабатывает: в конце своего хода`);
          lines.push(`+ ${tierData.amount || 0} маны за ход (если она ниже максимума)`);
          lines.push(`до ${tierData.capPerWave || 0} за сражение.`);
        } else if (sid === 'crushing_magic') {
          // Не событийная пассивка, а модификатор шанса крита — читается
          // в core/stats-calc.js → critChanceOf. mult: basic 1.0 / advanced 1.5 / elite 2.0.
          // Формула в тултипе ровно та же, что в коде: `chance += floor(wis * mult)`.
          const mult = (typeof tierData.mult === 'number') ? tierData.mult : 1;
          // Показываем mult без дробной части, когда она нулевая (×2 вместо ×2.0),
          // иначе — с одним знаком после точки (×1.5).
          const multStr = (mult === Math.floor(mult)) ? String(mult) : mult.toFixed(1);
          lines.push(`Срабатывает: пассивно (модификатор крита)`);
          lines.push(`Эффект: увеличивает шанс критического удара на ⌊Мудрость × ${multStr}⌋ %`);
        } else if (sid === 'mana_absorb') {
          // Триггер `onManaSpent` — см. core/skills.js → triggerOnManaSpent.
          // ВАЖНО: фактическое лечение — плоское `tierData.heal`, ограничено
          // только maxHp. Description в SKILLS.mana_absorb говорит «пропорционально
          // потраченной мане», но реализация так не работает; тултип должен
          // совпадать с поведением (как и у corpse_poison).
          lines.push(`Срабатывает: после каста активного навыка (при затрате маны)`);
          lines.push(`Эффект: +${tierData.heal || 0} HP (не выше максимума)`);
        } else if (sid === 'reinforcement') {
          // Триггер `onTakeDamage` — см. core/skills.js →
          // triggerOnTakeDamagePassives. За каждое получение урона
          // (incoming > 0) добавляется gainPerHit стака к эффекту
          // «Укрепление» на цели. Стаки висят до начала следующего
          // хода носителя и снижают входящий урон в фазе 1 на сумму
          // стаков (но не ниже 1).
          lines.push(`Срабатывает: при каждом получении урона`);
          lines.push(`Эффект: +${tierData.gainPerHit || 0} стак к «Укреплению»`);
          lines.push(`Каждый стак снижает следующий получаемый урон на 1 (но не ниже 1)`);
          lines.push(`Стаки сбрасываются в начале своего хода`);
        } else if (sid === 'endurance') {
          // Маркер-модификатор. Срабатывает в фазе 1 computeIncomingDamage
          // ТОЛЬКО на DoT-тики (Горение, Отравление). Снижает на reduction
          // (по тиру), max(0, ...) — может полностью обнулить тик
          // (особое правило для эффектов, в отличие от обычных снижений
          // с полом 1).
          lines.push(`Срабатывает: при каждом тике DoT (Горение, Отравление и т.п.)`);
          lines.push(`Эффект: уменьшает урон тика на ${tierData.reduction || 0} (может полностью обнулить)`);
          lines.push(`На обычные удары и AoE НЕ влияет`);
        } else if (sid === 'marksman') {
          // С21: модификатор шанса крита (как crushing_magic). Читается
          // в critChanceOf (core/stats-calc.js): `chance += tierData.bonus`,
          // ДО общего clamp'а в [-100, 100].
          const bonus = (typeof tierData.bonus === 'number') ? tierData.bonus : 0;
          lines.push(`Срабатывает: пассивно (модификатор крита)`);
          lines.push(`Эффект: +${bonus}% к шансу критического удара`);
        } else if (sid === 'joint_hunt') {
          // Сессия волков. Стаки на цели — эффект joint_hunt_marks.
          // Бонус к урону читается в getJointHuntDamageBonus (core/skills.js).
          // gainPerAttack — число стаков, которое накладывается ПОСЛЕ удара.
          const gain = (tierData && (tierData.stacksGain | 0)) || 1;
          lines.push(`Срабатывает: при ударе по цели`);
          lines.push(`Эффект: бьёт +N урона (N = стаков на цели)`);
          lines.push(`После удара: +${gain} стак на цели (стаки делятся пополам в её начале хода)`);
        } else if (sid === 'wolf_howl') {
          // Сессия волков. Триггер onTurnStart — triggerPassivesAtTurnStart.
          // spdBuff — для advanced/elite тиров, basic просто будит.
          const spd = (tierData && (tierData.spdBuff | 0)) || 0;
          lines.push(`Срабатывает: в начале своего хода (если в режиме агро)`);
          lines.push(`Эффект: пробуждает спящих сородичей группы «волки»`);
          if (spd > 0) lines.push(`Пробуждённые получают +${spd} к Скорости до конца следующего хода (инициатива пересчитывается)`);
        } else if (sid === 'pack_leader') {
          // Сессия волков. Аура: refreshPackLeaderAuras в core/skills.js.
          // strPercent: 30% от базовой Силы цели, округление вверх.
          const r = (tierData && (tierData.radius | 0)) || 5;
          const pct = (tierData && (tierData.strPercent | 0)) || 30;
          lines.push(`Срабатывает: пассивно (аура вокруг лидера)`);
          lines.push(`Эффект: подчинённые юниты группы «волки» в радиусе ${r} клеток получают +${pct}% к Силе (округление вверх)`);
          lines.push(`Сам вожак ауру не получает`);
          lines.push(`Усиление спадает при выходе из радиуса или гибели лидера`);
        } else if (sid === 'bony') {
          // Camp v1.5-skeletons (09.05.2026): «Костлявый» — статический
          // модификатор входящего урона по delivery:'ranged'. Читается
          // в core/damage.js → computeIncomingDamage фаза 1.6.
          const pct = (tierData && (tierData.reduction | 0)) || 0;
          lines.push(`Срабатывает: пассивно (модификатор входящего урона)`);
          lines.push(`Получаемый урон от атак дальнего боя снижается на ${pct}%`);
          lines.push(`Не действует на ближний бой, AoE и спец-урон`);
        } else if (sid === 'evil_slayer') {
          // Camp v1.5-priest-B (10.05.2026): «Истребитель зла» — двухсторонний
          // модификатор урона по нежити/демонам. Читается в core/damage.js
          // (фаза 1.7, входящий) и в core/combat.js → executeAttack
          // (исходящий, перед computeIncomingDamage).
          const r = (tierData && (tierData.reductionPercent | 0)) || 0;
          const b = (tierData && (tierData.bonusPercent | 0)) || 0;
          lines.push(`Срабатывает: пассивно (модификатор урона по типу цели/источника)`);
          lines.push(`Получает на ${r}% меньше урона от нежити и демонов`);
          lines.push(`Наносит на ${b}% больше урона по нежити и демонам`);
        } else if (sid === 'healing_aura') {
          // Camp v1.5-priest-C (11.05.2026): «Исцеляющая аура» — пассивная
          // регенерация HP у соседних союзников в начале их хода. Триггер —
          // triggerHealingAuraForUnit в core/effects.js, зовётся в beginTurn.
          const h = (tierData && (tierData.healAmount | 0)) || 0;
          lines.push('Срабатывает: пассивно (аура вокруг носителя)');
          lines.push(`В начале своего хода союзники на смежных клетках восстанавливают ${h} HP`);
          lines.push('Соседи — 8 клеток вокруг (включая диагональные)');
          lines.push('Не действует на механизмы');
        } else {
          lines.push('Пассивный навык');
        }
      }
      const title = lines.join('\n').replace(/"/g, '&quot;');
      // spriteSrc — общая pixel-art иконка для слота пассивки (когда есть).
      // icon-эмодзи остаётся fallback'ом для навыков без спрайта.
      const face = s.spriteSrc
        ? `<img src="${s.spriteSrc}" alt="${s.name.replace(/"/g, '&quot;')}">`
        : s.icon;
      passiveSlots.push(`<div class="slot filled" title="${title}">${face}</div>`);
    } else {
      passiveSlots.push(`<div class="slot"></div>`);
    }
  }

  // Экипировка — 5 пустых слотов (иконка + tooltip с названием слота).
  // В MVP экипировка только отображается. Позже tooltip будет описывать
  // сам предмет, если он надет (название, характеристики, эффекты).
  // С1-предметы (07.05.2026): шлем заменён на расходник. Порядок слотов
  // — оружие, броня, амулет, кольцо, расходник.
  const equipDefs = [
    { key: 'weapon',     icon: '⚔', label: 'Оружие' },
    { key: 'armor',      icon: '🛡', label: 'Броня' },
    { key: 'amulet',     icon: '📿', label: 'Амулет' },
    { key: 'ring',       icon: '💍', label: 'Кольцо' },
    { key: 'consumable', icon: '🧪', label: 'Расходник' }
  ];
  // С2-предметы (07.05.2026): все 5 слотов теперь рендерятся универсально
  // — если в слоте есть инстанс предмета или (для weapon) id-string базы,
  // показываем его иконку и tooltip с деталями. Иначе — пустой слот.
  // Раньше была реализована только ветка weapon, остальные всегда
  // рендерились как «пусто», даже когда были экипированы (баг 07.05.2026).
  const equipSlots = equipDefs.map(d => {
    const item = readEquipmentEntry(u, d.key);
    if (!item) {
      // С8-предметы (08.05.2026): пустой слот без эмодзи-заполнителя —
      // тип слота читается через title-тултип, иконки в нижней панели
      // только сбивали с толку.
      return `<div class="slot" title="${d.label} (слот пуст)"></div>`;
    }
    // Имя с аффиксами для инстансов; чистое name для базовых записей реестра.
    const itemName = (typeof itemFullName === 'function' && (item.prefix || item.suffix))
      ? itemFullName(item)
      : (item.name || item.id || d.label);
    const titleLines = [`${d.label}: ${itemName}`];
    // С3-предметы: тир и стоимость для weapon (в S4 — для armor).
    if (item.tier) titleLines.push(`Тир: ${item.tier}`);
    if (typeof itemTotalCost === 'function') {
      const cost = itemTotalCost(item);
      if (cost > 0) titleLines.push(`Стоимость: ${cost} оч.`);
    }
    if (d.key === 'weapon') {
      // Подробности оружия: тип/дальность/формула/урон. Та же арифметика,
      // что в кнопке атаки.
      const dmg = weaponDamage(item, uStatsEff, u);
      const desc = describeDamage(item.delivery, item.damageType);
      titleLines.push(`Тип: ${desc}`);
      titleLines.push(`Дальность: ${item.range != null ? item.range : '—'} кл.`);
      titleLines.push(`Формула: ${weaponFormulaText(item)}`);
      titleLines.push(`Текущий урон: ${dmg}`);
    }
    // Балансная правка 14.05.2026: для брони — тип и per-class свойство.
    if (d.key === 'armor' && item.armorType) {
      // Балансная правка 15.05.2026: метки типа брони — по классу-носителю.
      const TYPE_LABELS = { heavy_armor: 'Воин', medium_armor: 'Лучник', robe: 'Маг', priest_robe: 'Священник' };
      const tLabel = TYPE_LABELS[item.armorType] || item.armorType || '?';
      titleLines.push(`Тип брони: ${tLabel}`);
      if (typeof item.armoredOnSpawn === 'number') {
        titleLines.push(`«Бронирован»: ${item.armoredOnSpawn | 0} зар. в начале миссии`);
      }
      if (typeof item.attackDamageBonus === 'number') {
        titleLines.push(`Урон атак: +${item.attackDamageBonus | 0}`);
      }
      if (typeof item.manaDiscount === 'number') {
        titleLines.push(`Стоимость навыков в мане: −${item.manaDiscount | 0} (минимум 1)`);
      }
      if (typeof item.incomingReduction === 'number') {
        titleLines.push(`Получаемый урон: −${item.incomingReduction | 0} (любой тип, включая эффекты)`);
      }
    }
    // Аффиксы — построчно. Для всех слотов (универсальный путь).
    if (typeof itemAffixes === 'function') {
      const affs = itemAffixes(item);
      for (const aff of affs) {
        if (!aff || !aff.statMods) continue;
        for (const k of Object.keys(aff.statMods)) {
          const v = aff.statMods[k];
          if (typeof v !== 'number' || v === 0) continue;
          const label = (PANEL_STAT_LABELS[k] || k);
          const sign = v > 0 ? '+' : '−';
          titleLines.push(`${label}: ${sign}${Math.abs(v)} (${aff.name})`);
        }
      }
    }
    const title = titleLines.join('\n').replace(/"/g, '&quot;');
    const face = item.spriteSrc
      ? `<img src="${item.spriteSrc}" alt="${(item.name || d.label).replace(/"/g, '&quot;')}">`
      : (item.icon || d.icon);
    return `<div class="slot filled" title="${title}">${face}</div>`;
  }).join('');

  // Эффекты — квадратные чипы 48×48 с pixel-art иконкой и бейджем
  // длительности в правом нижнем углу. Tooltip формата:
  //   Название (включая тир для Трупного яда)
  //   Короткое описание действия (из SKILLS[id].description)
  //   [для stat-модификаторов — «Все характеристики (кроме Удачи): −N»]
  //   Осталось N ход.
  // Тик длительности — в конце хода носителя (tickEffectsAtTurnEnd).
  // Если у эффекта нет spriteSrc — fallback на эмодзи-icon.
  const effectsHtml = u.effects.length
    ? u.effects.map(e => {
        const sk = SKILLS[e.id];
        const face = (sk && sk.spriteSrc)
          ? `<img src="${sk.spriteSrc}" alt="${e.name.replace(/"/g, '&quot;')}">`
          : `<span class="effect-emoji" role="img" aria-label="${e.name.replace(/"/g, '&quot;')}">${(sk && sk.icon) || '?'}</span>`;
        const tLines = [e.name];
        if (sk && sk.description) tLines.push(sk.description);
        if (typeof e.statMod === 'number' && e.statMod !== 0) {
          const sign = e.statMod > 0 ? '+' : '−';
          // Трупный яд не трогает Удачу — формулировка согласована
          // со statBreakdown (там luk пропускается в расчёте).
          const targetText = (e.id === 'corpse_poison')
            ? 'Все характеристики (кроме Удачи)'
            : 'Все характеристики';
          tLines.push(`${targetText}: ${sign}${Math.abs(e.statMod)}`);
        }
        // Точечные stat-модификаторы (eff.statMods = { spd: -2, ... }).
        // По одной строке на каждый ключ — «Скорость: −2», «Мудрость: +4».
        // Согласовано с веткой statBreakdown в core/stats-calc.js: те же
        // модификаторы попадают в детализацию ячеек «Характеристики».
        if (e.statMods && typeof e.statMods === 'object') {
          for (const k of Object.keys(e.statMods)) {
            const delta = e.statMods[k];
            if (typeof delta !== 'number' || delta === 0) continue;
            const sign = delta > 0 ? '+' : '−';
            const label = (typeof STAT_LABELS === 'object' && STAT_LABELS && STAT_LABELS[k]) || k;
            tLines.push(`${label}: ${sign}${Math.abs(delta)}`);
          }
        }
        // Огненный щит (Сессия 14): два кастомных числа на экземпляре
        // эффекта — retaliateDmg (ответка melee-атакующему) и
        // damageReduction (снижение входящего fire/frost). Расписываем
        // обе строки; они зафиксированы в момент наложения и не
        // пересчитываются при изменении статов кастера.
        if (e.id === 'fire_shield') {
          if (Number.isFinite(e.retaliateDmg) && e.retaliateDmg > 0) {
            tLines.push(`Ответка: ${e.retaliateDmg} огненного урона атакующему в ближнем бою`);
          }
          if (Number.isFinite(e.damageReduction) && e.damageReduction > 0) {
            tLines.push(`Снижение огненного/ледяного урона: ${e.damageReduction} (но итог не ниже 1)`);
          }
        }
        // Блок щитом (С18): пишем суть эффекта в чипе явно — игроку
        // полезно видеть, на сколько уменьшается следующий получаемый
        // урон. Длительности у эффекта нет (expiresAt:'turnStart' —
        // обрабатывается ниже общей веткой).
        if (e.id === 'shield_block') {
          if (Number.isFinite(e.damageReduction) && e.damageReduction > 0) {
            tLines.push(`Получаемый урон: −${e.damageReduction} (но не ниже 1)`);
          }
        }
        // Укрепление (С19): стак-эффект, снижает урон на свою сумму.
        if (e.id === 'reinforcement') {
          if (Number.isFinite(e.stacks) && e.stacks > 0) {
            tLines.push(`Стаков: ${e.stacks} (получаемый урон: −${e.stacks}, но не ниже 1)`);
          }
        }
        // Camp v1.5-priest (10.05.2026): «Святая сила» — на инстансе
        // лежит stunChance (% шанс оглушить нежить/демона при базовой
        // атаке). statMods.str уже выводится универсальной веткой выше;
        // тут добавляем именно строку про оглушение.
        if (e.id === 'holy_strength_buff' && (e.stunChance | 0) > 0) {
          tLines.push(`Шанс оглушить нежить/демона при базовой атаке: ${e.stunChance | 0}%`);
        }
        // Camp v1.5-priest-B (10.05.2026): «Священная броня» — финальный
        // damage cap до 1 единицы. Истечение — общей веткой по
        // expiresAt:'turnStart' ниже.
        if (e.id === 'holy_shield_buff' && Number.isFinite(e.damageCap)) {
          tLines.push(`Получаемый урон ограничен ${e.damageCap | 0} единицей`);
        }
        // С18: длительность/badge — три варианта в зависимости от формы
        // эффекта. Раньше жёстко писали «Осталось ${e.remaining}», что для
        // эффектов с expiresAt:'turnStart' (shield_block) и charges
        // (armored) давало undefined.
        let badgeText = '';
        if (Number.isFinite(e.stacks) && e.stacks > 0) {
          // Сессия 19: stack-based эффекты (reinforcement).
          badgeText = String(e.stacks);
          if (e.expiresAt === 'turnStart') {
            tLines.push('Истекает в начале следующего хода');
          }
        } else if (e.expiresAt === 'nextAttack') {
          // С24: эффекты-усиления следующей атаки (poison_arrow_buff,
          // fire_arrow_buff, second_attack_buff). Не тикают по ходам;
          // спадают после первой же атаки носителя через
          // consumeNextAttackEffects.
          tLines.push('Спадает после первой атаки');
          // applyOnHit-эффекты (стрелы): расписываем что наложится.
          if (e.applyOnHit && e.applyOnHit.id && (e.applyOnHit.duration | 0) > 0) {
            // С24-рефактор: имя эффекта-он-ит из SKILLS[id].name
            // (раньше дублирующая карта onHitNames).
            const _onHitSk = SKILLS[e.applyOnHit.id];
            const onHitLabel = (_onHitSk && _onHitSk.name) || e.applyOnHit.id;
            tLines.push(`На цели атаки: «${onHitLabel}» на ${e.applyOnHit.duration} ход.`);
          }
          badgeText = '✦';
        } else if (e.expiresAt === 'turnStart') {
          tLines.push('Истекает в начале следующего хода');
          badgeText = '↻';
        } else if (e.expiresAt === 'turnEnd') {
          // С21: long_shot_buff — спадает в конце текущего хода носителя
          // (через expireTurnEndEffects в endTurn).
          tLines.push('Истекает в конце этого хода');
          badgeText = '⏳';
        } else if (Number.isFinite(e.charges) && e.charges > 0) {
          // Правка 04.05.2026: убрано «X / Y». У armored нет понятия
          // максимального значения — есть только текущее число зарядов.
          tLines.push(`Зарядов: ${e.charges}`);
          badgeText = String(e.charges);
        } else if (Number.isFinite(e.remaining) && e.remaining > 0) {
          tLines.push(`Осталось ${e.remaining} ход.`);
          badgeText = String(e.remaining);
        }
        const title = tLines.join('\n').replace(/"/g, '&quot;');
        // Camp v1.5-polarity (09.05.2026): чип получает класс полярности
        // ('effect-chip-buff' / 'effect-chip-debuff') — CSS красит рамку
        // зелёной (бафф) или красной (дебафф). См. styles/effects.css.
        const pol = (typeof effectPolarityOf === 'function') ? effectPolarityOf(e) : 'debuff';
        const polCls = (pol === 'buff') ? 'effect-chip-buff' : 'effect-chip-debuff';
        return `<div class="effect-chip ${polCls}" title="${title}">${face}<span class="duration-badge">${badgeText}</span></div>`;
      }).join('')
    : '<div class="effects-empty">— нет активных воздействий —</div>';

  // Характеристики. Показываем эффективные значения — те же, что идут
  // во все производные расчёты (HP_max, Mana_max, дальность хода, урон,
  // крит). При дебаффе «Трупный яд» игрок видит реально уменьшенные
  // цифры; расшифровка «база vs модификаторы» — в tooltip'е каждой
  // ячейки: «База: N», затем каждый модификатор отдельной строкой
  // (c знаком ±), затем «Итого: M». Если модификаторов нет — показываем
  // только базу и итог (совпадают).
  const sbd = statBreakdown(u);
  const statsRows = STAT_ORDER.map(k => {
    const row = sbd[k];
    const label = STAT_LABELS[k];
    // С25-рефактор (06.05.2026): иконка стата через общий хелпер
    // `statIconHtml` (render/render.js). Раньше здесь был inline-блок,
    // дублировавший локальную копию в render-level-up.js.
    const face = statIconHtml(k, label);
    const tLines = [`База: ${row.base}`];
    for (const m of row.mods) {
      const sign = m.delta > 0 ? '+' : '−';
      tLines.push(`${m.name}: ${sign}${Math.abs(m.delta)}`);
    }
    tLines.push(`Итого: ${row.total}`);
    // Tooltip начинается с названия стата — Windows native title показывает
    // первую строку выделенно, и без подписи сложно понять какую именно
    // характеристику смотришь (иконки без подписи, пары рядом на грид).
    const title = ([label, ...tLines]).join('\n').replace(/"/g, '&quot;');
    const valueCls = 'stat-value'
      + (row.total < row.base ? ' stat-debuffed' : '')
      + (row.total > row.base ? ' stat-buffed'   : '');
    // Удача (luk) больше не висит на отдельной строке: позиция «колонка 3
    // ряда 3, справа от Интеллекта» прописана в CSS через .stat-luk —
    // сюда специальный класс уже не нужен.
    const cellCls = 'stat-cell stat-' + k;
    return `<div class="${cellCls}" title="${title}">${face}<span class="${valueCls}">${row.total}</span></div>`;
  }).join('');

  panel.innerHTML = `
    <div class="section action-buttons">
      <div class="section-title">Действия</div>
      <button class="${attackBtnCls}" ${attackBtnDis} data-action="attack" title="${attackTitle}">Атака</button>
      <button class="${moveBtnCls}"   ${moveBtnDis}   data-action="move" title="${moveBtnTitle.replace(/"/g, '&quot;')}">Движение</button>
      <button class="btn" ${endTurnDis} data-action="end">Конец хода</button>
    </div>
    <div class="section">
      <div class="section-title">Активные навыки</div>
      <div class="slots">${activeSlots.join('')}</div>
      <div class="section-title" style="margin-top:6px;">Пассивные навыки</div>
      <div class="slots">${passiveSlots.join('')}</div>
    </div>
    <div class="section">
      <div class="section-title">Экипировка</div>
      <div class="equipment-slots">${equipSlots}</div>
    </div>
    <div class="section">
      <div class="section-title">Воздействия</div>
      <div class="effects-list">${effectsHtml}</div>
    </div>
    <div class="section">
      <div class="section-title">Характеристики</div>
      <div class="stats-list">${statsRows}</div>
    </div>
  `;
}
