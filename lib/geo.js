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

export function geoTag(title = '') {
  let best = null;
  for (const c of cityRx) {
    const m = c.rx.exec(title);
    if (m && (!best || m.index < best.idx)) best = { idx: m.index, state: c.st, city: c.name.replace(/, .*/, '') };
  }
  if (best) return { state: best.state, city: best.city };
  let sBest = null;
  for (const s of stateRx) {
    const m = s.rx.exec(title);
    if (!m) continue;
    // "West Virginia" must win over "Virginia": longest-first ordering plus index check
    if (!sBest || m.index < sBest.idx) sBest = { idx: m.index, state: s.st };
  }
  return sBest ? { state: sBest.state, city: null } : null;
}
