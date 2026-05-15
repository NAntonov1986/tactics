/* render-inventory.js (render/) — UI «Снаряжение отряда»
   (С1 — список, С8 08.05.2026 — grid-сетка + drag&drop).

   Что внутри:
     • renderInventoryOverlay() — рисует/прячет модальный оверлей.
       Контейнер #inventoryOverlay создаётся лениво.
     • toggleInventoryOverlay() — переключает state.inventoryOpen.
     • _bindLureHoverDelegation? — нет, это для приманок (отдельная история).
     • canHeroEquipItem(hero, item) — class-валидация (для weapon/armor;
       amulet/ring/consumable — без локов).
     • buildItemDetailLines(item, wearer?) — строки для tooltip
       (тир/стоимость/тип/формула/защита/аффиксы).
     • Drag&drop через HTML5 API: dragstart на предмете, dragover/drop
       на ячейках инвентаря и слотах героев. Визуальная подсветка
       drop-зон (зелёная — валидно, красная — несовместимо).
     • Click-to-equip как fallback убран; equip только через drag&drop.
       Снять предмет — drag из слота героя в инвентарь либо клик
       по «×» в углу слота.
     • Discard через drag в зону «Корзина» внизу инвентаря.

   Состояние:
     • state.inventoryOpen (bool) — показывать ли overlay.
     • state.partyInventory (Array<Item|null>) — фиксированный grid.
       Размер задаётся PARTY_INVENTORY_SIZE в core/state.js.
       Каждый предмет имеет ФИКСИРОВАННУЮ позицию (= индекс в массиве),
       сохраняемую между перерисовками.

   Контракт UI:
     • Overlay перекрывает поле боя (z-index 950). Клик мимо контента
       закрывает overlay. Esc — то же самое.
     • Drag-event-source: элемент `.inv-cell` или `.inv-slot-filled`
       с `draggable="true"`, dataTransfer хранит JSON с информацией
       о источнике (тип, индекс ячейки или героя+слот).
     • Drag-target: `.inv-cell` (любая ячейка инвентаря), `.inv-slot`
       (слот героя — с проверкой класс-локов на dragover для подсветки),
       `.inv-discard` (корзина).

   Внешние имена через script-scope:
   `state`, `getUnit`, `render`, `log`, `CLASSES`, `WEAPONS`, `ARMORS`,
   `RINGS`, `AMULETS`, `CONSUMABLES`, `getUnitWeapon`, `getUnitArmor`,
   `getUnitAmulet`, `getUnitRing`, `getUnitConsumable`,
   `addToInventory`, `removeFromInventory`, `swapInventoryCells`,
   `findInventoryCellOf`, `itemFullName`, `itemAffixes`, `itemTotalCost`. */

(function () {
  let _overlayEl = null;

  function ensureOverlay() {
    if (_overlayEl && document.body.contains(_overlayEl)) return _overlayEl;
    const el = document.createElement('div');
    el.id = 'inventoryOverlay';
    el.className = 'inventory-overlay';
    el.style.display = 'none';
    document.body.appendChild(el);
    el.addEventListener('click', onOverlayClick);
    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragend',   onDragEnd);
    el.addEventListener('dragover',  onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop',      onDrop);
    _overlayEl = el;
    return el;
  }

  function onOverlayClick(e) {
    // Клик по фону overlay'а — закрытие.
    if (e.target === _overlayEl) {
      closeOverlay();
      return;
    }
    const btn = e.target.closest('[data-inv-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-inv-action');
    if (action === 'close') {
      closeOverlay();
      return;
    }
    if (action === 'unequip-x') {
      // Кнопка «×» в углу слота героя — снять в инвентарь.
      const heroId  = btn.getAttribute('data-hero-id');
      const slotKey = btn.getAttribute('data-slot');
      unequipFromHeroToInventory(heroId, slotKey);
      renderInventoryOverlay();
      return;
    }
  }

  /* ================================================================
     === Drag & drop ================================================
     ================================================================
     Источник перетаскивания упаковывается в JSON на dataTransfer.
     Поддерживаемые источники:
       { from: 'inventory', cellIndex: N }
       { from: 'hero', heroId: 'u1', slot: 'weapon' }

     Цели:
       .inv-cell[data-cell-index="N"] — ячейка инвентаря.
       .inv-slot[data-hero-id="..."][data-slot="..."] — слот героя.
       .inv-discard — корзина.

     Все цели сначала валидируют возможность дропа на dragover
     (preventDefault — даёт «можно дроп», без — нельзя). Подсветка
     добавляется через class .drop-ok / .drop-bad. */

  let _dragSource = null;  // объект {from, cellIndex} или {from, heroId, slot}

  function onDragStart(e) {
    const cell = e.target.closest('.inv-cell-filled');
    const slot = e.target.closest('.inv-slot-filled');
    let src = null;
    if (cell) {
      const idx = parseInt(cell.dataset.cellIndex, 10);
      if (Number.isFinite(idx)) src = { from: 'inventory', cellIndex: idx };
    } else if (slot) {
      const heroId = slot.dataset.heroId;
      const slotKey = slot.dataset.slot;
      if (heroId && slotKey) {
        // Базовое (id-string) defaultWeapon снять нельзя — отказываем.
        const hero = (typeof getUnit === 'function') ? getUnit(heroId) : null;
        if (hero && hero.equipment && typeof hero.equipment[slotKey] !== 'string') {
          src = { from: 'hero', heroId, slot: slotKey };
        }
      }
    }
    if (!src) {
      e.preventDefault();
      return;
    }
    _dragSource = src;
    try {
      e.dataTransfer.setData('text/plain', JSON.stringify(src));
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) {
      // Some browsers throw on dataTransfer access — игнорируем.
    }
    // Полупрозрачность источника (через CSS-класс).
    if (cell) cell.classList.add('inv-dragging');
    if (slot) slot.classList.add('inv-dragging');
    // Camp v1.5 (09.05.2026): pre-highlight всех валидных hero-слотов
    // зелёным сразу после старта drag — игрок видит, куда МОЖНО положить
    // предмет, не двигая мышь по очереди над каждым слотом. Использует
    // ту же _canDropOn, что валидирует реальный drop.
    _prehighlightHeroSlots();
  }

  function _prehighlightHeroSlots() {
    if (!_overlayEl || !_dragSource) return;
    const slots = _overlayEl.querySelectorAll('.inv-slot[data-hero-id][data-slot]');
    slots.forEach(slot => {
      const target = {
        type: 'hero',
        heroId: slot.dataset.heroId,
        slot: slot.dataset.slot,
        el: slot
      };
      if (_canDropOn(target)) slot.classList.add('drop-ok');
    });
  }

  function onDragEnd(e) {
    _dragSource = null;
    // Снимаем класс drag/highlight со всех целей.
    if (_overlayEl) {
      _overlayEl.querySelectorAll('.inv-dragging').forEach(el => el.classList.remove('inv-dragging'));
      _overlayEl.querySelectorAll('.drop-ok, .drop-bad').forEach(el => {
        el.classList.remove('drop-ok');
        el.classList.remove('drop-bad');
      });
    }
  }

  function onDragOver(e) {
    if (!_dragSource) return;
    const target = _resolveDropTarget(e.target);
    if (!target) return;
    const ok = _canDropOn(target);
    e.preventDefault();  // даёт визуальный «можно дроп»
    if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'move' : 'none';
    if (target.el) {
      target.el.classList.toggle('drop-ok',  ok);
      target.el.classList.toggle('drop-bad', !ok);
    }
  }

  function onDragLeave(e) {
    const target = _resolveDropTarget(e.target);
    if (target && target.el) {
      // .drop-bad всегда снимаем при leave (она ставится только во
      // время hover на невалидной цели).
      target.el.classList.remove('drop-bad');
      // Camp v1.5 (09.05.2026): для hero-слотов .drop-ok — pre-highlight
      // (выставлен в onDragStart на ВСЕ валидные hero-слоты), его не
      // снимаем — иначе зелёная подсветка исчезнет, как только курсор
      // ушёл со слота. Для inventory-ячеек и discard .drop-ok ставится
      // только на hover в onDragOver — её снимаем как раньше.
      if (target.type !== 'hero') {
        target.el.classList.remove('drop-ok');
      }
    }
  }

  function onDrop(e) {
    if (!_dragSource) return;
    e.preventDefault();
    const target = _resolveDropTarget(e.target);
    if (!target) return;
    if (!_canDropOn(target)) return;
    _performDrop(_dragSource, target);
    _dragSource = null;
    renderInventoryOverlay();
    if (typeof render === 'function') render();
  }

  /* Резолв drop-цели по DOM-узлу. Возвращает один из:
       { type: 'inventory', cellIndex: N, el }
       { type: 'hero', heroId: 'u1', slot: 'weapon', el }
       { type: 'discard', el }
     Или null, если узел не drop-цель. */
  function _resolveDropTarget(node) {
    if (!node || !node.closest) return null;
    const cell = node.closest('.inv-cell');
    if (cell) {
      const idx = parseInt(cell.dataset.cellIndex, 10);
      if (Number.isFinite(idx)) return { type: 'inventory', cellIndex: idx, el: cell };
    }
    const slot = node.closest('.inv-slot');
    if (slot) {
      const heroId = slot.dataset.heroId;
      const slotKey = slot.dataset.slot;
      if (heroId && slotKey) return { type: 'hero', heroId, slot: slotKey, el: slot };
    }
    const discard = node.closest('.inv-discard');
    if (discard) return { type: 'discard', el: discard };
    return null;
  }

  /* Можно ли уронить _dragSource на target. Логика:
       - inventory ↔ inventory: всегда OK (swap или move).
       - inventory → hero: класс-локи + соответствие slotKind.
       - hero → inventory: всегда OK (расконкурент).
       - hero → hero (09.05.2026): прямой перенос/swap — slotKind должен
         совпасть с target.slot, оба героя должны мочь надеть свои новые
         предметы (взаимная class-проверка). Раньше было запрещено и
         требовало транзита через инвентарь.
       - * → discard: всегда OK (любой предмет можно выбросить).
     Возвращает boolean. */
  function _canDropOn(target) {
    const src = _dragSource;
    if (!src || !target) return false;
    if (target.type === 'discard') return true;
    if (src.from === 'inventory') {
      if (target.type === 'inventory') {
        if (target.cellIndex === src.cellIndex) return false;  // на ту же — no-op
        return true;
      }
      if (target.type === 'hero') {
        const item = state.partyInventory[src.cellIndex];
        if (!item) return false;
        if (item.slotKind !== target.slot) return false;
        const hero = (typeof getUnit === 'function') ? getUnit(target.heroId) : null;
        if (!hero) return false;
        return canHeroEquipItem(hero, item);
      }
    }
    if (src.from === 'hero') {
      if (target.type === 'inventory') {
        // Снять с героя в инвентарь — да, ячейка может быть пуста или
        // занята (тогда swap: предмет из ячейки автоматически встанет
        // в слот героя — если совместим; иначе drop запрещён).
        const heroItem = (typeof getUnit === 'function') ? _getEquipmentInstance(target.heroId, src.slot) : null;
        if (target.cellIndex < state.partyInventory.length) {
          const cellItem = state.partyInventory[target.cellIndex];
          if (cellItem) {
            // swap: проверяем что cellItem совместим со слотом героя.
            if (cellItem.slotKind !== src.slot) return false;
            const hero = (typeof getUnit === 'function') ? getUnit(src.heroId) : null;
            if (!hero) return false;
            return canHeroEquipItem(hero, cellItem);
          }
        }
        return true;
      }
      if (target.type === 'hero') {
        // 09.05.2026: прямой hero → hero. Условия:
        //   1) Не тот же самый слот того же героя (no-op).
        //   2) src.item.slotKind === target.slot (нельзя кинуть оружие
        //      в слот брони).
        //   3) Целевой герой может надеть src.item (canHeroEquipItem).
        //   4) Если в целевом слоте уже что-то есть — это swap, и
        //      исходный герой должен мочь надеть тот предмет.
        if (target.heroId === src.heroId && target.slot === src.slot) return false;
        const srcItem = (typeof getUnit === 'function') ? _getEquipmentInstance(src.heroId, src.slot) : null;
        if (!srcItem) return false;
        if (srcItem.slotKind !== target.slot) return false;
        const tgtHero = (typeof getUnit === 'function') ? getUnit(target.heroId) : null;
        if (!tgtHero) return false;
        if (!canHeroEquipItem(tgtHero, srcItem)) return false;
        const tgtItem = _getEquipmentInstance(target.heroId, target.slot);
        if (tgtItem) {
          // swap-обмен: целевой предмет должен подойти исходному герою
          // (slotKind совпадает автоматически — оба слота одного типа).
          const srcHero = (typeof getUnit === 'function') ? getUnit(src.heroId) : null;
          if (!srcHero) return false;
          if (!canHeroEquipItem(srcHero, tgtItem)) return false;
        }
        return true;
      }
    }
    return false;
  }

  /* Выполнить дроп. Источник и цель уже валидированы _canDropOn. */
  function _performDrop(src, target) {
    if (target.type === 'discard') {
      _discardFromSource(src);
      return;
    }
    if (src.from === 'inventory' && target.type === 'inventory') {
      // Swap или move в инвентаре.
      if (typeof swapInventoryCells === 'function') {
        swapInventoryCells(src.cellIndex, target.cellIndex);
      }
      return;
    }
    if (src.from === 'inventory' && target.type === 'hero') {
      _equipFromInventoryCell(target.heroId, target.slot, src.cellIndex);
      return;
    }
    if (src.from === 'hero' && target.type === 'inventory') {
      _moveHeroSlotToInventoryCell(src.heroId, src.slot, target.cellIndex);
      return;
    }
    if (src.from === 'hero' && target.type === 'hero') {
      _transferHeroToHero(src.heroId, src.slot, target.heroId, target.slot);
      return;
    }
  }

  /* Прямой перенос/обмен предмета между героями (09.05.2026).
     Уже валидировано в _canDropOn:
       - srcItem существует;
       - srcItem.slotKind === tgtSlot;
       - целевой герой может надеть srcItem;
       - если в целевом слоте есть tgtItem — исходный герой может его надеть. */
  function _transferHeroToHero(srcHeroId, srcSlot, tgtHeroId, tgtSlot) {
    const srcHero = (typeof getUnit === 'function') ? getUnit(srcHeroId) : null;
    const tgtHero = (typeof getUnit === 'function') ? getUnit(tgtHeroId) : null;
    if (!srcHero || !tgtHero || !srcHero.equipment || !tgtHero.equipment) return;
    const srcItem = _getEquipmentInstance(srcHeroId, srcSlot);
    if (!srcItem) return;
    const tgtItem = _getEquipmentInstance(tgtHeroId, tgtSlot);
    // Положить srcItem в целевой слот.
    tgtHero.equipment[tgtSlot] = srcItem;
    // Освободить исходный слот: если был swap — кладём tgtItem; иначе
    // weapon → defaultWeapon, остальные → null.
    if (tgtItem) {
      srcHero.equipment[srcSlot] = tgtItem;
    } else if (srcSlot === 'weapon') {
      const cls = CLASSES[srcHero.classId] || {};
      srcHero.equipment.weapon = cls.defaultWeapon || null;
    } else {
      srcHero.equipment[srcSlot] = null;
    }
    if (typeof log === 'function') {
      const srcCls = CLASSES[srcHero.classId] || {};
      const tgtCls = CLASSES[tgtHero.classId] || {};
      const srcName = srcCls.name || srcHero.id;
      const tgtName = tgtCls.name || tgtHero.id;
      const fn = (typeof itemFullName === 'function') ? itemFullName(srcItem) : (srcItem.name || srcItem.id);
      if (tgtItem) {
        const tn = (typeof itemFullName === 'function') ? itemFullName(tgtItem) : (tgtItem.name || tgtItem.id);
        log(`${srcName} (${srcHero.team}) ↔ ${tgtName} (${tgtHero.team}): обмен «${fn}» ↔ «${tn}»`, 'info');
      } else {
        log(`${srcName} (${srcHero.team}) → ${tgtName} (${tgtHero.team}): передаёт «${fn}»`, 'info');
      }
    }
  }

  function _discardFromSource(src) {
    if (src.from === 'inventory') {
      const item = state.partyInventory[src.cellIndex];
      if (!item) return;
      state.partyInventory[src.cellIndex] = null;
      if (typeof log === 'function') {
        const fn = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || item.id);
        log(`Выброшено: «${fn}»`, 'system');
      }
    } else if (src.from === 'hero') {
      const hero = (typeof getUnit === 'function') ? getUnit(src.heroId) : null;
      if (!hero || !hero.equipment) return;
      const cur = hero.equipment[src.slot];
      if (!cur || typeof cur === 'string') return;
      // Сбрасываем слот: weapon → defaultWeapon, остальные → null.
      if (src.slot === 'weapon') {
        const cls = CLASSES[hero.classId] || {};
        hero.equipment.weapon = cls.defaultWeapon || null;
      } else {
        hero.equipment[src.slot] = null;
      }
      if (typeof log === 'function') {
        const fn = (typeof itemFullName === 'function') ? itemFullName(cur) : (cur.name || cur.id);
        log(`Выброшено: «${fn}»`, 'system');
      }
    }
  }

  /* Экипировать предмет из ячейки инвентаря на героя. Если в слоте
     уже есть предмет — он отправляется в освободившуюся ячейку. */
  function _equipFromInventoryCell(heroId, slotKey, cellIndex) {
    const hero = (typeof getUnit === 'function') ? getUnit(heroId) : null;
    if (!hero || !hero.equipment) return;
    const item = state.partyInventory[cellIndex];
    if (!item) return;
    const previous = hero.equipment[slotKey];
    hero.equipment[slotKey] = item;
    state.partyInventory[cellIndex] = null;
    // Если в слоте был инстанс предмета — кладём его на освободившееся
    // место (та же ячейка, откуда взяли новый).
    if (previous && typeof previous !== 'string') {
      state.partyInventory[cellIndex] = previous;
    }
    if (typeof log === 'function') {
      const cls = CLASSES[hero.classId] || {};
      const fn = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || item.id);
      log(`${cls.name || hero.id} (${hero.team}) надевает «${fn}»`, 'info');
    }
  }

  /* Снять с героя и положить в указанную ячейку инвентаря. Если в
     ячейке уже есть предмет, и он совместим со слотом героя — swap
     (предмет из ячейки идёт в слот героя). */
  function _moveHeroSlotToInventoryCell(heroId, slotKey, cellIndex) {
    const hero = (typeof getUnit === 'function') ? getUnit(heroId) : null;
    if (!hero || !hero.equipment) return;
    const cur = hero.equipment[slotKey];
    if (!cur || typeof cur === 'string') return;
    // Расширяем массив, если нужно.
    while (state.partyInventory.length <= cellIndex) state.partyInventory.push(null);
    const cellItem = state.partyInventory[cellIndex];
    if (cellItem) {
      // Swap: cellItem → слот героя. Уже валидировано в _canDropOn.
      hero.equipment[slotKey] = cellItem;
      state.partyInventory[cellIndex] = cur;
    } else {
      // Move: cur → ячейка, слот героя освобождается (для weapon — defaultWeapon).
      state.partyInventory[cellIndex] = cur;
      if (slotKey === 'weapon') {
        const cls = CLASSES[hero.classId] || {};
        hero.equipment.weapon = cls.defaultWeapon || null;
      } else {
        hero.equipment[slotKey] = null;
      }
    }
    if (typeof log === 'function') {
      const cls = CLASSES[hero.classId] || {};
      const fn = (typeof itemFullName === 'function') ? itemFullName(cur) : (cur.name || cur.id);
      log(`${cls.name || hero.id} (${hero.team}) снимает «${fn}» в инвентарь`, 'info');
    }
  }

  /* Снять предмет из слота героя в первую свободную ячейку инвентаря.
     Используется кнопкой «×» в углу слота. */
  function unequipFromHeroToInventory(heroId, slotKey) {
    const hero = (typeof getUnit === 'function') ? getUnit(heroId) : null;
    if (!hero || !hero.equipment) return;
    const cur = hero.equipment[slotKey];
    if (!cur || typeof cur === 'string') return;
    if (typeof addToInventory === 'function') {
      addToInventory(cur);
    } else {
      state.partyInventory.push(cur);
    }
    if (slotKey === 'weapon') {
      const cls = CLASSES[hero.classId] || {};
      hero.equipment.weapon = cls.defaultWeapon || null;
    } else {
      hero.equipment[slotKey] = null;
    }
    if (typeof log === 'function') {
      const cls = CLASSES[hero.classId] || {};
      const fn = (typeof itemFullName === 'function') ? itemFullName(cur) : (cur.name || cur.id);
      log(`${cls.name || hero.id} (${hero.team}) снимает «${fn}» в инвентарь`, 'info');
    }
    if (typeof render === 'function') render();
  }

  function _getEquipmentInstance(heroId, slotKey) {
    const hero = (typeof getUnit === 'function') ? getUnit(heroId) : null;
    if (!hero || !hero.equipment) return null;
    const e = hero.equipment[slotKey];
    if (!e || typeof e === 'string') return null;
    return e;
  }

  /* Class-валидация для weapon/armor; amulet/ring/consumable — без локов.
     Источник weaponType/armorType — на инстансе или (fallback) из реестра
     по baseId. */
  function canHeroEquipItem(hero, item) {
    if (!hero || !item) return false;
    if (!item.slotKind) return false;
    const cls = (typeof CLASSES === 'object' && CLASSES) ? CLASSES[hero.classId] : null;
    if (!cls) return false;
    if (item.slotKind === 'weapon') {
      let wType = item.weaponType;
      if (!wType && item.baseId && typeof WEAPONS !== 'undefined' && WEAPONS[item.baseId]) {
        wType = WEAPONS[item.baseId].weaponType;
      }
      if (!wType) return false;
      const allowed = Array.isArray(cls.allowedWeaponTypes) ? cls.allowedWeaponTypes : [];
      return allowed.includes(wType);
    }
    if (item.slotKind === 'armor') {
      let aType = item.armorType;
      if (!aType && item.baseId && typeof ARMORS !== 'undefined' && ARMORS[item.baseId]) {
        aType = ARMORS[item.baseId].armorType;
      }
      if (!aType) return false;
      const allowed = Array.isArray(cls.allowedArmorTypes) ? cls.allowedArmorTypes : [];
      return allowed.includes(aType);
    }
    return true;
  }
  if (typeof window !== 'undefined') window.canHeroEquipItem = canHeroEquipItem;

  function closeOverlay() {
    if (state) state.inventoryOpen = false;
    renderInventoryOverlay();
  }

  function toggleInventoryOverlay() {
    if (!state) return;
    state.inventoryOpen = !state.inventoryOpen;
    renderInventoryOverlay();
  }

  /* ================================================================
     === Render =====================================================
     ================================================================ */

  function renderInventoryOverlay() {
    const overlay = ensureOverlay();
    if (!state || !state.inventoryOpen) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      return;
    }
    overlay.style.display = 'flex';
    overlay.innerHTML = buildOverlayHtml();
  }

  function buildOverlayHtml() {
    // Camp v1.5 (08.05.2026): источник героев для инвентаря — state.party
    // (в лагере state.units может быть пустым). Fallback на state.units —
    // совместимость с открытием инвентаря из боя (там state.party и
    // state.units пересекаются по ссылкам, выберется тот же список).
    const partySource = (Array.isArray(state.party) && state.party.length > 0)
      ? state.party
      : (state.units || []);
    const heroes = partySource.filter(u => {
      if (!u || !u.alive) return false;
      const cls = CLASSES[u.classId];
      return cls && cls.kind !== 'monster';
    });
    const heroBlocks = heroes.map(renderHeroBlock).join('');
    const inventoryHtml = renderInventoryGrid();
    return `
      <div class="inv-content" data-inv-content>
        <div class="inv-header">
          <div class="inv-title">Снаряжение отряда</div>
          <button class="inv-close" data-inv-action="close" title="Закрыть (I / Esc)">×</button>
        </div>
        <div class="inv-body">
          <div class="inv-heroes">${heroBlocks || '<div class="inv-empty">Нет живых героев</div>'}</div>
          <div class="inv-right">
            <div class="inv-subtitle">Инвентарь отряда</div>
            ${inventoryHtml}
            <div class="inv-discard" title="Перетащи сюда, чтобы выбросить">🗑 Корзина</div>
          </div>
        </div>
      </div>`;
  }

  function renderHeroBlock(hero) {
    const cls = CLASSES[hero.classId] || {};
    const slots = [
      { key: 'weapon',     icon: '⚔', label: 'Оружие' },
      { key: 'armor',      icon: '🛡', label: 'Броня' },
      { key: 'amulet',     icon: '📿', label: 'Амулет' },
      { key: 'ring',       icon: '💍', label: 'Кольцо' },
      { key: 'consumable', icon: '🧪', label: 'Расходник' }
    ];
    const slotsHtml = slots.map(s => renderHeroSlot(hero, s)).join('');
    return `
      <div class="inv-hero">
        <div class="inv-hero-name">${escapeHtml(cls.name || hero.classId)} <span class="inv-hero-team">(${escapeHtml(hero.team)})</span></div>
        <div class="inv-hero-slots">${slotsHtml}</div>
      </div>`;
  }

  function renderHeroSlot(hero, slot) {
    const equipped = hero.equipment && hero.equipment[slot.key];
    const dataAttrs = `data-hero-id="${escapeAttr(hero.id)}" data-slot="${escapeAttr(slot.key)}"`;
    if (!equipped) {
      // Пустой слот — без эмодзи-заполнителя, только пустой квадрат.
      // Тип слота читается через tooltip (см. title).
      return `<div class="inv-slot inv-slot-empty" ${dataAttrs} title="${escapeAttr(slot.label)} (пусто)"></div>`;
    }
    let name, iconHtml;
    if (typeof equipped === 'string') {
      const w = WEAPONS[equipped] || {};
      name = w.name || equipped;
      iconHtml = w.spriteSrc
        ? `<img src="${escapeAttr(w.spriteSrc)}" alt="${escapeAttr(name)}">`
        : (w.icon || slot.icon);
    } else {
      name = (typeof itemFullName === 'function') ? itemFullName(equipped) : (equipped.name || equipped.id);
      iconHtml = equipped.spriteSrc
        ? `<img src="${escapeAttr(equipped.spriteSrc)}" alt="${escapeAttr(name)}">`
        : (equipped.icon || slot.icon);
    }
    const titleLines = [`${slot.label}: ${name}`];
    if (typeof equipped !== 'string') {
      const detailLines = buildItemDetailLines(equipped, hero);
      for (const line of detailLines) titleLines.push(line);
    } else {
      titleLines.push('Базовое оружие класса');
      if (slot.key === 'weapon' && typeof WEAPONS !== 'undefined' && WEAPONS[equipped]) {
        const detailLines = buildItemDetailLines(WEAPONS[equipped], hero);
        for (const line of detailLines) titleLines.push(line);
      }
    }
    const titleAttr = titleLines.join('\n');
    // draggable=true только для инстансов (defaultWeapon-string не таскается).
    const draggable = (typeof equipped !== 'string') ? 'true' : 'false';
    // «×»-кнопка в углу — только для инстансов (defaultWeapon снять нельзя).
    const closeBtn = (typeof equipped !== 'string')
      ? `<button class="inv-slot-x" data-inv-action="unequip-x" data-hero-id="${escapeAttr(hero.id)}" data-slot="${escapeAttr(slot.key)}" title="Снять в инвентарь">×</button>`
      : '';
    return `
      <div class="inv-slot inv-slot-filled" ${dataAttrs} draggable="${draggable}" title="${escapeAttr(titleAttr)}">
        <span class="inv-slot-icon">${iconHtml}</span>
        ${closeBtn}
      </div>`;
  }

  function renderInventoryGrid() {
    const items = state.partyInventory || [];
    const cols = 6;  // ширина сетки
    const minRows = 4;
    const rowsNeeded = Math.max(minRows, Math.ceil(items.length / cols));
    const totalCells = rowsNeeded * cols;
    const cellsHtml = [];
    for (let i = 0; i < totalCells; i++) {
      const item = items[i] || null;
      cellsHtml.push(renderInventoryCell(i, item));
    }
    // minmax(0, 1fr) вместо 1fr — иначе колонки берут intrinsic-ширину
    // содержимого как минимум, и любая <img> с natural size > колонки
    // растягивает ВСЕ ячейки (баг 09.05.2026: при добавлении предмета
    // со спрайтом инвентарь распухал, без спрайтов — сжимался обратно).
    return `<div class="inv-grid" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr));">${cellsHtml.join('')}</div>`;
  }

  function renderInventoryCell(index, item) {
    if (!item) {
      return `<div class="inv-cell inv-cell-empty" data-cell-index="${index}"></div>`;
    }
    const fullName = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || item.id);
    const slotKindLabel = SLOT_LABELS[item.slotKind] || item.slotKind || '?';
    const detailLines = buildItemDetailLines(item);
    const tooltip = [fullName, slotKindLabel].concat(detailLines).join('\n');
    const iconHtml = item.spriteSrc
      ? `<img src="${escapeAttr(item.spriteSrc)}" alt="${escapeAttr(fullName)}">`
      : (item.icon || SLOT_ICONS[item.slotKind] || '?');
    return `
      <div class="inv-cell inv-cell-filled" data-cell-index="${index}" draggable="true" title="${escapeAttr(tooltip)}">
        ${iconHtml}
      </div>`;
  }

  /* ================================================================
     === Тултипы и метки ============================================
     ================================================================ */
  const SLOT_LABELS = {
    weapon: 'Оружие',
    armor: 'Броня',
    amulet: 'Амулет',
    ring: 'Кольцо',
    consumable: 'Расходник'
  };
  const SLOT_ICONS = {
    weapon: '⚔', armor: '🛡', amulet: '📿', ring: '💍', consumable: '🧪'
  };
  const STAT_LABELS_INV = {
    str: 'Сила', vit: 'Живучесть', dex: 'Ловкость', spd: 'Скорость',
    wis: 'Мудрость', int: 'Интеллект', luk: 'Удача',
    damage: 'Базовый урон', hp_regen: 'Рег. HP/ход', mana_regen: 'Рег. маны/ход'
  };
  // Балансная правка 15.05.2026: метки типа брони — по классу-носителю,
  // не по «весу». Включён priest_robe (раньше был пропущен).
  const ARMOR_TYPE_LABELS = {
    heavy_armor: 'Воин', medium_armor: 'Лучник', robe: 'Маг', priest_robe: 'Священник'
  };

  function buildItemDetailLines(item, wearer) {
    if (!item) return [];
    const out = [];
    if (item.tier) out.push(`Тир ${item.tier}`);
    if (typeof itemTotalCost === 'function') {
      const cost = itemTotalCost(item);
      if (cost > 0) out.push(`Стоимость: ${cost} оч.`);
    }
    if (item.armorType) {
      const tLabel = ARMOR_TYPE_LABELS[item.armorType] || item.armorType || '?';
      out.push(`Тип брони: ${tLabel}`);
      // Балансная правка 14.05.2026: per-class свойства брони.
      if (typeof item.armoredOnSpawn === 'number') {
        out.push(`«Бронирован»: ${item.armoredOnSpawn | 0} зар. в начале миссии`);
      }
      if (typeof item.attackDamageBonus === 'number') {
        out.push(`Урон атак: +${item.attackDamageBonus | 0}`);
      }
      if (typeof item.manaDiscount === 'number') {
        out.push(`Стоимость навыков в мане: −${item.manaDiscount | 0} (минимум 1)`);
      }
      if (typeof item.incomingReduction === 'number') {
        out.push(`Получаемый урон: −${item.incomingReduction | 0} (любой тип, включая эффекты)`);
      }
    }
    if (item.formula) {
      const desc = (typeof describeDamage === 'function')
        ? describeDamage(item.delivery, item.damageType) : (item.damageType || '');
      out.push(`Тип: ${desc}`);
      if (item.range != null) out.push(`Дальность: ${item.range} кл.`);
      const formulaText = (typeof weaponFormulaText === 'function')
        ? weaponFormulaText(item) : '';
      let dmgBonusFromItem = 0;
      const affsForDmg = (typeof itemAffixes === 'function') ? itemAffixes(item) : [];
      for (const aff of affsForDmg) {
        if (aff && aff.statMods && typeof aff.statMods.damage === 'number') {
          dmgBonusFromItem += aff.statMods.damage;
        }
      }
      if (dmgBonusFromItem > 0) {
        out.push(`Формула: ${formulaText} + ${dmgBonusFromItem} (аффиксы оружия)`);
      } else {
        out.push(`Формула: ${formulaText}`);
      }
      if (wearer && typeof effectiveStats === 'function' && typeof weaponDamage === 'function') {
        const stats = effectiveStats(wearer);
        const total = weaponDamage(item, stats, wearer);
        out.push(`Текущий урон: ${total}`);
      }
    }
    const affs = (typeof itemAffixes === 'function') ? itemAffixes(item) : [];
    for (const aff of affs) {
      if (!aff || !aff.statMods) continue;
      for (const k of Object.keys(aff.statMods)) {
        const v = aff.statMods[k];
        if (typeof v !== 'number' || v === 0) continue;
        const label = STAT_LABELS_INV[k] || k;
        const sign = v > 0 ? '+' : '−';
        out.push(`${label}: ${sign}${Math.abs(v)} (${aff.name})`);
      }
    }
    return out;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  // Esc для закрытия — добавочный handler.
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!state || !state.inventoryOpen) return;
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      closeOverlay();
      e.preventDefault();
    });
  }

  if (typeof window !== 'undefined') {
    window.renderInventoryOverlay = renderInventoryOverlay;
    window.toggleInventoryOverlay = toggleInventoryOverlay;
    // Camp v1.5-popups (12.05.2026): экспорт сборщика строк тултипа предмета,
    // чтобы render-modals.js мог переиспользовать его для попапа трофея.
    window.buildItemDetailLines = buildItemDetailLines;
  }

  /* ================================================================
     === Тестовый спавнер (С1+С2+С3+С4+С5) ===========================
     ================================================================
     См. шапку файла и ранее задокументированный API. */
  let _testItemCounter = 0;
  const TEST_DEFAULT_BASE_BY_SLOT = {
    weapon: 'sword',
    armor: 'leather_armor',
    ring: 'ring_basic',
    amulet: 'amulet_basic'
  };
  function __spawnTestItem(slotKind, opts) {
    if (!state) return;
    const labels = {
      weapon: { name: 'Тестовый меч', icon: '⚔' },
      armor:  { name: 'Тестовая броня', icon: '🛡' },
      amulet: { name: 'Тестовый амулет', icon: '📿' },
      ring:   { name: 'Тестовое кольцо', icon: '💍' },
      consumable: { name: 'Тестовое зелье', icon: '🧪' }
    };
    const def = labels[slotKind];
    if (!def) {
      console.warn('__spawnTestItem: неизвестный slotKind', slotKind);
      return;
    }
    _testItemCounter += 1;
    const o = opts || {};
    let baseFields = {};
    let baseId = o.baseId || TEST_DEFAULT_BASE_BY_SLOT[slotKind] || null;
    let baseName = null;
    let baseIcon = null;
    if (slotKind === 'weapon' && baseId && typeof WEAPONS !== 'undefined' && WEAPONS[baseId]) {
      const base = WEAPONS[baseId];
      baseFields = {
        range: base.range,
        delivery: base.delivery,
        damageType: base.damageType,
        formula: base.formula ? { ...base.formula } : null,
        weaponType: base.weaponType,
        tier: base.tier,
        costPoints: base.costPoints,
        spriteSrc: base.spriteSrc || null
      };
      baseName = base.name;
      baseIcon = base.icon || null;
    } else if (slotKind === 'armor' && baseId && typeof ARMORS !== 'undefined' && ARMORS[baseId]) {
      const base = ARMORS[baseId];
      baseFields = {
        armorType: base.armorType,
        // Балансная правка 14.05.2026: вместо общего armorFlat —
        // per-class свойство. Копируем то, что есть на базе.
        armoredOnSpawn: base.armoredOnSpawn,
        attackDamageBonus: base.attackDamageBonus,
        manaDiscount: base.manaDiscount,
        incomingReduction: base.incomingReduction,
        tier: base.tier,
        costPoints: base.costPoints,
        spriteSrc: base.spriteSrc || null
      };
      baseName = base.name;
      baseIcon = base.icon || null;
    } else if (slotKind === 'ring' && baseId && typeof RINGS !== 'undefined' && RINGS[baseId]) {
      const base = RINGS[baseId];
      baseFields = {
        costPoints: base.costPoints || 0,
        spriteSrc: base.spriteSrc || null
      };
      baseName = base.name;
      baseIcon = base.icon || null;
    } else if (slotKind === 'amulet' && baseId && typeof AMULETS !== 'undefined' && AMULETS[baseId]) {
      const base = AMULETS[baseId];
      baseFields = {
        costPoints: base.costPoints || 0,
        spriteSrc: base.spriteSrc || null
      };
      baseName = base.name;
      baseIcon = base.icon || null;
    }
    const finalName = o.name || baseName || (def.name + ' #' + _testItemCounter);
    const finalIcon = baseIcon || def.icon;
    const item = Object.assign({}, baseFields, {
      id: 'test_' + slotKind + '_' + _testItemCounter,
      slotKind,
      baseId,
      name: finalName,
      icon: finalIcon,
      prefix: o.prefix || null,
      suffix: o.suffix || null,
      baseCost: baseFields.costPoints || 0
    });
    if (typeof addToInventory === 'function') {
      addToInventory(item);
    } else {
      if (!Array.isArray(state.partyInventory)) state.partyInventory = [];
      state.partyInventory.push(item);
    }
    const fullName = (typeof itemFullName === 'function') ? itemFullName(item) : item.name;
    if (typeof log === 'function') log(`DevTools: добавлен «${fullName}» в инвентарь`, 'system');
    if (typeof render === 'function') render();
    return item;
  }
  if (typeof window !== 'undefined') {
    window.__spawnTestItem = __spawnTestItem;
  }
})();
