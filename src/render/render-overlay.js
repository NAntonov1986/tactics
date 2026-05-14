/* render-overlay.js (render/) — подсветка валидных клеток и превью
   маршрута/AoE для активных режимов прицеливания.

   Что внутри:
     • `renderOverlay()` — главный рендер overlay-слоя. Полностью
       перестраивает `#overlayLayer` под текущий `state.mode`:
       - `'move'`: подсвечивает все клетки `computeReachableCells(u)`
         как `.highlight-cell.move`. У каждой mouseenter/mouseleave
         управляют `PreviewState.movePath`, click — `executeMove`.
         После цикла дёргает `renderMovePathPreview` (если курсор уже
         стоял на клетке до перерендера, путь рисуется сразу).
       - `'attack'`: сначала мягкая зона досягаемости
         (`computeAttackArea` → `.highlight-cell.area-attack`,
         pointer-events: none — клики проходят насквозь), затем поверх
         яркие клетки врагов (`computeAttackTargets` →
         `.highlight-cell.attack`, click → `executeAttack`).
       - `'fireball'`: клетки прицела (`computeFireballRange`) с
         mouseenter/leave → `PreviewState.fireball` + ререндер превью,
         click → `executeFireball`. После цикла —
         `renderFireballPreview`.
       Если `state.mode === null` или активный юнит ≠ выбранному —
       overlay просто чистится (return).
     • `renderMovePathPreview()` — тонкий ререндер только маркеров пути.
       Чистит `.move-path-marker` и (если режим `move` и есть
       `PreviewState.movePath`) рисует стрелки направления для
       промежуточных клеток + точку для финальной. Старт-клетка не
       маркируется (там стоит юнит). Путь — через `computeMovePath`,
       тот же, что у `executeMove` — превью гарантированно совпадает
       с реальным маршрутом.
     • `renderFireballPreview()` — тонкий ререндер только AoE-превью.
       Чистит `.fireball-aoe`/`.fireball-center` и (если режим
       `fireball` и есть `PreviewState.fireball`) рисует 3×3
       (`computeFireballAoe`) с особым классом для центра.

   Зачем отдельные ре-рендеры маршрута и AoE? Чтобы при перемещении
   мыши над зоной не дёргать весь overlayLayer (который содержит
   десятки клеток-кликабельных элементов с обработчиками). Путь и AoE —
   тонкая прослойка поверх основной подсветки, обновляется без
   пересоздания базовых клеток.

   Что НЕ внутри:
     • Сами действия (`executeMove`/`executeAttack`/`executeFireball`) —
       `core/movement.js` (R13) / `core/combat.js` (R14).
     • Подсчёты `computeReachableCells`/`computeMovePath` — `core/movement.js`.
     • Подсчёты `computeAttackTargets`/`computeAttackArea`/
       `computeFireballRange`/`computeFireballAoe` — `core/combat.js`.
     • Состояние режима (`state.mode`, `PreviewState.fireball`,
       `PreviewState.movePath`) — пока в монолите, переедет в
       `ui/input.js` (R18). Render-overlay обращается к ним через
       script-scope.
     • Спецэффекты на effects-layer (вспышка фаербола после каста) —
       `render/render-effects.js` (`playFireballBlast`).

   Где править:
     • Добавить новый режим прицеливания (например, telegraph «удар
       молнии» по линии): добавить ветку в `renderOverlay` + при
       необходимости свою тонкую `renderXxxPreview`.
     • Изменить вид маркеров пути (например, заменить стрелки на
       полупрозрачные шеврон-спрайты) — `renderMovePathPreview`.
     • Подсветка пирамидки фаербола вокруг центра — `renderFireballPreview`.

   Внешние имена через script-scope (резолв при вызове):
   `state` (core/state); `getActiveUnit` (core/turn);
   `computeReachableCells`, `computeMovePath`, `executeMove`
   (core/movement); `computeAttackArea`, `computeAttackTargets`,
   `executeAttack`, `computeFireballRange`, `computeFireballAoe`,
   `executeFireball` (core/combat); `PreviewState.fireball`,
   `PreviewState.movePath` (монолит — переедут в R18). */

/* Overlay-слой: подсветка валидных клеток в режимах move/attack.
   Для attack подсвечиваем и клетки врагов в радиусе, и сами цели.
   Рендер без анимации — включается/выключается по смене state.mode. */
/* С24-рефактор: общий helper для паттерна mouseenter/leave с превью.
   Раньше повторялся в 4 местах (move/charge/fireball/lightning).

   Привязывает к элементу `el` пару mouseenter/mouseleave, которая
   синхронизирует PreviewState[key] с клеткой (row, col):
     - mouseenter → PreviewState[key] = { row, col }; renderFn();
     - mouseleave → если PreviewState[key] всё ещё «про эту» клетку,
       то PreviewState[key] = null; renderFn().

   Тонкость с mouseleave: при быстром переходе курсора между соседними
   подсветками сначала срабатывает mouseenter новой клетки (PreviewState
   уже указывает туда), и затем mouseleave старой — он не должен
   обнулять чужое значение. Поэтому проверка row/col на совпадение.

   Параметры:
     el        — DOM-элемент-подсветка.
     row, col  — координаты клетки (для записи и для leave-проверки).
     key       — ключ в PreviewState ('movePath' | 'fireball' | 'lightning').
                 Объект объявлен в src/ui/input.js.
     renderFn  — тонкий ререндер превью (renderMovePathPreview / etc.). */
function bindPreviewTarget(el, row, col, key, renderFn) {
  el.addEventListener('mouseenter', () => {
    PreviewState[key] = { row, col };
    renderFn();
  });
  el.addEventListener('mouseleave', () => {
    const cur = PreviewState[key];
    if (cur && cur.row === row && cur.col === col) {
      PreviewState[key] = null;
      renderFn();
    }
  });
}

function renderOverlay() {
  const layer = document.getElementById('overlayLayer');
  layer.innerHTML = '';
  if (!state.mode) return;
  const u = getActiveUnit();
  if (!u) return;
  // Режимы доступны только если выбран тот же юнит, что и ходит.
  if (state.selectedUnitId !== u.id) return;

  if (state.mode === 'move') {
    const cells = computeReachableCells(u);
    for (const { row, col } of cells) {
      const el = document.createElement('div');
      el.className = 'highlight-cell move';
      el.style.setProperty('--r', row);
      el.style.setProperty('--c', col);
      // Hover показывает превью пути «через какие клетки реально пройдёт».
      // Зеркалит логику фаербола: запоминаем клетку под курсором и
      // дёргаем тонкий ререндер — без перетряски всего overlayLayer.
      // Конкретный путь строит computeMovePath (тот же, что executeMove),
      // так что превью гарантированно совпадает с тем, как юнит пойдёт.
      // С24: единый helper bindPreviewTarget — закрывает копипасту mouseenter/leave.
      bindPreviewTarget(el, row, col, 'movePath', renderMovePathPreview);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        executeMove(row, col);
      });
      layer.appendChild(el);
    }
    // Если курсор уже стоял на клетке до перерендера overlay — дорисуем
    // путь сразу, не дожидаясь следующего mouseenter.
    renderMovePathPreview();
  } else if (state.mode === 'attack') {
    // Сначала мягкая подсветка ВСЕЙ зоны досягаемости (воину — соседние
    // клетки, лучнику — большой диамант, магу — средний). Сам клетку
    // юнита не включаем, клетки вне поля — тоже.
    const area = computeAttackArea(u);
    for (const { row, col } of area) {
      const el = document.createElement('div');
      el.className = 'highlight-cell area-attack';
      el.style.setProperty('--r', row);
      el.style.setProperty('--c', col);
      // Без click-обработчика — pointer-events: none в CSS, клики проходят
      // насквозь (к целям сверху или к фону — отмена режима).
      layer.appendChild(el);
    }
    // Поверх — яркая подсветка конкретных врагов в радиусе (кликается).
    const targets = computeAttackTargets(u);
    for (const t of targets) {
      const el = document.createElement('div');
      el.className = 'highlight-cell attack';
      el.style.setProperty('--r', t.row);
      el.style.setProperty('--c', t.col);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        executeAttack(t.id);
      });
      layer.appendChild(el);
    }
  } else if (state.mode === 'fireball') {
    // Все клетки, куда маг может прицелиться (манхэттен ≤ range).
    // Они кликабельны, при наведении показываем превью AoE 3×3.
    const cells = computeFireballRange(u);
    for (const { row, col } of cells) {
      const el = document.createElement('div');
      el.className = 'highlight-cell fireball-range';
      el.style.setProperty('--r', row);
      el.style.setProperty('--c', col);
      bindPreviewTarget(el, row, col, 'fireball', renderFireballPreview);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        executeFireball(row, col);
      });
      layer.appendChild(el);
    }
    // Если есть актуальный центр превью — дорисовываем AoE сразу.
    renderFireballPreview();
  } else if (state.mode === 'lightning') {
    // Сессия 10: режим прицеливания Молнии. Прицел — одна из 4 СМЕЖНЫХ
    // к магу клеток (вверх/вниз/влево/вправо), без выхода за границы.
    // На каждой anchor — mouseenter→PreviewState.lightning + ререндер
    // линии (renderLightningPreview, тонкая прослойка как у фаербола).
    // Click → executeLightning(row, col).
    const anchors = computeLightningAnchors(u);
    for (const a of anchors) {
      const el = document.createElement('div');
      el.className = 'highlight-cell lightning-anchor';
      el.style.setProperty('--r', a.row);
      el.style.setProperty('--c', a.col);
      bindPreviewTarget(el, a.row, a.col, 'lightning', renderLightningPreview);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        executeLightning(a.row, a.col);
      });
      layer.appendChild(el);
    }
    // Если курсор уже стоял на anchor — дорисуем линию сразу.
    renderLightningPreview();
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'self_aoe') {
    // Camp v1.5-priest-C (11.05.2026): AoE вокруг кастера. Подсвечиваем
    // манхэттенский радиус params.range. Все клетки кликабельны — клик
    // на любой подтверждает каст (целью executor'у передаётся u.id,
    // он сам найдёт цели в радиусе). Это симметрично self_buff/range=0:
    // фактически targetId не важен, важен сам факт «применить».
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = (params.range | 0) || 1;
    for (let dr = -range; dr <= range; dr++) {
      const maxDc = range - Math.abs(dr);
      for (let dc = -maxDc; dc <= maxDc; dc++) {
        const r = u.row + dr, c = u.col + dc;
        if (!inBounds(r, c)) continue;
        const el = document.createElement('div');
        el.className = 'highlight-cell self-aoe';
        el.style.setProperty('--r', r);
        el.style.setProperty('--c', c);
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          dispatchActiveSkill(getActiveUnit(), u.id, skillId);
        });
        layer.appendChild(el);
      }
    }
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'self_buff') {
    // Сессия 14+ (общая ветка для всех self_buff-скиллов): цель —
    // сам маг (его клетка) или СОЮЗНИК в манхэттене ≤range. Подсветка
    // — янтарная (.buff-target). Range берётся из getUnitSkillParams
    // с учётом ТИРА слота (см. шапку core/skills.js про slot-aware tier).
    // Огненный щит: range=1 (сам + смежные союзники). Концентрация
    // маны (Сессия 15): range=0 (только сам маг — фильтр dist<=0
    // оставит ровно одну клетку). Click → dispatchActiveSkill →
    // соответствующий executor (см. core/combat.js).
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = (typeof params.range === 'number') ? params.range : 0;
    // Camp v1.5-priest-B (10.05.2026): tier-зависимый allowSelf — для
    // holy_shield basic/advanced нельзя на себя, elite — можно. Существующие
    // self_buff'ы (mana_focus/fire_shield) не задают allowSelf — defaults true.
    const allowSelf = (typeof params.allowSelf === 'boolean') ? params.allowSelf : true;
    const targets = state.units.filter(t =>
      t.alive && t.team === u.team &&
      Math.abs(t.row - u.row) + Math.abs(t.col - u.col) <= range &&
      (allowSelf || t.id !== u.id)
    );
    for (const t of targets) {
      const el = document.createElement('div');
      el.className = 'highlight-cell buff-target';
      el.style.setProperty('--r', t.row);
      el.style.setProperty('--c', t.col);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchActiveSkill(getActiveUnit(), t.id, skillId);
      });
      layer.appendChild(el);
    }
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'grave_target') {
    // Camp v1.5-priest-B (10.05.2026): таргетинг на НАДГРОБИЯ союзных
    // героев в манхэттене ≤range. Используется только воскрешением
    // (resurrection). Подсветка — общая для buff'ов (.buff-target),
    // чтобы зрительно отличалась от ranged-атак (красная). Click →
    // dispatchActiveSkill → executeResurrection.
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = (typeof params.range === 'number') ? params.range : 1;
    const targets = state.units.filter(t => {
      if (t.alive) return false;                         // только мёртвые
      if (t.team !== u.team) return false;               // только союзники
      const tcls = CLASSES[t.classId];
      if (!tcls || tcls.kind !== 'hero') return false;   // только герои
      const md = Math.abs(t.row - u.row) + Math.abs(t.col - u.col);
      return md <= range;
    });
    for (const t of targets) {
      const el = document.createElement('div');
      el.className = 'highlight-cell buff-target';
      el.style.setProperty('--r', t.row);
      el.style.setProperty('--c', t.col);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchActiveSkill(getActiveUnit(), t.id, skillId);
      });
      layer.appendChild(el);
    }
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'cleanse') {
    // Сессия 15: режим прицеливания Очищения. Цель — ЛЮБОЙ живой
    // юнит в манхэттене ≤range (включая мага, союзников и ВРАГОВ).
    // НЕ фильтруем по team — это намеренно: с врага можно сбросить
    // баффы, с союзника дебаффы (см. data/skills.js → purify).
    // Подсветка бирюзовая (.cleanse-target), отличается от ranged-
    // атак (красная) и self-buff (янтарная). Click → dispatchActiveSkill
    // → executeCleanse.
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = (typeof params.range === 'number') ? params.range : 0;
    const targets = state.units.filter(t =>
      t.alive &&
      Math.abs(t.row - u.row) + Math.abs(t.col - u.col) <= range
    );
    for (const t of targets) {
      const el = document.createElement('div');
      el.className = 'highlight-cell cleanse-target';
      el.style.setProperty('--r', t.row);
      el.style.setProperty('--c', t.col);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchActiveSkill(getActiveUnit(), t.id, skillId);
      });
      layer.appendChild(el);
    }
  } else if (state.mode === 'charge' || (SKILLS[state.mode] && SKILLS[state.mode].delivery === 'leap')) {
    // С18: режим прицеливания «Рывок» воина. Подсветка пустых клеток
    // в радиусе chargeRange(u). Click → executeCharge(row, col). На
    // hover — превью L-маршрута стрелками (как у обычного движения),
    // через тот же PreviewState.movePath + renderMovePathPreview
    // (расширена ниже для mode==='charge').
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const range = (typeof chargeRange === 'function') ? chargeRange(u, slotIdx) : 0;
    if (range > 0) {
      for (let dr = -range; dr <= range; dr++) {
        const maxDc = range - Math.abs(dr);
        for (let dc = -maxDc; dc <= maxDc; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = u.row + dr, c = u.col + dc;
          if (!inBounds(r, c)) continue;
          if (unitAt(r, c)) continue;
          if (graveAt(r, c)) continue;
          if (treeAt(r, c)) continue;
          const el = document.createElement('div');
          el.className = 'highlight-cell leap-target';
          el.style.setProperty('--r', r);
          el.style.setProperty('--c', c);
          bindPreviewTarget(el, r, c, 'movePath', renderMovePathPreview);
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            executeCharge(r, c);
          });
          layer.appendChild(el);
        }
      }
    }
    // Если курсор уже стоял на клетке до перерендера — дорисуем маршрут.
    renderMovePathPreview();
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'self_aura') {
    // С20: режим прицеливания «Провокация». AoE-аура — манхэттенский
    // радиус params.range вокруг кастера. Подсветка ВСЕХ клеток в
    // радиусе (без выбора эпицентра); любой клик кастует. Палитра —
    // ярко-красная (.self-aura-target), отличается от whirlwind
    // (3×3 chebyshev) и от обычной атаки.
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = (params.range | 0) || 0;
    if (range > 0) {
      for (let dr = -range; dr <= range; dr++) {
        const maxDc = range - Math.abs(dr);
        for (let dc = -maxDc; dc <= maxDc; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = u.row + dr, c = u.col + dc;
          if (!inBounds(r, c)) continue;
          const el = document.createElement('div');
          el.className = 'highlight-cell self-aura-target';
          el.style.setProperty('--r', r);
          el.style.setProperty('--c', c);
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            dispatchActiveSkill(getActiveUnit(), null, skillId);
          });
          layer.appendChild(el);
        }
      }
    }
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'cover') {
    // С20: режим прицеливания «Прикрыть». Подсветка ЮНИТОВ в радиусе:
    // basic/advanced — только союзники, elite (allowEnemies:true) —
    // любой живой юнит. Click → dispatchActiveSkill → executeCover (свап).
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = (params.range | 0) || 0;
    const targets = state.units.filter(t =>
      t.alive && t.id !== u.id &&
      (params.allowEnemies || t.team === u.team) &&
      Math.abs(t.row - u.row) + Math.abs(t.col - u.col) <= range
    );
    for (const t of targets) {
      const el = document.createElement('div');
      el.className = 'highlight-cell cover-target';
      el.style.setProperty('--r', t.row);
      el.style.setProperty('--c', t.col);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchActiveSkill(getActiveUnit(), t.id, skillId);
      });
      layer.appendChild(el);
    }
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'self_aoe') {
    // С18: режим прицеливания AoE «себе под ноги» (Круговой удар воина).
    // Подсвечивает 8 СМЕЖНЫХ клеток вокруг кастера (3×3 минус центр).
    // Любой клик кастует — нет выбора эпицентра, центр всегда воин.
    // Подсветка ярко-красная (пилообразная) — отличается и от обычной
    // атаки (точечная подсветка цели) и от leap (пустые клетки).
    const skillId = state.mode;
    const offsets = [
      [-1,-1],[-1, 0],[-1, 1],
      [ 0,-1],        [ 0, 1],
      [ 1,-1],[ 1, 0],[ 1, 1]
    ];
    for (const [dr, dc] of offsets) {
      const r = u.row + dr, c = u.col + dc;
      if (!inBounds(r, c)) continue;
      const el = document.createElement('div');
      el.className = 'highlight-cell whirlwind-target';
      el.style.setProperty('--r', r);
      el.style.setProperty('--c', c);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        dispatchActiveSkill(getActiveUnit(), null, skillId);
      });
      layer.appendChild(el);
    }
  } else if (state.mode === 'teleport') {
    // Сессия 13: режим прицеливания Телепорта. Подсветка — все ВАЛИДНЫЕ
    // пустые клетки в манхэттене ≤ range (range из tier-параметров).
    // Дистанция считается без учёта блокеров (можно телепортнуться
    // «сквозь» юнитов/надгробия). Целевая клетка должна быть свободной
    // — пропускаем те, на которых стоит живой юнит или надгробие
    // (через unitAt/graveAt). Клетка самого мага исключается.
    // Click → executeTeleport(row, col). Превью пути не делаем —
    // телепорт «мгновенный», подсветка валидной зоны самодостаточна.
    // slotIdx — чтобы tier-зависимый range брался ИЗ СЛОТА, по которому
    // игрок кликнул (см. шапку getUnitSkillParams в core/skills.js про
    // slot-aware tier; без этого все слоты теплепорта подсвечивают
    // дистанцию ПЕРВОГО найденного entry в unit.skills).
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, 'teleport', slotIdx);
    const range = (params.range | 0) || 0;
    if (range > 0) {
      for (let dr = -range; dr <= range; dr++) {
        const maxDc = range - Math.abs(dr);
        for (let dc = -maxDc; dc <= maxDc; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = u.row + dr, c = u.col + dc;
          if (!inBounds(r, c)) continue;
          if (unitAt(r, c)) continue;
          if (graveAt(r, c)) continue;
          const el = document.createElement('div');
          el.className = 'highlight-cell teleport-target';
          el.style.setProperty('--r', r);
          el.style.setProperty('--c', c);
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            executeTeleport(r, c);
          });
          layer.appendChild(el);
        }
      }
    }
  } else if (SKILLS[state.mode] && SKILLS[state.mode].delivery === 'place_object') {
    // С22: режим размещения объекта (trap, lure). Подсветка — все
    // ВАЛИДНЫЕ клетки в манхэттене ≤ params.range. Валидная = пустая
    // (нет живого юнита, нет надгробия, нет другого объекта). Клетка
    // под самим лучником — валидна (range = 1+ всегда; даже при range=0
    // в ноль не упирается, потому что у С22-навыков минимальный range=1).
    // Click → executeTrap/executeLure через диспатч по state.mode.
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = (params.range | 0) || 0;
    for (let dr = -range; dr <= range; dr++) {
      const maxDc = range - Math.abs(dr);
      for (let dc = -maxDc; dc <= maxDc; dc++) {
        if (dr === 0 && dc === 0) continue;  // под собой нельзя (правило 05.05.2026)
        const r = u.row + dr, c = u.col + dc;
        if (!inBounds(r, c)) continue;
        if (unitAt(r, c)) continue;
        if (graveAt(r, c)) continue;
        if (objectAt(r, c)) continue;
        if (treeAt(r, c)) continue;  // 09.05.2026: дерево — непроходимый блокер, под него ставить нельзя.
        const el = document.createElement('div');
        el.className = 'highlight-cell place-target';
        el.style.setProperty('--r', r);
        el.style.setProperty('--c', c);
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          // Диспатч по skillId — каждый place_object скилл имеет свой executor.
          if (skillId === 'trap') executeTrap(r, c);
          else if (skillId === 'lure') executeLure(r, c);
        });
        layer.appendChild(el);
      }
    }
  } else if (SKILLS[state.mode] && SKILLS[state.mode].kind === 'active' && SKILLS[state.mode].delivery === 'ranged') {
    // Универсальный single-target ranged скилл (Сессия 9: ice_arrow,
    // magic_arrow; Сессии 11/12 — Цепная молния, Призматическая сфера).
    // Подсветка зеркалит режим 'attack': мягкая зона досягаемости (диамант
    // манхэттенского радиуса, pointer-events: none) + поверх — яркие
    // подсветки живых вражеских юнитов в радиусе, не иммунных к damageType
    // (computeRangedTargets фильтрует; для скиллов со strikes-массивом —
    // иммунен ко ВСЕМ типам). Иммунные цели не появляются в подсветке
    // вообще — клик через них невозможен.
    // Условие сужено до `delivery === 'ranged'` (Сессия 13): другие не-AoE
    // delivery (например, 'teleport') обрабатываются собственными ветками
    // выше, с собственным форматом цели (клетка, а не юнит).
    // slotIdx — для tier-зависимого range (заделано на будущие скиллы;
    // сейчас у всех ranged-актив range одинаков на всех тирах, но без
    // этого новый скилл с tier-зависимым range подсветится не той зоной).
    const skillId = state.mode;
    const slotIdx = (typeof state.modeSlotIdx === 'number') ? state.modeSlotIdx : undefined;
    const params = getUnitSkillParams(u, skillId, slotIdx);
    const range = params.range;
    const targets = computeRangedTargets(u, skillId);
    const targetSet = new Set(targets.map(t => `${t.row}:${t.col}`));
    // Мягкая подсветка зоны досягаемости (без клика). Клетки с целями
    // пропускаем — поверх будет яркая подсветка с обработчиком.
    for (let dr = -range; dr <= range; dr++) {
      const maxDc = range - Math.abs(dr);
      for (let dc = -maxDc; dc <= maxDc; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = u.row + dr, c = u.col + dc;
        if (!inBounds(r, c)) continue;
        if (targetSet.has(`${r}:${c}`)) continue;
        const el = document.createElement('div');
        el.className = 'highlight-cell area-attack';
        el.style.setProperty('--r', r);
        el.style.setProperty('--c', c);
        layer.appendChild(el);
      }
    }
    // Поверх — кликабельные подсветки конкретных целей.
    for (const t of targets) {
      const el = document.createElement('div');
      el.className = 'highlight-cell attack';
      el.style.setProperty('--r', t.row);
      el.style.setProperty('--c', t.col);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        // Через диспатчер: для chain_lightning (Сессия 11) сработает
        // executeChainLightning, для остальных single-target — общий
        // executeSingleTargetSkill. См. core/combat.js.
        dispatchActiveSkill(getActiveUnit(), t.id, skillId);
      });
      layer.appendChild(el);
    }
  }
}

/* Перерисовывает превью пути в режиме движения. На каждой
   промежуточной клетке пути ставим стрелку в направлении следующего
   шага, на финальной — точку «сюда придёт юнит». Стартовая клетка
   (та, где юнит стоит сейчас) не маркируется. Чистит свои метки
   независимо от остального overlay, чтобы не дёргать всю подсветку.

   Путь считается через тот же computeMovePath, что и executeMove,
   с тем же facing-предпочтением порядка соседей в BFS — превью
   гарантированно совпадает с реальным маршрутом, по которому юнит
   пойдёт. Это и есть точка, ради которой задел будет переиспользован
   при появлении наземных ловушек: подсвеченный маршрут — это ровно
   те клетки, которые «активируют» ловушки при проходе. */
function renderMovePathPreview() {
  const layer = document.getElementById('overlayLayer');
  if (!layer) return;
  layer.querySelectorAll('.move-path-marker').forEach(el => el.remove());
  // С18: переиспользуем превью пути для двух режимов:
  //   - 'move'   — обычное движение через computeMovePath (BFS, обходит блокеры)
  //   - 'charge' — Рывок воина через computeChargePath (L-путь, сквозь блокеры)
  // Маркеры — те же стрелки и точка-финиш, чтобы UX был единым.
  const isMove = (state.mode === 'move');
  const isCharge = (state.mode === 'charge');
  if (!isMove && !isCharge) return;
  if (!PreviewState.movePath) return;
  const u = getActiveUnit();
  if (!u) return;
  let path;
  if (isCharge) {
    path = (typeof computeChargePath === 'function')
      ? computeChargePath(u.row, u.col, PreviewState.movePath.row, PreviewState.movePath.col)
      : null;
  } else {
    path = computeMovePath(u, PreviewState.movePath.row, PreviewState.movePath.col);
  }
  // Длина < 2 = невалидная цель (BFS не построил путь) или цель = старт.
  // В обоих случаях рисовать нечего.
  if (!path || path.length < 2) return;
  // Маркеры рисуем для каждой клетки пути, КРОМЕ стартовой (там стоит
  // сам юнит). Промежуточные клетки получают стрелку «куда уйдёт отсюда»
  // (в сторону следующей клетки пути), финальная — нейтральную точку.
  for (let i = 1; i < path.length; i++) {
    const cur = path[i];
    const isEnd = (i === path.length - 1);
    let glyph;
    if (isEnd) {
      glyph = '●';
    } else {
      const next = path[i + 1];
      const dr = next.row - cur.row;
      const dc = next.col - cur.col;
      glyph = (dr === -1) ? '↑' : (dr === 1) ? '↓' : (dc === -1) ? '←' : '→';
    }
    const el = document.createElement('div');
    el.className = 'move-path-marker' + (isEnd ? ' end' : '');
    el.style.setProperty('--r', cur.row);
    el.style.setProperty('--c', cur.col);
    el.textContent = glyph;
    layer.appendChild(el);
  }
}

/* Перерисовывает только слой превью AoE фаербола. Чистит старые
   превью-клетки и, если задан PreviewState.fireball и мы всё ещё
   в режиме фаербола, рисует 3×3 поверх подсветки радиуса. */
/* Перерисовывает только слой превью линии Молнии. Чистит .lightning-line
   и (если режим 'lightning' и есть PreviewState.lightning) рисует клетки
   линии через computeLightningLine. Тонкий ререндер по аналогии с
   renderFireballPreview — не пересоздаёт базовые anchor-клетки. */
function renderLightningPreview() {
  const layer = document.getElementById('overlayLayer');
  if (!layer) return;
  layer.querySelectorAll('.lightning-line').forEach(el => el.remove());
  if (state.mode !== 'lightning') return;
  if (!PreviewState.lightning) return;
  const u = getActiveUnit();
  if (!u) return;
  const cells = computeLightningLine(u, PreviewState.lightning.row, PreviewState.lightning.col);
  for (const cell of cells) {
    const el = document.createElement('div');
    el.className = 'highlight-cell lightning-line';
    el.style.setProperty('--r', cell.row);
    el.style.setProperty('--c', cell.col);
    layer.appendChild(el);
  }
}

function renderFireballPreview() {
  const layer = document.getElementById('overlayLayer');
  if (!layer) return;
  layer.querySelectorAll('.fireball-aoe, .fireball-center').forEach(el => el.remove());
  if (state.mode !== 'fireball') return;
  if (!PreviewState.fireball) return;
  const { row, col } = PreviewState.fireball;
  const aoe = computeFireballAoe(row, col);
  for (const cell of aoe) {
    const el = document.createElement('div');
    el.className = 'highlight-cell ' + (cell.isCenter ? 'fireball-center' : 'fireball-aoe');
    el.style.setProperty('--r', cell.row);
    el.style.setProperty('--c', cell.col);
    layer.appendChild(el);
  }
}


/* ================================================================
   === AGGRO-ПРЕВЬЮ (Сессия aggro, 04.05.2026; расширено 06.05.2026)
   Подсветка зоны вокруг NPC при наведении на него мышью.
   Чисто read-only: не блокирует клики, не мешает обычной overlay-
   подсветке (их клетки рисуются с pointer-events: none).

   Два режима в зависимости от aggroState:
     • sleeping → Чебышевский aggroRadius («зона слежения, в которую
       нельзя заходить») — мягкая жёлто-оранжевая заливка;
     • active   → реальные достижимые клетки за один ход с текущей
       Скоростью (computeReachableCells, BFS с учётом деревьев и
       юнитов как блокеров) — красноватая заливка, чтобы игрок видел,
       докуда зомби может прыгнуть в следующий ход.

   Контракт:
     • showAggroPreview(unit) — выбирает режим по unit.aggroState.
       НЕ показываем, если идёт прицеливание (state.mode задан) —
       чтобы не путать игрока с боевыми подсветками.
     • hideAggroPreview([unit]) — убрать ВСЕ aggro-/move-preview клетки.
       Опциональный аргумент unit — для защиты от ложных снятий
       (если курсор уже ушёл на другой юнит, у того сработал
       enter раньше нашего leave).
     • При render() (renderOverlay) превью пропадает само — слой
       чистится. Это допустимо: если игрок продолжает наводить,
       при следующем mouseenter превью отрисуется заново.
   ================================================================ */
let _aggroPreviewUnitId = null;

function showAggroPreview(unit) {
  if (!unit || !unit.alive) return;
  if (unit.aggroState !== 'sleeping' && unit.aggroState !== 'active') return;
  // В режиме прицеливания (атака/фаербол/телепорт/и т.д.) — не
  // показываем, чтобы не накладываться на боевые подсветки. Игрок
  // в этот момент сосредоточен на каст-выборе.
  if (state.mode) return;
  const layer = document.getElementById('overlayLayer');
  if (!layer) return;
  // Сначала снимаем старое превью (если было от другого юнита).
  layer.querySelectorAll('.aggro-preview, .move-preview').forEach(el => el.remove());

  if (unit.aggroState === 'sleeping') {
    // ===== SLEEPING: Чебышевский aggroRadius =====
    const radius = unit.aggroRadius | 0;
    if (radius <= 0) return;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = unit.row + dr, c = unit.col + dc;
        if (typeof inBounds === 'function' && !inBounds(r, c)) continue;
        const cell = document.createElement('div');
        cell.className = 'highlight-cell aggro-preview';
        cell.style.setProperty('--r', r);
        cell.style.setProperty('--c', c);
        layer.appendChild(cell);
      }
    }
  } else {
    // ===== ACTIVE: реальная зона хода (BFS) =====
    // computeReachableCells учитывает блокеры (деревья + юниты) и
    // ортогональную сетку. Возвращает массив { row, col }, не включая
    // саму клетку юнита. Для подсветки этого достаточно.
    if (typeof computeReachableCells !== 'function') return;
    const cells = computeReachableCells(unit);
    for (const { row: r, col: c } of cells) {
      const cell = document.createElement('div');
      cell.className = 'highlight-cell move-preview';
      cell.style.setProperty('--r', r);
      cell.style.setProperty('--c', c);
      layer.appendChild(cell);
    }
  }
  _aggroPreviewUnitId = unit.id;
}

function hideAggroPreview(unit) {
  // Если передан конкретный юнит — снимаем превью только если оно
  // принадлежит ему. Защита от race condition: курсор быстро
  // перешёл с одного NPC на другого, mouseenter второго
  // отработал ДО mouseleave первого; без проверки мы бы снесли
  // только что нарисованное превью второго.
  if (unit && _aggroPreviewUnitId !== unit.id) return;
  const layer = document.getElementById('overlayLayer');
  if (!layer) return;
  layer.querySelectorAll('.aggro-preview, .move-preview').forEach(el => el.remove());
  _aggroPreviewUnitId = null;
}

/* ================================================================
   === Превью радиуса приманки (С07.05.2026 правка) ================
   По аналогии с aggro-preview у NPC: при наведении мыши на приманку
   подсвечиваем Манхэттен-зону её притяжения. AI считает «враг попал в
   зону» при `md ≤ payload.lureRadius` (см. findAttractingLure в
   core/ai.js). Подсветка лежит в overlayLayer (.lure-preview), так что
   пропадает автоматически при render(). Для защиты от race condition
   при быстром переходе мыши между приманками — _lurePreviewObjId.

   Не показываем во время режима прицеливания (state.mode не null) —
   как и aggro-превью, чтобы не накладываться на боевые подсветки. */
let _lurePreviewObjId = null;
function showLurePreview(obj) {
  if (!obj || obj.kind !== 'lure') return;
  if (state && state.mode) return;
  const layer = document.getElementById('overlayLayer');
  if (!layer) return;
  // Снимаем старое превью (если было от другой приманки).
  layer.querySelectorAll('.lure-preview').forEach(el => el.remove());
  const lr = (obj.payload && obj.payload.lureRadius | 0) || 0;
  if (lr <= 0) { _lurePreviewObjId = obj.id; return; }
  for (let dr = -lr; dr <= lr; dr++) {
    for (let dc = -lr; dc <= lr; dc++) {
      const md = Math.abs(dr) + Math.abs(dc);
      if (md === 0 || md > lr) continue;
      const r = obj.row + dr, c = obj.col + dc;
      if (typeof inBounds === 'function' && !inBounds(r, c)) continue;
      const cell = document.createElement('div');
      cell.className = 'highlight-cell lure-preview';
      cell.style.setProperty('--r', r);
      cell.style.setProperty('--c', c);
      layer.appendChild(cell);
    }
  }
  _lurePreviewObjId = obj.id;
}

function hideLurePreview(obj) {
  // Защита от race: если курсор быстро ушёл с одной приманки на другую,
  // mouseenter второй мог сработать до mouseleave первой; не сносим
  // только что нарисованное превью «не своей» приманки.
  if (obj && _lurePreviewObjId !== obj.id) return;
  const layer = document.getElementById('overlayLayer');
  if (!layer) return;
  layer.querySelectorAll('.lure-preview').forEach(el => el.remove());
  _lurePreviewObjId = null;
}
