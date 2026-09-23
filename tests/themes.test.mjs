// Every built-in theme follows its own rules: each meaning colour clearly
// different from the others, text easy to read, and every signal readable on
// the backgrounds it sits on.
import assert from 'node:assert/strict';
import { installMock } from './mock.js';
installMock({ settings: { graphs: {} } });
const v = JSON.parse((await import('node:fs')).readFileSync(new URL('../manifest.json', import.meta.url))).version;
const T = await import(`../src/theme.js?v=${v}`);
const MEANING = T.ROLES.filter(r => r.group === 'meaning').map(r => r.key);

const needed = ['dark-night', 'blue-moon', 'purple-prose', 'pink-blink', 'brown-gown', 'sillytavern'];
assert.deepEqual(needed.filter(k => !T.PRESETS[k]), []);
const problems = [];
for (const [key, p] of Object.entries(T.PRESETS)) {
    const c = { panel: '#141418', block: '#282830', text: '#e8e8e8', ...p.colors };   // SillyTavern preset: typical dark ST theme
    const P = (k) => T.parseColor(c[k]);
    for (const k of ['panel', 'block', 'canvas', 'border', 'text', 'muted', ...MEANING]) if (c[k] !== undefined && !P(k)) problems.push(`${key}.${k} unparseable`);
    const tp = T.contrast(P('text'), P('panel')), tb = T.contrast(P('text'), P('block'));
    if (tp < 7 || tb < 7) problems.push(`${key}: text contrast ${tp.toFixed(1)} / ${tb.toFixed(1)} (want 7+)`);
    if (T.contrast(P('muted'), P('block')) < 3.5) problems.push(`${key}: muted text ${T.contrast(P('muted'), P('block')).toFixed(1)} on blocks`);
    for (const m of MEANING) {
        for (const bg of ['panel', 'block']) {
            const r = T.contrast(P(m), P(bg));
            if (r < 3) problems.push(`${key}: ${m} on ${bg} only ${r.toFixed(2)}:1`);
        }
    }
    for (let i = 0; i < MEANING.length; i++) for (let j = i + 1; j < MEANING.length; j++) {
        const dd = T.distance(P(MEANING[i]), P(MEANING[j]));
        if (dd < 20) problems.push(`${key}: ${MEANING[i]} vs ${MEANING[j]} only ${dd.toFixed(1)} apart`);
    }
    if (key !== 'sillytavern' && T.themeWarnings(c).length) problems.push(`${key}: ${T.themeWarnings(c).map(w => w.text).join(' ')}`);
}
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }

// the light fix: a colour picked for a dark theme is darkened on a light panel
const pale = T.parseColor('#f0c36a'), white = T.parseColor('#ffffff');
assert.ok(T.contrast(pale, white) < 3);
assert.ok(T.contrast(T.fitContrast(pale, white), white) >= 3);
const fitted = T.toHex(T.fitContrast(pale, white));
assert.notEqual(fitted, '#f0c36a');

// warnings catch look-alikes and unreadable text
const w = T.themeWarnings({ flow: '#7ab7ff', append: '#7bb8fe', text: '#333333', panel: '#222222', block: '#222222' });
assert.ok(w.some(x => x.kind === 'similar'));
assert.ok(w.some(x => x.kind === 'contrast'));

// export and import round trip, and custom colours sit on top of a preset
T.setPreset('blue-moon');
T.setColor('generate', '#ff00aa');
const shared = T.exportTheme('Mine');
T.setPreset('dark-night');
assert.equal(T.currentTheme().colors.generate, T.PRESETS['dark-night'].colors.generate);
assert.equal(T.importTheme(shared).ok, true);
assert.equal(T.currentTheme().preset, 'blue-moon');
assert.equal(T.currentTheme().colors.generate, '#ff00aa');
assert.equal(T.currentTheme().colors.flow, T.PRESETS['blue-moon'].colors.flow);
T.setColor('generate', null);
assert.equal(T.currentTheme().colors.generate, T.PRESETS['blue-moon'].colors.generate, 'reset one role');
assert.equal(T.importTheme('not a theme').ok, false);
assert.equal(T.importTheme('{"sillyCanvasTheme":1,"colors":{"flow":"javascript:alert(1)"}}').ok, true);
assert.equal(T.currentTheme().custom.flow, undefined, 'junk values are dropped');
console.log('themes: ok');
