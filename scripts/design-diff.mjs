// Diffs the handed-over design system against what the frontend actually ships.
//
// The complaint is that the redesign was not implemented in depth. That is a
// claim about SPECIFIC declarations, so this compares them one by one rather
// than forming an impression: every selector the design system defines, whether
// we define it at all, and where we do, which properties disagree.
//
// Only properties the design system actually states are compared. Extra
// properties on our side are not a divergence — the design system is a floor,
// not an exhaustive stylesheet.
import fs from 'node:fs';

const DESIGN = 'd:/JKANNEL/design/JKANNEL design system/tokens';
const APP = 'd:/JKANNEL/frontend/src';

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** Strips comments, then returns [{selector, decls:Map}] for top-level rules. */
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  // Skip at-rule blocks: media queries are compared separately and would
  // otherwise flatten into the base rules and produce false matches.
  const body = clean.replace(/@[a-z-]+[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi, '');
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      const val = d.slice(i + 1).trim();
      if (prop) decls.set(prop, val);
    }
    for (const sel of m[1].split(',')) {
      const s = sel.replace(/\s+/g, ' ').trim();
      if (s) out.push({ selector: s, decls });
    }
  }
  return out;
}

/** Values differing only in whitespace, quoting or case are the same value. */
const norm = (v) =>
  v
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/['"]/g, '')
    .replace(/0\.(\d)/g, '.$1')
    .trim();

const designRules = [
  ...rules(read(`${DESIGN}/components.css`)),
  ...rules(read(`${DESIGN}/layout.css`)),
];

// In load order, so "last declaration wins" below matches the real cascade.
// The design-system/ files are vendored copies of the package, which is why the
// bulk of the comparison now passes — this script exists to prove that stays
// true, and to catch anything the console overrides afterwards.
const appCss = [
  read(`${APP}/style.css`),
  read(`${APP}/views/workspace-extras.css`),
  read(`${APP}/design-authority.css`),
  read(`${APP}/design-system/spacing.css`),
  read(`${APP}/design-system/typography.css`),
  read(`${APP}/design-system/components.css`),
  read(`${APP}/design-system/layout.css`),
  read(`${APP}/design-system/index.css`), // loads last, wins
].join('\n');
const appRules = rules(appCss);

/** Last declaration wins, matching the cascade for equal specificity. */
function appValue(selector, prop) {
  let found;
  for (const r of appRules) {
    if (r.selector !== selector) continue;
    if (r.decls.has(prop)) found = r.decls.get(prop);
  }
  return found;
}
const appHasSelector = (selector) => appRules.some((r) => r.selector === selector);

// Properties that describe layout and identity. Comparing every property would
// bury the signal in shorthand-vs-longhand noise.
const KEY = new Set([
  'display',
  'grid-template-columns',
  'grid-template-rows',
  'flex-direction',
  'position',
  'height',
  'min-height',
  'width',
  'max-width',
  'padding',
  'margin',
  'gap',
  'border',
  'border-bottom',
  'border-top',
  'border-radius',
  'background',
  'box-shadow',
  'font-size',
  'font-weight',
  'text-transform',
  'letter-spacing',
  'color',
  'align-items',
  'justify-content',
  'overflow',
  'text-align',
  'top',
  'z-index',
]);

const missing = [];
const differs = [];
const matches = [];
const seen = new Set();

for (const rule of designRules) {
  if (rule.selector.startsWith(':root') || rule.selector.startsWith('@')) continue;
  if (seen.has(rule.selector + [...rule.decls.keys()].join())) continue;
  seen.add(rule.selector + [...rule.decls.keys()].join());

  if (!appHasSelector(rule.selector)) {
    missing.push({
      selector: rule.selector,
      props: [...rule.decls.keys()].filter((p) => KEY.has(p)),
    });
    continue;
  }
  for (const [prop, want] of rule.decls) {
    if (!KEY.has(prop)) continue;
    const got = appValue(rule.selector, prop);
    if (got === undefined) differs.push({ selector: rule.selector, prop, want, got: '(not set)' });
    else if (norm(got) !== norm(want)) differs.push({ selector: rule.selector, prop, want, got });
    else matches.push(1);
  }
}

const banner = (t) => `\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`;
console.log(banner('SELECTORS THE DESIGN SYSTEM DEFINES THAT WE DO NOT HAVE AT ALL'));
for (const m of missing)
  console.log(`  ${m.selector.padEnd(44)} ${m.props.slice(0, 5).join(', ')}`);
console.log(`\n  ${missing.length} missing selectors`);

console.log(banner('SELECTORS WE HAVE, BUT WITH DIFFERENT VALUES'));
let last = '';
for (const d of differs) {
  if (d.selector !== last) {
    console.log(`\n  ${d.selector}`);
    last = d.selector;
  }
  console.log(`      ${d.prop.padEnd(24)} want ${d.want.padEnd(38)} got ${d.got}`);
}
console.log(`\n  ${differs.length} diverging declarations`);
console.log(
  `\nSUMMARY  ${matches.length} match | ${differs.length} differ | ${missing.length} selectors absent`,
);
