import assert from 'node:assert/strict';
import { geoTag } from '../lib/geo.js';
import { scoreMarket, actionFor } from '../lib/score.js';
import { classify } from '../lib/types.js';
import { parseGkg } from '../lib/ingest.js';

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
assert.ok(scoreMarket(spike).score > scoreMarket(flat).score + 15, 'spike should outscore flat');
// persistence: the same total coverage spread over 8 days beats a 2 day burst
const steady = flat.concat([0, 1, 2, 3, 4, 5, 6, 7].map(n => ({ d: day(n), type: 'mass_casualty', domains: 8 })));
assert.ok(scoreMarket(steady).score > scoreMarket(spike).score, 'sustained coverage beats a short burst');
assert.equal(scoreMarket(steady).durability, 'Sustained');
assert.equal(scoreMarket(spike).durability, 'Spike');
assert.equal(scoreMarket(flat.concat([{ d: day(6), type: 'mass_casualty', domains: 30 }])).durability, 'Fading');
assert.match(actionFor(80, ['carjacking'], [], 'Spike', 1).action, /Don't shift/);
const old = flat.concat([{ d: day(13), type: 'mass_casualty', domains: 40 }]);
assert.ok(scoreMarket(spike).score > scoreMarket(old).score, 'recent beats old');
assert.equal(actionFor(80).level, 'Hot');
assert.ok(!/%|bid/i.test(actionFor(80, ['carjacking'], ['Houston']).action), 'no bid language');
assert.match(actionFor(80, ['carjacking','home_invasion'], ['Houston','Dallas']).action, /Houston and Dallas/);
assert.equal(actionFor(5).level, 'Quiet');

// headline classifier
assert.deepEqual(classify('Riot Games announces new champion'), []);
assert.deepEqual(classify('Looters hit stores after Atlanta blackout'), ['disaster_looting']);
assert.deepEqual(classify('Looters caught on camera at the mall'), []); // looting needs a disaster word
assert.deepEqual(classify('ICE agents arrest dozens in Charlotte'), ['ice_enforcement']);

// GKG 2.1 line: 27 tab separated columns, title lives in Extras, geo from title first then location column
const row = (title, loc = '') => { const f = Array(27).fill(''); f[1] = '20261006143000'; f[3] = 'wral.com'; f[4] = 'https://wral.com/a1'; f[10] = loc; f[26] = `<PAGE_TITLE>${title}</PAGE_TITLE>`; return f.join('\t'); };
const txt = [
  row('Mass shooting leaves 4 dead in Houston, police say'),
  row('Police: &quot;active shooter&quot; reported near mall', '3#Tulsa, Oklahoma, United States#US#USOK#USOK143#36.1#-95.9#1#10'),
  row('Active shooter drill planned', '1#United States#US#US##39#-98#US#5;3#Tulsa, Oklahoma, United States#US#USOK#USOK143#36.1#-95.9#1#10;3#Dallas, Texas, United States#US#USTX#USTX113#32#-96#2#40'),
  row('Local bakery wins award in Houston'),
  'broken\tline',
].join('\n');
const got = parseGkg(txt);
assert.equal(got.length, 2);
assert.deepEqual([got[0].type, got[0].state, got[0].city, got[0].domain], ['mass_casualty', 'TX', 'Houston', 'wral.com']);
assert.deepEqual([got[1].state, got[1].city], ['OK', 'Tulsa']);
assert.ok(got[1].title.includes('"active shooter"'), 'xml entities decoded');
console.log('all tests passed');
