// Event types and headline terms. MAJOR EVENTS ONLY: things that become national news and make ordinary people
// think "this could happen to me". A week of local crime is not a signal; scoring also requires national pickup
// (see NATIONAL in outlets.js and NAT_MIN in score.js). ICE enforcement is out of scope by decision.
// Bump when terms or geo rules change: on deploy rows that no longer classify are removed and the last 90 days are re-read.
export const CLASSIFIER_VERSION = 3;

// Terms: "quoted" = exact phrase, bare = whole word, RegExp = used as is. Optional: must (one must also match),
// not (any match drops the headline).
const ROLE = '(?:senators?|congress(?:man|woman|men|women)|lawmakers?|legislators?|state rep(?:resentative)?s?|governors?|lieutenant governor|mayors?|'
  + 'judges?|justices?|candidates?|council ?(?:member|man|woman)s?|commissioners?|attorney general|prosecutors?|politicians?|political (?:figure|commentator|activist|leader)s?|'
  + 'conservative activist|congressional (?:staffer|candidate)s?|speaker|president|vice president|secretary)';
// physical only: "Senator attacked over vote", "Governor beaten in primary", "Mayor shot down plan" must not match
const HIT = '(?:shot(?! down)|stabbed|physically attacked|attacked by (?:a |an )?(?:man|woman|suspect|gunman|attacker|assailant|mob|protesters?)|assaulted|ambushed|'
  + 'attacked (?:outside|at|near|inside|in (?:his|her|their) )|killed (?:in|by|at)|murdered|wounded|injured in (?:an? )?attack|punched|beaten up|hospitalized after (?:an? )?attack)';
// up to 2 words between role and verb ("Senator Jane Doe attacked"), but not "Governor says man shot"
const GAP = "(?:\\s+(?!says\\b|said\\b|calls\\b|condemns\\b|reacts\\b|vows\\b|urges\\b|after\\b|on\\b|over\\b|of\\b|who\\b|whose\\b|to\\b|as\\b|mourns\\b|responds\\b)[\\w.'’-]+){0,2}";

export const TYPES = {
  mass_casualty: { label: 'Mass shooting / mass attack', tier: 1, weight: 1.0,
    terms: ['"mass shooting"', '"active shooter"', '"school shooting"', '"shooting rampage"', '"shooting spree"', '"gunman opens fire"', '"gunman opened fire"',
      '"opens fire on"', '"opened fire on"', '"shooting kills"', '"shooting leaves"', '"mass stabbing"', '"stabbing spree"', '"stabbing rampage"',
      '"terror attack"', '"terrorist attack"', '"act of terror"', '"plowed into"', '"rammed into a crowd"', '"drove into a crowd"', '"drives into crowd"', '"vehicle attack"',
      /\b(?:three|four|five|six|seven|eight|nine|ten|several|multiple|dozens?(?: of)?|[3-9]|\d{2,}) (?:people |victims |students )?(?:shot|killed in (?:a )?(?:shooting|stabbing|attack)|dead in (?:a )?(?:shooting|stabbing|attack)|stabbed)\b/i] },
  political_violence: { label: 'Political figure attacked', tier: 1, weight: 1.0,
    terms: ['assassination', 'assassinated', '"assassination attempt"', '"attempted assassination"',
      new RegExp(`\\b${ROLE}${GAP}\\s+(?:(?:is|was|were|has been|have been|gets|got) )?${HIT}\\b`, 'i'),
      new RegExp(`\\b(?:shooting|stabbing|ambush|arson|arson attack|firebombing|violent attack|physical attack|knife attack|gun attack|assassination plot)s? (?:on|against|targeting) (?:a |an |the )?(?:[\\w.'’-]+ ){0,2}${ROLE}\\b`, 'i'),
      /\b(?:shooting|shots fired|gunfire|gunman|stabbing)\b.{0,50}\b(?:campaign (?:event|rally|office)|political rally|town hall|rally for)\b/i,
      new RegExp(`\\b${ROLE}['’]s? (?:home|house|residence|mansion|office) (?:attacked|shot at|set on fire|firebombed|torched)`, 'i')],
    not: ['"character assassination"', 'JFK', '"Kennedy assassination"', '"assassination records"', '"assassination files"', '"Lincoln assassination"', 'MLK'] },
  unrest: { label: 'Riots / major unrest', tier: 1, weight: 0.9,
    terms: ['riots', 'rioting', 'rioters', '"riot breaks out"', '"riot broke out"', '"riot erupts"', '"riot erupted"', '"declared a riot"', 'looting', 'looters',
      '"protests turn violent"', '"protest turns violent"', '"violent protests"', '"violent unrest"', '"civil unrest"',
      /\bcurfew\b.{0,60}\b(?:protest|riot|unrest|looting|violence)|\b(?:protest|riot|unrest|looting|violence).{0,60}\bcurfew\b/i],
    // ICE is out of scope, and ICE protests are routinely called "riots" by officials. A major riot still shows up in the
    // many headlines that don't mention ICE. Non-news riots (Riot Games, Riot Fest) are dropped too.
    not: ['ICE', 'immigration', 'deportation', 'deportations', '"Riot Games"', '"Riot Fest"', '"Pussy Riot"', 'prison', 'jail', 'inmates'] },
  high_profile_crime: { label: 'High-profile violent crime', tier: 2, weight: 0.8,
    // counts only when national outlets pick it up, like every type. Cornell-style cases, not the local crime blotter.
    terms: ['"sexual assault"', '"sexually assaulted"', '"sex assault"', 'rape', 'raped', 'rapist', '"gang rape"', 'abducted', 'kidnapped', 'abduction',
      '"attempted abduction"', '"attempted kidnapping"', 'stalker', '"home invasion"', 'carjacking', '"random attack"', '"unprovoked attack"',
      '"serial killer"', 'manhunt', '"stabbing attack"', '"beaten to death"', '"stabbed to death"',
      /\b(?:campus|university|college|fraternity|sorority|dorm|students?)\b.{0,80}\b(?:shooting|shooter|stabbing|stabbed|lockdown|attacked)\b/i],
    not: ['ICE', 'immigration', 'deportation'] },
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
  if (term instanceof RegExp) return term;
  const raw = term.replace(/^"|"$/g, '');
  return new RegExp(`\\b${esc(raw)}\\b`, /^[A-Z]{2,}\b/.test(raw) ? '' : 'i');
};
const COMPILED = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, {
  any: v.terms.map(compile), must: (v.must || []).map(compile), not: (v.not || []).map(compile),
}]));

// Which event types does this headline belong to?
export function classify(title) {
  const out = [];
  for (const [k, c] of Object.entries(COMPILED)) {
    if (c.any.some(rx => rx.test(title)) && (!c.must.length || c.must.some(rx => rx.test(title))) && !c.not.some(rx => rx.test(title))) out.push(k);
  }
  return out;
}
