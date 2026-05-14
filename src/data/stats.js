/* stats.js — справочные данные о характеристиках юнита (статах).
   Что внутри:
     • STAT_LABELS — подписи на русском по ключу: str/vit/dex/spd/wis/int/luk →
       Сила/Живучесть/Ловкость/Скорость/Мудрость/Интеллект/Удача.
       Используется в тултипах, лог-сообщениях, секции «Характеристики».
     • STAT_ICONS — источник визуала иконки для каждого стата.
       Каждая запись: { type: 'sprite', src: '...' } для PNG-спрайта,
       либо { type: 'emoji', char: '...' } для эмодзи-плейсхолдера.
       Сейчас все семь — спрайты (Интеллект и Удача раньше были эмодзи-
       плейсхолдерами 🧠 / 🍀, после добавления PNG переведены на 'sprite').
     • STAT_ORDER — порядок и группировка характеристик в панели:
       пара str/vit, пара dex/spd, пара wis/int, отдельно luk.
       CSS-grid в panel.css даёт 2 столбца, .stat-luk занимает отдельную строку.
   Что НЕ внутри:
     • Расчёт эффективных статов (effectiveStats, statBreakdown) —
       в src/core/stats-calc.js (когда будет извлечён).
     • Базовые значения статов класса — в src/data/classes.js → CLASSES[id].stats.
     • CSS-стили `.stats-list`, `.stat-icon` и т.п. — в styles/panel.css.
   Где править подпись/иконку конкретного стата: тут.
   Где добавить новую характеристику: добавить ключ в STAT_LABELS, STAT_ICONS,
     STAT_ORDER (в нужное место в порядке) + во все CLASSES[id].stats указать
     базовое значение. Раскладка панели сейчас рассчитана на 7 стат — больше
     потребует правки CSS.
   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   STAT_LABELS, STAT_ICONS, STAT_ORDER попадают в глобальный scope window.
*/

const STAT_LABELS = {
  str: 'Сила',
  vit: 'Живучесть',
  dex: 'Ловкость',
  spd: 'Скорость',
  wis: 'Мудрость',
  int: 'Интеллект',
  luk: 'Удача'
};

/* Источники пиксельных иконок характеристик. Все семь теперь PNG.
   Интеллект и Удача раньше временно рендерились эмодзи-плейсхолдерами
   (🧠 / 🍀) — PNG появились позже, и записи унифицировались с остальными. */
const STAT_ICONS = {
  str: { type: 'sprite', src: 'assets/sprites/stats/str.png' },
  vit: { type: 'sprite', src: 'assets/sprites/stats/vit.png' },
  dex: { type: 'sprite', src: 'assets/sprites/stats/dex.png' },
  spd: { type: 'sprite', src: 'assets/sprites/stats/spd.png' },
  wis: { type: 'sprite', src: 'assets/sprites/stats/wis.png' },
  int: { type: 'sprite', src: 'assets/sprites/stats/int.png' },
  luk: { type: 'sprite', src: 'assets/sprites/stats/luk.png' }
};

/* Порядок и группировка характеристик в панели. Пары идут в своих
   строках (верстка через CSS grid 2fr), Удача занимает отдельную
   строку целиком. Порядок внутри пары совпадает со смысловым:
   Сила ↔ Живучесть, Ловкость ↔ Скорость, Мудрость ↔ Интеллект. */
const STAT_ORDER = ['str', 'vit', 'dex', 'spd', 'wis', 'int', 'luk'];
