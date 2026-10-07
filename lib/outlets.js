// Which outlets count toward heat and triggers. Three ways in:
//  1. named national, wire, major-metro and local broadcast newsrooms (list below)
//  2. local TV and public radio by call sign (khou.com, wbur.org)
//  3. established local outlets, learned from the data (see localOutlets): small is fine if they're a real local newsroom
// Aggregators, syndication mirrors, press-release wires and random small sites never count, even if 100 of them carry a story.

// National, wire, and major metro newspapers / digital newsrooms
const NAMED = `apnews.com reuters.com nytimes.com washingtonpost.com wsj.com usatoday.com latimes.com chicagotribune.com bostonglobe.com
cnn.com nbcnews.com abcnews.go.com abcnews.com cbsnews.com foxnews.com msnbc.com npr.org pbs.org bloomberg.com axios.com politico.com
thehill.com time.com newsweek.com theatlantic.com bbc.com bbc.co.uk theguardian.com nypost.com nydailynews.com newsday.com
houstonchronicle.com chron.com dallasnews.com star-telegram.com expressnews.com statesman.com sfchronicle.com sfgate.com mercurynews.com
sacbee.com fresnobee.com sandiegouniontribune.com ocregister.com pressdemocrat.com azcentral.com abc15.com seattletimes.com oregonlive.com
denverpost.com sltrib.com reviewjournal.com startribune.com twincities.com jsonline.com freep.com detroitnews.com mlive.com cleveland.com
dispatch.com cincinnati.com post-gazette.com inquirer.com philly.com baltimoresun.com nj.com northjersey.com app.com courant.com
providencejournal.com syracuse.com timesunion.com buffalonews.com democratandchronicle.com miamiherald.com sun-sentinel.com orlandosentinel.com
tampabay.com tallahassee.com jacksonville.com ajc.com charlotteobserver.com newsobserver.com tennessean.com commercialappeal.com
knoxnews.com courier-journal.com kansascity.com stltoday.com nola.com theadvocate.com al.com clarionledger.com oklahoman.com tulsaworld.com
desmoinesregister.com omaha.com indystar.com richmond.com pilotonline.com post-courier.com postandcourier.com thestate.com
arkansasonline.com abqjournal.com santafenewmexican.com idahostatesman.com spokesman.com honolulu.com staradvertiser.com adn.com
madison.com journalnow.com wral.com ksl.com wbur.org wnyc.org kqed.org wamu.org whyy.org gothamist.com
11alive.com click2houston.com clickondetroit.com local10.com news4jax.com abc7chicago.com abc7ny.com abc7.com abc13.com abc11.com
6abc.com nbcchicago.com nbcnewyork.com nbcdfw.com nbclosangeles.com nbcbayarea.com nbcwashington.com nbcboston.com nbcmiami.com
nbcphiladelphia.com nbcsandiego.com fox5ny.com fox5dc.com fox5atlanta.com fox26houston.com fox4news.com fox13news.com fox2detroit.com
fox32chicago.com fox9.com fox10phoenix.com foxla.com ktvu.com kare11.com king5.com kiro7.com komonews.com kcra.com ksdk.com wfaa.com
wsbtv.com wsoctv.com wftv.com wcvb.com whdh.com wbaltv.com wgal.com wpxi.com wtae.com wkyc.com wlwt.com wcpo.com wsmv.com wbir.com
kshb.com kmbc.com kwch.com kcci.com wral.com wtop.com wjla.com nbc4i.com 10tv.com wgntv.com kxan.com kvue.com kens5.com ksat.com
12news.com azfamily.com 9news.com krqe.com kob.com kgw.com koin.com`;
const NAMED_SET = new Set(NAMED.split(/\s+/).filter(Boolean));

// Never count: aggregators, syndication mirrors, press-release wires, hyperlocal and user-generated sites
const BLOCK = /(^|\.)(yahoo\.com|msn\.com|aol\.com|newsbreak\.com|ground\.news|patch\.com|prnewswire\.com|globenewswire\.com|businesswire\.com|einpresswire\.com|medium\.com|substack\.com|blogspot\.com|wordpress\.com|reddit\.com|youtube\.com|facebook\.com|x\.com|twitter\.com)$/;

// Local broadcast and public radio by call sign (khou.com, wkyc.com, wbur.org, kiro7.com, wsbtv.com) and network-branded locals
const CALL_SIGN = /^[kw][a-z]{2,3}(tv|\d{1,2}|news|radio|am|fm)?\.(com|org)$/;
const NETWORK_LOCAL = /^(abc|nbc|cbs|fox)\d{0,2}[a-z]*\.com$/;

const norm = domain => String(domain || '').toLowerCase().replace(/^www\./, '');
export const isBlocked = domain => BLOCK.test(norm(domain));

export function isTrusted(domain, local = null) {
  if (!domain) return false;
  const d = norm(domain);
  if (BLOCK.test(d)) return false;
  if (local && local.has(d)) return true;
  if (NAMED_SET.has(d)) return true;
  // subdomains of named outlets (eu.usatoday.com, local.nytimes.com)
  for (const n of NAMED_SET) if (d.endsWith('.' + n)) return true;
  return CALL_SIGN.test(d) || NETWORK_LOCAL.test(d);
}

// A small outlet counts if it behaves like a real local newsroom over the last 90 days:
// it covered incidents on 15+ separate days, and 70%+ of its stories are about one state.
// Content farms and aggregators fail this: they spread across many states or show up in bursts.
export const LOCAL_MIN_DAYS = 15, LOCAL_MIN_FOCUS = 0.7;
export const LOCAL_SQL = `
  WITH a AS (SELECT lower(regexp_replace(domain, '^www\\.', '')) d, state, (seen_at AT TIME ZONE 'UTC')::date day
             FROM articles WHERE domain IS NOT NULL AND seen_at > now() - interval '90 days'),
       per_state AS (SELECT d, state, count(*) n FROM a GROUP BY 1, 2),
       focus AS (SELECT d, max(n)::float / sum(n) share FROM per_state GROUP BY 1),
       days AS (SELECT d, count(DISTINCT day) nd FROM a GROUP BY 1)
  SELECT focus.d FROM focus JOIN days USING (d) WHERE days.nd >= ${LOCAL_MIN_DAYS} AND focus.share >= ${LOCAL_MIN_FOCUS}`;
