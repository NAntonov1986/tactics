/* save.js (core/) — сохранение и загрузка прогресса в localStorage
   (Camp v1, 08.05.2026; Camp v1.5 backend, 09.05.2026).

   Что внутри:
     • SAVE_VERSION — текущая версия формата сейва. При изменении схемы —
       инкрементировать и добавить миграцию в _migrate.
     • saveToLocalStorage() — сериализует мета-поля state, кладёт в
       localStorage по соответствующему DEV/prod-ключу. Вызывается
       автоматически при enterCampMain (см. core/state.js).
     • loadFromLocalStorage() — читает по ключу, парсит, мигрирует к
       SAVE_VERSION (если нужно), возвращает snapshot или null если
       сейва нет / он битый / версия неизвестна.
     • applySaveSnapshot(snapshot) — переносит данные из snapshot в state.
       Вызывается на старте игры (см. init() в state.js) если есть сейв.
     • clearSave() — удаляет сейв из localStorage (для DevTools «Сбросить
       сейв» / «Новый забег»).
     • exportSaveJson() / importSaveJson(jsonStr) — текстовый импорт/
       экспорт сейва (для ручного бэкапа и переноса).

   Какие поля state считаются «мета» (сохраняются):
     • saveVersion (на самом сейве, не на state).
     • party (Camp v1.5: канонический список героев — было `units` в v1).
       Только живые (мёртвые отфильтрованы permadeath на endMissionCleanup).
     • partyInventory (Array<Item|null>).
     • wave (объект { number } — теперь cumulative счётчик миссий, не уровень).
     • regions (Camp v1.5: Array<{id, name, difficulty}>).
     • campScreen (текущий экран лагеря — чтобы при загрузке восстановиться
       туда же).
     • activeSkillTiersOverride / passiveSkillTiersOverride внутри героев —
       будут сериализованы автоматически в составе party.
     • restingTurnsLeft / participatedThisMission на каждом герое —
       автоматически в составе party.

   Какие поля НЕ сохраняются (восстанавливаются дефолтами):
     • grid (size — пересоздаётся в createInitialState).
     • trees, objects (re-spawn новой битвы).
     • turnIndex/initiativeOrder/round/mode/activeUnitId/gameOver — battle-only.
     • view (камера) — оставляем дефолтную.
     • log — battle-only, не критично.
     • activeLevelUp/levelUpQueue — UI-state.
     • inventoryOpen — UI-state.
     • currentMissionRegionId — battle-only (миссия завершилась, прежде
       чем сейв вообще создался — enterCampMain зовётся ПОСЛЕ
       endMissionCleanup, который очищает поле).

   Ключи в localStorage:
     • tactics.save.dev — для разработки (localhost / file://).
     • tactics.save.prod — для боевого окружения.
   Различие важно: разработчик-тестер не должен обнулять прогресс
   живого игрока случайным экспериментом, и наоборот.

   Ограничения сериализации:
     • JSON.stringify не справляется с циклическими ссылками — на
       юнитах их нет (id-string ссылки, не object refs).
     • Функции (apply / onTurnStart) не сериализуются — они не лежат
       на инстансах, только в SKILLS/AFFIXES реестрах.

   Файл подключается ОБЫЧНЫМ <script src="..."> в порядке core/* до
   core/state.js НЕ требуется — state.js резолвит saveToLocalStorage и
   applySaveSnapshot в момент вызова. По соглашению грузим ПОСЛЕ
   state.js, чтобы globals оттуда (state, CLASSES) уже существовали. */

/* SAVE_VERSION история:
   v1 (Camp v1, 08.05.2026): units[], partyInventory[], wave, campScreen.
   v2 (Camp v1.5, 09.05.2026): units → party; добавлены regions[],
     restingTurnsLeft, participatedThisMission на героях.
   v3 (Camp v1.5-calendar, 11.05.2026): добавлены state.calendar
     ({week, month, year}) и region.instability. Сложность регионов
     больше не меняется после каждой миссии — пересчёт в endOfMonthTick.
   v4 (Camp v2-economy, 13.05.2026): добавлены state.gold,
     state.recruitPool, state.nextRecruitNonce, state.debtMonths и
     hero.upkeepMultiplier на каждом герое. Стартовый капитал — из
     ECONOMY.START_CAPITAL для новых забегов; для legacy v3 — гранатовая
     заплатка ECONOMY.START_CAPITAL (одноразово на миграции, чтобы старые
     забеги не оказались в нуле и не сломали найм).
*/
const SAVE_VERSION = 4;

const SAVE_KEY_DEV  = 'tactics.save.dev';
const SAVE_KEY_PROD = 'tactics.save.prod';

/* Какой ключ использовать. Простое правило: если хост localhost,
   127.0.0.1 или пусто (file://) — это dev. Иначе prod. */
function _getSaveKey() {
  try {
    const host = (typeof location !== 'undefined' && location.hostname) || '';
    const isDev = (!host || host === 'localhost' || host === '127.0.0.1');
    return isDev ? SAVE_KEY_DEV : SAVE_KEY_PROD;
  } catch (e) {
    return SAVE_KEY_DEV;
  }
}

/* Собрать снимок мета-полей state. Вынесено в отдельную функцию,
   чтобы было ясно, что именно мы сохраняем (легче проверить, что не
   утекают функции/циклы). */
function _buildSaveSnapshot() {
  // Camp v1.5: party — канонический список. Только живые (мёртвых
  // должен был отфильтровать endMissionCleanup, но фильтруем ещё раз
  // на уровне сейва — defensive: вдруг сейв вызвался из странного места).
  const party = (state && Array.isArray(state.party))
    ? state.party.filter(u => u && u.alive && CLASSES[u.classId] && CLASSES[u.classId].kind !== 'monster')
    : [];
  return {
    saveVersion: SAVE_VERSION,
    timestamp: Date.now(),
    party,
    partyInventory: (state && Array.isArray(state.partyInventory)) ? state.partyInventory : [],
    wave: (state && state.wave) ? { number: state.wave.number | 0 } : { number: 0 },
    regions: (state && Array.isArray(state.regions))
      ? state.regions.map(r => ({
          id: r.id, name: r.name,
          difficulty: r.difficulty | 0,
          instability: (r.instability | 0),
          currentThreat: r.currentThreat || null,
          rewardOffer: (typeof r.rewardOffer === 'number') ? (r.rewardOffer | 0) : 0
        }))
      : [],
    calendar: (state && state.calendar) ? {
      week:  state.calendar.week  | 0,
      month: state.calendar.month | 0,
      year:  state.calendar.year  | 0
    } : { week: 1, month: 1, year: 1 },
    campScreen: (state && state.campScreen) || 'main',
    /* Camp v2-economy (13.05.2026). recruitPool сохраняется, чтобы при
       загрузке игрок видел тот же набор кандидатов, который был на момент
       сохранения (а не получал новый рандом). debtMonths — счётчик месяцев
       долга, нужен для UI и долговой системы. nextRecruitNonce —
       чтобы id кандидатов оставались уникальными при следующих рефрешах. */
    gold: (state && typeof state.gold === 'number') ? state.gold : 0,
    recruitPool: (state && Array.isArray(state.recruitPool)) ? state.recruitPool : [],
    nextRecruitNonce: (state && typeof state.nextRecruitNonce === 'number') ? state.nextRecruitNonce : 1,
    debtMonths: (state && typeof state.debtMonths === 'number') ? state.debtMonths : 0,
    // Camp v2-economy/shop (14.05.2026): ассортимент магазина — список
    // предметов. На загрузке восстанавливается as-is; cold-start в
    // enterCampMain заполнит, если поле пустое.
    shopInventory: (state && Array.isArray(state.shopInventory)) ? state.shopInventory : []
  };
}

/* Сохранить state в localStorage. Возвращает true/false. */
function saveToLocalStorage() {
  try {
    const snap = _buildSaveSnapshot();
    const json = JSON.stringify(snap);
    localStorage.setItem(_getSaveKey(), json);
    if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'saveToLocalStorage', { wave: snap.wave.number, heroes: snap.party.length, items: snap.partyInventory.filter(Boolean).length });
    return true;
  } catch (e) {
    console.warn('[save] saveToLocalStorage failed:', e);
    return false;
  }
}

/* Загрузить snapshot из localStorage. Возвращает объект snapshot или null. */
function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(_getSaveKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    return _migrate(data);
  } catch (e) {
    console.warn('[save] loadFromLocalStorage failed:', e);
    return null;
  }
}

/* Миграция старых версий до SAVE_VERSION. */
function _migrate(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.saveVersion !== 'number') return null;
  let cur = data;
  if (cur.saveVersion === 1 && SAVE_VERSION >= 2) cur = _migrateV1toV2(cur);
  if (cur.saveVersion === 2 && SAVE_VERSION >= 3) cur = _migrateV2toV3(cur);
  if (cur.saveVersion === 3 && SAVE_VERSION >= 4) cur = _migrateV3toV4(cur);
  if (cur.saveVersion !== SAVE_VERSION) {
    console.warn('[save] unknown saveVersion', cur.saveVersion, '— ignored');
    return null;
  }
  return cur;
}

/* Миграция v1 → v2 (Camp v1.5):
   • snapshot.units (1-3 героя) → snapshot.party. Партию ДОБИВАЕМ до 6
     свежими героями (level=0, без скиллов) с правильным распределением
     по классам (по 2 каждого: warrior/archer/mage). Если у игрока v1
     уже был герой класса X — досчитываем сколько его не хватает до 2
     и добавляем; в результате партия в v2 = старые герои + новые до 6.
     Свежие герои level=0 → init() после applySaveSnapshot запустит
     initial level-up queue ТОЛЬКО для них (так у новичков игрок выбирает
     стартовый скилл, а старые герои сохраняют свой прогресс).
   • snapshot.regions: создаём 5 регионов с difficulty=1 (свежие).
     Прогресс по регионам у v1-сейва не сохранялся — стартуем с дефолтов.
   • Каждому старому герою добавляем restingTurnsLeft=0 и
     participatedThisMission=false. */
function _migrateV1toV2(v1) {
  const v2 = Object.assign({}, v1);
  // Старые герои — копируем как есть, дополняя camp v1.5-полями.
  const oldHeroes = Array.isArray(v1.units) ? v1.units.slice() : [];
  for (const h of oldHeroes) {
    if (!h) continue;
    if (typeof h.restingTurnsLeft !== 'number') h.restingTurnsLeft = 0;
    if (typeof h.participatedThisMission !== 'boolean') h.participatedThisMission = false;
  }
  // Camp v1.5-priest (09.05.2026): партия 8 = 2 каждого класса
  // (warrior/archer/mage/priest), чтобы оба ротационных состава были
  // сбалансированы. Считаем существующих по classId, добавляем
  // недостающих свежими (level=0, без скиллов).
  const TARGET_PER_CLASS = { warrior: 2, archer: 2, mage: 2, priest: 2 };
  const haveByClass = {};
  for (const h of oldHeroes) {
    if (!h || !h.classId) continue;
    haveByClass[h.classId] = (haveByClass[h.classId] | 0) + 1;
  }
  const additions = [];
  for (const classId of Object.keys(TARGET_PER_CLASS)) {
    const need = TARGET_PER_CLASS[classId] - (haveByClass[classId] | 0);
    for (let i = 0; i < need; i++) {
      additions.push({ classId, team: 'B' });
    }
  }
  // Помечаем «нужно создать» — реальные инстансы создаются в applySaveSnapshot,
  // потому что только там доступна фабрика makeUnit и счётчики nextUnitId.
  v2._migrationAdditions = additions;
  v2.party = oldHeroes;
  delete v2.units;
  // Регионы — дефолтные 5×1 (прогресса в v1 не было).
  v2.regions = [
    { id: 'r1', name: 'Регион 1', difficulty: 1 },
    { id: 'r2', name: 'Регион 2', difficulty: 1 },
    { id: 'r3', name: 'Регион 3', difficulty: 1 },
    { id: 'r4', name: 'Регион 4', difficulty: 1 },
    { id: 'r5', name: 'Регион 5', difficulty: 1 }
  ];
  v2.saveVersion = 2;
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', '_migrateV1toV2', { oldHeroes: oldHeroes.length, additions: additions.length });
  return v2;
}

/* Миграция v2 → v3 (Camp v1.5-calendar): добавить state.calendar и
   region.instability. Существующие сейвы v2 не имели календаря —
   стартуем с {1, 1, 1}. Текущая сложность регионов сохраняется как
   есть (это то, что у игрока уже накопилось). Instability стартует с 1
   у всех — следующий месяц сразу применит +1 ко всем, что мягко
   введёт игрока в новую механику. */
function _migrateV2toV3(v2) {
  const v3 = Object.assign({}, v2);
  v3.calendar = { week: 1, month: 1, year: 1 };
  if (Array.isArray(v3.regions)) {
    v3.regions = v3.regions.map(r => Object.assign({}, r, {
      // Camp v1.5-calendar (11.05.2026, балансная правка): дефолт 0 (был 1).
      instability: (typeof r.instability === 'number') ? r.instability : 0
    }));
  }
  v3.saveVersion = 3;
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', '_migrateV2toV3', { regions: (v3.regions || []).length });
  return v3;
}

/* Миграция v3 → v4 (Camp v2-economy, 13.05.2026): добавить state.gold,
   state.recruitPool, state.nextRecruitNonce, state.debtMonths и
   hero.upkeepMultiplier на каждом сохранённом герое.
   • gold — дефолт ECONOMY.START_CAPITAL (1600 при дефолтных параметрах).
     Это «подарок» legacy-игроку, чтобы найм сразу работал.
   • recruitPool — пустой; cold-start refreshRecruitPool сгенерирует
     при первом enterCampMain после загрузки.
   • debtMonths — 0.
   • Каждому герою упрямо ставим upkeepMultiplier = 1.0 (legacy герои
     без рандомизации; новые с этого момента — через makeUnit). */
function _migrateV3toV4(v3) {
  const v4 = Object.assign({}, v3);
  const startCap = (typeof ECONOMY !== 'undefined') ? ECONOMY.START_CAPITAL : 1600;
  v4.gold = (typeof v4.gold === 'number') ? v4.gold : startCap;
  v4.recruitPool = Array.isArray(v4.recruitPool) ? v4.recruitPool : [];
  v4.nextRecruitNonce = (typeof v4.nextRecruitNonce === 'number') ? v4.nextRecruitNonce : 1;
  v4.debtMonths = (typeof v4.debtMonths === 'number') ? v4.debtMonths : 0;
  if (Array.isArray(v4.party)) {
    for (const h of v4.party) {
      if (!h || typeof h !== 'object') continue;
      if (typeof h.upkeepMultiplier !== 'number') h.upkeepMultiplier = 1.0;
    }
  }
  v4.saveVersion = 4;
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', '_migrateV3toV4', { gold: v4.gold });
  return v4;
}

/* Применить snapshot к state. Зовётся из init() ДО startNextWave —
   когда state уже создан createInitialState (с дефолтными полями), и
   перед стартом боя. Перезаписывает мета-поля; battle-only поля
   остаются дефолтными.

   Camp v1.5: snapshot.party (а не snapshot.units) — канонический список
   героев. state.units ставим в [] (поле боя пустое в лагере). */
function applySaveSnapshot(snapshot) {
  if (!state || !snapshot) return false;
  // Восстанавливаем героев из party. Если по какой-то причине snapshot
  // содержит legacy units (миграция не сработала) — fallback на units.
  const restoredParty = Array.isArray(snapshot.party)
    ? snapshot.party.slice()
    : (Array.isArray(snapshot.units) ? snapshot.units.slice() : []);
  state.party = restoredParty;
  state.units = []; // поле боя пустое в лагере; миссия начнётся через startMission.
  // Сдвинуть nextUnitId, чтобы новые юниты имели уникальные id.
  let maxN = 0;
  for (const u of state.party) {
    const m = (u && typeof u.id === 'string') ? u.id.match(/^u(\d+)$/) : null;
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  if (typeof nextUnitId !== 'undefined') {
    // nextUnitId — let-переменная в state.js. Перезаписываем «через
    // глобальную ссылку». Поскольку state.js использует
    // `nextUnitId++` напрямую, и переменная объявлена в script-scope,
    // её можно обновить из любого подключённого после файла.
    window.nextUnitId = Math.max((typeof nextUnitId === 'number') ? nextUnitId : 0, maxN + 1);
  }
  // Camp v1.5 (миграция v1→v2): если миграция оставила запрос на добавление
  // недостающих героев (snapshot._migrationAdditions) — создаём их через
  // makeUnit (теперь, когда nextUnitId сдвинут). Свежие герои level=0,
  // без скиллов; init() запустит initial level-up queue для них.
  if (Array.isArray(snapshot._migrationAdditions) && snapshot._migrationAdditions.length > 0) {
    const beforeAdd = state.party.length;
    for (const spec of snapshot._migrationAdditions) {
      if (typeof makeUnit !== 'function') break;
      const u = makeUnit({ classId: spec.classId, team: spec.team || 'B', row: -1, col: -1, level: 0 });
      u.activeSkillsOverride = [];
      u.passiveSkillsOverride = [];
      u.skills = [];
      u.restingTurnsLeft = 0;
      u.participatedThisMission = false;
      state.party.push(u);
    }
    if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'applySaveSnapshot: migration additions', { added: state.party.length - beforeAdd, total: state.party.length });
  }
  if (Array.isArray(snapshot.partyInventory)) {
    state.partyInventory = snapshot.partyInventory.slice();
  }
  if (snapshot.wave && typeof snapshot.wave.number === 'number') {
    state.wave = { number: snapshot.wave.number };
  }
  // Camp v1.5: восстанавливаем regions. Если в сейве их нет — оставляем
  // дефолты из createInitialState (state.regions уже там).
  // Camp v1.5-threats (09.05.2026): currentThreat сохраняется (id группы);
  // если в legacy-сейве отсутствует — рандомим, чтобы UI не показывал «—».
  // Camp v1.5-calendar (11.05.2026): instability — стартово 0 если поле
  // отсутствует (legacy v2). Балансная правка от 11.05.2026: было 1.
  if (Array.isArray(snapshot.regions) && snapshot.regions.length > 0) {
    state.regions = snapshot.regions.map(r => {
      let threat = r.currentThreat || null;
      if (!threat && typeof pickRandomThreatId === 'function') {
        threat = pickRandomThreatId();
      }
      // Camp v2-economy (13.05.2026): если в сейве нет rewardOffer
      // (legacy v3 или поле просто не сохранилось) — ролим прямо сейчас
      // по текущему difficulty региона.
      let offer = (typeof r.rewardOffer === 'number' && r.rewardOffer > 0) ? r.rewardOffer : 0;
      if (offer <= 0 && typeof rollRewardForDifficulty === 'function') {
        offer = rollRewardForDifficulty((r.difficulty | 0) || 1);
      }
      return {
        id: r.id,
        name: r.name || r.id,
        difficulty: (r.difficulty | 0) || 1,
        instability: (typeof r.instability === 'number') ? r.instability : 0,
        currentThreat: threat,
        rewardOffer: offer
      };
    });
  }
  // Camp v1.5-calendar: восстановление даты. Если в сейве её нет —
  // стартуем с {1, 1, 1} (legacy сейв перед v3).
  if (snapshot.calendar && typeof snapshot.calendar.week === 'number') {
    state.calendar = {
      week:  snapshot.calendar.week  | 0,
      month: snapshot.calendar.month | 0,
      year:  snapshot.calendar.year  | 0
    };
  } else {
    state.calendar = { week: 1, month: 1, year: 1 };
  }
  state.currentMissionRegionId = null; // в лагере точно null.
  if (snapshot.campScreen) {
    state.campScreen = snapshot.campScreen;
  } else {
    state.campScreen = 'main';
  }
  // Camp v2-economy (13.05.2026): экономические поля из снапшота.
  const startCap = (typeof ECONOMY !== 'undefined') ? ECONOMY.START_CAPITAL : 1600;
  state.gold = (typeof snapshot.gold === 'number') ? snapshot.gold : startCap;
  state.recruitPool = Array.isArray(snapshot.recruitPool) ? snapshot.recruitPool.slice() : [];
  state.nextRecruitNonce = (typeof snapshot.nextRecruitNonce === 'number') ? snapshot.nextRecruitNonce : 1;
  state.debtMonths = (typeof snapshot.debtMonths === 'number') ? snapshot.debtMonths : 0;
  // Camp v2-economy/shop (14.05.2026): ассортимент магазина.
  state.shopInventory = Array.isArray(snapshot.shopInventory) ? snapshot.shopInventory.slice() : [];
  if (typeof DebugLog !== 'undefined') DebugLog.log('wave', 'applySaveSnapshot', { wave: snapshot.wave && snapshot.wave.number, heroes: state.party.length, regions: state.regions.length, gold: state.gold });
  return true;
}

/* Удалить сейв из localStorage. */
function clearSave() {
  try {
    localStorage.removeItem(_getSaveKey());
    return true;
  } catch (e) {
    console.warn('[save] clearSave failed:', e);
    return false;
  }
}

/* Экспорт сейва как JSON-строку (для ручного бэкапа). Если сейва нет —
   создаём свежий снимок текущего state. */
function exportSaveJson() {
  const snap = _buildSaveSnapshot();
  return JSON.stringify(snap, null, 2);
}

/* Импорт сейва из JSON-строки. Заменяет текущий state.meta-поля.
   Возвращает true/false. */
function importSaveJson(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    const snap = _migrate(data);
    if (!snap) return false;
    if (!applySaveSnapshot(snap)) return false;
    saveToLocalStorage();  // сразу синхронизируем localStorage
    if (typeof render === 'function') render();
    return true;
  } catch (e) {
    console.warn('[save] importSaveJson failed:', e);
    return false;
  }
}

/* Есть ли сохранённая игра. */
function hasSave() {
  try {
    return !!localStorage.getItem(_getSaveKey());
  } catch (e) {
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.SAVE_VERSION = SAVE_VERSION;
  window.saveToLocalStorage = saveToLocalStorage;
  window.loadFromLocalStorage = loadFromLocalStorage;
  window.applySaveSnapshot = applySaveSnapshot;
  window.clearSave = clearSave;
  window.exportSaveJson = exportSaveJson;
  window.importSaveJson = importSaveJson;
  window.hasSave = hasSave;
}
