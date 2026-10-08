import assert from 'node:assert/strict';
import { geoTag } from '../lib/geo.js';
import { scoreMarket, actionFor, windowFor } from '../lib/score.js';
import { affordFor } from '../lib/income.js';
import { isTrusted, isNational } from '../lib/outlets.js';
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
// campuses and "Town, ST" places that aren't in the city list
assert.deepEqual(geoTag("Cornell president calls gang rape allegations 'deeply disturbing'"), { state: 'NY', city: 'Ithaca' });
assert.deepEqual(geoTag('Columbia University students stage walkout'), { state: 'NY', city: 'New York City' });
assert.deepEqual(geoTag('Woman attacked on trail in Ithaca, N.Y.'), { state: 'NY', city: 'Ithaca' });
assert.deepEqual(geoTag('Shooting reported in Bozeman, Montana'), { state: 'MT', city: 'Bozeman' });
assert.deepEqual(geoTag('Shooting on Monday, Texas police say'), { state: 'TX', city: null });
assert.equal(geoTag('Nationwide protest planned'), null);

const day = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
// scoring: a fresh spike beats a flat baseline (spikes matter). national = distinct national outlets that day.
const N = 5; // comfortably over the national gate
const flat = []; for (let n = 15; n < 70; n++) flat.push({ d: day(n), type: 'high_profile_crime', domains: 3, national: 3, n: 3 });
const spike = flat.concat([{ d: day(0), type: 'high_profile_crime', domains: 12, national: N, n: 15 }, { d: day(1), type: 'high_profile_crime', domains: 8, national: N, n: 9 }]);
assert.ok(scoreMarket(spike).score > scoreMarket(flat).score + 25, 'spike should outscore flat');
const old = flat.concat([{ d: day(13), type: 'high_profile_crime', domains: 12, national: N, n: 15 }]);
assert.ok(scoreMarket(spike).score > scoreMarket(old).score, 'recent beats old');

// MAJOR EVENT GATE: a busy local crime day with lots of local outlets but no national pickup is nothing
const localWeek = []; for (let n = 0; n < 7; n++) localWeek.push({ d: day(n), type: 'high_profile_crime', domains: 15, national: 1, n: 20, severe: 10 });
assert.equal(scoreMarket(localWeek).score, 0, 'local crime week is not heat');
assert.equal(windowFor(localWeek).lastTrigger, null, 'local crime week is not a trigger');
// the same coverage with national pickup is a trigger
assert.equal(windowFor([{ d: day(0), type: 'mass_casualty', domains: 15, national: 6, n: 20 }]).lastTrigger, 0);
assert.ok(scoreMarket([{ d: day(0), type: 'political_violence', domains: 12, national: 8, n: 12 }]).score >= 40, 'attack on a politician lands Warm+');
assert.ok(scoreMarket([{ d: day(0), type: 'unrest', domains: 10, national: 4, n: 10 }]).score > 0);
// dropped types (ICE etc) never score, even with old rows still in the DB
assert.equal(scoreMarket([{ d: day(0), type: 'ice_enforcement', domains: 10, national: 6, n: 10 }]).score, 0);

// severity: same outlets, a murder outweighs a minor incident
const ev = (sev, minor) => [{ d: day(0), type: 'high_profile_crime', domains: 6, national: N, n: 6, severe: sev, minor }];
assert.ok(scoreMarket(ev(4, 0)).score > scoreMarket(ev(0, 0)).score && scoreMarket(ev(0, 0)).score > scoreMarket(ev(0, 5)).score, 'severity orders scores');

// triggers need 6+ trusted outlets (4 if severe) on top of the national gate
assert.equal(windowFor([{ d: day(0), type: 'high_profile_crime', domains: 5, national: 3, n: 5 }]).lastTrigger, null, 'small story is not a trigger');
assert.equal(windowFor([{ d: day(0), type: 'high_profile_crime', domains: 9, national: 3, n: 9 }]).lastTrigger, 0);
assert.equal(windowFor([{ d: day(0), type: 'high_profile_crime', domains: 4, national: 3, n: 4, severe: 2 }]).lastTrigger, 0, 'severe needs fewer outlets');

// a market with steady national-level coverage stays near 0 heat and never triggers on its normal
const busy = []; for (let n = 0; n < 74; n++) busy.push({ d: day(n), type: 'high_profile_crime', domains: 10, national: 4, n: 10 });
assert.ok(scoreMarket(busy).score < 10, 'steady coverage is not heat');
assert.equal(windowFor(busy).lastTrigger, null, 'steady coverage is not a trigger');

// window: 14 days from the last trigger, repeats counted, resolved shortens it, unresolved extends it
const big = d => ({ d: day(d), type: 'mass_casualty', domains: 10, national: N, n: 10 });
const w1 = windowFor([big(3)]);
assert.equal(w1.daysLeft, 11);
const w2 = windowFor([big(9), big(2)]);
assert.equal(w2.incidents, 2); assert.equal(w2.daysLeft, 12);
// follow-ups (arrest, still at large) count even without national pickup
assert.equal(windowFor([big(4), { d: day(1), type: 'mass_casualty', domains: 1, national: 0, n: 2, resolved: 2 }]).daysLeft, 3, 'arrest shortens');
assert.equal(windowFor([big(4), { d: day(1), type: 'mass_casualty', domains: 1, national: 0, n: 2, ongoing: 1 }]).daysLeft, 14, 'at large extends');

// calls
const win = (daysLeft, incidents = 1) => ({ lastTrigger: 14 - daysLeft, daysLeft, incidents, note: '' });
assert.equal(actionFor(80, ['high_profile_crime'], [], win(12)).call, 'Launch');
assert.equal(actionFor(80, ['high_profile_crime'], [], win(12, 2)).call, 'Extend');
assert.equal(actionFor(80, ['high_profile_crime'], [], win(3)).call, 'Wind down');
assert.equal(actionFor(30, ['high_profile_crime'], [], win(12)).call, 'Watch');
assert.equal(actionFor(80, ['high_profile_crime'], [], null).call, 'Hold');
assert.equal(actionFor(80, ['high_profile_crime'], [], win(12), { tier: 'Low', ratio: 0.7 }).call, 'Hold', 'low income holds');
assert.match(actionFor(80, ['high_profile_crime'], [], win(12), { tier: 'Mid', ratio: 0.95 }).action, /top 50% household income/);
assert.ok(!/%|bid/i.test(actionFor(80, ['high_profile_crime'], ['Houston'], win(12)).action), 'no bid language');
assert.match(actionFor(80, ['high_profile_crime', 'mass_casualty'], ['Houston', 'Dallas'], win(12)).action, /Houston and Dallas/);
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
assert.equal(affordFor('Houston, TX', inc, { campus: true }).income, 76000, 'campus stories use the state median');

// headline classifier: major events only
const C = t => classify(t);
assert.deepEqual(C('Riot Games announces new champion'), []);
assert.deepEqual(C('Riot Fest lineup announced in Chicago'), []);
assert.deepEqual(C('Grape harvest begins early'), []);
// ICE is out, including ICE protests called riots
assert.deepEqual(C('ICE agents arrest dozens in Charlotte'), []);
assert.deepEqual(C('ICE raids in Los Angeles spark fear'), []);
assert.deepEqual(C('Rioters clash with agents outside Portland ICE facility'), []);
// mass shootings and attacks
assert.deepEqual(C('Mass shooting at Ohio festival'), ['mass_casualty']);
assert.deepEqual(C('Gunman opens fire at Austin mall, 5 killed'), ['mass_casualty']);
assert.deepEqual(C('4 people shot outside Dallas nightclub'), ['mass_casualty']);
assert.deepEqual(C('Police: 2 people shot in Memphis'), []);
assert.deepEqual(C('Driver plowed into New Orleans crowd'), ['mass_casualty']);
// political figures attacked: physical attacks only, not rhetoric or losses
assert.deepEqual(C('Minnesota lawmakers shot in their homes'), ['political_violence']);
assert.deepEqual(C('Assassination attempt on Trump in Butler, Pennsylvania'), ['political_violence']);
assert.deepEqual(C('Conservative activist shot at Utah Valley University event'), ['political_violence']);
assert.deepEqual(C("Pennsylvania governor's mansion set on fire"), ['political_violence']);
assert.deepEqual(C('Senator Jane Doe attacked outside Phoenix office'), ['political_violence']);
assert.deepEqual(C('Senator attacked over vote in Arizona'), []);
assert.deepEqual(C('Governor beaten in Texas primary'), []);
assert.deepEqual(C('Mayor shot down plan in Denver'), []);
assert.deepEqual(C('Governor says man shot by police in Dallas'), []);
assert.deepEqual(C('Judge sentences man who shot clerk in Tampa'), []);
assert.deepEqual(C('JFK assassination files released in Dallas'), []);
// riots
assert.deepEqual(C('Riots erupt in Los Angeles after verdict'), ['unrest']);
assert.deepEqual(C('Curfew imposed as protests grip Minneapolis'), ['unrest']);
assert.deepEqual(C('Looters hit stores after Atlanta blackout'), ['unrest']);
assert.deepEqual(C('Inmates riot at Georgia prison'), []);
// high-profile crime (counts only with national pickup): the Cornell case
assert.deepEqual(C("Cornell president calls gang rape allegations 'deeply disturbing'"), ['high_profile_crime']);
assert.deepEqual(C('Pressure Mounts on Cornell to Explain Its Handling of Sexual Assault Allegations'), ['high_profile_crime']);
assert.deepEqual(C('Man arrested for burglary in Mesa'), []);
// national outlets: CBS local stations live on cbsnews.com but are local
assert.ok(isNational('apnews.com') && isNational('www.cnn.com') && isNational('cbsnews.com', 'https://www.cbsnews.com/news/x'));
assert.ok(!isNational('cbsnews.com', 'https://www.cbsnews.com/chicago/news/x') && !isNational('latimes.com') && !isNational('khou.com'));

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
// outlets: newsrooms count, aggregators and random sites don't, learned local outlets do
assert.ok(isTrusted('khou.com') && isTrusted('www.nytimes.com') && isTrusted('wbur.org') && isTrusted('fox26houston.com'));
assert.ok(!isTrusted('yahoo.com') && !isTrusted('patch.com') && !isTrusted('randomcrimeblog.net'));
assert.ok(isTrusted('ithacajournal.com', new Set(['ithacajournal.com'])), 'learned local outlet counts');
assert.ok(!isTrusted('patch.com', new Set(['patch.com'])), 'blocked stays blocked');
console.log('all tests passed');
