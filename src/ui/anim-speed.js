/* anim-speed.js (ui/) — глобальный множитель скорости анимаций.

   Что внутри:
     • `window.AnimSpeed` — единственный публичный объект:
         - `mul`           — текущий множитель (1, 2, 3, 4).
         - `set(mul)`      — переключить, обновить CSS-переменную, перерисовать UI,
                             сохранить в localStorage.
         - `scaled(ms)`    — поделить длительность на текущий мультипликатор и
                             округлить до 1 мс минимум. Используется в JS-таймерах
                             (setTimeout), чтобы они шли в ногу с CSS-анимациями.
     • Кнопка-переключатель `.speed-controls` в углу viewport (HTML лежит в
       `index.html`, рядом с `.portrait-panel`). Делегированный click-listener
       реагирует на `data-speed`.
     • CSS-переменная `--anim-speed-mul` ставится на `<html>`. Все анимации,
       которые «должны быстреть», у себя в CSS делят свою базовую длительность
       через `calc(<base>ms / var(--anim-speed-mul, 1))`. См. `units.css`,
       `effects.css`.

   Что подвержено ускорению (scope C24):
     • Анимации действий: shake/crit-shake, slide (движение), die (смерть),
       вспышка фаербола, HP-bar.
     • JS-таймеры этих же анимаций (через `AnimSpeed.scaled`):
       playHitAnimation, playMoveAnimation (STEP_MS), scheduleDeathCleanup,
       playFireballBlast, отложенный `endTurn` после смерти/стана,
       AI_STEP_DELAY_MS, пауза перед следующей волной (900 мс).

   Что НЕ ускоряется (специально):
     • UI-hover transition'ы (кнопки, чипы) — это интерактивный фидбэк,
       не «время игры».
     • Бесконечные ambient-анимации (`pulse-acting`, `aggroAlertPulse`,
       `lure-pulse`, `ft-skill-pulse`) — это маркеры состояния, разгонять
       их в 4× выглядит истерично.
     • Тултипы (`tooltip.css`) — UI-слой.

   Где добавлять новую ускоряемую анимацию:
     1) В соответствующем `.css` использовать
        `animation-duration: calc(<base>ms / var(--anim-speed-mul, 1))`
        (или то же самое внутри короткой записи `animation:`).
     2) Если в JS есть `setTimeout`, синхронизированный с этой анимацией —
        обернуть длительность в `AnimSpeed.scaled(<base>ms)`.

   Хранилище:
     • Выбор пользователя сохраняется в `localStorage['ft.animSpeed']`.
       На старте читается и применяется до первого render-а. Невалидные
       значения игнорируются (откат к 1×).

   Самоинициализация: на `DOMContentLoaded` (или сразу, если DOM уже готов).
   От `init()` в `core/state.js` зависимости нет. */

(function () {
  const STORAGE_KEY = 'ft.animSpeed';
  const ALLOWED = [1, 2, 3, 4];
  const DEFAULT_MUL = 1;

  function readStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null) return DEFAULT_MUL;
      const n = parseInt(raw, 10);
      if (ALLOWED.indexOf(n) === -1) return DEFAULT_MUL;
      return n;
    } catch (_) {
      return DEFAULT_MUL;
    }
  }

  const AnimSpeed = {
    mul: readStored(),
    /* Поделить длительность setTimeout на текущий мультипликатор.
       Минимум 1 мс — на 0 ставить нельзя, иначе теряется идемпотентность
       requestAnimationFrame-цепочек на старте анимации. */
    scaled(ms) {
      const m = this.mul > 0 ? this.mul : 1;
      const out = Math.round(ms / m);
      return out < 1 ? 1 : out;
    },
    set(mul) {
      const next = ALLOWED.indexOf(mul) === -1 ? DEFAULT_MUL : mul;
      this.mul = next;
      applyToDom(next);
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch (_) {}
      renderButtonsState();
    },
  };

  function applyToDom(mul) {
    document.documentElement.style.setProperty('--anim-speed-mul', String(mul));
  }

  function renderButtonsState() {
    const root = document.getElementById('speedControls');
    if (!root) return;
    const buttons = root.querySelectorAll('.speed-btn');
    buttons.forEach((b) => {
      const v = parseInt(b.getAttribute('data-speed'), 10);
      if (v === AnimSpeed.mul) b.classList.add('active');
      else b.classList.remove('active');
    });
  }

  function bind() {
    // Применяем сохранённое значение ДО привязки кликов — чтобы CSS-переменная
    // была правильной, даже если пользователь ещё не кликал.
    applyToDom(AnimSpeed.mul);
    const root = document.getElementById('speedControls');
    if (!root) return;
    renderButtonsState();
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.speed-btn');
      if (!btn || !root.contains(btn)) return;
      const v = parseInt(btn.getAttribute('data-speed'), 10);
      if (!Number.isFinite(v)) return;
      AnimSpeed.set(v);
    });
  }

  // Применяем CSS-переменную как можно раньше (ещё до DOMContentLoaded),
  // чтобы первая же анимация шла с правильной скоростью.
  applyToDom(AnimSpeed.mul);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.AnimSpeed = AnimSpeed;
})();
