/* render-initiative.js (render/) — полоска очерёдности справа от поля.

   Что внутри:
     • `renderInitiative()` — отрисовывает `#roundIndicator` (текст
       «Раунд N») и `#initiativeList` (чипы юнитов в порядке
       `state.initiativeOrder`). Каждый чип:
         - класс команды (`team-a`/`team-b`);
         - модификатор `acting` для текущего юнита, `selected` для
           выбранного;
         - визуал класса (через `renderClassVisual` из render.js);
         - бейдж порядкового номера в углу;
         - click-handler → `selectUnit(u.id)`.
       Мёртвые юниты в очереди пропускаются (если кто-то умер в
       середине раунда, его чип просто не рисуется — пересчёт самой
       очерёдности произойдёт в начале следующего раунда через
       `computeInitiativeOrder` в `advanceTurn`).

   Что НЕ внутри:
     • Сам расчёт очерёдности (`computeInitiativeOrder`) —
       `core/turn.js` (R15). renderInitiative только читает массив id.
     • CSS чипов и анимации (`.ini-chip`, `.acting`, `.order-badge`) —
       `styles/initiative.css`.
     • Хелпер визуала класса (`renderClassVisual`) — `render/render.js`.

   Где править:
     • Изменить порядок отрисовки внутри чипа (например, добавить
       мини-полоску HP) — здесь.
     • Показ дебаффов на чипе (например, маленький значок «отравлен») —
       добавить в renderInitiative + CSS в `styles/initiative.css`.

   Внешние имена через script-scope (резолв при вызове):
   `state` (core/state); `getUnit`, `selectUnit` (core/state);
   `CLASSES` (data/classes); `renderClassVisual` (render/render). */

function renderInitiative() {
  const roundEl = document.getElementById('roundIndicator');
  if (roundEl) roundEl.textContent = 'Раунд ' + state.round;
  const list = document.getElementById('initiativeList');
  list.innerHTML = '';
  state.initiativeOrder.forEach((uid, idx) => {
    const u = getUnit(uid);
    if (!u || !u.alive) return;
    const chip = document.createElement('div');
    chip.className = 'ini-chip team-' + u.team.toLowerCase();
    if (u.id === state.activeUnitId)   chip.classList.add('acting');
    if (u.id === state.selectedUnitId) chip.classList.add('selected');
    const cls = CLASSES[u.classId];
    // Спрайт/эмодзи через общий helper. Бейдж порядка добавляется ПОСЛЕ —
    // helper чистит innerHTML, поэтому порядок важен.
    renderClassVisual(chip, cls);
    const badge = document.createElement('div');
    badge.className = 'order-badge';
    badge.textContent = idx + 1;
    chip.appendChild(badge);
    chip.addEventListener('click', () => selectUnit(u.id));
    list.appendChild(chip);
  });
}
