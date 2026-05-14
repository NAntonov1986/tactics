/* render-effects.js (render/) — спецэффекты на effects-layer.

   Что внутри:
     • `playFireballBlast(row, col)` — fire-and-forget анимация вспышки
       фаербола в клетке (row, col). Создаёт `.fireball-blast`-div
       размером 3×3 клетки (позиционируется по верхне-левой клетке
       `(row-1, col-1)`), внутрь добавляет `<img class="fireball-sprite">`
       со спрайтом из `SKILLS.fireball.spriteSrc`. Через 560мс удаляет
       элемент. Анимация задаётся CSS (`@keyframes fireball-blast` и
       `fireball-sprite-pop` в `styles/effects.css`).

   Зачем отдельный файл? effects-layer концептуально отделён от
   units-layer/overlay-layer: в нём живут «летучие» эффекты, которые
   не привязаны к юниту и существуют независимо от render-цикла.
   Сейчас единственный обитатель — вспышка фаербола, но при появлении
   взрыва трупа, цепной молнии, проклятия по области — все они тоже
   будут жить здесь. Файл готов к росту.

   Что НЕ внутри:
     • Анимации, привязанные к юниту (shake/slide/fade-смерть) —
       `render/render-units.js` (`playHitAnimation`, `playMoveAnimation`,
       `scheduleDeathCleanup`).
     • Подсветка валидных клеток — `render/render-overlay.js`.
     • Сам каст фаербола (логика урона/эффектов) — `core/combat.js`
       (`executeFireball`).

   Где править:
     • Длительность вспышки — параметр `setTimeout` (560мс) + CSS
       `@keyframes` (должны совпадать).
     • Новый AoE-эффект (например, «удар молнии 3×1»): добавить
       `playLightningStrike(row, col)` сюда + CSS-класс в
       `styles/effects.css` + спрайт.

   Внешние имена через script-scope (резолв при вызове):
   `SKILLS` (data/skills). */

function playFireballBlast(row, col) {
  const layer = document.getElementById('effectsLayer');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'fireball-blast';
  // Блок 3×3 позиционируется по верхне-левой клетке, т.е. (row-1, col-1).
  el.style.setProperty('--r', row - 1);
  el.style.setProperty('--c', col - 1);
  // Поверх радиально-градиентной вспышки кладём pixel-art спрайт огненного
  // шара в эпицентре. Спрайт берётся из SKILLS.fireball.spriteSrc — не
  // зашиваем путь в JS, чтобы апдейт ассета шёл одной правкой данных.
  const fb = SKILLS.fireball;
  if (fb && fb.spriteSrc) {
    const img = document.createElement('img');
    img.src = fb.spriteSrc;
    img.alt = '';
    img.className = 'fireball-sprite';
    el.appendChild(img);
  }
  layer.appendChild(el);
  // C24: приведено к --anim-speed-mul. CSS-анимации .fireball-blast
  // и .fireball-sprite делят 520 мс на ту же переменную — JS-таймер
  // удаления элемента совпадает.
  const dur = (typeof AnimSpeed !== 'undefined') ? AnimSpeed.scaled(560) : 560;
  setTimeout(() => el.remove(), dur);
}
