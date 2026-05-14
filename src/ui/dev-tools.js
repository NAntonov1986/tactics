/* dev-tools.js (ui/) — отладочная панелька «Выдай юниту любой навык».
   Сессия 7+: позволяет на лету раздать любому живому юниту любую активку
   или пассивку из реестра SKILLS на любом тире (basic/advanced/elite) в
   любой из четырёх слотов. Это инструмент тестирования навыков, а не
   игровая механика; в релизе модуль вырезается из index.html одним
   удалением `<link>`/`<script>` (state.js пробует bindDevTools только
   если функция определена).

   Что внутри:
     • bindDevTools() — создаёт плавающую кнопку 🛠 справа и пустой popover.
       Зовётся из state.js → init() рядом с bindHotkeys / bindFieldClickHandler.
     • openDevToolsPopover / closeDevToolsPopover — показ/скрытие, перерисовка.
     • renderDevToolsPopover() — полная перерисовка содержимого popover-а
       по текущему выбранному юниту (dtUnitSelect → state.units.find).
       Реестр навыков сгруппирован по классу (Воин/Лучник/Маг/Монстры) и
       внутри каждого класса разделён на Активные/Пассивные через
       вложенные <details>. Состояние раскрытия (что открыто/закрыто)
       переживает перерисовку через pop.dataset.dtOpenSections (см.
       readOpenSectionSet и toggle-listener в bindDevTools). Если у
       skill.classId массив (на будущее — навык, общий для нескольких
       классов), он дублируется в каждой группе. Незнакомые classId и
       навыки без classId уезжают в группу «Монстры».
     • applyDevToolsAssignment(unit, sid, tier, slot, kind) — выдаёт навык в
       слот, выставляя override-поля на инстансе юнита (см. ниже).
     • clearDevToolsSlot(unit, slot, kind) — освобождает конкретный слот
       без сноса остальных override-ов (актив → null в activeSkillsOverride
       и в unit.skills; пассивка → null в passiveSkillsOverride; запись о
       тире в passiveSkillTiersOverride сохраняется на случай повторной
       выдачи того же sid).
     • resetUnitToClass(unit) — снимает ВСЕ override-ы (`activeSkillsOverride`,
       `passiveSkillsOverride`, `passiveSkillTiersOverride`, плюс пересобирает
       `unit.skills` из CLASSES[classId].activeSkills и activeSkillTiers).
       Эффекты, HP, мана, действия — НЕ трогаются. Если нужен «свежий юнит» —
       подождать до конца волны: startNextWave сам восстанавливает героев.

   Что НЕ внутри:
     • Сама механика «как пассивка читает override тира» — `core/skills.js`
       (`getPassiveSkillTier`, `passiveSkillsOf`). DevTools только пишет
       override-поля в нужном формате.
     • Игровая нижняя панель (4+4 слота). Её мы НЕ переделываем — это
       работа сессии прокачки (см. project-memory). Поэтому DevTools-
       выданный второй активный навык не появится в нижней панели у юнита
       без `activeSkills` от класса; запустить его можно через хоткей или
       прямой вызов executeXxx из консоли. Для фаербола, выданного не магу,
       executeFireball отработает — проверка ослаблена в combat.js.

   Override-поля на инстансе (формат):
     unit.activeSkillsOverride          : Array<string|null> длиной ≥ slot
                                          (полностью заменяет CLASSES[id].activeSkills)
     unit.skills                        : Array<{id, tier} | null>
                                          (источник тира для активов; синхронизируется
                                          с activeSkillsOverride)
     unit.passiveSkillsOverride         : Array<string|null> длиной ≥ slot
                                          (полностью заменяет CLASSES[id].passiveSkills;
                                          см. passiveSkillsOf в core/skills.js)
     unit.passiveSkillTiersOverride     : Object<sid, tier>
                                          (читается getPassiveSkillTier; перекрывает
                                          таблицу passiveSkillTiers по уровню)

   Override-ы НЕ сбрасываются между волнами — это сознательно (тестировать
   через несколько волн подряд). Сбрасываются только per-волну счётчики
   (`unit.passives`) в `startNextWave` — там же, где сбрасывается всё
   остальное на героях.

   Список активов с реализованным исполнителем (`executeXxx` в core/combat.js)
   — `ACTIVE_EXECUTORS`. Активы вне этого набора показываются с пометкой
   «НЕТ ИСПОЛНИТЕЛЯ»: их МОЖНО выдать (override запишется), но клик в бою
   ничего не сделает — потому что нет функции, которая бы их применила.
   При добавлении нового execute-функционала в combat.js — расширить набор.

   Файл подключается ОБЫЧНЫМ <script src="..."> ПОСЛЕ ui/hotkeys.js и ПЕРЕД
   src/main.js. Все объявления попадают в глобальный scope window.

   Тонкость с порядком загрузки. bindDevTools() читает SKILLS, CLASSES,
   SKILL_TIER_LABELS — все из data/* (загружены раньше). render() и
   state из state.js (тоже раньше). Сам bindDevTools зовётся из init()
   уже после установки всех глобалов, на готовом state.units (после
   первой startNextWave). К моменту первого openDevToolsPopover popover
   собирается из живого state — никаких кэшей. */

/* ================================================================
   === КОНСТАНТЫ И НАБОРЫ ========================================
   ================================================================ */

/* DOM-id наших корневых узлов (кнопка и popover). Используем константы,
   чтобы не разбежались between bindDevTools и обработчиками. */
const DT_BUTTON_ID = 'devToolsButton';
const DT_POPOVER_ID = 'devToolsPopover';

/* Сколько слотов поддерживается (по 4 на каждый kind). Если
   игровая панель когда-нибудь сменит число — поменять тут и разом. */
const DT_SLOT_COUNT = 4;

/* Тиры, поддерживаемые большинством скиллов. Если у конкретного skill.tiers
   нет какого-то тира — кнопка не теряется, applyDevToolsAssignment запишет
   тир как есть; читатели тира (effectiveSkillParams, getPassiveSkillTier)
   защитятся возвратом верхнего уровня скилла. */
const DT_TIERS = ['basic', 'advanced', 'elite'];

/* Активные навыки с реализованным исполнителем (executeXxx в core/combat.js).
   На Сессии 11: fireball + ice_arrow + magic_arrow (через executeSingleTargetSkill)
   + lightning (Сессия 10, линейная АоЕ через executeLightning) + chain_lightning
   (Сессия 11, single-target initial с отскоками через executeChainLightning).
   При добавлении новых execute-функций в combat.js пополнять этот набор;
   иначе DevTools будет вешать ложную пометку «НЕТ ИСПОЛНИТЕЛЯ» на
   работающий навык. */
const ACTIVE_EXECUTORS = new Set(['fireball', 'ice_arrow', 'magic_arrow', 'lightning', 'chain_lightning', 'prismatic_sphere', 'teleport', 'fire_shield', 'mana_focus', 'purify', 'charge', 'shield_block', 'whirlwind', 'second_wind', 'fortify_armor', 'second_attack', 'provoke', 'cover', 'poison_arrow', 'fire_arrow', 'long_shot', 'second_shot', 'trap', 'lure', 'camouflage', 'healing', 'blessing', 'purify_touch', 'holy_strength', 'resurrection', 'holy_shield', 'light_wave']);

/* Группы для двухуровневой выпадайки реестра навыков. Порядок — герои,
   потом монстры. Иконки чисто визуальные, ни на что не влияют. */
const DT_CLASS_GROUPS = [
  { key: 'warrior',  label: 'Воин',       icon: '⚔' },
  { key: 'archer',   label: 'Лучник',     icon: '🏹' },
  { key: 'mage',     label: 'Маг',        icon: '✨' },
  { key: 'priest',   label: 'Священник',  icon: '✝' },
  { key: 'monsters', label: 'Монстры',    icon: '👹' }
];
/* Какие classId считать «героями» (всё остальное — в группу monsters,
   включая навыки без classId или с classId='zombie' и т.п.). */
const DT_HERO_CLASS_KEYS = new Set(['warrior', 'archer', 'mage', 'priest']);

/* Вернуть массив group-key'ев, в которых должен показаться навык.
   Поддерживает skill.classId как строку, как массив (на будущее —
   общие навыки нескольких классов), и как undefined (→ monsters). */
function dtSkillGroupKeys(skill) {
  let cids = skill && skill.classId;
  if (cids == null) return ['monsters'];
  if (!Array.isArray(cids)) cids = [cids];
  const out = [];
  const seen = new Set();
  for (const cid of cids) {
    const g = DT_HERO_CLASS_KEYS.has(cid) ? cid : 'monsters';
    if (!seen.has(g)) { seen.add(g); out.push(g); }
  }
  return out.length ? out : ['monsters'];
}

/* ================================================================
   === ИНИЦИАЛИЗАЦИЯ ==============================================
   ================================================================
   bindDevTools() добавляет в DOM кнопку 🛠 справа и пустой popover.
   Кликом по кнопке popover открывается; повторный клик / клик «Закрыть» /
   Esc закрывают. Открытый popover каждый раз перерисовывается заново
   (renderDevToolsPopover) — это проще, чем поддерживать диффы. Объёмы
   небольшие (десятки строк HTML).
   ================================================================ */
function bindDevTools() {
  // Защита от двойного вызова (на случай повторного init() в тесте).
  if (document.getElementById(DT_BUTTON_ID)) return;

  const btn = document.createElement('button');
  btn.id = DT_BUTTON_ID;
  btn.className = 'devtools-btn';
  btn.title = 'DevTools: выдать навык юниту';
  btn.textContent = '🛠';
  btn.addEventListener('click', () => {
    const pop = document.getElementById(DT_POPOVER_ID);
    if (pop && pop.style.display !== 'none') closeDevToolsPopover();
    else openDevToolsPopover();
  });
  document.body.appendChild(btn);

  const pop = document.createElement('div');
  pop.id = DT_POPOVER_ID;
  pop.className = 'devtools-popover';
  pop.style.display = 'none';
  document.body.appendChild(pop);

  // Запоминаем какие <details data-dt-key> были раскрыты, чтобы это
  // переживало перерисовку (renderDevToolsPopover пересобирает innerHTML).
  // Событие toggle НЕ всплывает — слушаем в capture-фазе. Слушатель
  // на самом popover-е переживает innerHTML-пересборку внутренностей.
  pop.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.dataset || !d.dataset.dtKey) return;
    const set = readOpenSectionSet(pop);
    if (d.open) set.add(d.dataset.dtKey);
    else set.delete(d.dataset.dtKey);
    pop.dataset.dtOpenSections = JSON.stringify([...set]);
  }, true);

  // Esc — закрыть. Не мешает игровому Esc (тот в hotkeys.js глушит режимы),
  // потому что мы не stopPropagation; просто параллельно закрываем popover.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const p = document.getElementById(DT_POPOVER_ID);
      if (p && p.style.display !== 'none') closeDevToolsPopover();
    }
  });
}

/* Прочитать множество ключей раскрытых <details> из dataset popover-а.
   Хранится как JSON-массив, чтобы переживать render и не зависеть от
   порядка узлов. */
function readOpenSectionSet(pop) {
  try {
    const raw = pop.dataset.dtOpenSections;
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) { return new Set(); }
}

function openDevToolsPopover() {
  const pop = document.getElementById(DT_POPOVER_ID);
  if (!pop) return;
  pop.style.display = 'block';
  // 06.05.2026: при каждом открытии popover'а сбрасываем кэш «выбранного
  // в DevTools юнита» — чтобы renderDevToolsPopover ниже подхватил
  // СВЕЖИЙ state.selectedUnitId (или activeUnitId как fallback). Без
  // этого dataset.dtUnitId переживал закрытие/открытие, и DevTools
  // продолжал показывать прошлого юнита, даже если игрок выделил на
  // поле другого. Внутри popover'а пользователь может переключить
  // юнит через селект — этот выбор сохраняется через перерисовки в том
  // же dataset.dtUnitId, его НЕ роняем (renderDevToolsPopover сам
  // выставит туда выбранный из селекта при последующих рендерах).
  delete pop.dataset.dtUnitId;
  renderDevToolsPopover();
}

function closeDevToolsPopover() {
  const pop = document.getElementById(DT_POPOVER_ID);
  if (!pop) return;
  pop.style.display = 'none';
}

/* ================================================================
   === РЕНДЕР POPOVER-А ===========================================
   ================================================================
   Один обходчик — собирает innerHTML и навешивает обработчики через
   делегирование на сам popover. Внутри:
   • селект юнита (живые из state.units),
   • два блока «Текущие слоты» (active / passive) с кнопкой «Очистить»
     на каждом занятом,
   • реестр SKILLS, сгруппированный по классу (Воин/Лучник/Маг/Монстры),
     внутри каждого класса — раскрывающиеся подсекции Активные/Пассивные
     (вложенные <details>); состояние раскрытия переживает перерисовку.
   После любой операции зовётся renderDevToolsPopover() + render().
   ================================================================ */
function renderDevToolsPopover() {
  const pop = document.getElementById(DT_POPOVER_ID);
  if (!pop || !state) return;

  const units = state.units.filter(u => u.alive);
  if (!units.length) {
    pop.innerHTML = '<div class="dt-header">🛠 DevTools</div>' +
                    '<div class="dt-empty">Нет живых юнитов на поле.</div>' +
                    '<div class="dt-actions"><button data-dt-action="close">Закрыть</button></div>';
    bindPopoverHandlers(pop, null);
    return;
  }

  // Текущий «выбранный для DevTools» юнит. По умолчанию — выбранный
  // в игре (state.selectedUnitId), либо активный (state.activeUnitId),
  // либо первый из живых. Не трогаем state — храним в data-атрибуте
  // popover-а, чтобы переживало перерисовку.
  let pickedId = pop.dataset.dtUnitId;
  if (!pickedId || !units.some(u => u.id === pickedId)) {
    pickedId = state.selectedUnitId || state.activeUnitId || units[0].id;
    pop.dataset.dtUnitId = pickedId;
  }
  const unit = units.find(u => u.id === pickedId);

  // Группировка навыков: { groupKey: { active: [sid...], passive: [sid...] } }.
  // Один навык может попасть в несколько групп (если skill.classId — массив).
  // Незнакомые classId и навыки без classId уезжают в 'monsters'.
  const grouped = {};
  for (const g of DT_CLASS_GROUPS) grouped[g.key] = { active: [], passive: [] };
  for (const sid of Object.keys(SKILLS)) {
    const sk = SKILLS[sid];
    if (!sk) continue;
    if (sk.kind !== 'active' && sk.kind !== 'passive') continue; // effects не показываем
    const groupKeys = dtSkillGroupKeys(sk);
    for (const gk of groupKeys) {
      if (!grouped[gk]) grouped[gk] = { active: [], passive: [] };
      grouped[gk][sk.kind].push(sid);
    }
  }
  const openSet = readOpenSectionSet(pop);
  const openAttr = (key) => openSet.has(key) ? ' open' : '';

  // Содержимое.
  let html = '';
  html += '<div class="dt-header">🛠 DevTools — выдача навыков</div>';

  // === Отладочные тоглы ===
  // forceChance — байпас applyEffect.chance в applySkillEffectDef
  // (см. core/skills.js). Хранится в state.dev.forceChance, ленивая
  // инициализация — чтобы не править createInitialState. Скрытый
  // dev-флаг, на финальный gameplay не влияет (дефолт false).
  const forceChanceOn = !!(state.dev && state.dev.forceChance);
  html += '<div class="dt-section-title">Отладка</div>';
  html += '<div class="dt-row">';
  html += '<label class="dt-label" style="display:flex; align-items:center; gap:6px; cursor:pointer;">';
  html += '<input type="checkbox" data-dt-action="toggle-force-chance"' + (forceChanceOn ? ' checked' : '') + '>';
  html += '<span>Все шанс-эффекты — 100%</span>';
  html += '</label>';
  html += '</div>';

  // === Селект юнита ===
  html += '<div class="dt-row">';
  html += '<label class="dt-label">Юнит:</label>';
  html += '<select class="dt-select" data-dt-action="pick-unit">';
  for (const u of units) {
    const cls = CLASSES[u.classId] ? CLASSES[u.classId].name : u.classId;
    const sel = u.id === pickedId ? ' selected' : '';
    html += '<option value="' + u.id + '"' + sel + '>' +
            esc(cls) + ' (' + u.team + ') #' + u.id + ' L' + (u.level || 1) +
            '</option>';
  }
  html += '</select>';
  html += '</div>';

  // === Текущие слоты юнита (active) ===
  html += '<div class="dt-section-title">Активные слоты юнита</div>';
  html += renderSlotsBlock(unit, 'active');

  // === Текущие слоты юнита (passive) ===
  html += '<div class="dt-section-title">Пассивные слоты юнита</div>';
  html += renderSlotsBlock(unit, 'passive');

  // === Реестр навыков, сгруппированный по классу → kind ===
  // Двухуровневый <details>: внешний — класс, внутренний — kind.
  // Состояние раскрытия переживает перерисовку (см. readOpenSectionSet).
  html += '<div class="dt-section-title">Реестр навыков (выдать)</div>';
  for (const g of DT_CLASS_GROUPS) {
    const buckets = grouped[g.key] || { active: [], passive: [] };
    const total = buckets.active.length + buckets.passive.length;
    if (!total) continue; // пустую группу не показываем
    const gKey = 'cls:' + g.key;
    html += '<details class="dt-class" data-dt-key="' + gKey + '"' + openAttr(gKey) + '>';
    html += '<summary>' + esc(g.icon) + ' ' + esc(g.label) +
            ' <span class="dt-class-count">(' + total + ')</span></summary>';
    for (const kind of ['active', 'passive']) {
      const list = buckets[kind];
      if (!list.length) continue;
      const kKey = gKey + ':' + kind;
      const kindLabel = kind === 'active' ? 'Активные' : 'Пассивные';
      html += '<details class="dt-kind" data-dt-key="' + kKey + '"' + openAttr(kKey) + '>';
      html += '<summary>' + esc(kindLabel) +
              ' <span class="dt-kind-count">(' + list.length + ')</span></summary>';
      html += '<div class="dt-skill-list">';
      for (const sid of list) html += renderSkillRow(sid, kind);
      html += '</div>';
      html += '</details>';
    }
    html += '</details>';
  }

  // === Кнопки ===
  html += '<div class="dt-actions">';
  html += '<button class="dt-reset" data-dt-action="reset-unit">Сбросить юнита к классу</button>';
  // С25: «Победа волны» — мгновенно завершает текущую волну и
  // запускает очередь прокачки + следующую волну. Не убивает зомби
  // вручную, а вызывает forceWaveVictory() — единая точка победы
  // миссии (под будущие типы миссий с другими условиями победы).
  html += '<button class="dt-victory" data-dt-action="force-victory">Победа битвы</button>';
  // С25+ (06.05.2026): «Дамп для агента» — копирует JSON-снапшот
  // (state + DOM + последние 200 событий из DebugLog) в буфер обмена.
  // Используется для удалённой диагностики: пользователь жмёт →
  // вставляет в чат → агент видит точное состояние в момент бага.
  html += '<button class="dt-debug-dump" data-dt-action="debug-dump">📋 Дамп для агента</button>';
  // Camp v1.5-popups (12.05.2026): «Дамп из localStorage» — читает уже
  // сохранённый persistent-буфер из localStorage. Полезно когда страница
  // только что зависла и в RAM-буфере не успели накопиться последние
  // события (или зависание мешает их собрать).
  html += '<button class="dt-debug-dump-persisted" data-dt-action="debug-dump-persisted">💾 Дамп из localStorage</button>';
  html += '<button data-dt-action="close">Закрыть</button>';
  html += '</div>';

  pop.innerHTML = html;
  bindPopoverHandlers(pop, unit);
}

/* Рендер блока «текущие слоты юнита» по kind. Показывает 4 строки —
   каждая либо «занят: name (tier)» с кнопкой «Очистить», либо «пусто». */
function renderSlotsBlock(unit, kind) {
  let html = '<div class="dt-slots">';
  for (let i = 1; i <= DT_SLOT_COUNT; i++) {
    const occ = readSlot(unit, i, kind);
    html += '<div class="dt-slot">';
    html += '<span class="dt-slot-num">#' + i + '</span> ';
    if (occ && occ.sid) {
      const sk = SKILLS[occ.sid];
      const name = sk ? sk.name : occ.sid;
      const icon = sk && sk.icon ? sk.icon : '·';
      const tierLbl = SKILL_TIER_LABELS[occ.tier] || occ.tier;
      html += '<span class="dt-slot-icon">' + esc(icon) + '</span> ';
      html += '<span class="dt-slot-name">' + esc(name) + '</span> ';
      html += '<span class="dt-slot-tier">[' + esc(tierLbl) + ']</span> ';
      html += '<button class="dt-clear" data-dt-action="clear-slot" ' +
              'data-kind="' + kind + '" data-slot="' + i + '">Очистить</button>';
    } else {
      html += '<span class="dt-slot-empty">пусто</span>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

/* Рендер строки одного навыка в списке выдачи: иконка + имя + бейдж
   «НЕТ ИСПОЛНИТЕЛЯ» (для активов без executeXxx) + селект тира +
   селект слота + кнопка «Выдать». */
function renderSkillRow(sid, kind) {
  const sk = SKILLS[sid];
  if (!sk) return '';
  const name = sk.name || sid;
  const icon = sk.icon || '·';
  const noExec = (kind === 'active') && !ACTIVE_EXECUTORS.has(sid);

  let html = '<div class="dt-skill" data-sid="' + sid + '" data-kind="' + kind + '">';
  html += '<span class="dt-skill-icon">' + esc(icon) + '</span>';
  html += '<span class="dt-skill-name">' + esc(name) + '</span>';
  if (noExec) {
    html += '<span class="dt-skill-badge" title="В core/combat.js нет executeXxx — выдать можно, клик в бою ничего не сделает">НЕТ ИСПОЛНИТЕЛЯ</span>';
  }
  // Тир — селект только из тех ключей, что реально есть в skill.tiers
  // (на случай, если у нового скилла будет только basic).
  const tiers = (sk.tiers && Object.keys(sk.tiers)) || DT_TIERS;
  html += '<select class="dt-tier" data-role="tier">';
  for (const t of tiers) {
    const lbl = SKILL_TIER_LABELS[t] || t;
    html += '<option value="' + t + '">' + esc(lbl) + '</option>';
  }
  html += '</select>';
  // Слот — 1..DT_SLOT_COUNT.
  html += '<select class="dt-slot-pick" data-role="slot">';
  for (let i = 1; i <= DT_SLOT_COUNT; i++) {
    html += '<option value="' + i + '">слот ' + i + '</option>';
  }
  html += '</select>';
  html += '<button class="dt-give" data-dt-action="give">Выдать</button>';
  html += '</div>';
  return html;
}

/* Один обработчик на все клики/изменения внутри popover-а — делегирование
   удобнее, чем переподписка после каждого render-а. data-dt-action
   определяет команду. */
function bindPopoverHandlers(pop, unit) {
  pop.onclick = (e) => {
    const t = e.target;
    const action = t && t.dataset && t.dataset.dtAction;
    if (!action) return;
    if (action === 'close') {
      closeDevToolsPopover();
      return;
    }
    if (action === 'force-victory') {
      // С25: ручной вызов «волна пройдена». Закрываем popover, чтобы
      // не перекрывал окно прокачки.
      if (typeof forceWaveVictory === 'function') forceWaveVictory();
      closeDevToolsPopover();
      return;
    }
    if (action === 'debug-dump') {
      // С25+: дамп DebugLog в буфер обмена. Async — не блокируем UI.
      if (typeof DebugLog !== 'undefined' && DebugLog.copyToClipboard) {
        Promise.resolve(DebugLog.copyToClipboard()).then(ok => {
          alert(ok
            ? '✓ Дамп скопирован в буфер обмена.\n\nТеперь вставьте (Ctrl+V) в чат с агентом.'
            : '✗ Не удалось скопировать в буфер обмена.\nОткройте Console (F12) — дамп выведен туда.');
        });
      } else {
        alert('DebugLog не загружен. Проверьте, что src/ui/debug-log.js подключён в index.html.');
      }
      return;
    }
    if (action === 'debug-dump-persisted') {
      // Camp v1.5-popups (12.05.2026): достать дамп из localStorage.
      // Работает даже если буфер в RAM пустой/неактуальный.
      if (typeof DebugLog !== 'undefined' && DebugLog.copyPersistedToClipboard) {
        Promise.resolve(DebugLog.copyPersistedToClipboard()).then(ok => {
          alert(ok
            ? '✓ Дамп из localStorage скопирован.\n\nЭто персистентная копия, которая обновляется каждые 250 мс. Если игра зависла — данные за последние секунды до зависания всё ещё здесь.\n\nВставьте (Ctrl+V) в чат с агентом.'
            : '✗ Не удалось скопировать. Console (F12) — дамп выведен туда.\n\nЕсли там «(empty)» — buffer ещё не был записан в localStorage.');
        });
      } else {
        alert('DebugLog.copyPersistedToClipboard не доступен.');
      }
      return;
    }
    if (action === 'reset-unit') {
      if (!unit) return;
      resetUnitToClass(unit);
      renderDevToolsPopover();
      if (typeof render === 'function') render();
      return;
    }
    if (action === 'clear-slot') {
      if (!unit) return;
      const kind = t.dataset.kind;
      const slot = parseInt(t.dataset.slot, 10);
      if (!kind || !(slot >= 1 && slot <= DT_SLOT_COUNT)) return;
      clearDevToolsSlot(unit, slot, kind);
      renderDevToolsPopover();
      if (typeof render === 'function') render();
      return;
    }
    if (action === 'give') {
      if (!unit) return;
      const row = t.closest('.dt-skill');
      if (!row) return;
      const sid = row.dataset.sid;
      const kind = row.dataset.kind;
      const tierEl = row.querySelector('[data-role="tier"]');
      const slotEl = row.querySelector('[data-role="slot"]');
      if (!sid || !kind || !tierEl || !slotEl) return;
      const tier = tierEl.value;
      const slot = parseInt(slotEl.value, 10);
      if (!(slot >= 1 && slot <= DT_SLOT_COUNT)) return;
      applyDevToolsAssignment(unit, sid, tier, slot, kind);
      renderDevToolsPopover();
      if (typeof render === 'function') render();
      return;
    }
  };

  pop.onchange = (e) => {
    const t = e.target;
    const action = t && t.dataset && t.dataset.dtAction;
    if (action === 'pick-unit') {
      pop.dataset.dtUnitId = t.value;
      renderDevToolsPopover();
      return;
    }
    if (action === 'toggle-force-chance') {
      // Ленивая инициализация state.dev — без правок createInitialState.
      if (!state.dev) state.dev = {};
      state.dev.forceChance = !!t.checked;
      // Нет render() — флаг влияет только на следующий каст эффекта,
      // визуальный лейаут панели не меняется.
      return;
    }
  };
}

/* ================================================================
   === МУТАЦИИ override-полей =====================================
   ================================================================ */

/* Выдать навык в слот. Контракт override-полей описан в шапке. */
function applyDevToolsAssignment(unit, skillId, tier, slot, kind) {
  if (!unit || !skillId || !(slot >= 1 && slot <= DT_SLOT_COUNT)) return;
  if (kind === 'active') {
    if (!Array.isArray(unit.activeSkillsOverride)) {
      const cls = CLASSES[unit.classId];
      unit.activeSkillsOverride = ((cls && cls.activeSkills) || []).slice();
    }
    while (unit.activeSkillsOverride.length < slot) unit.activeSkillsOverride.push(null);
    unit.activeSkillsOverride[slot - 1] = skillId;
    // Источник правды для тира активов — unit.skills (см. getActiveSkillTier
    // в core/skills.js). Синхронизируем здесь же, чтобы тир «сел» сразу.
    if (!Array.isArray(unit.skills)) unit.skills = [];
    while (unit.skills.length < slot) unit.skills.push(null);
    unit.skills[slot - 1] = { id: skillId, tier };
  } else if (kind === 'passive') {
    if (!Array.isArray(unit.passiveSkillsOverride)) {
      const cls = CLASSES[unit.classId];
      unit.passiveSkillsOverride = ((cls && cls.passiveSkills) || []).slice();
    }
    while (unit.passiveSkillsOverride.length < slot) unit.passiveSkillsOverride.push(null);
    unit.passiveSkillsOverride[slot - 1] = skillId;
    if (!unit.passiveSkillTiersOverride) unit.passiveSkillTiersOverride = {};
    unit.passiveSkillTiersOverride[skillId] = tier;
  }
}

/* Очистить конкретный слот без сноса остальных override-ов. Запись о
   тире пассивки в passiveSkillTiersOverride сохраняется — это удобно
   для повторной выдачи того же sid (тир запомнился). */
function clearDevToolsSlot(unit, slot, kind) {
  if (!unit || !(slot >= 1 && slot <= DT_SLOT_COUNT)) return;
  if (kind === 'active') {
    if (Array.isArray(unit.activeSkillsOverride) && unit.activeSkillsOverride.length >= slot) {
      unit.activeSkillsOverride[slot - 1] = null;
    }
    if (Array.isArray(unit.skills) && unit.skills.length >= slot) {
      unit.skills[slot - 1] = null;
    }
  } else if (kind === 'passive') {
    if (Array.isArray(unit.passiveSkillsOverride) && unit.passiveSkillsOverride.length >= slot) {
      unit.passiveSkillsOverride[slot - 1] = null;
    }
  }
}

/* Полный сброс юнита к «как будто только что создан классом». Снимаем
   ВСЕ override-поля и пересобираем unit.skills из CLASSES[id].activeSkills
   и activeSkillTiers (как в makeUnit). HP/мана/эффекты/действия НЕ
   трогаются — для «реально свежего» проще дождаться startNextWave. */
function resetUnitToClass(unit) {
  if (!unit) return;
  delete unit.activeSkillsOverride;
  delete unit.passiveSkillsOverride;
  delete unit.passiveSkillTiersOverride;
  const cls = CLASSES[unit.classId];
  unit.skills = ((cls && cls.activeSkills) || []).map(id => ({
    id,
    tier: (cls && cls.activeSkillTiers && cls.activeSkillTiers[id]) || 'basic'
  }));
}

/* ================================================================
   === ВНУТРЕННИЕ ХЕЛПЕРЫ =========================================
   ================================================================ */

/* Прочитать «что сейчас в слоте». Возвращает { sid, tier } или null.
   Источник для актива — unit.activeSkillsOverride (если есть) ∩ unit.skills
   для тира; иначе fallback на CLASSES[id].activeSkills + activeSkillTiers.
   Источник для пассивки — passiveSkillsOf(unit) + getPassiveSkillTier. */
function readSlot(unit, slot, kind) {
  if (!unit) return null;
  const idx = slot - 1;
  if (kind === 'active') {
    let sid = null;
    if (Array.isArray(unit.activeSkillsOverride)) {
      sid = unit.activeSkillsOverride[idx] || null;
    } else {
      const cls = CLASSES[unit.classId];
      const list = (cls && cls.activeSkills) || [];
      sid = list[idx] || null;
    }
    if (!sid) return null;
    let tier = 'basic';
    if (Array.isArray(unit.skills) && unit.skills[idx] && unit.skills[idx].id === sid) {
      tier = unit.skills[idx].tier || 'basic';
    } else if (typeof getActiveSkillTier === 'function') {
      tier = getActiveSkillTier(unit, sid);
    }
    return { sid, tier };
  }
  if (kind === 'passive') {
    let sids;
    if (typeof passiveSkillsOf === 'function') {
      sids = passiveSkillsOf(unit);
    } else if (Array.isArray(unit.passiveSkillsOverride)) {
      sids = unit.passiveSkillsOverride;
    } else {
      const cls = CLASSES[unit.classId];
      sids = (cls && cls.passiveSkills) || [];
    }
    const sid = sids[idx] || null;
    if (!sid) return null;
    const tier = (typeof getPassiveSkillTier === 'function')
      ? getPassiveSkillTier(unit, sid)
      : 'basic';
    return { sid, tier };
  }
  return null;
}

/* Простейший экранировщик для вставки в innerHTML — имена классов и
   навыков теоретически могут содержать «<», хотя сейчас не содержат.
   Пишем сразу, чтобы не вспоминать про XSS-в-DevTools-в-проде, если
   когда-нибудь модуль перестанет вырезаться сборкой. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
