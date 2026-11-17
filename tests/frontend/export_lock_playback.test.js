// An export locks the recording's editing controls, but never its playback controls:
// a track or A/B sample started before Process & Save must still be stoppable.
// Static check of index.html: the lock is a disabled <fieldset> (which disables every
// control inside it, whatever the control's own :disabled says) or a control's own
// :disabled binding, so this walks the markup and resolves each control's lock.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../../backend/static/index.html'), 'utf8');

const VOID_ELEMENTS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const CONTROLS = new Set(['button', 'input', 'select', 'textarea']);
// Quoted attribute values may contain '>' (arrow functions, comparisons), so match them whole.
const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g;
const attr = (attrs, name) => {
    const match = attrs.match(new RegExp(`\\s${name.replace(/[$:@.]/g, '\\$&')}\\s*=\\s*"([^"]*)"`));
    return match ? match[1] : null;
};
const disabledBinding = attrs => attr(attrs, ':disabled') ?? attr(attrs, 'x-bind:disabled') ?? (/\sdisabled[\s>=]/.test(attrs + '>') ? 'true' : null);
// A lock is a binding that is true while exporting; a negated lock ("!currentLocked") is the opposite.
const locksExport = binding => binding !== null && /(?<!!\s*)\b(?:currentLocked|processDisabled|isLocked\()/.test(binding);

/** Every form control with its own attributes, document position and whether an export locks it. */
function controls(source) {
    const stack = []; const found = [];
    for (const match of source.matchAll(TOKEN)) {
        const [, closing, name, attrs = '', selfClosing] = match;
        if (closing) {
            const at = stack.map(entry => entry.name).lastIndexOf(closing.toLowerCase());
            assert.ok(at >= 0, `unbalanced </${closing}> at offset ${match.index}`);
            stack.length = at;
            continue;
        }
        if (!name) continue;   // comment
        const tag = name.toLowerCase();
        if (CONTROLS.has(tag)) {
            const fieldsets = stack.filter(entry => entry.name === 'fieldset');
            found.push({ tag, attrs, offset: match.index,
                // Any disabled fieldset would disable a Pause inside it, whatever its condition.
                inDisabledFieldset: fieldsets.some(entry => disabledBinding(entry.attrs) !== null),
                locked: fieldsets.some(entry => locksExport(disabledBinding(entry.attrs))) || locksExport(disabledBinding(attrs)) });
        }
        if (!VOID_ELEMENTS.has(tag) && !selfClosing) stack.push({ name: tag, attrs });
    }
    return found;
}

const all = controls(html);
// The tokenizer must not silently skip a control it cannot parse.
assert.strictEqual(all.length, (html.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:button|input|select|textarea)\b/g) || []).length,
    'tag walker missed a control');
const describe = control => `<${control.tag}${control.attrs.slice(0, 140)}…>`;

// Playback only: they play, pause, seek or switch what is heard, and never change the export.
const PLAYBACK = [/@click="toggleTrackPlay\(/, /@click="auditionCut\(/, /@click="togglePlay\(\)"/,
    /@click="abToggle\(\)"/, /@click="abSetSide\(/, /@input="abSeek\(/, /x-model="abMatch"/, /x-model="abBoost"/];
const isPlayback = control => PLAYBACK.some(pattern => pattern.test(control.attrs));
for (const pattern of PLAYBACK) {
    assert.ok(all.some(control => pattern.test(control.attrs)), `playback control ${pattern} not found in index.html`);
}
for (const control of all.filter(isPlayback)) {
    assert.ok(!control.inDisabledFieldset, `playback control inside a disabled fieldset: ${describe(control)}`);
    assert.ok(!control.locked, `playback control disabled by the export lock: ${describe(control)}`);
}

// Everything else from the track table to the Process button stays locked during an export.
// Only form controls are checked: they are what a disabled fieldset or :disabled can lock
// (the region has no clickable <a>/<div>; one added there would need its own guard in app.js).
const regionStart = html.indexOf('<!-- Merged track table');
const regionEnd = html.indexOf('<!-- Success Message -->');
assert.ok(regionStart > 0 && regionEnd > regionStart, 'track table / export card markers not found');
const editing = all.filter(control => control.offset > regionStart && control.offset < regionEnd && !isPlayback(control));
assert.ok(editing.length > 30, `expected the track table and export card controls, found ${editing.length}`);
for (const control of editing) assert.ok(control.locked, `editing control not locked during an export: ${describe(control)}`);

console.log(`export lock ok (${editing.length} editing controls locked, ${all.filter(isPlayback).length} playback controls free)`);
