import assert from 'node:assert/strict';
import { geoTag } from '../lib/geo.js';
import { scoreMarket, actionFor } from '../lib/score.js';
import { gdeltQuery } from '../lib/types.js';

const cases = [
  ['Chicago police respond to mass shooting that left 6 hurt', 'IL', 'Chicago'],
  ['ICE agents arrest dozens in Charlotte, North Carolina', 'NC', 'Charlotte'],
  ['Protesters clash with police in West Virginia', 'WV', null],
  ['Carjacking suspect arrested in Virginia Beach', 'VA', 'Virginia Beach'],
  ['Tear gas used on crowd outside Portland, Maine rally', 'ME', 'Portland'],
  ['Texas governor deploys National Guard', 'TX', null],
  ['Looters hit stores after Atlanta blackout', 'GA', 'Atlanta'],
  ['Man killed in Washington, D.C. shooting', 'DC', 'Washington'],
];
for (const [t, st, city] of cases) {
  const g = geoTag(t);
  assert.ok(g, `no geo: ${t}`);
  assert.equal(g.state, st, t);
  assert.equal(g.city, city, t);
}
assert.equal(geoTag('Georgia and Russia sign deal'), null);
assert.equal(geoTag('Nationwide protest planned'), null);

// scoring: a fresh spike beats a flat baseline
const day = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const flat = []; for (let n = 15; n < 70; n++) flat.push({ d: day(n), type: 'mass_casualty', domains: 3 });
const spike = flat.concat([{ d: day(0), type: 'mass_casualty', domains: 40 }, { d: day(1), type: 'mass_casualty', domains: 25 }]);
assert.ok(scoreMarket(spike).score > scoreMarket(flat).score + 30, 'spike should outscore flat');
const old = flat.concat([{ d: day(13), type: 'mass_casualty', domains: 40 }]);
assert.ok(scoreMarket(spike).score > scoreMarket(old).score, 'recent beats old');
assert.equal(actionFor(80).level, 'Hot');
assert.equal(actionFor(5).level, 'Quiet');
console.log(gdeltQuery('disaster_looting'));
console.log('all tests passed');
