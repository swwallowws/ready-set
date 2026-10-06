// The website's "Inside Ableton Live" block: "Coming soon" until the extension has
// a release, then its download. Run: node scripts/test_extension_link.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkExtension, RELEASES } from './extension-link.mjs';

const page = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

// No release yet: the page stays as it is.
assert.equal(linkExtension(page, ''), page);

// A release: "Coming soon" goes, the download takes its place, nothing else changes.
const linked = linkExtension(page, 'v0.1.0');
assert.ok(!linked.includes('Coming soon'));
assert.ok(linked.includes(`href="${RELEASES}"`));
assert.ok(linked.includes('Download the extension'));
const at = page.indexOf('<!-- extension:soon -->');
const end = page.indexOf('<!-- /extension:soon -->') + '<!-- /extension:soon -->'.length;
assert.ok(linked.startsWith(page.slice(0, at)) && linked.endsWith(page.slice(end)));

// A page without the block is a mistake, not a silent no-op.
assert.throws(() => linkExtension('<main></main>', 'v0.1.0'), /extension:soon/);
console.log('extension link ok');
