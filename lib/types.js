// Event types, buyer-fit tiers, and GDELT query terms.
// Tiers are about SALES, not news volume: how much an incident makes ordinary people think "this could happen to me"
// and reach for a non-lethal personal device. Tier 1 = high buyer fit, 2 = medium, 3 = low.
// Bump when terms or geo rules change: on deploy the last 90 days are re-read so baselines stay consistent.
export const CLASSIFIER_VERSION = 2;

export const TYPES = {
  ice_enforcement:    { label: 'ICE raids / enforcement surge', tier: 1, weight: 0.9,
    terms: ['"ICE raid"', '"ICE raids"', '"ICE agents"', '"immigration raid"', '"immigration sweep"', '"ICE arrests"'] },
  unrest:             { label: 'Protest / unrest', tier: 1, weight: 0.8,
    terms: ['"tear gas"', '"protesters clash"', '"protest turns violent"', 'rioters', '"riot police"', '"rioting"', '"curfew imposed"', '"National Guard deployed"'] },
  stalking_abduction: { label: 'Sexual assault / stalking / abduction', tier: 1, weight: 1.0,
    terms: ['"sexual assault"', '"sexually assaulted"', '"sex assault"', 'rape', 'raped', 'rapist', '"gang rape"',
      '"attempted abduction"', '"attempted kidnapping"', 'stalker', '"jogger attacked"', '"woman attacked"', '"woman abducted"'] },
  home_invasion:      { label: 'Home invasion / break-in cluster', tier: 1, weight: 1.0,
    terms: ['"home invasion"', '"burglary spree"', '"break-ins"'] },
  carjacking:         { label: 'Carjacking / road rage', tier: 1, weight: 0.9,
    terms: ['carjacking', 'carjackings', '"road rage shooting"'] },
  violent_crime_spike:{ label: 'Violent crime spike', tier: 1, weight: 0.8,
    terms: ['"crime spike"', '"violent crime surge"', '"wave of shootings"', '"spike in homicides"'] },
  police_response:    { label: 'Police shortage / slow response', tier: 2, weight: 0.6,
    terms: ['"police shortage"', '"911 response times"', '"police budget cuts"', '"slow police response"'] },
  campus:             { label: 'Campus incident', tier: 2, weight: 0.5,
    // any violent word in a headline that is clearly about a campus
    terms: ['shooting', 'shooter', 'stabbing', 'stabbed', 'assault', 'assaulted', 'rape', 'raped', 'attacked', 'abducted', 'kidnapped', 'lockdown'],
    must: ['campus', 'university', 'college', 'fraternity', 'sorority', 'dorm', 'student', 'students', 'Cornell', 'Harvard', 'Yale', 'Stanford'] },
  disaster_looting:   { label: 'Disaster / blackout looting', tier: 2, weight: 0.5,
    terms: ['looting', 'looters'], must: ['hurricane', 'blackout', 'outage', 'storm', 'flood', 'wildfire'] },
  mass_casualty:      { label: 'Mass casualty / shooting', tier: 3, weight: 0.4,
    terms: ['"mass shooting"', '"active shooter"', '"shooting leaves"', '"shooting kills"', '"shooting rampage"'] },
};

// Headline cues that change how long fear lasts. Postgres regex (case-insensitive), also used in JS.
export const ONGOING_RX = '(at large|manhunt|on the run|still searching|search continues|suspect sought|no arrests? (yet|made))';
export const RESOLVED_RX = '(arrested|in custody|charged|indicted|captured|apprehended|pleads? guilty|sentenced|convicted)';
// Severity: a small robbery isn't a trigger, a robbery that ends in a murder is.
export const SEVERE_RX = '(killed|kills|murder|dead|death|fatal|stabbed|stabbing|shot |shot,|shooting|kidnapped|abducted|raped|rape |sexual(ly)? assault|beaten|bludgeon|critical condition|life-threatening|broad daylight|random attack|unprovoked|brutal|horrific|terrifying)';
export const MINOR_RX = '(attempted|no one (was )?(hurt|injured)|no injuries|minor injuries|uninjured|unharmed|shoplift|petty|vandal|stolen (car|vehicle)|car break-?ins?|package theft)';

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "ICE agents" style terms keep their capitals (so "ice agents" in a cooking headline can't match); the rest ignore case.
const compile = term => {
  const raw = term.replace(/^"|"$/g, '');
  return new RegExp(`\\b${esc(raw)}\\b`, /^[A-Z]{2,}\b/.test(raw) ? '' : 'i');
};
const COMPILED = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, {
  any: v.terms.map(compile), must: (v.must || []).map(compile),
}]));

// Which event types does this headline belong to?
export function classify(title) {
  const out = [];
  for (const [k, c] of Object.entries(COMPILED)) {
    if (c.any.some(rx => rx.test(title)) && (!c.must.length || c.must.some(rx => rx.test(title)))) out.push(k);
  }
  return out;
}
