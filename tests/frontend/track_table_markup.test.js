// The merged track table in index.html (ported from upstream PR 21's review fixes): header and rows
// share one wrapper shape, no element combines a static style with a string :style, and an ignored row
// dims its data cells but never its buttons.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'static', 'index.html'), 'utf8');

// ---- a static style plus a string :style on one element: Alpine 3.17 applies a string :style with
// setAttribute("style", ...), wiping the static one (the row separators vanished).  Use the object form. ----
// Opening tags, walking the attributes with their quoting: a plain /<[^<>]*>/ stops at a ">" or "<"
// inside an attribute value ("=>", ">=") and skips that tag.
const openingTagsOf = markup => {
    const tags = [];
    for (let at = markup.indexOf('<'); at >= 0; at = markup.indexOf('<', at + 1)) {
        if (!/[a-z]/i.test(markup[at + 1] || '')) continue;
        let quote = null, end = at + 1;
        for (; end < markup.length; end++) {
            const char = markup[end];
            if (quote) { if (char === quote) quote = null; } else if (char === '"' || char === "'") quote = char;
            else if (char === '>') break;
        }
        tags.push(markup.slice(at, end + 1));
        at = end;
    }
    return tags;
};
const openingTags = openingTagsOf(html);
// A string binding starts with a quote/backtick or is a ternary yielding one; `cond ? { ... } : {}` is an object.
const stringStyle = tag => /\s:style="\s*['`]/.test(tag) || /\s:style="[^"]*\?\s*['`]/.test(tag);
const clashing = openingTags.filter(tag => /\sstyle="/.test(tag) && stringStyle(tag));
assert.deepStrictEqual(clashing.map(tag => tag.slice(0, 80)), [], 'static style + string :style on the same element');
// the scan sees tags whose attributes contain ">" and "=>", and the object-form elements that are fine
const fixture = '<div style="a: b" :style="`x: ${items.find(i => i.n >= 2)}`" @click="go(() => 1)">';
assert.deepStrictEqual(openingTagsOf(fixture + '<p>'), [fixture, '<p>']);
assert.ok(openingTagsOf(fixture).filter(tag => /\sstyle="/.test(tag) && stringStyle(tag)).length === 1, 'a string :style on a tag containing => is caught');
const objectForm = openingTags.filter(tag => /\sstyle="/.test(tag) && /\s:style="/.test(tag));
assert.strictEqual(objectForm.length, 3, 'the Ignored button and both context menus use an object :style next to a static style');

// ---- the header and a row are separate grids with the same shape: every column but one fixed ----
const css = html.match(/\.track-grid\s*\{([^}]*)\}/)[1];
const columns = css.match(/grid-template-columns:\s*([^;]*);/)[1].trim();
const tokens = columns.replace(/minmax\([^)]*\)/g, found => found.replace(/\s/g, '')).split(/\s+/);
const flexible = tokens.filter(token => !/^\d+px$/.test(token));
assert.strictEqual(flexible.length, 1, 'only one non-fixed column: ' + columns);
assert.ok(!/auto|max-content|min-content|fit-content/.test(columns));
assert.ok(/\.track-table-scroll\s*\{\s*overflow-x:\s*auto/.test(html), 'a narrow window scrolls the table, not the page');

const rule = selector => {
    const found = html.match(new RegExp('\\n\\s*' + selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}'));
    assert.ok(found, selector + ' rule');
    return found[1];
};
// Header and rows share one wrapper rule: the same transparent left border and the same width (the
// grid's min-width plus that border), so their cells line up even when the table scrolls sideways.
const shared = rule('.track-head, .track-row');
const borderPx = Number((shared.match(/border-left:\s*(\d+)px\s+solid\s+transparent/) || [])[1]);
assert.ok(borderPx > 0, 'header and rows reserve a transparent left border');
const gridMin = Number(rule('.track-grid').match(/min-width:\s*(\d+)px/)[1]);
// The grid's min-width must be what its columns really need (fixed widths + the flexible column's
// minmax minimum + the gaps). Too small, and the columns overflow the grid box: the last cell's buttons
// stuck out past the header and row separators when the table scrolled (fork, after the Clicks and
// Declick columns were added to a 1050 px minimum that no longer held them).
const gapPx = Number(rule('.track-grid').match(/(?:^|[\s;])gap:\s*(\d+)px/)[1]);
const columnMinimum = tokens.reduce((sum, token) => sum + Number((token.match(/^(\d+)px$/) || token.match(/^minmax\((\d+)px,/))[1]), 0)
    + gapPx * (tokens.length - 1);
assert.strictEqual(gridMin, columnMinimum, `.track-grid min-width ${gridMin}px vs ${columnMinimum}px its columns need`);
assert.strictEqual(Number((shared.match(/min-width:\s*(\d+)px/) || [])[1]), gridMin + borderPx, 'wrappers are as wide as the grid plus the border');
assert.ok(/border-bottom/.test(rule('.track-row')) && /border-bottom/.test(rule('.track-head')), 'separators are in the classes');
const playingRule = rule('.track-row-playing');
assert.ok(!/padding|border-left:\s*\d+px\s+solid/.test(playingRule.replace(/border-left-color/g, '')), 'the playing row only recolours, it never changes the box');
assert.ok(/border-left-color/.test(playingRule));
assert.ok(/<div class="track-row py-2" :class="\{ 'track-row-playing': playheadIdx === idx \}">/.test(html), 'playing row class toggled by the playhead');
assert.ok(/<div class="track-head pb-2">\s*<div class="track-grid/.test(html), 'the header grid sits in a track-head wrapper, like each row in a track-row');

// ---- header cells and row cells both equal the column count ----
const topLevelCount = markup => {
    let depth = 0, count = 0;
    for (const tag of markup.matchAll(/<(\/?)(div|select|input|span|button|template|label|svg|path)\b[^>]*?(\/?)>/g)) {
        const closing = tag[1] === '/', selfClosing = tag[3] === '/' || ['input', 'path'].includes(tag[2]);
        if (closing) { depth--; continue; }
        if (depth === 0 && tag[2] === 'div') count++;
        if (!selfClosing) depth++;
    }
    return count;
};
const headerStart = html.indexOf('<div class="track-grid text-xs');
const headerMarkup = html.slice(html.indexOf('>', headerStart) + 1, html.indexOf('</div>\n                            </div>\n                            <template x-for="(track, idx) in detectedTracks"'));
assert.strictEqual(topLevelCount(headerMarkup), tokens.length, 'header cells = columns');
const rowStart = html.indexOf('<div class="track-grid text-sm"');
const rowEnd = html.indexOf('<form x-show="trackFormShown(idx)"');
assert.ok(rowStart > 0 && rowEnd > rowStart);
const rowMarkup = html.slice(html.indexOf('>', rowStart) + 1, html.lastIndexOf('<fieldset', rowEnd)).replace(/<\/div>\s*$/, '');
assert.strictEqual(topLevelCount(rowMarkup), tokens.length, 'row cells = columns');

// ---- an ignored row dims its data cells only: the enabled buttons keep their contrast ----
const rowGridTag = html.match(/<div class="track-grid text-sm"[^>]*>/)[0];
assert.ok(!/opacity-50/.test(rowGridTag), 'the row grid itself is not dimmed');
const buttonsAt = rowMarkup.indexOf('flex gap-1.5 justify-end');
assert.ok(buttonsAt > 0);
const buttonCell = rowMarkup.slice(buttonsAt);
const buttonCellWithoutDisabledStates = buttonCell.replace(/:class="\{[^"]*cursor-not-allowed[^"]*\}"/g, '');
assert.ok(!/track\.ignored \}/.test(buttonCellWithoutDisabledStates), 'no ignored-row dimming on or inside the button cell');
assert.ok((rowMarkup.slice(0, buttonsAt).match(/'opacity-50': track\.ignored/g) || []).length >= 8, 'swatch, number, mapping, times, length, Discogs, delta, clicks and declick cells dim');
// Un-ignore stays clearly emphasised: an object :style (a string one would wipe the static style)
assert.ok(/:style="track\.ignored \? \{ backgroundColor: '#5E5E5A', color: '#FFFFFF' \} : \{\}"/.test(buttonCell), 'the Ignored button keeps a dark fill with white text');

// ---- the playing row's Pause stays enabled even when that row is ignored ----
assert.ok(html.includes(':disabled="!waveform || (track.ignored && !(isPlaying && playheadIdx === idx))"'),
    'the playing row keeps its Pause enabled even when ignored');
console.log('track_table_markup ok');
