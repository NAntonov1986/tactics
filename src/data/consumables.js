/* consumables.js — реестр расходников и хелперы.
   Что внутри:
     • CONSUMABLES — реестр одноразовых предметов (зелья, свитки, бомбы).
       Поля каждой записи (планируется в S8):
         id, name, icon, spriteSrc,
         costPoints (для лавки в S9; на S1 — null или произвольно),
         apply(unit, state) — функция применения. Получает носителя
            и текущий state, выполняет эффект (лечение, наложение
            эффекта на цель, телепорт и т.п.). Возвращает true/false
            (сработало ли — для логики «трачу слот / нет»).
         requiresTarget (bool) — нужна ли цель для применения.
            Если true, UI запросит выбор клетки/юнита, передаст в apply.
     • getUnitConsumable(unit) — запись/инстанс из слота consumable.

   Что НЕ внутри:
     • Сами расходники как механика — добавляются в S8 (одноразовое
       использование на свой ход; слот пустеет после применения).
     • UI «применить расходник» — будет в render/render-panel.js (S8).
     • Лавка и валюта — S9, отдельный экран `render/render-shop.js`.

   На этапе С1 реестр пустой. Файл существует ради симметрии с
   data/equipment.js и чтобы slot 'consumable' имел свою «домашнюю»
   точку правды, когда в S8 начнём наполнять.

   Файл подключается ОБЫЧНЫМ <script src="..."> до inline-блока в index.html.
   CONSUMABLES и getUnitConsumable попадают в глобальный scope window. */

/* ================================================================
   === РАСХОДНИКИ =================================================
   ================================================================
   На С1 пусто. Стартовый набор (3-5 рецептов: малое лечащее зелье,
   бомба, свиток телепорта и т.п.) появится в S8.
*/
const CONSUMABLES = {
  // Заглушка-пример на S8:
  //   minor_healing_potion: {
  //     id: 'minor_healing_potion', name: 'Малое лечащее зелье',
  //     icon: '🧪', spriteSrc: null,
  //     costPoints: 2, requiresTarget: false,
  //     apply(unit, state) {
  //       const heal = 5;
  //       const max = maxHpOf(unit);
  //       const before = unit.hp;
  //       unit.hp = Math.min(max, unit.hp + heal);
  //       const got = unit.hp - before;
  //       log(`${CLASSES[unit.classId].name} (${unit.team}) выпивает зелье: +${got} HP`, 'info');
  //       return true;
  //     }
  //   }
};

/* Тонкая обёртка симметрично с getUnitWeapon/getUnitArmor.
   Возвращает запись CONSUMABLES либо инстанс предмета или null. */
function getUnitConsumable(unit) {
  if (!unit || !unit.equipment) return null;
  const e = unit.equipment.consumable;
  if (!e) return null;
  if (typeof e === 'string') return CONSUMABLES[e] || null;
  return e;
}
