import assert from 'node:assert/strict';
import { clusterStories, cleanTitle } from '../lib/stories.js';

const now = Date.parse('2026-10-13T20:00:00Z');
const h = n => new Date(now - n * 3600e3).toISOString();
let id = 1;
const A = (title, city, type, hrs, domain) => ({ id: id++, title, url: 'https://' + domain + '/' + id, domain, city, type, state: 'PA', seen_at: h(hrs) });
const arts = [
  A('Gunman kills 9 at Erie bar, police say', 'Erie', 'mass_casualty', 30, 'cnn.com'),
  A('Erie bar shooting: what we know about the 9 victims', 'Erie', 'mass_casualty', 20, 'nbcnews.com'),
  A('Vigil held for victims of Erie mass shooting - AP News', 'Erie', 'mass_casualty', 10, 'apnews.com'),
  A('Suspect in Erie bar shooting still at large', 'Erie', 'mass_casualty', 5, 'foxnews.com'),
  A('Philadelphia jogger attacked in random stabbing on Kelly Drive', 'Philadelphia', 'high_profile_crime', 40, 'nypost.com'),
  A('Kelly Drive stabbing: Philadelphia police release sketch of suspect', 'Philadelphia', 'high_profile_crime', 28, 'cbsnews.com'),
  A('Pittsburgh riots after playoff loss lead to curfew', 'Pittsburgh', 'unrest', 70, 'nytimes.com'),
];
// same URL stored under 2 types counts once
arts.push({ ...arts[0], id: id++, type: 'high_profile_crime' });

const s = clusterStories(arts, now);
assert.equal(s.length, 3, 'three stories: ' + s.map(x => x.label).join(' | '));
const erie = s.find(x => x.city === 'Erie');
assert.equal(erie.articles, 4);
assert.equal(erie.outlets, 4);
assert.equal(erie.type, 'mass_casualty');
assert.ok(erie.at_large && erie.severe);
assert.equal(s[0].city, 'Erie', 'biggest, freshest story first');
assert.equal(s.find(x => x.city === 'Philadelphia').articles, 2);
assert.equal(cleanTitle('Vigil held for victims - AP News'), 'Vigil held for victims');
assert.equal(cleanTitle('Self-defense classes fill up'), 'Self-defense classes fill up');
console.log('stories ok:', s.map(x => `${x.label} (${x.articles})`).join(' | '));
