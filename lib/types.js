// Event types, tier weights, and GDELT query terms. Keep this tight: every type must tie to personal-safety fear.
export const TYPES = {
  mass_casualty:      { label: 'Mass casualty / shooting', tier: 1, weight: 1.0,
    terms: ['"mass shooting"', '"active shooter"', '"shooting leaves"', '"shooting kills"', '"shooting rampage"'] },
  ice_enforcement:    { label: 'ICE raids / enforcement surge', tier: 1, weight: 0.9,
    terms: ['"ICE raid"', '"ICE raids"', '"ICE agents"', '"immigration raid"', '"immigration sweep"', '"ICE arrests"'] },
  unrest:             { label: 'Protest / unrest', tier: 1, weight: 0.8,
    terms: ['"tear gas"', '"protesters clash"', '"protest turns violent"', 'riot', '"curfew imposed"', '"National Guard deployed"'] },
  violent_crime_spike:{ label: 'Violent crime spike', tier: 2, weight: 0.6,
    terms: ['"crime spike"', '"violent crime surge"', '"wave of shootings"', '"spike in homicides"'] },
  carjacking:         { label: 'Carjacking / road rage', tier: 2, weight: 0.5,
    terms: ['carjacking', 'carjackings', '"road rage shooting"'] },
  stalking_abduction: { label: 'Stalking / abduction / assault', tier: 2, weight: 0.5,
    terms: ['"attempted abduction"', '"attempted kidnapping"', 'stalker', '"jogger attacked"', '"woman attacked"', '"woman abducted"'] },
  home_invasion:      { label: 'Home invasion / break-in cluster', tier: 2, weight: 0.5,
    terms: ['"home invasion"', '"burglary spree"', '"break-ins"'] },
  disaster_looting:   { label: 'Disaster / blackout looting', tier: 3, weight: 0.4,
    terms: ['looting', 'looters'], must: ['hurricane', 'blackout', 'outage', 'storm', 'flood', 'wildfire'] },
  police_response:    { label: 'Police shortage / slow response', tier: 3, weight: 0.3,
    terms: ['"police shortage"', '"911 response times"', '"police budget cuts"', '"slow police response"'] },
  campus:             { label: 'Campus incident', tier: 3, weight: 0.4,
    terms: ['"campus shooting"', '"campus assault"', '"campus stabbing"', '"student attacked"'] },
};

export function gdeltQuery(key) {
  const t = TYPES[key];
  let q = `(${t.terms.join(' OR ')})`;
  if (t.must) q += ` (${t.must.join(' OR ')})`;
  return `${q} sourcecountry:US sourcelang:english`;
}
