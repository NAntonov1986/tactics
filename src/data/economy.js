/* economy.js (data/) — параметры экономики (Camp v2-economy, 13.05.2026).

   Источник правды для всех денежных формул. Меняешь здесь — пересчитывается
   всё в игре. Параметры подобраны под условие «4 миссии в месяц содержат
   партию из 8 + 40-50% избытка», см. C:\Проекты\Баланс_экономики.xlsx
   и раздел «Черновик экономики» в DESIGN.md.

   Что внутри:
     • Базовые коэффициенты U/R/H, разброс ±15%.
     • Стартовый капитал и формула.
     • Параметры пула найма.
     • Helpers: heroMonthlyUpkeep, missionReward, hireCost,
       partySalaryTotal, maxPartyLevel, applyVariation.

   Зачем отдельный data/-файл (а не core/):
     • Это ДАННЫЕ-параметры, не логика. Логика стейта/UI читает их.
     • Файл подключается ДО core/state.js, чтобы createInitialState мог
       использовать ECONOMY.START_CAPITAL.

   Что НЕ внутри:
     • Сами хранилища (state.gold и т.п.) — core/state.js.
     • Применение к стейту (applyMissionReward, applyMonthlySalary) —
       core/state.js.
     • UI (счётчик золота, кнопка найма, окно найма) — render-camp.js. */

const ECONOMY = {
  /* Базовые коэффициенты. Все формулы используют их и уровень героя/миссии.
     Балансная правка 13.05.2026 (после первых пробных забегов): U_BASE
     и H_BASE снижены на 15% (со 100→85 и 200→170 соответственно). Причина:
     при сильных колебаниях сложности (одна тяжёлая миссия + три средних)
     старая планка съедала весь излишек, игрок уходил в долг даже без
     ошибок. Сейчас базовый излишек ≈ 57.5% (вместо 50%), запаса хватает
     на одну посредственную миссию в месяц без долга. */
  U_BASE: 85,    // содержание героя/мес = U_BASE × уровень_героя
  R_BASE: 400,   // награда миссии = R_BASE × сложность_миссии
  H_BASE: 170,   // стоимость найма = H_BASE × уровень_кандидата

  /* Разброс ±15% — каждое начисление/списание варьируется относительно базы. */
  VARIATION: 0.15,

  /* Стартовый капитал. Базовая идея: 8 героев × найм × 1 уровень = 1 600.
     Реальное значение 2 000 — небольшой запас сверху (≈400 g на 1-2
     зелья или на разброс цен найма ±15%). Игрок может нанять полный
     отряд 1 уровня и ещё иметь подушку до первой миссии. */
  START_HEROES: 8,           // справочно: на сколько героев рассчитан минимум
  START_HERO_LEVEL: 1,       // справочно: какого уровня
  START_CAPITAL: 2000,       // фактическая сумма в кошельке игрока на старте

  /* Пул найма. */
  POOL_SIZE: 6,            // кандидатов на ход
  POOL_LVL_MIN_FACTOR: 0.60,  // мин уровень = max уровень × 0.60
  POOL_LVL_MAX_FACTOR: 0.80,  // макс уровень = max уровень × 0.80

  /* Магазин (Camp v2-economy/shop, 14.05.2026). */
  SHOP_SIZE: 6,            // позиций в магазине
  SHOP_LVL_MIN_FACTOR: 0.80,  // мин уровень = средняя сложность × 0.80
  SHOP_LVL_MAX_FACTOR: 1.20,  // макс уровень = средняя сложность × 1.20
  SHOP_MIN_LEVEL: 2,       // минимальный уровень предмета в магазине (база дропа)
  SELL_MULT: 0.35,         // продажа = SELL_MULT × itemGoldPrice
  ITEM_PRICE_MULT: 1,      // покупка = ITEM_PRICE_MULT × R_BASE × cost (одна средняя награда)
};

/* Цена предмета в золоте. По дизайну (14.05.2026, балансная правка):
   100% средней награды за уровень сложности, на котором предмет может
   выпасть. Уровень предмета ≈ его суммарная стоимость в очках
   (см. itemTotalCost). Базовое оружие класса (id-строка) цены не имеет
   (продаже не подлежит). */
function itemGoldPrice(item) {
  if (!item || typeof item === 'string') return 0;
  const cost = (typeof itemTotalCost === 'function')
    ? itemTotalCost(item)
    : ((item.costPoints | 0) || 0);
  if (cost <= 0) return 0;
  return ECONOMY.ITEM_PRICE_MULT * ECONOMY.R_BASE * cost;
}

/* Цена продажи предмета (35% от его рыночной стоимости). */
function itemSellPrice(item) {
  return Math.round(itemGoldPrice(item) * ECONOMY.SELL_MULT);
}

/* Применить ±VARIATION к значению. Используется на трёх осях:
   награда миссии (каждая миссия), стоимость найма (каждый кандидат в пуле),
   зарплата героя (фиксируется при найме как множитель «жадности»). */
function applyEconomyVariation(base) {
  const v = ECONOMY.VARIATION;
  const factor = 1 + (Math.random() * 2 - 1) * v;  // в диапазоне [1-v, 1+v]
  return Math.round(base * factor);
}

/* Базовое содержание героя/мес = U_BASE × paidLevel. paidLevel — это
   уровень, зафиксированный при последнем пересмотре оклада (при найме или
   в начале месяца). Между пересмотрами уровень героя может расти выше,
   но оклад остаётся «старым». В applyMonthlySalary мы сначала списываем
   зарплату по старому paidLevel, потом синхронизируем paidLevel со свежим
   hero.level — следующий месяц будет уже по новой ставке. Fallback на
   hero.level — для legacy сейвов без paidLevel и для свежих героев,
   которые ещё не прошли пересмотр. */
function heroBaseUpkeep(hero) {
  if (!hero) return 0;
  const paid = (typeof hero.paidLevel === 'number') ? hero.paidLevel : hero.level;
  const lvl = Math.max(1, (paid | 0));
  return ECONOMY.U_BASE * lvl;
}

/* Эффективное содержание героя/мес с учётом его персонального множителя. */
function heroMonthlyUpkeep(hero) {
  if (!hero) return 0;
  const base = heroBaseUpkeep(hero);
  const mult = (typeof hero.upkeepMultiplier === 'number') ? hero.upkeepMultiplier : 1.0;
  return Math.round(base * mult);
}

/* Прогноз содержания после пересмотра в начале следующего месяца.
   Использует ТЕКУЩИЙ hero.level (а не paidLevel). Если уровень не вырос
   с момента последнего пересмотра — равен heroMonthlyUpkeep. */
function heroProjectedUpkeep(hero) {
  if (!hero) return 0;
  const lvl = Math.max(1, (hero.level | 0));
  const mult = (typeof hero.upkeepMultiplier === 'number') ? hero.upkeepMultiplier : 1.0;
  return Math.round(ECONOMY.U_BASE * lvl * mult);
}

/* Награда миссии данной сложности. Применяет VARIATION (рандом на каждый вызов). */
function missionReward(difficulty) {
  const d = Math.max(1, difficulty | 0);
  return applyEconomyVariation(ECONOMY.R_BASE * d);
}

/* Базовая стоимость найма (без variation). Используется для отображения «средней». */
function hireCostBase(level) {
  const lvl = Math.max(1, level | 0);
  return ECONOMY.H_BASE * lvl;
}

/* Стоимость найма с применённым variation. Фиксируется в момент генерации
   кандидата (recruit.hireCost) и не меняется до того, как кандидата нанимают. */
function hireCost(level) {
  return applyEconomyVariation(hireCostBase(level));
}

/* Сумма содержания всей живой партии за месяц. */
function partySalaryTotal(party) {
  if (!Array.isArray(party)) return 0;
  let total = 0;
  for (const h of party) {
    if (!h || !h.alive) continue;
    total += heroMonthlyUpkeep(h);
  }
  return total;
}

/* Уровень самого прокачанного героя в партии. Минимум 1. */
function maxPartyLevel(party) {
  if (!Array.isArray(party)) return 1;
  let max = 0;
  for (const h of party) {
    if (!h || !h.alive) continue;
    const lvl = h.level | 0;
    if (lvl > max) max = lvl;
  }
  return Math.max(1, max);
}

/* Случайный персональный множитель содержания (жадность героя). */
function rollUpkeepMultiplier() {
  const v = ECONOMY.VARIATION;
  return Number((1 + (Math.random() * 2 - 1) * v).toFixed(3));
}
