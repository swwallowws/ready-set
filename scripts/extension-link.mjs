// Turns the website's "Coming soon" for the Ableton Live extension into its download
// once a release exists. deploy-web.sh runs it on the staged index.html, so the live
// site switches by itself on the first deploy after a release.
//   node scripts/extension-link.mjs <index.html> <latest release tag, or "">
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RELEASES = 'https://github.com/swwallowws/ready-set/releases/latest';
const BLOCK = /<!-- extension:soon -->[\s\S]*?<!-- \/extension:soon -->/;

export function linkExtension(html, tag) {
  if (!BLOCK.test(html)) throw new Error('index.html has no <!-- extension:soon --> block');
  if (!tag) return html;
  return html.replace(BLOCK, `<a class="ds-button" href="${RELEASES}">Download the extension</a>`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, tag = ''] = process.argv.slice(2);
  writeFileSync(file, linkExtension(readFileSync(file, 'utf8'), tag));
  console.log(tag ? `extension: ${tag} linked` : 'extension: no release yet, coming soon');
}
