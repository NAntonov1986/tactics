/* render-log.js (render/) — лог боя: запись в буфер и отрисовка.

   Что внутри:
     • `LOG_KEEP = 80` — максимум хранимых записей (свежие
       вытесняют старые).
     • `log(text, type)` — запись в буфер `state.log[]`. Если буфер
       переполнен, отрезает старые. Параметр `type` (по умолчанию
       'info') влияет на CSS-класс при рендере: `'system'`, `'damage'`,
       `'death'`, `'crit'`, `'turn'`, `'victory'` — каждый со своей
       подсветкой в `styles/log.css`.
     • `renderLog()` — отрисовка буфера в `#logEntries`. Берёт последние
       40 записей (`state.log.slice(-40)`), рисует по `<div.log-entry>`
       на каждую с классом по типу. Автопрокручивает родителя в самый
       низ (свежие записи внизу — как в боевых логах rogue-like / MMO).

   Зачем `log()` живёт здесь, а не отдельно?
   Семантически log() — это тонкий писатель в state.log[], а renderLog —
   читатель того же буфера. Они формируют одну доменную пару «лог боя:
   запись + рендер». Разделять их в два файла — преждевременная
   фрагментация: log() будут править те же люди, что и renderLog
   (новый тип события → CSS-класс + ветка типа в log + цвет в renderLog).

   Что НЕ внутри:
     • Содержимое лога (тексты сообщений) — пишут все остальные модули
       через `log(...)`. Добавить новый тип события — добавить ветку
       в любом модуле (например, `core/damage.js`) с уникальным `type`,
       и подобрать CSS-класс в `styles/log.css`.
     • Render-оркестратор — `render/render.js` (`render()` зовёт
       `renderLog()` в фиксированном порядке слоёв).

   Тонкость с порядком загрузки. log() резолвит `state.log` в момент
   ВЫЗОВА. Все модули, которые зовут log() (damage, effects, combat, ai,
   turn, state), делают это только из тел функций — к моменту первого
   вызова state уже инициализирован через init(). render-log.js может
   подключаться где угодно среди render-* (порядок не критичен).

   Внешние имена через script-scope (резолв при вызове):
   `state` (core/state). */

const LOG_KEEP = 80;
function log(text, type) {
  type = type || 'info';
  state.log.push({ text, type });
  if (state.log.length > LOG_KEEP) state.log.splice(0, state.log.length - LOG_KEEP);
}

function renderLog() {
  const box = document.getElementById('logEntries');
  if (!box) return;
  box.innerHTML = '';
  // Рендерим последние ~40 записей, свежая внизу.
  const slice = state.log.slice(-40);
  for (const entry of slice) {
    const el = document.createElement('div');
    el.className = 'log-entry ' + (entry.type || 'info');
    el.textContent = entry.text;
    box.appendChild(el);
  }
  // Автопрокрутка вниз.
  box.parentElement.scrollTop = box.parentElement.scrollHeight;
}
