import assert from 'node:assert/strict';
import { geoTag } from '../lib/geo.js';
import { scoreMarket, actionFor, windowFor } from '../lib/score.js';
import { affordFor } from '../lib/income.js';
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

// scoring: a fresh spike beats a flat baseline (spikes matter)
const day = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const flat = []; for (let n = 15; n < 70; n++) flat.push({ d: day(n), type: 'home_invasion', domains: 2, n: 2 });
const spike = flat.concat([{ d: day(0), type: 'home_invasion', domains: 12, n: 15 }, { d: day(1), type: 'home_invasion', domains: 8, n: 9 }]);
assert.ok(scoreMarket(spike).score > scoreMarket(flat).score + 30, 'spike should outscore flat');
const old = flat.concat([{ d: day(13), type: 'home_invasion', domains: 12, n: 15 }]);
assert.ok(scoreMarket(spike).score > scoreMarket(old).score, 'recent beats old');

// ICE and protest coverage score like any high-fit type
assert.ok(scoreMarket([{ d: day(0), type: 'ice_enforcement', domains: 10, n: 10 }]).score > 0);
assert.equal(windowFor([{ d: day(0), type: 'unrest', domains: 10, n: 10 }]).lastTrigger, 0);

// severity: same outlets, a murder outweighs a minor incident
const ev = (sev, minor) => [{ d: day(0), type: 'home_invasion', domains: 6, n: 6, severe: sev, minor }];
assert.ok(scoreMarket(ev(4, 0)).score > scoreMarket(ev(0, 0)).score && scoreMarket(ev(0, 0)).score > scoreMarket(ev(0, 5)).score, 'severity orders scores');

// triggers are for major stories: a handful of outlets is not enough, 8+ is; severe incidents need 6+
assert.equal(windowFor([{ d: day(0), type: 'stalking_abduction', domains: 1, n: 1 }]).lastTrigger, null, 'single outlet is not a trigger');
assert.equal(windowFor([{ d: day(0), type: 'stalking_abduction', domains: 5, n: 5 }]).lastTrigger, null, 'small story is not a trigger');
assert.equal(windowFor([{ d: day(0), type: 'stalking_abduction', domains: 9, n: 9 }]).lastTrigger, 0);
assert.equal(windowFor([{ d: day(0), type: 'stalking_abduction', domains: 6, n: 6, severe: 3 }]).lastTrigger, 0, 'severe needs fewer outlets');

// a high-crime market with steady coverage stays near 0 heat and never triggers on its normal
const busy = []; for (let n = 0; n < 74; n++) busy.push({ d: day(n), type: 'violent_crime_spike', domains: 10, n: 10 });
assert.ok(scoreMarket(busy).score < 10, 'steady high crime is not heat');
assert.equal(windowFor(busy).lastTrigger, null, 'steady high crime is not a trigger');

// window: 14 days from the last trigger, repeats counted, resolved shortens it, unresolved extends it
const w1 = windowFor([{ d: day(3), type: 'carjacking', domains: 10, n: 10 }]);
assert.equal(w1.daysLeft, 11);
const w2 = windowFor([{ d: day(9), type: 'carjacking', domains: 10, n: 10 }, { d: day(2), type: 'carjacking', domains: 10, n: 10 }]);
assert.equal(w2.incidents, 2); assert.equal(w2.daysLeft, 12);
assert.equal(windowFor([{ d: day(4), type: 'carjacking', domains: 10, n: 10 }, { d: day(1), type: 'carjacking', domains: 1, n: 2, resolved: 2 }]).daysLeft, 3, 'arrest shortens');
assert.equal(windowFor([{ d: day(4), type: 'carjacking', domains: 10, n: 10 }, { d: day(1), type: 'carjacking', domains: 1, n: 2, ongoing: 1 }]).daysLeft, 14, 'at large extends');

// calls
const win = (daysLeft, incidents = 1) => ({ lastTrigger: 14 - daysLeft, daysLeft, incidents, note: '' });
assert.equal(actionFor(80, ['carjacking'], [], win(12)).call, 'Launch');
assert.equal(actionFor(80, ['carjacking'], [], win(12, 2)).call, 'Extend');
assert.equal(actionFor(80, ['carjacking'], [], win(3)).call, 'Wind down');
assert.equal(actionFor(30, ['carjacking'], [], win(12)).call, 'Watch');
assert.equal(actionFor(80, ['carjacking'], [], null).call, 'Hold');
assert.equal(actionFor(80, ['carjacking'], [], win(12), { tier: 'Low', ratio: 0.7 }).call, 'Hold', 'low income holds');
assert.match(actionFor(80, ['carjacking'], [], win(12), { tier: 'Mid', ratio: 0.95 }).action, /top 50% household income/);
assert.ok(!/%|bid/i.test(actionFor(80, ['carjacking'], ['Houston'], win(12)).action), 'no bid language');
assert.match(actionFor(80, ['carjacking', 'home_invasion'], ['Houston', 'Dallas'], win(12)).action, /Houston and Dallas/);
assert.equal(actionFor(5).level, 'Quiet');

// income lookup: cities use their metro, states their own median
const inc = { us: 78000, states: { TX: 76000, MS: 54000, MA: 99000 }, metros: [
  { name: 'Houston-Pasadena-The Woodlands, TX', cities: ['Houston', 'Pasadena', 'The Woodlands'], states: ['TX'], income: 80000 },
  { name: 'New York-Newark-Jersey City, NY-NJ', cities: ['New York', 'Newark', 'Jersey City'], states: ['NY', 'NJ'], income: 97000 }] };
assert.equal(affordFor('MS', inc).tier, 'Low');
assert.equal(affordFor('MA', inc).tier, 'High');
assert.equal(affordFor('Houston, TX', inc).income, 80000);
assert.equal(affordFor('Brooklyn, NY', inc).income, 97000, 'borough maps to NY metro');
assert.equal(affordFor('El Paso, TX', inc).source, 'TX statewide (no metro match)');

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
