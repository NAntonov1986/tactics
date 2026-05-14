/* render-level-up.js (render/) — UI окошка прокачки героя (Сессия 25).

   Что внутри:
     • renderLevelUp() — рисует/прячет модальный оверлей по
       state.activeLevelUp. Один контейнер #levelUpOverlay создаётся
       лениво при первом показе и переиспользуется. Контент полностью
       пересобирается из state.activeLevelUp.
     • Click-handler делегируется на корне overlay'а — реагирует на
       data-lu-action ('stat' / 'new-skill' / 'upgrade-skill') и
       data-lu-value (ключ стата / id навыка).

   Состояние модели читается из state.activeLevelUp:
     {
       unitId,    // герой, который сейчас прокачивается
       level,     // достигнутый уровень
       autoStat,  // стат, уже автоматически +1 (показываем в шапке)
       kind,      // см. ниже (правка 06.05.2026 — расширено на 5 значений)
       choices    // массив кандидатов на выбор (формат зависит от kind)
     }

   Возможные kind:
     'stats'                    — чётный уровень: +2 к стату из 7;
     'skills-new'               — нечёт, фаза 1: изучение нового скилла;
     'skills-upgrade-basic'     — нечёт, фаза 2: basic → advanced;
     'skills-upgrade-advanced'  — нечёт, фаза 3: advanced → elite;
     'stat-bonus'               — нечёт, фаза 4 (full-elite): +2 к стату.

   Формат choices:
     'stats' / 'stat-bonus':       ['str','vit',...] — 7 ключей.
     'skills-new':                  [{ kind:'new', skillId }, ...]
     'skills-upgrade-*':            [{ kind:'upgrade', skillId, fromTier }, ...]

   Модальный поведенческий контракт:
     • overlay перекрывает поле боя (z-index выше всех панелей).
     • без autodismiss — игрок ОБЯЗАН выбрать один вариант.
     • если choices пуст (например, все навыки elite и слоты полны) —
       рисуется кнопка «Продолжить» (apply-no-op + finishCurrentLevelUp).

   Внешние имена через script-scope: state, getUnit (state.js); CLASSES
   (data/classes); SKILLS, STAT_LABELS, SKILL_TIER_LABELS
   (data/*); statIconHtml (render/render.js — общий хелпер иконок статов);
   buildSkillTooltipText / buildSkillUpgradeTooltipText (render/skill-tooltip.js);
   applyStatChoice, learnNewSkill, upgradeSkillTier (core/level-up);
   finishCurrentLevelUp (state.js); render (state.js). */

(function () {
  // Кэш корневого элемента overlay'а — переиспользуем.
  let _overlayEl = null;
  // 06.05.2026: snapshot state.view перед показом overlay — нужно
  // принудительно вернуть его при закрытии. Диагностика: после
  // показа overlay state.view.panY мутируется (например с 0 на -94),
  // источник мутации не найден (видимо браузер тригерит resize/wheel
  // во время focus-trap). Snapshot+restore — гарантированный фикс
  // независимо от первопричины.
  let _savedView = null;

  function ensureOverlay() {
    if (_overlayEl && document.body.contains(_overlayEl)) return _overlayEl;
    const el = document.createElement('div');
    el.id = 'levelUpOverlay';
    el.className = 'level-up-overlay';
    el.style.display = 'none';
    document.body.appendChild(el);
    el.addEventListener('click', onOverlayClick);
    _overlayEl = el;
    // Camp v1.5 (09.05.2026): глобальный capture-phase guard на клики
    // вне .lu-window, пока state.activeLevelUp != null. CSS ставит на
    // .level-up-overlay pointer-events:none (чтобы тултипы под ним
    // работали по hover), и без этого guard'а игрок мог бы кликнуть на
    // юнита в очерёдности или на пустую клетку и выбрать другого юнита /
    // запустить режим прицеливания, не сделав выбор прокачки. Capture-фаза —
    // чтобы перехватить ДО специфичных handler'ов панелей. Pointerdown
    // тоже глушим — иначе drag&drop инвентаря или mousedown-режимы могут
    // активироваться. Вешаем один раз при первом ensureOverlay; снять не
    // нужно — guard сам читает state.activeLevelUp и no-op'ит когда null.
    if (typeof document !== 'undefined' && !document._luGuardInstalled) {
      const guard = function (e) {
        if (!state || !state.activeLevelUp) return;
        if (e.target && e.target.closest && e.target.closest('.lu-window')) return;
        e.stopPropagation();
        e.preventDefault();
      };
      document.addEventListener('click', guard, true);
      document.addEventListener('mousedown', guard, true);
      document.addEventListener('pointerdown', guard, true);
      document._luGuardInstalled = true;
    }
    return el;
  }

  function onOverlayClick(e) {
    const btn = e.target.closest('[data-lu-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-lu-action');
    const value = btn.getAttribute('data-lu-value');
    handleChoice(action, value);
  }

  function handleChoice(action, value) {
    if (!state || !state.activeLevelUp) return;
    const u = getUnit(state.activeLevelUp.unitId);
    if (!u) return;
    if (action === 'stat') {
      applyStatChoice(u, value);
    } else if (action === 'new-skill') {
      learnNewSkill(u, value);
    } else if (action === 'upgrade-skill') {
      upgradeSkillTier(u, value);
    } else if (action === 'continue') {
      // no-op (например, нет кандидатов в выборе)
    } else {
      return;
    }
    finishCurrentLevelUp();
  }

  // Главная точка отрисовки. Зовётся из advanceLevelUpQueue в state.js.
  function renderLevelUp() {
    const overlay = ensureOverlay();
    if (!state || !state.activeLevelUp) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      // С25 (06.05.2026): восстанавливаем state.view из snapshot.
      // Снимок камеры — на случай если браузер сдвинет zoom/pan во время
      // показа overlay (focus-trap, auto-scroll). Глобальный
      // `overflow:hidden` на html/body в base.css теперь предотвращает
      // и сам scroll, но restore — двойная страховка для камеры.
      const view = _savedView;
      _savedView = null;
      if (view && state && state.view) {
        state.view.zoom = view.zoom;
        state.view.panX = view.panX;
        state.view.panY = view.panY;
        if (typeof applyView === 'function') applyView();
      }
      return;
    }
    const lu = state.activeLevelUp;
    const u = getUnit(lu.unitId);
    if (!u) { overlay.style.display = 'none'; return; }
    const cls = CLASSES[u.classId] || {};
    const heroName = cls.name || u.classId;
    const teamLabel = u.team;
    const statLabel = (typeof STAT_LABELS === 'object' && STAT_LABELS && STAT_LABELS[lu.autoStat]) || lu.autoStat;
    const statIconHtmlStr = statIconHtml(lu.autoStat, statLabel, { classPrefix: 'lu-stat' });

    const headerHtml = `
      <div class="lu-header">
        <div class="lu-title">${escapeHtml(heroName)} <span class="lu-team">(${escapeHtml(teamLabel)})</span></div>
        <div class="lu-level">Получение уровня ${lu.level}</div>
        <div class="lu-auto">Авто-рост: <strong>${escapeHtml(statLabel)} +1</strong>${statIconHtmlStr ? ` <span class="lu-auto-icon" title="${escapeAttr(statLabel)} +1">${statIconHtmlStr}</span>` : ''}</div>
      </div>`;

    let bodyHtml = '';
    let footerHtml = '';
    if (lu.kind === 'stats') {
      bodyHtml = `<div class="lu-subtitle">Выбери характеристику для усиления (+2):</div>` +
                 `<div class="lu-grid lu-grid-stats">` +
                 (lu.choices || []).map(renderStatButton).join('') +
                 `</div>`;
    } else if (lu.kind === 'stat-bonus') {
      // Фаза 4 (full-elite): нечётный уровень превращается в stat-выбор.
      // Подзаголовок намекает, что это бонусный режим.
      bodyHtml = `<div class="lu-subtitle">Все навыки в Элитном тире. Бонус: +2 к характеристике.</div>` +
                 `<div class="lu-grid lu-grid-stats">` +
                 (lu.choices || []).map(renderStatButton).join('') +
                 `</div>`;
    } else if (lu.kind === 'skills-new') {
      bodyHtml = `<div class="lu-subtitle">Изучи новый навык (1 из ${(lu.choices || []).length}):</div>`;
      if (!lu.choices || !lu.choices.length) {
        bodyHtml += `<div class="lu-empty">Пул новых навыков исчерпан.</div>`;
        footerHtml = `<button class="lu-continue" data-lu-action="continue">Продолжить</button>`;
      } else {
        bodyHtml += `<div class="lu-grid lu-grid-skills">` +
                    lu.choices.map(c => renderNewSkillButton(c, u)).join('') +
                    `</div>`;
      }
    } else if (lu.kind === 'skills-upgrade-basic' || lu.kind === 'skills-upgrade-advanced') {
      const toTierLabel = (lu.kind === 'skills-upgrade-basic') ? 'Продвинутого' : 'Элитного';
      bodyHtml = `<div class="lu-subtitle">Улучши навык до ${toTierLabel} тира:</div>`;
      if (!lu.choices || !lu.choices.length) {
        bodyHtml += `<div class="lu-empty">Нет навыков, готовых к улучшению на этой фазе.</div>`;
        footerHtml = `<button class="lu-continue" data-lu-action="continue">Продолжить</button>`;
      } else {
        bodyHtml += `<div class="lu-grid lu-grid-skills">` +
                    lu.choices.map(c => renderUpgradeButton(c, u)).join('') +
                    `</div>`;
      }
    } else {
      // kind === null — defensive (теоретически не должно случиться, но
      // если случилось — даём «Продолжить» и не блокируем игру).
      bodyHtml = `<div class="lu-empty">Прокачка не активна.</div>`;
      footerHtml = `<button class="lu-continue" data-lu-action="continue">Продолжить</button>`;
    }

    overlay.innerHTML = `
      <div class="lu-window">
        ${headerHtml}
        <div class="lu-body">
          ${bodyHtml}
          ${footerHtml ? `<div class="lu-footer">${footerHtml}</div>` : ''}
        </div>
      </div>`;
    overlay.style.display = 'flex';
    // С25: snapshot state.view ОДИН раз — на первом показе. Между
    // героями в очереди апа окно не скрывается, snapshot живёт.
    if (!_savedView && state && state.view) {
      _savedView = { zoom: state.view.zoom, panX: state.view.panX, panY: state.view.panY };
    }
  }

  function renderStatButton(stat) {
    const label = (typeof STAT_LABELS === 'object' && STAT_LABELS && STAT_LABELS[stat]) || stat;
    // С25-рефактор (06.05.2026): иконка стата идёт через общий хелпер
    // `statIconHtml` (render/render.js). Префикс 'lu-stat' даёт классы
    // .lu-stat-icon / .lu-stat-emoji, под которые написан CSS окна апа.
    const iconHtml = statIconHtml(stat, label, { classPrefix: 'lu-stat' });
    const tip = `${label}: +2`;
    return `<button class="lu-card lu-card-stat" data-lu-action="stat" data-lu-value="${escapeAttr(stat)}" title="${escapeAttr(tip)}">
      <div class="lu-card-icon">${iconHtml}</div>
      <div class="lu-card-label">${escapeHtml(label)}</div>
      <div class="lu-card-bonus">+2</div>
    </button>`;
  }

  function renderNewSkillButton(choice, unit) {
    const sk = SKILLS[choice.skillId] || {};
    const name = sk.name || choice.skillId;
    // 06.05.2026: подробный тултип через общий построитель — содержит
    // мана-стоимость, дальность, формулу урона, эффекты тира и т.д.
    // Если построитель почему-то недоступен — fallback на flavor.
    const tip = (typeof buildSkillTooltipText === 'function')
      ? buildSkillTooltipText(choice.skillId, 'basic', unit)
      : `${name}\n${sk.flavor || sk.description || ''}`;
    const sprite = sk.spriteSrc;
    const iconHtml = sprite
      ? `<img src="${escapeAttr(sprite)}" alt="${escapeAttr(name)}">`
      : `<span class="lu-card-emoji">${escapeHtml(sk.icon || '?')}</span>`;
    const kindBadge = (sk.kind === 'passive') ? `<span class="lu-card-kind">пассив</span>` : `<span class="lu-card-kind">актив</span>`;
    return `<button class="lu-card lu-card-skill" data-lu-action="new-skill" data-lu-value="${escapeAttr(choice.skillId)}" title="${escapeAttr(tip)}">
      <div class="lu-card-icon">${iconHtml}</div>
      <div class="lu-card-label">${escapeHtml(name)}</div>
      ${kindBadge}
    </button>`;
  }

  function renderUpgradeButton(choice, unit) {
    // Bugfix 12.05.2026: внутри функции ранее ссылались на `skillId` и `u`,
    // которые в этой области видимости НЕ объявлены (параметры — `choice`
    // и `unit`). При наличии effectiveSkillParams/SKILLS/buildSkillUpgradeTooltipText
    // (а они почти всегда есть в глобале) ReferenceError ронял весь
    // renderLevelUp, level-up окно не появлялось, очередь зависала.
    // Симптом: «Script error.» в DebugLog без stack и пустой экран после
    // победы. Фикс: читать choice.skillId и unit.
    const skillId = choice.skillId;
    const skill = (typeof SKILLS === 'object' && SKILLS && SKILLS[skillId]) || {};
    const name = skill.name || skillId;
    const fromTier = choice.fromTier;
    const TIER_CHAIN = ['basic', 'advanced', 'elite'];
    const idx = TIER_CHAIN.indexOf(fromTier);
    const toTier = (idx >= 0 && idx < TIER_CHAIN.length - 1) ? TIER_CHAIN[idx + 1] : fromTier;
    const tierLabels = (typeof SKILL_TIER_LABELS === 'object' && SKILL_TIER_LABELS) || {};
    const fromLabel = tierLabels[fromTier] || fromTier;
    const toLabel = tierLabels[toTier] || toTier;
    // cs не используется в итоговом HTML (был артефактом), но если в будущем
    // понадобятся итоговые числовые параметры — это правильный вызов.
    const cs = (typeof effectiveSkillParams === 'function')
      ? effectiveSkillParams(skillId, toTier, unit) : null;
    const upgradeTooltip = (typeof buildSkillUpgradeTooltipText === 'function')
      ? buildSkillUpgradeTooltipText(skillId, fromTier, toTier, unit) : '';
    // Bugfix 12.05.2026 (часть 2): использовались классы .lu-card-icon-img /
    // .lu-card-icon-wrap / .lu-card-icon-emoji / .lu-card-name — ни одного
    // CSS-правила для них не существует в level-up.css. В итоге <img>
    // рендерился натуральным размером (1024×1024 для скилл-спрайтов),
    // заполняя весь экран. Фикс: тот же DOM, что у renderNewSkillButton —
    // .lu-card-icon (72×72) + .lu-card-label. Класс .lu-card-upgrade
    // активирует CSS-стрелку.
    const iconHtml = skill.spriteSrc
      ? `<img src="${escapeAttr(skill.spriteSrc)}" alt="${escapeAttr(name)}">`
      : `<span class="lu-card-emoji">${escapeHtml(skill.icon || '✨')}</span>`;
    return `
    <button class="lu-card lu-card-skill lu-card-upgrade" data-lu-action="upgrade-skill" data-lu-value="${escapeAttr(skillId)}" title="${escapeAttr(upgradeTooltip)}">
      <div class="lu-card-icon">${iconHtml}<span class="lu-card-arrow">↑</span></div>
      <div class="lu-card-label">${escapeHtml(name)}</div>
      <div class="lu-card-tier">${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)}</div>
    </button>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
  }

  // Экспорт в глобал — state.js (advanceLevelUpQueue) зовёт по имени.
  window.renderLevelUp = renderLevelUp;
})();
