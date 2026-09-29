// Search over the frozen /try/ catalogue. Run: node tabridge/scripts/test_try_search.mjs
import assert from 'node:assert/strict';
import { searchCatalog } from '../web/try/search.js';
const rows = [
  { uid: 'a', title: 'Greensleeves', artist: 'Traditional' },
  { uid: 'b', title: 'Gymnopédie No. 1', artist: 'Erik Satie' },
];
assert.deepEqual(searchCatalog(rows, 'green').map((r) => r.uid), ['a']);
assert.deepEqual(searchCatalog(rows, 'GYMNOPEDIE').map((r) => r.uid), ['b']);
assert.deepEqual(searchCatalog(rows, 'satie').map((r) => r.uid), ['b']);
assert.deepEqual(searchCatalog(rows, ''), []);
assert.deepEqual(searchCatalog(rows, 'deftones'), []);
console.log('try search ok');
