/* render-modals.js — Camp v1.5-popups (12.05.2026)
   ================================================
   Два независимых модальных оверлея, рендерящихся из общего render() в
   render.js. Каждый имеет свой DOM-контейнер (#trophy-overlay,
   #events-overlay) и появляется/исчезает в зависимости от state-поля.

   Оверлеи:
   1) Trophy popup — «Вы получили трофей!». Показывается КОГДА бы то ни
      было state.pendingTrophyPopup != null. По дизайну выставляется в
      forceWaveVictory (после генерации reward), а enterCampMain
      откладывается в advanceLevelUpQueue до закрытия попапа. То есть
      виден на поле боя, после level-up, до перехода в лагерь.

   2) Events popup — «События»/«Ничего примечательного не произошло».
      Показывается КОГДА state.pendingCampEvents != null (массив, может
      быть пустым). Гейтится campScreen — попап появляется только если
      игрок уже в лагере (campScreen != null). Это гарантирует, что он
      не перекроет трофейный попап на поле и не мешает рендерингу боя.

   Z-index: trophy 945, events 942 (между camp 940 и inventory 950).
   Стили для обоих — в styles/camp.css секции «Camp v1.5-popups».

   API:
   - renderTrophyPopup() — главный entry-point, дёргается из render()
   - renderEventsPopup() — то же
   - оба — идемпотентны: показ/скрытие/обновление по текущему state.

   Обработчики «Продолжить» вызывают closeTrophyPopup() /
   closeCampEventsPopup() (определены в state.js). Эти функции
   очищают поля и продолжают переход в лагерь.
   ============================================================== */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  function ensureContainer(id, cls) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = cls;
      document.body.appendChild(el);
    }
    return el;
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

  /* Рендер иконки предмета: для оружия — поиск в WEAPONS; для остального —
     spriteSrc/icon на самом инстансе. Возвращает HTML-строку <img> или
     текстовый emoji. Совпадает с логикой render-inventory.js. */
  function renderItemBigIcon(item) {
    if (!item) return '<span class="trophy-icon-fallback">?</span>';
    if (typeof item === 'string') {
      const w = (typeof WEAPONS !== 'undefined') ? WEAPONS[item] : null;
      const src = (w && w.spriteSrc) || null;
      if (src) return `<img class="trophy-icon" src="${escapeAttr(src)}" alt="${escapeAttr(w && w.name || item)}">`;
      return '<span class="trophy-icon-fallback">⚔</span>';
    }
    if (item.spriteSrc) {
      const name = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || item.id || '');
      return `<img class="trophy-icon" src="${escapeAttr(item.spriteSrc)}" alt="${escapeAttr(name)}">`;
    }
    return `<span class="trophy-icon-fallback">${escapeHtml(item.icon || '?')}</span>`;
  }

  /* SLOT_LABELS — дубль из render-inventory.js, чтобы не тащить
     приватные константы через экспорт. Маленький словарь, проще
     продублировать. */
  const TROPHY_SLOT_LABELS = {
    weapon: 'Оружие',
    armor: 'Броня',
    amulet: 'Амулет',
    ring: 'Кольцо',
    consumable: 'Расходник'
  };

  /* Собрать многострочный тултип предмета — тот же формат, что и в
     инвентаре (см. renderInventoryCell). Используем экспортированный
     buildItemDetailLines из render-inventory.js. */
  function buildTrophyTooltip(item) {
    if (!item || typeof item === 'string') return '';
    const fullName = (typeof itemFullName === 'function') ? itemFullName(item) : (item.name || item.id);
    const slotKindLabel = TROPHY_SLOT_LABELS[item.slotKind] || item.slotKind || '?';
    const detailLines = (typeof buildItemDetailLines === 'function') ? buildItemDetailLines(item) : [];
    return [fullName, slotKindLabel].concat(detailLines).join('\n');
  }

  function renderTrophyPopup() {
    if (typeof state === 'undefined' || !state) return;
    const el = ensureContainer('trophy-overlay', 'trophy-overlay');
    if (!state.pendingTrophyPopup) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    const item = state.pendingTrophyPopup.itemRef;
    const fullName = item
      ? ((typeof itemFullName === 'function') ? itemFullName(item) : (item.name || item.id || 'Трофей'))
      : 'Трофей';
    const tooltip = buildTrophyTooltip(item);
    const tooltipAttr = tooltip ? ` title="${escapeAttr(tooltip)}"` : '';
    el.style.display = 'flex';
    el.innerHTML = `
      <div class="trophy-content">
        <div class="trophy-title">Вы получили трофей!</div>
        <div class="trophy-icon-box"${tooltipAttr}>${renderItemBigIcon(item)}</div>
        <div class="trophy-name">${escapeHtml(fullName)}</div>
        <div class="trophy-footer">
          <button class="camp-btn camp-btn-primary" data-trophy-action="close">Продолжить</button>
        </div>
      </div>`;
    // Делегированный обработчик. Заново вешать на каждом render — нормально:
    // мы перезаписываем innerHTML, ссылки на старые обработчики уходят с
    // DOM-нодами.
    el.onclick = function (e) {
      const t = e.target && e.target.closest && e.target.closest('[data-trophy-action]');
      if (!t) return;
      const a = t.getAttribute('data-trophy-action');
      if (a === 'close') {
        if (typeof closeTrophyPopup === 'function') closeTrophyPopup();
      }
    };
  }

  function renderEventsPopup() {
    if (typeof state === 'undefined' || !state) return;
    const el = ensureContainer('events-overlay', 'events-overlay');
    // Показываем только в лагере (campScreen != null). На поле боя
    // подождём — попап трофея сначала, потом игрок зайдёт в лагерь и
    // тогда попап событий нас встретит.
    const inCamp = !!state.campScreen;
    if (!inCamp || state.pendingCampEvents == null) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    const events = Array.isArray(state.pendingCampEvents) ? state.pendingCampEvents : [];
    let body;
    if (events.length === 0) {
      body = `<div class="events-empty">Ничего примечательного не произошло.</div>`;
    } else {
      const items = events.map(e => `<li class="events-item">${escapeHtml(e && e.text ? e.text : '')}</li>`).join('');
      body = `
        <div class="events-intro">Произошли следующие события:</div>
        <ul class="events-list">${items}</ul>`;
    }
    el.style.display = 'flex';
    el.innerHTML = `
      <div class="events-content">
        <div class="events-title">События</div>
        <div class="events-body">${body}</div>
        <div class="events-footer">
          <button class="camp-btn camp-btn-primary" data-events-action="close">Продолжить</button>
        </div>
      </div>`;
    el.onclick = function (e) {
      const t = e.target && e.target.closest && e.target.closest('[data-events-action]');
      if (!t) return;
      const a = t.getAttribute('data-events-action');
      if (a === 'close') {
        if (typeof closeCampEventsPopup === 'function') closeCampEventsPopup();
      }
    };
  }

  /* Document-level click delegation as a safety net. */
  let _delegationAttached = false;
  function attachClickDelegation() {
    if (_delegationAttached) return;
    _delegationAttached = true;
    document.addEventListener('click', function (e) {
      const t = e.target && e.target.closest && e.target.closest('[data-trophy-action], [data-events-action]');
      if (!t) return;
      const tro = t.getAttribute('data-trophy-action');
      const evt = t.getAttribute('data-events-action');
      try {
        if (tro === 'close' && typeof closeTrophyPopup === 'function') closeTrophyPopup();
        else if (evt === 'close' && typeof closeCampEventsPopup === 'function') closeCampEventsPopup();
      } catch (err) {
        console.error('[render-modals] click handler failed:', err);
      }
    }, false);
  }
  if (typeof document.addEventListener === 'function') attachClickDelegation();


  function renderMissionWarning() {
    if (typeof state === 'undefined' || !state) return;
    const el = ensureContainer('mission-warning-overlay', 'mission-warning-overlay');
    const w = state.pendingMissionWarning;
    if (!w) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    const heroLines = (w.heroes || []).map(h =>
      `<li class="mw-hero">${escapeHtml(h.name)} <span class="mw-hero-level">(ур. ${h.level | 0})</span></li>`
    ).join('');
    el.style.display = 'flex';
    el.innerHTML = `
      <div class="mw-content">
        <div class="mw-title">Внимание: миссия слишком лёгкая</div>
        <div class="mw-body">
          <div class="mw-intro">Сложность миссии: <strong>${w.missionDifficulty | 0}</strong>.</div>
          <div class="mw-intro">Эти герои <strong>не получат уровень</strong> по итогам этой миссии (их уровень на 3 или более выше сложности):</div>
          <ul class="mw-heroes">${heroLines}</ul>
        </div>
        <div class="mw-footer">
          <button class="camp-btn" data-mw-action="cancel">Отмена</button>
          <button class="camp-btn camp-btn-primary" data-mw-action="send-anyway">Отправить всё равно</button>
        </div>
      </div>`;
    el.onclick = function (e) {
      const t = e.target && e.target.closest && e.target.closest('[data-mw-action]');
      if (!t) return;
      const a = t.getAttribute('data-mw-action');
      if (typeof closeMissionWarning === 'function') closeMissionWarning(a);
    };
  }

  window.renderTrophyPopup = renderTrophyPopup;
  window.renderEventsPopup = renderEventsPopup;
  window.renderMissionWarning = renderMissionWarning;
})();
