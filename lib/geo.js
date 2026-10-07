// Title-based geo tagging. Returns { state, city } or null. No match = article is dropped.
export const STATES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',
  FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',
  NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',
  UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
};

// Bare names that are too ambiguous in headlines. Require a qualifier.
const STATE_NAME_OVERRIDES = { GA: ['Georgia state'], WA: ['Washington state'], DC: ['Washington, D.C.', 'Washington DC', 'D.C.'], NY: ['New York'] };
const SKIP_BARE = new Set(['GA', 'WA', 'DC']);

const CITY_LIST = `Los Angeles|CA;San Diego|CA;San Jose|CA;San Francisco|CA;Oakland|CA;Sacramento|CA;Fresno|CA;Long Beach|CA;Anaheim|CA;Riverside|CA;Bakersfield|CA;Stockton|CA;Santa Ana|CA;Compton|CA;
New York City|NY;Brooklyn|NY;Manhattan|NY;Queens|NY;The Bronx|NY;Buffalo|NY;Rochester|NY;Albany|NY;Syracuse|NY;
Chicago|IL;Houston|TX;Dallas|TX;Austin|TX;San Antonio|TX;Fort Worth|TX;El Paso|TX;Arlington|TX;Corpus Christi|TX;Plano|TX;Laredo|TX;McAllen|TX;
Phoenix|AZ;Tucson|AZ;Mesa|AZ;Tempe|AZ;Scottsdale|AZ;Chandler|AZ;Glendale|AZ;Philadelphia|PA;Pittsburgh|PA;Harrisburg|PA;
Jacksonville|FL;Miami|FL;Tampa|FL;Orlando|FL;St. Petersburg|FL;Fort Lauderdale|FL;Tallahassee|FL;Hialeah|FL;
Columbus|OH;Cleveland|OH;Cincinnati|OH;Toledo|OH;Akron|OH;Dayton|OH;Charlotte|NC;Raleigh|NC;Greensboro|NC;Durham|NC;Fayetteville|NC;
Indianapolis|IN;Fort Wayne|IN;Seattle|WA;Tacoma|WA;Spokane|WA;Denver|CO;Aurora|CO;Colorado Springs|CO;Boulder|CO;
Nashville|TN;Memphis|TN;Knoxville|TN;Chattanooga|TN;Oklahoma City|OK;Tulsa|OK;Louisville|KY;Lexington|KY;Portland|OR;Eugene|OR;
Las Vegas|NV;Henderson|NV;Reno|NV;Detroit|MI;Grand Rapids|MI;Flint|MI;Ann Arbor|MI;Lansing|MI;Boston|MA;Worcester|MA;Springfield|MA;
Baltimore|MD;Annapolis|MD;Milwaukee|WI;Madison|WI;Kenosha|WI;Green Bay|WI;Albuquerque|NM;Santa Fe|NM;Las Cruces|NM;
Atlanta|GA;Savannah|GA;Augusta|GA;Macon|GA;Omaha|NE;Lincoln|NE;Kansas City|MO;St. Louis|MO;Ferguson|MO;Minneapolis|MN;St. Paul|MN;
New Orleans|LA;Baton Rouge|LA;Shreveport|LA;Birmingham|AL;Montgomery|AL;Mobile|AL;Huntsville|AL;Honolulu|HI;Anchorage|AK;
Salt Lake City|UT;Provo|UT;Boise|ID;Des Moines|IA;Cedar Rapids|IA;Wichita|KS;Topeka|KS;Little Rock|AR;Jackson|MS;
Charleston|SC;Columbia|SC;Greenville|SC;Richmond|VA;Norfolk|VA;Virginia Beach|VA;Newark|NJ;Jersey City|NJ;Trenton|NJ;Paterson|NJ;
Providence|RI;Hartford|CT;New Haven|CT;Bridgeport|CT;Wilmington|DE;Burlington|VT;Manchester|NH;Portland, Maine|ME;Fargo|ND;Sioux Falls|SD;
Billings|MT;Cheyenne|WY;Charleston, West Virginia|WV;Charleston, W.Va.|WV;Washington, D.C.|DC;Washington DC|DC`;

const CITIES = CITY_LIST.split(/;\s*/).map(s => s.trim()).filter(Boolean).map(s => {
  const [name, st] = s.split('|');
  return { name, st };
}).sort((a, b) => b.name.length - a.name.length);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cityRx = CITIES.map(c => ({ ...c, rx: new RegExp(`(^|[^A-Za-z])${esc(c.name)}(?![A-Za-z])`, 'i') }));

const stateNames = [];
for (const [st, name] of Object.entries(STATES)) {
  if (!SKIP_BARE.has(st)) stateNames.push({ st, name });
  for (const alt of STATE_NAME_OVERRIDES[st] || []) stateNames.push({ st, name: alt });
}
stateNames.sort((a, b) => b.name.length - a.name.length);
const stateRx = stateNames.map(s => ({ ...s, rx: new RegExp(`(^|[^A-Za-z])${esc(s.name)}(?![A-Za-z])`) }));

// Big campuses. Checked first: headlines name the school, not the town ("Cornell", not "Ithaca, N.Y."),
// and some schools share a name with a listed city (Columbia University is not Columbia, SC).
const CAMPUS_LIST = `Cornell|Ithaca|NY;Harvard|Cambridge|MA;MIT|Cambridge|MA;Yale|New Haven|CT;Princeton University|Princeton|NJ;
Columbia University|New York City|NY;NYU|New York City|NY;New York University|New York City|NY;Stanford|Stanford|CA;UCLA|Los Angeles|CA;
UC Berkeley|Berkeley|CA;Duke University|Durham|NC;UNC|Chapel Hill|NC;Chapel Hill|Chapel Hill|NC;Penn State|State College|PA;
University of Pennsylvania|Philadelphia|PA;UPenn|Philadelphia|PA;Brown University|Providence|RI;Dartmouth|Hanover|NH;
Georgetown University|Washington|DC;Michigan State|East Lansing|MI;University of Michigan|Ann Arbor|MI;Ohio State|Columbus|OH;
Texas A&M|College Station|TX;UT Austin|Austin|TX;University of Texas|Austin|TX;University of Florida|Gainesville|FL;Florida State|Tallahassee|FL;
FSU|Tallahassee|FL;University of Idaho|Moscow|ID;Virginia Tech|Blacksburg|VA;University of Virginia|Charlottesville|VA;UVA|Charlottesville|VA;
Vanderbilt|Nashville|TN;Northwestern University|Evanston|IL;University of Chicago|Chicago|IL;Purdue|West Lafayette|IN;Indiana University|Bloomington|IN;
Rutgers|New Brunswick|NJ;Syracuse University|Syracuse|NY;Clemson|Clemson|SC;Auburn University|Auburn|AL;University of Alabama|Tuscaloosa|AL;
LSU|Baton Rouge|LA;Ole Miss|Oxford|MS;University of Georgia|Athens|GA;Georgia Tech|Atlanta|GA;Emory|Atlanta|GA;Tulane|New Orleans|LA;
Baylor|Waco|TX;TCU|Fort Worth|TX;SMU|Dallas|TX;Rice University|Houston|TX;University of Houston|Houston|TX;Arizona State|Tempe|AZ;ASU|Tempe|AZ;
University of Arizona|Tucson|AZ;University of Utah|Salt Lake City|UT;BYU|Provo|UT;University of Colorado|Boulder|CO;University of Oregon|Eugene|OR;
Oregon State|Corvallis|OR;University of Washington|Seattle|WA;Washington State University|Pullman|WA;UNLV|Las Vegas|NV;
University of Minnesota|Minneapolis|MN;University of Wisconsin|Madison|WI;University of Iowa|Iowa City|IA;Iowa State|Ames|IA;
University of Kansas|Lawrence|KS;Kansas State|Manhattan|KS;University of Kentucky|Lexington|KY;University of Tennessee|Knoxville|TN;
University of Missouri|Columbia|MO;Mizzou|Columbia|MO;University of Nebraska|Lincoln|NE;University of Oklahoma|Norman|OK;Oklahoma State|Stillwater|OK;
University of Maryland|College Park|MD;Johns Hopkins|Baltimore|MD;Boston University|Boston|MA;Boston College|Boston|MA;Northeastern University|Boston|MA;
UMass|Amherst|MA;UConn|Storrs|CT;University of South Carolina|Columbia|SC;Kent State|Kent|OH;University of Southern California|Los Angeles|CA`;
const CAMPUSES = CAMPUS_LIST.split(/;\s*/).filter(Boolean).map(s => { const [name, city, st] = s.split('|'); return { city, st, rx: new RegExp(`(^|[^A-Za-z])${esc(name)}(?![A-Za-z])`) }; });

// "Ithaca, N.Y." (AP style) and "Ithaca, New York": catches towns that aren't in CITY_LIST.
const AP = { 'Ala.':'AL','Ariz.':'AZ','Ark.':'AR','Calif.':'CA','Colo.':'CO','Conn.':'CT','Del.':'DE','Fla.':'FL','Ga.':'GA','Ill.':'IL','Ind.':'IN',
  'Kan.':'KS','Ky.':'KY','La.':'LA','Md.':'MD','Mass.':'MA','Mich.':'MI','Minn.':'MN','Miss.':'MS','Mo.':'MO','Mont.':'MT','Neb.':'NE','Nev.':'NV',
  'N.H.':'NH','N.J.':'NJ','N.M.':'NM','N.Y.':'NY','N.C.':'NC','N.D.':'ND','Okla.':'OK','Ore.':'OR','Pa.':'PA','R.I.':'RI','S.C.':'SC','S.D.':'SD',
  'Tenn.':'TN','Vt.':'VT','Va.':'VA','Wash.':'WA','W.Va.':'WV','Wis.':'WI','Wyo.':'WY' };
const FULL = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));
const PLACE = `([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2})`;
const placeRx = new RegExp(`${PLACE}, (${[...Object.keys(AP), ...Object.keys(FULL)].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![A-Za-z])`);
const NOT_A_PLACE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Police|Officials|Authorities|Report|Update|Video|Watch|Breaking|Exclusive|Opinion|Live|Photos|Sources)$/;

export function geoTag(title = '') {
  for (const c of CAMPUSES) if (c.rx.test(title)) return { state: c.st, city: c.city };
  let best = null;
  for (const c of cityRx) {
    const m = c.rx.exec(title);
    if (m && (!best || m.index < best.idx)) best = { idx: m.index, state: c.st, city: c.name.replace(/, .*/, '') };
  }
  if (best) return { state: best.state, city: best.city };
  const p = placeRx.exec(title);
  if (p) {
    const st = AP[p[2]] || FULL[p[2]];
    const name = p[1].replace(/^(In|At|Near|From|Outside)\s+/, '');
    return { state: st, city: NOT_A_PLACE.test(name) || /County$/.test(name) ? null : name };
  }
  let sBest = null;
  for (const s of stateRx) {
    const m = s.rx.exec(title);
    if (!m) continue;
    // "West Virginia" must win over "Virginia": longest-first ordering plus index check
    if (!sBest || m.index < sBest.idx) sBest = { idx: m.index, state: s.st };
  }
  return sBest ? { state: sBest.state, city: null } : null;
}
