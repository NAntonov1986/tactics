/* render-camp.js (render/) — UI лагеря и глобальной карты (Camp v1, 08.05.2026;
   Camp v1.5 backend, 09.05.2026; Camp v1.5-UI, 09.05.2026).

   Что внутри:
     • renderCampOverlay() — рисует/прячет camp-оверлей по
       state.campScreen ('main' | 'globalMap' | 'missionSetup' | null).
     • Главный экран лагеря — список героев из state.party (с уровнем,
       HP/маной и статусом отдыха), кнопки «Снаряжение», «Глобальная
       карта», «Новый забег», «Экспорт сейва».
     • Глобальная карта — список регионов из state.regions с цветовой
       индикацией сложности (easy/mid/hard/lethal). Кнопка «Выбрать
       отряд» ведёт на экран missionSetup.
     • Экран выбора отряда (missionSetup) — карточки 6 героев партии,
       клик добавляет/убирает из pendingMissionHeroIds (1-3). Кнопка
       «Отправить отряд» дёргает confirmMissionSelection.
     • Click-handler делегируется на корне overlay'а на data-camp-action.

   Что НЕ внутри:
     • Магазин/найм/палатки — Camp v2-v5.

   Контракт UI:
     • Overlay перекрывает поле боя (z-index 940 — ниже инвентарного
       950, чтобы открытый инвентарь оставался на верхнем слое).
     • Renderer вызывается из общего render() в render.js.

   Внешние имена через script-scope:
   `state`, `getUnit`, `render`, `log`, `CLASSES`, `WEAPONS`, `SKILLS`, `SKILL_TIER_LABELS`,
   `getLearnedSkills`, `enterCampMain`, `enterGlobalMap`, `enterMissionSetup`,
   `toggleMissionHeroSelection`, `confirmMissionSelection`,
   `toggleInventoryOverlay`, `restartGame`, `exportSaveJson`,
   `itemFullName`, `maxHpOf`, `maxManaOf`, `classVisualHtml`. */

(function () {
  let _overlayEl = null;
  /* Camp v1.5-squad4 (09.05.2026): сколько героев максимум можно
     отправить на одну миссию. Источник правды — HERO_SPAWN.length в
     core/state.js (там константа массива позиций). Дублируем здесь
     числом, потому что HERO_SPAWN в render-модуле не виден. Если
     поменяешь размер отряда — синхронизируй обе точки. */
  const MAX_SQUAD = 4;

  function ensureOverlay() {
    if (_overlayEl && document.body.contains(_overlayEl)) return _overlayEl;
    const el = document.createElement('div');
    el.id = 'campOverlay';
    el.className = 'camp-overlay';
    el.style.display = 'none';
    document.body.appendChild(el);
    el.addEventListener('click', onOverlayClick);
    // Camp v2-economy (13.05.2026): hover-режим инфо-панели героя.
    // mouseover/mouseout всплывают через делегирование. Перерисовываем
    // только при смене ховера, чтобы не дёргать render на каждом
    // movement event'е.
    el.addEventListener('mouseover', onOverlayMouseOver);
    el.addEventListener('mouseout', onOverlayMouseOut);
    // Camp v2-economy/shop (14.05.2026): drag-and-drop купли/продажи.
    el.addEventListener('dragstart', onShopDragStart);
    el.addEventListener('dragover', onShopDragOver);
    el.addEventListener('dragleave', onShopDragLeave);
    el.addEventListener('drop', onShopDrop);
    _overlayEl = el;
    return el;
  }

  /* === Camp v2-economy/shop drag-and-drop (14.05.2026) === */
  function onShopDragStart(e) {
    const cell = e.target.closest && e.target.closest('[data-shop-drag]');
    if (!cell) return;
    const kind = cell.getAttribute('data-shop-drag');
    const itemId = cell.getAttribute('data-item-id');
    if (!itemId || !kind) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', kind + ':' + itemId);
    cell.classList.add('dragging');
  }
  function onShopDragOver(e) {
    const zone = e.target.closest && e.target.closest('[data-shop-drop]');
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('shop-drop-hover');
  }
  function onShopDragLeave(e) {
    const zone = e.target.closest && e.target.closest('[data-shop-drop]');
    if (!zone) return;
    if (e.relatedTarget && zone.contains(e.relatedTarget)) return;
    zone.classList.remove('shop-drop-hover');
  }
  function onShopDrop(e) {
    const zone = e.target.closest && e.target.closest('[data-shop-drop]');
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('shop-drop-hover');
    const payload = e.dataTransfer.getData('text/plain') || '';
    const sep = payload.indexOf(':');
    if (sep < 0) return;
    const kind = payload.slice(0, sep);
    const itemId = payload.slice(sep + 1);
    const dropZone = zone.getAttribute('data-shop-drop');
    if (kind === 'buy-item' && dropZone === 'sell') {
      if (typeof buyFromShop === 'function' && buyFromShop(itemId)) {
        if (typeof render === 'function') render();
      }
    } else if (kind === 'sell-item' && dropZone === 'buy') {
      if (typeof sellToShop === 'function' && sellToShop(itemId)) {
        if (typeof render === 'function') render();
      }
    }
  }

  function onOverlayMouseOver(e) {
    const heroEl = e.target.closest && e.target.closest('[data-camp-action="select-hero"]');
    if (!heroEl) return;
    const heroId = heroEl.getAttribute('data-hero-id');
    if (!heroId || !state || state.hoveredHeroId === heroId) return;
    state.hoveredHeroId = heroId;
    if (typeof render === 'function') render();
  }

  function onOverlayMouseOut(e) {
    const heroEl = e.target.closest && e.target.closest('[data-camp-action="select-hero"]');
    if (!heroEl) return;
    // relatedTarget = куда переехал курсор. Если ушёл на другой
    // .camp-hero — onOverlayMouseOver уже всё переключит. Если ушёл
    // на саму инфо-панель — оставим ховер (чтобы не моргало).
    const rt = e.relatedTarget;
    if (rt && rt.closest) {
      if (rt.closest('[data-camp-action="select-hero"]')) return;
      if (rt.closest('.hero-info-panel')) return;
    }
    if (!state || state.hoveredHeroId == null) return;
    state.hoveredHeroId = null;
    if (typeof render === 'function') render();
  }

  function onOverlayClick(e) {
    const btn = e.target.closest('[data-camp-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-camp-action');
    if (action === 'open-inventory') {
      if (typeof toggleInventoryOverlay === 'function') toggleInventoryOverlay();
      return;
    }
    if (action === 'open-map') {
      if (typeof enterGlobalMap === 'function') enterGlobalMap();
      return;
    }
    if (action === 'back-camp') {
      if (typeof enterCampMain === 'function') enterCampMain();
      return;
    }
    // Camp v2-economy (13.05.2026): найм наёмников.
    if (action === 'open-hire') {
      if (typeof enterHireScreen === 'function') enterHireScreen();
      return;
    }
    // Camp v2-economy/shop (14.05.2026): магазин.
    if (action === 'open-shop') {
      if (typeof enterShopScreen === 'function') enterShopScreen();
      return;
    }
    if (action === 'buy-item') {
      const id = btn.getAttribute('data-item-id');
      if (id && typeof buyFromShop === 'function') {
        if (buyFromShop(id) && typeof render === 'function') render();
      }
      return;
    }
    if (action === 'sell-item') {
      const id = btn.getAttribute('data-item-id');
      if (id && typeof sellToShop === 'function') {
        if (sellToShop(id) && typeof render === 'function') render();
      }
      return;
    }
    if (action === 'do-hire') {
      const nonceStr = btn.getAttribute('data-recruit-nonce');
      const nonce = nonceStr ? parseInt(nonceStr, 10) : NaN;
      if (Number.isFinite(nonce) && typeof hireRecruit === 'function') {
        const ok = hireRecruit(nonce);
        // hireRecruit запускает level-up очередь (если recruit.level > 0).
        // Очередь сама вызывает renderLevelUp; здесь же — перерисовываем
        // карточку лагеря, чтобы исчезнувший из пула кандидат и обновлённое
        // золото отобразились ДО открытия первого level-up окна.
        if (ok && typeof render === 'function') render();
      }
      return;
    }
    if (action === 'pick-region') {
      const regionId = btn.getAttribute('data-region-id');
      if (regionId && typeof enterMissionSetup === 'function') {
        enterMissionSetup(regionId);
      }
      return;
    }
    if (action === 'mission-toggle-hero') {
      const heroId = btn.getAttribute('data-hero-id');
      if (heroId && typeof toggleMissionHeroSelection === 'function') {
        toggleMissionHeroSelection(heroId);
      }
      return;
    }
    if (action === 'mission-confirm') {
      if (typeof confirmMissionSelection === 'function') {
        confirmMissionSelection();
      }
      return;
    }
    if (action === 'mission-back') {
      if (typeof enterGlobalMap === 'function') enterGlobalMap();
      return;
    }
    // Camp v1.5-calendar (11.05.2026): кнопки календарной системы.
    if (action === 'skip-mission') {
      if (typeof skipMission === 'function') skipMission();
      return;
    }
    if (action === 'month-end-close') {
      // Сбрасываем монт-саммари и перерисовываем. Модалка исчезнет;
      // под ней останется тот экран лагеря, на котором игрок был.
      state.monthEndSummary = null;
      if (typeof saveToLocalStorage === 'function') {
        try { saveToLocalStorage(); } catch (e) { console.warn(e); }
      }
      if (typeof render === 'function') render();
      return;
    }
    if (action === 'select-hero') {
      const id = btn.getAttribute('data-hero-id');
      if (id) {
        // Camp v2-economy (13.05.2026): toggle pin — повторный клик
        // по уже закреплённому герою закрывает панель. Иначе закрепляем.
        state.selectedUnitId = (state.selectedUnitId === id) ? null : id;
        if (typeof render === 'function') render();
      }
      return;
    }
    // Camp v2-economy (13.05.2026): кнопка «×» в инфо-панели — снять
    // закрепление. hover-режим вернётся сам по mouseover.
    if (action === 'close-hero-info') {
      state.selectedUnitId = null;
      state.hoveredHeroId = null;
      if (typeof render === 'function') render();
      return;
    }
    if (action === 'new-run') {
      if (!confirm('Начать новый забег? Текущий прогресс будет потерян.')) return;
      if (typeof restartGame === 'function') restartGame();
      return;
    }
    if (action === 'export-save') {
      if (typeof exportSaveJson !== 'function') return;
      const json = exportSaveJson();
      try {
        navigator.clipboard.writeText(json).then(
          () => alert('Сейв скопирован в буфер обмена'),
          () => _showSaveText(json)
        );
      } catch (e) {
        _showSaveText(json);
      }
      return;
    }
  }

  function _showSaveText(json) {
    alert('Сейв (скопируй вручную):\n\n' + json);
  }

  function renderCampOverlay() {
    const overlay = ensureOverlay();
    if (!state || !state.campScreen) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      return;
    }
    overlay.style.display = 'flex';
    // Camp v1.5-calendar (11.05.2026): если только что закончился месяц,
    // показываем модалку ПОВЕРХ обычного экрана. Сама модалка — внутри
    // того же overlay, поэтому используем wrapper с двумя слоями.
    let inner = '';
    if (state.campScreen === 'main') inner = buildMainHtml();
    else if (state.campScreen === 'globalMap') inner = buildGlobalMapHtml();
    else if (state.campScreen === 'missionSetup') inner = buildMissionSetupHtml();
    else if (state.campScreen === 'hire') inner = buildHireHtml();
    else if (state.campScreen === 'shop') inner = buildShopHtml();
    // Camp v2-economy (13.05.2026): панель информации о герое — рендерится
    // поверх лагерного оверлея. Показывает данные ховер/закреплённого героя
    // (приоритет — закреплённый, т.е. selectedUnitId). На главном и hire
    // экранах есть кнопка «select-hero» в карточках героев.
    const infoHero = _heroForInfoPanel();
    if (infoHero) {
      inner += buildHeroInfoPanel(infoHero, state.selectedUnitId === infoHero.id);
    }
    if (state.monthEndSummary) {
      overlay.innerHTML = inner + '<div class="me-overlay">' + buildMonthEndHtml() + '</div>';
    } else {
      overlay.innerHTML = inner;
    }
  }

  /* Camp v1.5-threats (09.05.2026): человекочитаемое имя группы врагов
     и список её классов. Источник правды — WAVE_GROUPS в core/state.js
     (через id), CLASSES для имён конкретных классов. Возвращает
     { groupName, classNames: [string], iconHint } — или null, если
     группа неизвестна. */
  const THREAT_LABELS = {
    undead: 'Нежить',
    wolves: 'Волки'
  };
  function threatInfo(threatId) {
    if (!threatId || typeof WAVE_GROUPS === 'undefined') return null;
    const group = WAVE_GROUPS.find(g => g && g.id === threatId);
    if (!group) return null;
    const groupName = THREAT_LABELS[group.id] || group.id;
    const classIds = [];
    if (Array.isArray(group.regulars)) classIds.push.apply(classIds, group.regulars);
    else if (group.regular) classIds.push(group.regular);
    if (group.leader && CLASSES[group.leader]) classIds.push(group.leader);
    const classNames = classIds.map(id => (CLASSES[id] && CLASSES[id].name) || id);
    return { groupName, classNames };
  }

  /* Camp v1.5-calendar (11.05.2026): человекочитаемая дата для шапки. */
  function formatDate(cal) {
    if (!cal) return '';
    return 'Неделя ' + (cal.week | 0) + ' · Месяц ' + (cal.month | 0) + ' · Год ' + (cal.year | 0);
  }

  /* Camp v1.5-calendar (11.05.2026): цветовая дифференциация теперь идёт
     по уровню нестабильности региона, а не по абсолютной сложности.
     Шкала: ≤0 — зелёный (стабильно), 1 — синий, 2 — жёлтый, 3 — оранжевый,
     4+ — красный. Подпись «Лёгкий/Средний/...» убрана, в бейдже теперь
     просто «Сложность X». Функция оставлена под старым именем
     difficultyClass, но логически — instabilityClass. */
  function difficultyClass(inst) {
    const i = inst | 0;
    if (i <= 0) return 'inst-green';
    if (i === 1) return 'inst-blue';
    if (i === 2) return 'inst-yellow';
    if (i === 3) return 'inst-orange';
    return 'inst-red';
  }

  function buildMainHtml() {
    const party = Array.isArray(state.party) ? state.party : [];
    const heroes = party.filter(u => {
      if (!u || !u.alive) return false;
      const cls = CLASSES[u.classId];
      return cls && cls.kind !== 'monster';
    });
    const heroRows = heroes.map(renderHeroRow).join('');
    const waveLabel = (state.wave && Number.isFinite(state.wave.number) && state.wave.number > 0)
      ? `Миссий пройдено: ${state.wave.number} · ${formatDate(state.calendar)}`
      : `Лагерь готов к первой миссии · ${formatDate(state.calendar)}`;
    const inventoryCount = (state.partyInventory || []).filter(Boolean).length;
    const aliveCount = heroes.length;
    const restingCount = heroes.filter(h => (h.restingTurnsLeft | 0) > 0).length;
    // Camp v2-economy (13.05.2026): счётчик золота и прогноз зарплаты.
    const gold = (state.gold | 0);
    const goldLabel = (gold < 0 ? '−' + Math.abs(gold) : String(gold)) + ' g';
    const goldClass = gold < 0 ? 'camp-gold negative' : 'camp-gold';
    const salaryForecast = (typeof partySalaryTotal === 'function')
      ? partySalaryTotal(state.party)
      : 0;
    const debtBadge = ((state.debtMonths | 0) > 0)
      ? ` · <span class="camp-debt-badge" title="Месяцев в долгу подряд">долг ${state.debtMonths} мес.</span>`
      : '';
    return `
      <div class="camp-content">
        <div class="camp-header">
          <div class="camp-title">Лагерь</div>
          <div class="camp-subtitle">${escapeHtml(waveLabel)} · героев в партии: ${aliveCount}${restingCount ? ' · отдыхают: ' + restingCount : ''}${debtBadge}</div>
          <div class="${goldClass}" title="Текущий баланс казны. Зарплата ${salaryForecast} g списывается в начале каждого месяца.">
            💰 ${escapeHtml(goldLabel)}
            <span class="camp-gold-forecast">зарплата ${salaryForecast} g/мес</span>
          </div>
        </div>
        <div class="camp-body">
          <div class="camp-section camp-heroes">
            <div class="camp-section-title">Команда</div>
            ${heroRows || '<div class="camp-empty">Нет живых героев</div>'}
          </div>
          <div class="camp-section camp-actions">
            <div class="camp-section-title">Действия</div>
            <button class="camp-btn camp-btn-primary" data-camp-action="open-map">⛰ Глобальная карта</button>
            <button class="camp-btn" data-camp-action="open-hire">⚒ Найм наёмников</button>
            <button class="camp-btn" data-camp-action="open-shop">🏪 Магазин</button>
            <button class="camp-btn" data-camp-action="open-inventory">🎒 Снаряжение отряда (I)</button>
            <div class="camp-btn-row">
              <button class="camp-btn camp-btn-small" data-camp-action="export-save" title="Скопировать сейв в буфер">💾 Экспорт</button>
              <button class="camp-btn camp-btn-small camp-btn-danger" data-camp-action="new-run" title="Сбросить и начать заново">↻ Новый забег</button>
            </div>
            <div class="camp-info">Предметов в инвентаре: ${inventoryCount}</div>
          </div>
        </div>
      </div>`;
  }

  /* Camp v2-economy (13.05.2026): экран найма. Список из ECONOMY.POOL_SIZE
     кандидатов с уровнем, ценой найма и содержанием. Каждый — кнопка
     «Нанять». Кнопка disabled если не хватает золота (но позволяем уйти
     в долг — по дизайну долг это допустимое состояние).
     На самом деле disable не ставим, потому что DESIGN: «найм всегда
     доступен, стоимость уходит в долг». Просто подсвечиваем «уйдёшь в долг». */
  function buildHireHtml() {
    const pool = Array.isArray(state.recruitPool) ? state.recruitPool : [];
    const gold = (state.gold | 0);
    // Camp v2-economy (13.05.2026): слева — текущая команда. Игрок видит,
    // кто уже нанят, и принимает решение «брать четвёртого мага или
    // лучше воина».
    const party = Array.isArray(state.party) ? state.party : [];
    const heroes = party.filter(u => {
      if (!u || !u.alive) return false;
      const cls = CLASSES[u.classId];
      return cls && cls.kind !== 'monster';
    });
    const heroRows = heroes.map(renderHeroRow).join('');
    const cards = pool.map(rec => {
      const cls = CLASSES[rec.classId] || {};
      const visualHtml = (typeof classVisualHtml === 'function') ? classVisualHtml(cls) : (cls.visual && cls.visual.symbol) || '?';
      const upkeepEst = Math.round((typeof ECONOMY !== 'undefined' ? ECONOMY.U_BASE : 100) * rec.level * (rec.upkeepMultiplier || 1.0));
      const willGoNegative = (gold - rec.hireCost) < 0;
      const warnText = willGoNegative
        ? `<div class="hire-warn">⚠ Уйдёт в долг (баланс станет ${gold - rec.hireCost} g)</div>`
        : '';
      const upkeepNote = (Math.abs((rec.upkeepMultiplier || 1.0) - 1.0) < 0.05)
        ? ''
        : (rec.upkeepMultiplier > 1.0 ? ' <span class="hire-mult-bad">(жадный)</span>' : ' <span class="hire-mult-good">(скромный)</span>');
      return `
        <div class="hire-card">
          <div class="hire-visual">${visualHtml}</div>
          <div class="hire-info">
            <div class="hire-name">${escapeHtml(cls.name || rec.classId)}</div>
            <div class="hire-level">Уровень ${rec.level}</div>
            <div class="hire-line">Найм: <strong>${rec.hireCost} g</strong></div>
            <div class="hire-line">Содержание: <strong>${upkeepEst} g/мес</strong>${upkeepNote}</div>
            ${warnText}
          </div>
          <button class="camp-btn camp-btn-primary hire-btn" data-camp-action="do-hire" data-recruit-nonce="${rec.nonce}">Нанять</button>
        </div>`;
    }).join('');
    const heading = pool.length
      ? `<div class="camp-section-title">В лагерь пришли ${pool.length} кандидатов</div>`
      : `<div class="camp-section-title">Кандидатов нет — никто пока не пришёл в лагерь</div>`;
    return `
      <div class="camp-content">
        <div class="camp-header">
          <div class="camp-title">Найм</div>
          <div class="camp-subtitle">Уровень кандидатов: 60-80% от самого прокачанного. Невостребованные исчезнут после следующей миссии.</div>
          <div class="camp-gold${gold < 0 ? ' negative' : ''}">💰 ${gold < 0 ? '−' + Math.abs(gold) : gold} g</div>
        </div>
        <div class="camp-body camp-body-hire">
          <div class="camp-section camp-heroes">
            <div class="camp-section-title">Команда (${heroes.length})</div>
            ${heroRows || '<div class="camp-empty">Партия пуста</div>'}
          </div>
          <div class="camp-section">
            ${heading}
            <div class="hire-grid">${cards}</div>
            <button class="camp-btn camp-btn-back" data-camp-action="back-camp">← В лагерь</button>
          </div>
        </div>
      </div>`;
  }

  /* Camp v2-economy/shop (14.05.2026): экран магазина. Слева — общий
     инвентарь отряда, справа — 6 случайных позиций ассортимента. DnD:
     тащим из магазина в инвентарь — покупаем (если хватает золота).
     Тащим из инвентаря в магазин — продаём за 35% от цены покупки. */
  function buildShopHtml() {
    const gold = (state.gold | 0);
    const partyInv = Array.isArray(state.partyInventory) ? state.partyInventory : [];
    const shopInv = Array.isArray(state.shopInventory) ? state.shopInventory : [];

    function _shopCellHtml(item, action, idx) {
      if (!item) {
        return '<div class="shop-cell empty" data-shop-slot="' + idx + '"></div>';
      }
      const name = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || item.baseId || 'предмет');
      const sprite = item.spriteSrc
        ? `<img src="${escapeAttr(item.spriteSrc)}" alt="${escapeAttr(name)}">`
        : escapeHtml(item.icon || '•');
      const tipLines = [name];
      if (typeof buildItemDetailLines === 'function') {
        for (const l of buildItemDetailLines(item)) tipLines.push(l);
      }
      const buyPrice = (typeof itemGoldPrice === 'function') ? itemGoldPrice(item) : 0;
      const sellPrice = (typeof itemSellPrice === 'function') ? itemSellPrice(item) : 0;
      const priceLabel = (action === 'buy-item') ? (buyPrice + ' g') : (sellPrice + ' g');
      tipLines.push(action === 'buy-item'
        ? 'Цена покупки: ' + buyPrice + ' g'
        : 'Цена продажи: ' + sellPrice + ' g (35% от ' + buyPrice + ')');
      const insufficient = (action === 'buy-item' && gold < buyPrice);
      const cellCls = 'shop-cell filled' + (insufficient ? ' insufficient' : '');
      return `<div class="${cellCls}"
                   draggable="true"
                   data-shop-drag="${action}"
                   data-item-id="${escapeAttr(item.id)}"
                   data-shop-slot="${idx}"
                   title="${escapeAttr(tipLines.join('\n'))}">
        <div class="shop-cell-icon">${sprite}</div>
        <div class="shop-cell-name">${escapeHtml(name)}</div>
        <div class="shop-cell-price">${escapeHtml(priceLabel)}</div>
      </div>`;
    }

    const partyCellsHtml = partyInv.map((it, idx) => _shopCellHtml(it, 'sell-item', idx)).join('');
    const shopSize = (typeof ECONOMY !== 'undefined') ? ECONOMY.SHOP_SIZE : 6;
    const shopCellsHtml = [];
    for (let i = 0; i < shopSize; i++) {
      shopCellsHtml.push(_shopCellHtml(shopInv[i] || null, 'buy-item', i));
    }

    return `
      <div class="camp-content shop-content">
        <div class="camp-header">
          <div class="camp-title">Магазин</div>
          <div class="camp-subtitle">Перетащи справа налево — купить (нельзя в долг). Слева направо — продать за 35% цены.</div>
          <div class="camp-gold${gold < 0 ? ' negative' : ''}">💰 ${gold < 0 ? '−' + Math.abs(gold) : gold} g</div>
        </div>
        <div class="camp-body shop-body">
          <div class="camp-section shop-section shop-party" data-shop-drop="sell">
            <div class="camp-section-title">Инвентарь отряда</div>
            <div class="shop-grid">${partyCellsHtml || '<div class="camp-empty">Инвентарь пуст</div>'}</div>
          </div>
          <div class="camp-section shop-section shop-store" data-shop-drop="buy">
            <div class="camp-section-title">Прилавок</div>
            <div class="shop-grid shop-grid-fixed">${shopCellsHtml.join('')}</div>
            <button class="camp-btn camp-btn-back" data-camp-action="back-camp">← В лагерь</button>
          </div>
        </div>
      </div>`;
  }

  /* Camp v2-economy (13.05.2026): какого героя показать в инфо-панели.
     Приоритет — закреплённый (selectedUnitId), затем ховер (hoveredHeroId).
     Возвращает hero-объект или null. */
  function _heroForInfoPanel() {
    if (!state || !Array.isArray(state.party)) return null;
    const pinned = state.selectedUnitId
      ? state.party.find(h => h && h.id === state.selectedUnitId)
      : null;
    if (pinned && pinned.alive) return pinned;
    const hovered = state.hoveredHeroId
      ? state.party.find(h => h && h.id === state.hoveredHeroId)
      : null;
    if (hovered && hovered.alive) return hovered;
    return null;
  }

  /* Camp v2-economy (13.05.2026): HTML панели с подробностями героя.
     Содержит характеристики, выученные навыки и снаряжение. Если pinned
     (закреплено кликом) — есть кнопка закрытия и игрок может водить
     курсором по элементам, чтобы увидеть тултипы.
     На каждый стат/навык/предмет ставим title="..." — tooltip.js
     автоматически отрисует фэнтези-тултип. */
  function buildHeroInfoPanel(hero, pinned) {
    const cls = CLASSES[hero.classId] || {};
    const visualHtml = (typeof classVisualHtml === 'function') ? classVisualHtml(cls) : (cls.visual && cls.visual.symbol) || '?';
    const lvl = hero.level | 0;
    const hpMax = (typeof maxHpOf === 'function') ? maxHpOf(hero) : hero.hp;
    const manaMax = (typeof maxManaOf === 'function') ? maxManaOf(hero) : hero.mana;
    const upkeep = (typeof heroMonthlyUpkeep === 'function') ? heroMonthlyUpkeep(hero) : 0;
    const projected = (typeof heroProjectedUpkeep === 'function') ? heroProjectedUpkeep(hero) : upkeep;
    const projectionHtml = (projected !== upkeep)
      ? ` <span class="info-upkeep-next" title="Оклад пересмотрят в начале следующего месяца">(→ ${projected} g)</span>`
      : '';

    // === Характеристики ===
    // Полный тултип «база + модификаторы + итого» — как на нижней панели в бою.
    // Источник правды: statBreakdown(unit), общая со всем остальным UI.
    const sbd = (typeof statBreakdown === 'function') ? statBreakdown(hero) : null;
    const eff = (typeof effectiveStats === 'function') ? effectiveStats(hero) : (hero.stats || {});
    const statOrder = (typeof STAT_ORDER !== 'undefined' && Array.isArray(STAT_ORDER))
      ? STAT_ORDER : ['str', 'vit', 'dex', 'spd', 'wis', 'int', 'luk'];
    const statsHtml = statOrder.map(key => {
      const row = sbd ? sbd[key] : null;
      const total = row ? row.total : ((eff[key] | 0));
      const base  = row ? row.base : total;
      const label = (typeof STAT_LABELS === 'object' && STAT_LABELS && STAT_LABELS[key]) || key;
      const iconHtml = (typeof statIconHtml === 'function') ? statIconHtml(key, label, { classPrefix: 'info-stat' }) : '';
      const tipLines = [label, 'База: ' + base];
      if (row && Array.isArray(row.mods)) {
        for (const m of row.mods) {
          const sign = m.delta > 0 ? '+' : '−';
          tipLines.push((m.name || 'эффект') + ': ' + sign + Math.abs(m.delta));
        }
      }
      tipLines.push('Итого: ' + total);
      const tip = tipLines.join('\n');
      return `<div class="info-stat" title="${escapeAttr(tip)}">
        <span class="info-stat-icon">${iconHtml}</span>
        <span class="info-stat-label">${escapeHtml(label)}</span>
        <span class="info-stat-value">${total}</span>
      </div>`;
    }).join('');

    // === Навыки ===
    const learned = (typeof getLearnedSkills === 'function') ? getLearnedSkills(hero) : { active: [], passive: [] };
    const tierLabel = { basic: 'Б', advanced: 'П', elite: 'Э' };
    const tierFullLabel = { basic: 'Базовый', advanced: 'Продвинутый', elite: 'Элитный' };
    function _skillRowHtml(s, kindLabel) {
      const sk = (typeof SKILLS !== 'undefined' && SKILLS) ? SKILLS[s.id] : null;
      const name = (sk && sk.name) || s.id;
      const tierBadge = tierLabel[s.tier] || '?';
      // Иконка: pixel-art спрайт через getUnitSkillParams (учитывает
      // тиры — у некоторых навыков на advanced/elite спрайт другой).
      // Fallback на SKILLS[id].spriteSrc, затем на эмодзи sk.icon.
      let spriteSrc = null;
      let emojiIcon = (sk && sk.icon) ? sk.icon : '•';
      if (typeof getUnitSkillParams === 'function') {
        const p = getUnitSkillParams(hero, s.id);
        if (p && p.spriteSrc) spriteSrc = p.spriteSrc;
        else if (sk && sk.spriteSrc) spriteSrc = sk.spriteSrc;
        if (p && p.icon) emojiIcon = p.icon;
      } else if (sk && sk.spriteSrc) {
        spriteSrc = sk.spriteSrc;
      }
      const iconHtml = spriteSrc
        ? `<img src="${escapeAttr(spriteSrc)}" alt="${escapeAttr(name)}">`
        : escapeHtml(emojiIcon);
      // Полный тултип навыка — общая функция buildSkillTooltipText.
      let tip;
      if (typeof buildSkillTooltipText === 'function') {
        tip = buildSkillTooltipText(s.id, s.tier, hero);
      } else {
        const desc = (sk && sk.desc) ? sk.desc : '';
        tip = name + ' — ' + (tierFullLabel[s.tier] || s.tier) + ' тир'
            + (desc ? '. ' + desc : '');
      }
      return `<div class="info-skill" title="${escapeAttr(tip)}">
        <span class="info-skill-icon">${iconHtml}</span>
        <span class="info-skill-name">${escapeHtml(name)}</span>
        <span class="info-skill-tier tier-${escapeAttr(s.tier)}">${tierBadge}</span>
      </div>`;
    }
    const activeHtml = learned.active.length
      ? learned.active.map(s => _skillRowHtml(s, 'active')).join('')
      : '<div class="info-empty">— нет —</div>';
    const passiveHtml = learned.passive.length
      ? learned.passive.map(s => _skillRowHtml(s, 'passive')).join('')
      : '<div class="info-empty">— нет —</div>';

    // === Снаряжение ===
    const eq = hero.equipment || {};
    const slotLabels = {
      weapon: 'Оружие', armor: 'Броня', amulet: 'Амулет',
      ring: 'Кольцо', consumable: 'Расходник'
    };
    function _slotHtml(key) {
      const slot = eq[key];
      const label = slotLabels[key] || key;
      let name = '— пусто —';
      let spriteSrc = null;
      let emojiIcon = '';
      const tipLines = [label];
      if (slot) {
        if (typeof slot === 'string') {
          const w = (typeof WEAPONS !== 'undefined' && WEAPONS) ? WEAPONS[slot] : null;
          name = (w && w.name) || slot;
          if (w) {
            spriteSrc = w.spriteSrc || null;
            emojiIcon = w.icon || '';
          }
          if (typeof buildItemDetailLines === 'function' && w) {
            tipLines.push('Базовое оружие класса');
            const lines = buildItemDetailLines(w, hero);
            for (const l of lines) tipLines.push(l);
          } else {
            tipLines.push(name);
          }
        } else if (typeof slot === 'object') {
          name = (typeof itemFullName === 'function') ? itemFullName(slot) : (slot.name || slot.baseId || 'предмет');
          spriteSrc = slot.spriteSrc || null;
          emojiIcon = slot.icon || '';
          if (typeof buildItemDetailLines === 'function') {
            const lines = buildItemDetailLines(slot, hero);
            for (const l of lines) tipLines.push(l);
          } else {
            tipLines.push(name);
          }
        }
      } else {
        tipLines.push('пусто');
      }
      const tip = tipLines.join('\n');
      const iconHtml = spriteSrc
        ? `<img src="${escapeAttr(spriteSrc)}" alt="${escapeAttr(name)}">`
        : (emojiIcon ? escapeHtml(emojiIcon) : '');
      return `<div class="info-eq-slot${slot ? '' : ' empty'}" title="${escapeAttr(tip)}">
        <span class="info-eq-icon">${iconHtml}</span>
        <span class="info-eq-text">
          <span class="info-eq-label">${escapeHtml(label)}</span>
          <span class="info-eq-name">${escapeHtml(name)}</span>
        </span>
      </div>`;
    }
    const equipmentHtml = ['weapon', 'armor', 'amulet', 'ring', 'consumable']
      .map(_slotHtml).join('');

    const closeBtn = pinned
      ? `<button class="info-close" data-camp-action="close-hero-info" title="Закрыть (Esc)">×</button>`
      : '';
    return `
      <div class="hero-info-panel${pinned ? ' pinned' : ' hovered'}">
        <div class="info-header">
          <div class="info-visual">${visualHtml}</div>
          <div class="info-title-block">
            <div class="info-name">${escapeHtml(cls.name || hero.classId)}</div>
            <div class="info-meta">Уровень ${lvl} · ${hero.hp}/${hpMax} HP · ${hero.mana}/${manaMax} маны</div>
            <div class="info-upkeep">💰 ${upkeep} g/мес${projectionHtml}</div>
          </div>
          ${closeBtn}
        </div>
        <div class="info-body">
          <div class="info-section">
            <div class="info-section-title">Характеристики</div>
            <div class="info-stats">${statsHtml}</div>
          </div>
          <div class="info-section">
            <div class="info-section-title">Активные навыки</div>
            <div class="info-skills">${activeHtml}</div>
          </div>
          <div class="info-section">
            <div class="info-section-title">Пассивные навыки</div>
            <div class="info-skills">${passiveHtml}</div>
          </div>
          <div class="info-section">
            <div class="info-section-title">Снаряжение</div>
            <div class="info-equipment">${equipmentHtml}</div>
          </div>
        </div>
      </div>`;
  }

  function renderHeroRow(hero) {
    const cls = CLASSES[hero.classId] || {};
    const isSelected = (state.selectedUnitId === hero.id);
    const visualHtml = (typeof classVisualHtml === 'function') ? classVisualHtml(cls) : (cls.visual && cls.visual.symbol) || '?';
    const lvl = hero.level | 0;
    const hpMax = (typeof maxHpOf === 'function') ? maxHpOf(hero) : hero.hp;
    const manaMax = (typeof maxManaOf === 'function') ? maxManaOf(hero) : hero.mana;
    const resting = (hero.restingTurnsLeft | 0) > 0;
    const restingBadge = resting
      ? `<span class="camp-hero-resting" title="Отдых ${hero.restingTurnsLeft} миссию">💤 отдых ${hero.restingTurnsLeft}</span>`
      : '';
    // Camp v2-economy (13.05.2026): месячный оклад. Считается по paidLevel
    // (зафиксированный уровень при последнем пересмотре в начале месяца).
    // Если hero.level вырос с момента пересмотра — в скобках показываем
    // прогноз новой ставки, которая вступит в силу в начале следующего
    // месяца. Метку «жадный/скромный» здесь НЕ показываем — она видна
    // только в окне найма.
    const upkeep = (typeof heroMonthlyUpkeep === 'function') ? heroMonthlyUpkeep(hero) : 0;
    const projected = (typeof heroProjectedUpkeep === 'function') ? heroProjectedUpkeep(hero) : upkeep;
    const upkeepProjection = (projected !== upkeep)
      ? ` <span class="camp-hero-upkeep-next" title="Оклад пересмотрят в начале следующего месяца — герой подрос с момента найма/последнего пересмотра">(→ ${projected} g)</span>`
      : '';
    return `
      <button class="camp-hero${isSelected ? ' selected' : ''}${resting ? ' resting' : ''}" data-camp-action="select-hero" data-hero-id="${escapeAttr(hero.id)}">
        <span class="camp-hero-visual">${visualHtml}</span>
        <span class="camp-hero-info">
          <span class="camp-hero-name">${escapeHtml(cls.name || hero.classId)} ${restingBadge}</span>
          <span class="camp-hero-lvl">Уровень ${lvl}</span>
          <span class="camp-hero-stats">${hero.hp}/${hpMax} HP · ${hero.mana}/${manaMax} маны</span>
          <span class="camp-hero-upkeep" title="Списывается в начале каждого месяца">💰 ${upkeep} g/мес${upkeepProjection}</span>
        </span>
      </button>`;
  }

  function buildGlobalMapHtml() {
    const regions = Array.isArray(state.regions) ? state.regions : [];
    const party = Array.isArray(state.party) ? state.party : [];
    const availableHeroes = party.filter(h => h && h.alive && (h.restingTurnsLeft | 0) === 0);
    const cantStart = availableHeroes.length === 0;
    const cards = regions.map(r => {
      const diff = r.difficulty | 0;
      const inst = r.instability | 0;
      const previewDiff = Math.max(1, diff + inst);
      // Camp v1.5-calendar: цвет карточки/бейджа — по нестабильности.
      const dCls = difficultyClass(inst);
      const ti = threatInfo(r.currentThreat);
      const threatLine = ti
        ? `Заказ: истребить — <strong>${escapeHtml(ti.groupName)}</strong>`
        : 'Заказ: уничтожить любую угрозу в регионе';
      // Camp v1.5-calendar (11.05.2026): нестабильность — отдельный
      // бейдж справа от бейджа сложности (в шапке карточки). Внизу —
      // короткая строка-прогноз: к началу месяца сложность станет N ↑/↓.
      // Если inst=0 — без стрелки. instSign формируется для бейджа:
      // «+2», «−1», «0».
      // Camp v1.5-calendar UI-полировка: знак «+» не пишем, только число.
      // Минус — настоящий «−» (U+2212) для типографической ровности.
      const instSign = inst < 0 ? '−' + Math.abs(inst) : String(inst);
      const instCls = inst > 0 ? 'inst-up' : (inst < 0 ? 'inst-down' : 'inst-zero');
      const instTip = inst === 0
        ? 'Нестабильность региона: 0 — сложность к началу месяца не изменится.'
        : (inst > 0
            ? 'Нестабильность региона: ' + inst + '. К началу следующего месяца сложность вырастет до ' + previewDiff + '.'
            : 'Нестабильность региона: −' + Math.abs(inst) + '. К началу следующего месяца сложность снизится до ' + previewDiff + '.');
      let forecastLine;
      if (inst > 0) forecastLine = `К началу месяца сложность станет ${previewDiff} ↑`;
      else if (inst < 0) forecastLine = `К началу месяца сложность станет ${previewDiff} ↓`;
      else forecastLine = `К началу месяца сложность не изменится`;
      // Camp v2-economy (13.05.2026): конкретная сумма награды, выставленная
      // регионом. Зафиксирована в region.rewardOffer при появлении заказа.
      // Если поля по какой-то причине нет (defensive) — ролим прямо сейчас.
      let rewardOffer = (typeof r.rewardOffer === 'number' && r.rewardOffer > 0) ? r.rewardOffer : 0;
      if (rewardOffer <= 0 && typeof rollRewardForDifficulty === 'function') {
        rewardOffer = rollRewardForDifficulty(diff);
        r.rewardOffer = rewardOffer;
      }
      const rewardTip = 'Награда за выполнение заказа в регионе.';
      return `
        <div class="camp-mission ${dCls}">
          <div class="camp-mission-head">
            <div class="camp-mission-name">${escapeHtml(r.name || r.id)}</div>
            <div class="camp-mission-badges">
              <div class="camp-mission-badge" title="Сложность региона">Сложность ${diff}</div>
              <div class="camp-mission-inst-badge ${instCls}" title="${escapeAttr(instTip)}">Нестабильность ${instSign}</div>
            </div>
          </div>
          <div class="camp-mission-desc">${threatLine}</div>
          <div class="camp-mission-reward" title="${escapeAttr(rewardTip)}">💰 Награда: <strong>${rewardOffer} g</strong></div>
          <div class="camp-mission-instability">${escapeHtml(forecastLine)}</div>
          <button class="camp-btn camp-btn-primary" data-camp-action="pick-region" data-region-id="${escapeAttr(r.id)}"${cantStart ? ' disabled' : ''}>⚔ Выбрать отряд</button>
        </div>`;
    }).join('');
    const subtitle = cantStart
      ? 'Все герои мертвы или отдыхают — миссии недоступны.'
      : `Доступно героев для миссии: ${availableHeroes.length}.`;
    return `
      <div class="camp-content">
        <div class="camp-header">
          <div class="camp-title">Глобальная карта · ${escapeHtml(formatDate(state.calendar))}</div>
          <button class="camp-back" data-camp-action="back-camp" title="Назад в лагерь">← Назад</button>
        </div>
        <div class="camp-body">
          <div class="camp-section camp-map">
            <div class="camp-section-title">Регионы</div>
            <div class="camp-info" style="margin-bottom:8px;">${escapeHtml(subtitle)}</div>
            ${cards || '<div class="camp-empty">Нет доступных регионов</div>'}
            <div class="camp-skip-block">
              <button class="camp-btn" data-camp-action="skip-mission" title="Пропустить неделю — отряд отдохнёт, но нестабильность во всех регионах вырастет">⏭ Пропустить миссию (отдых)</button>
              <div class="camp-info" style="margin-top:4px;">Тратит неделю. Все герои отдыхают (счётчик отдыха −1). Нестабильность во ВСЕХ регионах +1.</div>
            </div>
          </div>
        </div>
      </div>`;
  }

  /* Camp v1.5-calendar (11.05.2026): модалка «начало месяца». Показывается
     поверх campScreen, если state.monthEndSummary не null. Содержит
     пер-региональную таблицу «было → стало» и кнопку «Продолжить».
     Клик по кнопке: state.monthEndSummary = null + render → модалка
     исчезает. Дальнейшие действия игрока — обычные. */
  function buildMonthEndHtml() {
    const s = state.monthEndSummary;
    if (!s) return '';
    const rows = (s.deltas || []).map(d => {
      const arrow = d.delta > 0 ? '↑' : (d.delta < 0 ? '↓' : '·');
      const sign = d.delta > 0 ? '+' + d.delta : String(d.delta);
      // Camp v1.5-calendar: цвет строки итогов — по применённой
      // нестабильности (d.instability), не по итоговой сложности.
      const dCls = difficultyClass(d.instability);
      return `
        <div class="me-row ${dCls}">
          <div class="me-name">${escapeHtml(d.name)}</div>
          <div class="me-change">${d.before} → ${d.after} <span class="me-delta">(${sign}) ${arrow}</span></div>
        </div>`;
    }).join('');
    return `
      <div class="me-content">
        <div class="me-header">
          <div class="me-title">Наступил Месяц ${s.month}</div>
          <div class="me-subtitle">Год ${s.year} · сложности регионов пересчитаны</div>
        </div>
        <div class="me-body">${rows || '<div class="camp-empty">Нет регионов</div>'}</div>
        <div class="me-footer">
          <button class="camp-btn camp-btn-primary" data-camp-action="month-end-close">Продолжить</button>
        </div>
      </div>`;
  }

  /* Camp v1.5-UI: экран выбора отряда. */
  function buildMissionSetupHtml() {
    const regionId = state.pendingMissionRegionId;
    const region = (state.regions || []).find(r => r && r.id === regionId);
    if (!region) {
      return `<div class="camp-content"><div class="camp-empty">Регион не найден. <button class="camp-btn" data-camp-action="mission-back">← Назад</button></div></div>`;
    }
    const diff = region.difficulty | 0;
    // Camp v1.5-calendar: цвет шапки миссии — по нестабильности региона.
    const dCls = difficultyClass(region.instability | 0);
    const party = Array.isArray(state.party) ? state.party : [];
    const selected = Array.isArray(state.pendingMissionHeroIds) ? state.pendingMissionHeroIds : [];
    const cards = party.map(h => renderMissionHeroCard(h, selected)).join('');
    const selectedCount = selected.length;
    const canConfirm = selectedCount > 0;
    return `
      <div class="camp-content camp-content-mission">
        <div class="camp-header">
          <div class="camp-title">Подготовка миссии</div>
          <button class="camp-back" data-camp-action="mission-back" title="К выбору региона">← К карте</button>
        </div>
        <div class="camp-body camp-body-mission">
          <div class="camp-mission-header ${dCls}">
            <div class="camp-mission-head">
              <div class="camp-mission-name">${escapeHtml(region.name)}</div>
              <div class="camp-mission-badge">Сложность ${diff}</div>
            </div>
            <div class="camp-mission-desc">${
              (function () {
                const ti = threatInfo(region.currentThreat);
                if (!ti) return 'Уровень монстров масштабируется от сложности региона.';
                const cls = ti.classNames.length ? ' (' + ti.classNames.map(escapeHtml).join(', ') + ')' : '';
                return `Заказ: истребить — <strong>${escapeHtml(ti.groupName)}</strong>${cls}. Уровень монстров масштабируется от сложности региона.`;
              })()
            }</div>
          </div>
          <div class="camp-section-title">Отряд (${selectedCount}/${MAX_SQUAD})</div>
          <div class="camp-mission-roster">${cards || '<div class="camp-empty">Партия пуста</div>'}</div>
          <div class="camp-mission-footer">
            <div class="camp-info">${selectedCount === 0 ? 'Выбери хотя бы одного героя.' : (selectedCount < MAX_SQUAD ? 'Можно добавить ещё ' + (MAX_SQUAD - selectedCount) + '.' : 'Отряд укомплектован полностью.')}</div>
            <div class="camp-btn-row">
              <button class="camp-btn" data-camp-action="mission-back">Отмена</button>
              <button class="camp-btn camp-btn-primary" data-camp-action="mission-confirm"${canConfirm ? '' : ' disabled'}>⚔ Отправить отряд</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderMissionHeroCard(hero, selectedIds) {
    if (!hero) return '';
    const cls = CLASSES[hero.classId] || {};
    const isSelected = selectedIds.indexOf(hero.id) >= 0;
    const visualHtml = (typeof classVisualHtml === 'function') ? classVisualHtml(cls) : (cls.visual && cls.visual.symbol) || '?';
    const lvl = hero.level | 0;
    const hpMax = (typeof maxHpOf === 'function') ? maxHpOf(hero) : hero.hp;
    const manaMax = (typeof maxManaOf === 'function') ? maxManaOf(hero) : hero.mana;
    const resting = (hero.restingTurnsLeft | 0) > 0;
    const dead = !hero.alive;
    const disabled = resting || dead;
    const status = dead ? 'мёртв' : (resting ? `💤 отдых ${hero.restingTurnsLeft}` : '');
    const statusBadge = status ? `<span class="camp-mission-card-status">${escapeHtml(status)}</span>` : '';
    const eqIcons = renderEquipmentIcons(hero);
    const skillIcons = renderSkillIcons(hero);
    return `
      <button class="camp-mission-card${isSelected ? ' selected' : ''}${disabled ? ' disabled' : ''}" data-camp-action="mission-toggle-hero" data-hero-id="${escapeAttr(hero.id)}"${disabled ? ' disabled' : ''}>
        <div class="camp-mission-card-head">
          <span class="camp-mission-card-visual">${visualHtml}</span>
          <span class="camp-mission-card-info">
            <span class="camp-mission-card-name">${escapeHtml(cls.name || hero.classId)}</span>
            <span class="camp-mission-card-lvl">Уровень ${lvl}${statusBadge ? ' · ' + statusBadge : ''}</span>
          </span>
          ${isSelected ? '<span class="camp-mission-card-check">✓</span>' : ''}
        </div>
        <div class="camp-mission-card-stats">
          <span title="HP">❤ ${hero.hp}/${hpMax}</span>
          <span title="Мана">💧 ${hero.mana}/${manaMax}</span>
        </div>
        ${eqIcons ? `<div class="camp-mission-card-row">${eqIcons}</div>` : ''}
        ${skillIcons ? `<div class="camp-mission-card-row">${skillIcons}</div>` : ''}
      </button>`;
  }

  function renderEquipmentIcons(hero) {
    if (!hero || !hero.equipment) return '';
    const slots = ['weapon', 'armor', 'amulet', 'ring', 'consumable'];
    const out = [];
    for (const k of slots) {
      const it = hero.equipment[k];
      if (!it) continue;
      let label, icon;
      if (typeof it === 'string') {
        const w = (typeof WEAPONS !== 'undefined') ? WEAPONS[it] : null;
        label = (w && w.name) || it;
        icon = (w && w.spriteSrc) ? `<img src="${escapeAttr(w.spriteSrc)}" alt="">` : '⚔';
      } else {
        label = (typeof itemFullName === 'function') ? itemFullName(it) : (it.name || it.id);
        icon = it.spriteSrc ? `<img src="${escapeAttr(it.spriteSrc)}" alt="">` : (it.icon || '?');
      }
      out.push(`<span class="camp-mission-card-eq" title="${escapeAttr(label)}">${icon}</span>`);
    }
    return out.join('');
  }

  function renderSkillIcons(hero) {
    if (!hero) return '';
    let learned = null;
    if (typeof getLearnedSkills === 'function') learned = getLearnedSkills(hero);
    if (!learned) return '';
    const out = [];
    const allSkills = learned.active.concat(learned.passive);
    for (const s of allSkills) {
      const sk = (typeof SKILLS === 'object' && SKILLS) ? SKILLS[s.id] : null;
      if (!sk) continue;
      const tierLabel = (typeof SKILL_TIER_LABELS === 'object' && SKILL_TIER_LABELS && SKILL_TIER_LABELS[s.tier]) || s.tier;
      const title = `${sk.name || s.id} (${tierLabel})`;
      const icon = sk.spriteSrc ? `<img src="${escapeAttr(sk.spriteSrc)}" alt="">` : (sk.icon || '✨');
      out.push(`<span class="camp-mission-card-skill" title="${escapeAttr(title)}">${icon}</span>`);
    }
    return out.join('');
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

  if (typeof window !== 'undefined') {
    window.renderCampOverlay = renderCampOverlay;
  }
})();
