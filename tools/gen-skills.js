#!/usr/bin/env node
/* tools/gen-skills.js — генератор справочника навыков `docs/skills.md`.

   Зачем:
     При раздумывании над балансом/новыми навыками удобно иметь одно
     место, где видны ВСЕ актуальные цифры по тирам — без необходимости
     открывать data/skills.js и читать многословные комментарии. Этот
     скрипт собирает такой справочник из самих данных. Источник правды
     остаётся `src/data/skills.js`, рассинхрона нет: после правки баланса
     запускается генератор, и markdown переписывается из живых данных.

   Как пользоваться:
     1) Из корня проекта: `node tools/gen-skills.js`.
     2) Скрипт записывает `docs/skills.md` (создаёт папку, если нет).
     3) Открываешь markdown в IDE рядом с кодом, читаешь актуальные
        цифры. Не редактируй вручную — следующий запуск перезапишет.

   Что генерирует:
     • Заголовок (дата генерации, инструкция по обновлению).
     • Группировка по классу (Воин / Лучник / Маг / Прочие).
     • Каждый навык: имя + id, kind, flavor, и для каждого тира —
       полный «тултип»-блок (мана/CD/дальность/формула/эффекты),
       тот же что показывается в окне прокачки. Используем
       `render/skill-tooltip.js → buildSkillTooltipText` для гарантии,
       что in-game тултип и markdown идут из одной логики.

   Технически:
     • Node не понимает `<script>`-style глобалы напрямую. Грузим
       исходники в `vm.createContext` с трансформацией `^const`/`^let`
       → `var` на верхнем уровне (только начало строки), чтобы
       объявления попадали в контекст (Node-специфика: const/let из vm
       не «вытекают» в context-объект, а var — да).
     • `window` подменяем на сам контекст, чтобы строки
       `window.X = ...` в IIFE-обёртках попадали в нужное место.
     • Передаём в `buildSkillTooltipText(id, tier, null)` — без
       юнита: для markdown нужны абстрактные формулы, а не цифры,
       зависящие от текущих статов конкретного героя. skill-tooltip.js
       при unit=null fallback'ает на формульное представление.

   Где править:
     • Список загружаемых файлов — массив SCRIPTS_TO_LOAD ниже.
       При добавлении нового data/-модуля или зависимости тултипа —
       дописать сюда. Порядок важен: позже загружаемое может зависеть
       от раньше загруженного.
     • Формат markdown — функции buildHeader, buildSkillBlock,
       buildTierBlock. Меняй здесь, если хочешь иной вид справочника. */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'docs', 'skills.md');

const SCRIPTS_TO_LOAD = [
  'src/data/damage-types.js',
  'src/data/unit-types.js',
  'src/data/stats.js',
  'src/data/weapons.js',
  'src/data/skills.js',
  'src/data/classes.js',
  'src/core/stats-calc.js',
  'src/core/skills.js',
  'src/render/skill-tooltip.js',
];

/* Преобразование верхнеуровневых const/let в var. Только начало строки —
   локальные const/let внутри функций (с отступом) не трогаем.
   Это необходимо, потому что Node `vm.runInContext` не вытаскивает
   const/let из script scope в context, но var — да. */
function transformForVm(code) {
  return code.replace(/^(const|let)\b/gm, 'var');
}

/* Создаём контекст-«браузер»: window указывает на сам контекст,
   чтобы IIFE-обёртки с `window.X = ...` попадали в наши глобалы. */
function makeContext() {
  const sandbox = { console, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

function loadAll(ctx) {
  for (const rel of SCRIPTS_TO_LOAD) {
    const abs = path.join(PROJECT_ROOT, rel);
    let code;
    try {
      code = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      throw new Error(`Не найден ${rel}: ${e.message}`);
    }
    code = transformForVm(code);
    try {
      vm.runInContext(code, ctx, { filename: rel });
    } catch (e) {
      throw new Error(`Ошибка при загрузке ${rel}: ${e.message}\n${e.stack || ''}`);
    }
  }
}

/* === ФОРМАТ MARKDOWN ============================================ */

const KIND_LABEL = { active: 'Активный', passive: 'Пассивный', effect: 'Эффект' };
const TIER_LABEL = { basic: 'Базовый', advanced: 'Продвинутый', elite: 'Элитный' };
const CLASS_LABEL = { warrior: 'Воин', archer: 'Лучник', mage: 'Маг' };

function buildHeader() {
  const date = new Date().toISOString().slice(0, 10);
  return [
    '# Реестр навыков (автогенерация)',
    '',
    `> Сгенерировано из \`src/data/skills.js\` через \`tools/gen-skills.js\`. Дата: ${date}.`,
    '> ',
    '> **НЕ РЕДАКТИРОВАТЬ ВРУЧНУЮ.** Любые правки будут перезаписаны при следующем запуске.',
    '> ',
    '> Чтобы обновить после балансной правки: `node tools/gen-skills.js` из корня проекта.',
    '',
    '---',
    '',
  ].join('\n');
}

/* Вытаскиваем тело тултипа без первой строки (там «Имя · тир: X», она
   у нас уже в подзаголовке тира). Также убираем flavor-строку, если
   она совпадает с общим flavor скилла (мы его выводим в blockquote
   под заголовком навыка — нет смысла дублировать в каждом тире).
   Если у тира собственный flavor (отличный от общего) — оставляем,
   это полезная инфа (например, ice_arrow advanced/elite описывают
   свой эффект замедления). Каждую строку оборачиваем в bullet. */
function buildTierBlock(skillId, tier, sk, ctx) {
  const fn = ctx.window.buildSkillTooltipText;
  if (typeof fn !== 'function') return '_(тултип-построитель недоступен)_';
  const text = fn(skillId, tier, null);
  const lines = String(text).split('\n');
  // Первая строка — header с именем и тиром, дублирует подзаголовок.
  if (lines.length > 1) lines.shift();
  // Если первая оставшаяся строка == общий flavor скилла — отрезаем
  // (вывели уже выше). Если у тира свой flavor (отличается) — оставляем.
  const generalFlavor = sk.flavor || sk.description;
  if (lines.length && generalFlavor && lines[0].trim() === String(generalFlavor).trim()) {
    lines.shift();
  }
  return lines.filter(l => l.trim().length).map(l => '- ' + l).join('\n') || '_(нет описания)_';
}

function buildSkillBlock(id, sk, ctx) {
  const out = [];
  const name = sk.name || id;
  const kind = KIND_LABEL[sk.kind] || sk.kind || '?';
  out.push(`### ${name} \`(${id})\``);
  // Подзаголовок: тип навыка + delivery/damageType если есть.
  const subParts = [kind];
  if (sk.delivery) subParts.push('доставка: `' + sk.delivery + '`');
  if (sk.damageType) subParts.push('тип урона: `' + sk.damageType + '`');
  out.push('*' + subParts.join(' · ') + '*');
  out.push('');
  if (sk.flavor) {
    out.push('> ' + sk.flavor);
    out.push('');
  } else if (sk.description) {
    out.push('> ' + sk.description);
    out.push('');
  }
  // Тиры. Не у всех скиллов они есть (kind=='effect' обычно без них).
  if (sk.tiers) {
    for (const tier of ['basic', 'advanced', 'elite']) {
      if (!sk.tiers[tier]) continue;
      out.push(`#### ${TIER_LABEL[tier]}`);
      out.push('');
      out.push(buildTierBlock(id, tier, sk, ctx));
      out.push('');
    }
  } else {
    out.push('_(без тирной структуры — параметры одинаковы для всех уровней)_');
    out.push('');
  }
  out.push('---');
  out.push('');
  return out.join('\n');
}

/* Группировка: classId → массив записей. Скиллы без classId (эффекты-
   записи slowed/burning/poisoned/etc.) идут в отдельную секцию. */
function groupSkills(SKILLS) {
  const groups = { warrior: [], archer: [], mage: [], _effects: [], _other: [] };
  for (const id of Object.keys(SKILLS).sort()) {
    const sk = SKILLS[id];
    if (sk.kind === 'effect') {
      groups._effects.push({ id, sk });
      continue;
    }
    const cls = sk.classId;
    if (cls && groups[cls]) groups[cls].push({ id, sk });
    else groups._other.push({ id, sk });
  }
  return groups;
}

function buildClassSection(clsId, items, ctx, label) {
  if (!items.length) return '';
  const out = [];
  out.push(`## ${label} (${items.length} навыков)`);
  out.push('');
  for (const { id, sk } of items) {
    out.push(buildSkillBlock(id, sk, ctx));
  }
  return out.join('\n');
}

/* === MAIN ======================================================= */

function main() {
  const ctx = makeContext();
  loadAll(ctx);

  const SKILLS = ctx.SKILLS;
  if (!SKILLS) throw new Error('SKILLS не найден в контексте. Проверь порядок загрузки.');
  const fnTip = ctx.window.buildSkillTooltipText;
  if (typeof fnTip !== 'function') {
    throw new Error('window.buildSkillTooltipText не найден. Проверь skill-tooltip.js.');
  }

  const groups = groupSkills(SKILLS);

  const parts = [];
  parts.push(buildHeader());
  parts.push(buildClassSection('warrior', groups.warrior, ctx, '⚔️ ' + CLASS_LABEL.warrior));
  parts.push(buildClassSection('archer',  groups.archer,  ctx, '🏹 ' + CLASS_LABEL.archer));
  parts.push(buildClassSection('mage',    groups.mage,    ctx, '🔮 ' + CLASS_LABEL.mage));
  if (groups._other.length) {
    parts.push(buildClassSection('_other', groups._other, ctx, '🔘 Прочие'));
  }
  if (groups._effects.length) {
    parts.push(buildClassSection('_effects', groups._effects, ctx, '🌀 Эффекты (статус-записи)'));
  }

  const out = parts.join('\n');
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, out, 'utf8');

  const total = Object.keys(SKILLS).length;
  console.log(`✓ ${OUTPUT_PATH}`);
  console.log(`  всего записей: ${total} (воин ${groups.warrior.length} · лучник ${groups.archer.length} · маг ${groups.mage.length} · эффекты ${groups._effects.length} · прочие ${groups._other.length})`);
}

try {
  main();
} catch (e) {
  console.error('Ошибка генерации:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
}
