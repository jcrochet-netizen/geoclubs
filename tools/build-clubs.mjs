#!/usr/bin/env node
/* ============================================================================
   Construit data/clubs.json + logos/ à partir d'une simple liste, via Sportmonks.

   Sportmonks donne d'un seul coup le club, son stade géolocalisé et son logo :
   pas besoin de repasser par Wikidata comme pour GeoConf.

     tools/clubs.txt  →  node tools/build-clubs.mjs  →  data/clubs.json + logos/

   Format de tools/clubs.txt :
     ## Ligue 1              une section : devient le « groupe » des clubs suivants
     @league 301             tous les clubs de cette ligue (saison en cours)
     @league Eredivisie      idem, par nom de ligue
     Celtic | Scotland       un club précis ; le pays est facultatif mais fiabilise
     # commentaire           ignoré

   La clé vient de SPORTMONKS_TOKEN ou d'un fichier .env à la racine.
   Relisez tools/build-report.json : le script signale ce dont il n'est pas sûr.
   ========================================================================== */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.sportmonks.com/v3/football';
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_LOGOS = args.includes('--no-logos');

let TOKEN = process.env.SPORTMONKS_TOKEN || process.env.SPORTMONKS_API_TOKEN;
if (!TOKEN) {
  try {
    const env = await readFile(join(ROOT, '.env'), 'utf8');
    TOKEN = env.match(/^\s*SPORTMONKS_(?:API_)?TOKEN\s*=\s*["']?([^"'\r\n]+)/m)?.[1]?.trim();
  } catch {}
}
if (!TOKEN) {
  console.error('✖ Clé absente. export SPORTMONKS_TOKEN="…" ou un fichier .env à la racine.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const haversine = (a, b) => {
  const R = 6371.0088, d2r = Math.PI / 180;
  const dp = (b.lat - a.lat) * d2r, dl = (b.lon - a.lon) * d2r;
  const h = Math.sin(dp / 2) ** 2 +
    Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const pad = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n);
const safe = m => String(m).split(TOKEN).join('***').replace(/api_token=[^&\s"']+/gi, 'api_token=***');

async function api(path, params = {}) {
  const u = new URL(API + path);
  u.searchParams.set('api_token', TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let a = 0; a < 4; a++) {
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await sleep(5000 * (a + 1)); continue; }
    if (r.status === 404) return { data: [] };
    if (!r.ok) throw new Error(safe(`HTTP ${r.status} ${(await r.text()).slice(0, 140)}`));
    return r.json();
  }
  throw new Error('quota horaire atteint (429)');
}

/* Certains stades n'ont pas de city_name mais portent un city_id : l'API core
   sait le résoudre. On met en cache, plusieurs clubs partagent souvent la ville. */
const cityCache = new Map();
async function cityOf(v) {
  if (v?.city_name) return v.city_name;
  if (!v?.city_id) return null;
  if (cityCache.has(v.city_id)) return cityCache.get(v.city_id);
  let name = null;
  try {
    const u = new URL('https://api.sportmonks.com/v3/core/cities/' + v.city_id);
    u.searchParams.set('api_token', TOKEN);
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    if (r.ok) name = (await r.json())?.data?.name ?? null;
  } catch {}
  cityCache.set(v.city_id, name);
  return name;
}

/* --search="terme" : inspecter les résultats bruts, sans rien écrire. */
const PROBE = (args.find(a => a.startsWith('--search=')) || '').split('=').slice(1).join('=');

/* ── identité : noms français et drapeaux déduits du code ISO ─────────────── */
const FR = new Intl.DisplayNames(['fr'], { type: 'region' });
const NATION = {              // les nations britanniques n'ont pas de code ISO 3166
  England:            { cc: 'ENG', country: 'Angleterre',        flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  Scotland:           { cc: 'SCO', country: 'Écosse',            flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
  Wales:              { cc: 'WAL', country: 'Pays de Galles',    flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
  'Northern Ireland': { cc: 'NIR', country: 'Irlande du Nord',   flag: '🏴' },
};
function identityFromCC(cc) {
  cc = String(cc || '').toUpperCase();
  for (const k in NATION) if (NATION[k].cc === cc) return NATION[k];
  const flag = /^[A-Z]{2}$/.test(cc)
    ? cc.replace(/./g, ch => String.fromCodePoint(127397 + ch.charCodeAt())) : '';
  let country = cc;
  try { country = FR.of(cc) || cc; } catch {}
  return { cc, country, flag };
}

function identity(c) {
  if (!c) return { cc: '??', country: '?', flag: '' };
  if (NATION[c.name]) return NATION[c.name];
  const iso = (c.iso2 || '').toUpperCase();
  const flag = /^[A-Z]{2}$/.test(iso)
    ? iso.replace(/./g, ch => String.fromCodePoint(127397 + ch.charCodeAt())) : '';
  let country = c.name;
  try { if (iso) country = FR.of(iso) || c.name; } catch {}
  return { cc: iso || '??', country, flag };
}

/** Sportmonks mélange les formats : 45.58311 mais aussi "84.4000° W".
    Sans lire l'hémisphère, Seattle passe de -122° à +122°, soit la Chine. */
function coord(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).trim().match(/^(-?\d+(?:[.,]\d+)?)\s*°?\s*([NSEW])?$/i);
  let n = m ? parseFloat(m[1].replace(',', '.')) : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  const h = (m && m[2] || '').toUpperCase();
  if (h === 'S' || h === 'W') n = -Math.abs(n);
  else if (h === 'N' || h === 'E') n = Math.abs(n);
  return n;
}

/* ── appariement, repris de GeoConf et éprouvé sur 143 clubs ──────────────── */
const ascii = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[đĐ]/g, 'd').replace(/[øØ]/g, 'o').replace(/[ħĦ]/g, 'h').replace(/[ıİ]/g, 'i')
  .replace(/[łŁ]/g, 'l').replace(/[ßẞ]/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[þÞ]/g, 'th')
  .replace(/[ðÐ]/g, 'd').replace(/[œŒ]/g, 'oe');
const norm = s => ascii(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NOISE = /\b(fc|fk|sk|ac|as|af|cf|cs|sc|bk|if|kf|nk|hnk|gnk|pfc|kv|rc|ks|ss|sv|us|ca|vv|jk|aif|club|de|du|la|le|of|and|f|c|s|k|a|calcio|football|futbol|fodbold|team)\b/g;
const core = s => norm(s).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
const GENERIC = new Set(['stade', 'sporting', 'athletic', 'atletico', 'united', 'city', 'real',
  'olympique', 'olympic', 'racing', 'dynamo', 'dinamo', 'spartak', 'lokomotiv', 'inter',
  'national', 'academy', 'sport', 'sports', 'union', 'rovers', 'wanderers', 'town', 'county',
  'star', 'red', 'blue', 'young', 'new', 'saint', 'santa']);
const RESERVE = /(^|\s)(w|women|femmes|u\d{2}|ii|iii|res\.?|reserves?|amateurs?|academy|jong)(\s|$)/i;

function searchTerms(name) {
  const out = [];
  const add = s => {
    s = String(s || '').replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s*\b(F\.?C\.?|A\.?F\.?C\.?|S\.?C\.?)\s*$/i, '').replace(/\s+/g, ' ').trim();
    if (s.length >= 3 && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  add(name); add(ascii(name));
  const words = [...new Set(core(name).split(' '))].filter(w => w.length >= 4);
  if (words[0]) add(words[0]);
  const longest = [...words].sort((a, b) => b.length - a.length)[0];
  if (longest && longest !== words[0]) add(longest);
  return out.slice(0, 5);
}

/** Coefficient de Dice sur les bigrammes : rattrape les translittérations
    (« Spartak Moskva » vs « Spartak Moscow ») sans rapprocher deux clubs qui
    ne partagent qu'un mot passe-partout (« Stade Rennais » / « Stade Bordelais »). */
function dice(a, b) {
  a = a.replace(/ /g, ''); b = b.replace(/ /g, '');
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2), n = grams.get(g) || 0;
    if (n > 0) { hit++; grams.set(g, n - 1); }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

function score(wanted, hintCountry, cand) {
  const a = norm(wanted), aC = core(wanted);
  const b = norm(cand.name || ''), bC = core(cand.name || '');
  if (!b) return 0;
  let s;
  if (a === b) s = 100;
  else if (aC && aC === bC) s = 96;
  else if (b.startsWith(a) || a.startsWith(b)) s = 82;
  else if (bC && aC && (bC.startsWith(aC) || aC.startsWith(bC))) s = 78;
  else if (b.includes(a) || a.includes(b)) s = 66;
  else {
    const keep = w => w.length > 2 && !GENERIC.has(w);
    const wa = new Set(aC.split(' ').filter(keep)), wb = new Set(bC.split(' ').filter(keep));
    const hit = [...wa].filter(w => wb.has(w)).length;
    s = hit ? 40 + hit * 14 : 0;
    if (!s) { const d = dice(a, b); if (d >= 0.7) s = Math.round(d * 80); }
  }
  const got = cand.country?.name;
  if (hintCountry && got) s += norm(got) === norm(hintCountry) ? 25 : -30;
  if (RESERVE.test(cand.name || '')) s -= 80;
  if (cand.gender && cand.gender !== 'male') s -= 70;
  if (cand.placeholder) s -= 35;
  return s;
}

/* ── logos ────────────────────────────────────────────────────────────────── */
const PLACEHOLDER = '6eee8dbcd462399f70b52a1191e53ccef1d9dc91';
function sniff(buf) {
  const h = buf.subarray(0, 16);
  if (h.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (h.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (h.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 400).toString('utf8').includes('<svg')) return 'svg';
  return null;
}
const exists = async p => { try { await access(p); return true; } catch { return false; } };

async function saveLogo(url, id) {
  if (!url) return null;
  const base = join(ROOT, 'logos', id);
  for (const e of ['png', 'webp', 'jpg', 'gif', 'svg'])
    if (await exists(base + '.' + e)) return 'logos/' + id + '.' + e;
  const r = await fetch(url);
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 300) return null;
  if (createHash('sha1').update(buf).digest('hex') === PLACEHOLDER) return null;   // écusson gris
  const ext = sniff(buf);
  if (!ext) return null;
  await writeFile(base + '.' + ext, buf);
  return 'logos/' + id + '.' + ext;
}

const COUNTRY_PROBE = (args.find(a => a.startsWith('--country=')) || '').split('=').slice(1).join('=');
if (COUNTRY_PROBE) {
  const u = new URL('https://api.sportmonks.com/v3/core/countries/search/' + encodeURIComponent(COUNTRY_PROBE));
  u.searchParams.set('api_token', TOKEN);
  const c = (await (await fetch(u)).json()).data?.[0];
  if (!c) { console.log('pays introuvable'); process.exit(1); }
  console.log(`${c.name} → country_id ${c.id}`);
  const t = await api(`/teams/countries/${c.id}`, { per_page: 50, include: 'venue' });
  for (const x of (t.data || [])) {
    if (RESERVE.test(x.name || '')) continue;
    console.log(`   ${String(x.id).padEnd(8)} ${pad(x.name, 28)} ${x.venue?.latitude ?? 'PAS DE COORDS'}`);
  }
  process.exit(0);
}

if (PROBE) {
  const r = await api(`/teams/search/${encodeURIComponent(PROBE)}`, { include: 'country;venue' });
  const d = r.data || [];
  console.log(`« ${PROBE} » → ${d.length} résultat(s)`);
  for (const t of d.slice(0, 10)) {
    const v = t.venue;
    console.log(`   ${String(t.id).padEnd(8)} ${pad(t.name, 30)} ${pad(t.country?.name ?? '—', 20)}` +
      (v?.latitude != null ? `${pad(v.city_name ?? '?', 16)} ${(+v.latitude).toFixed(3)}, ${(+v.longitude).toFixed(3)}`
                           : 'PAS DE COORDONNÉES'));
  }
  process.exit(0);
}

/* ── lecture de la liste ──────────────────────────────────────────────────── */
const slug = s => ascii(s).normalize('NFKD').replace(/[^\w\s-]/g, '')
  .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').toLowerCase().replace(/^-|-$/g, '');

/* Les données de stade de Sportmonks comportent des erreurs : Karpaty Lviv est
   donné en Australie, le Lincoln Red Imps n'a aucune coordonnée. Ce fichier
   corrige au cas par cas, après coup. */
let fixes = {};
try { fixes = JSON.parse(await readFile(join(ROOT, 'tools/overrides.json'), 'utf8')); } catch {}

let raw;
try { raw = await readFile(join(ROOT, 'tools/clubs.txt'), 'utf8'); }
catch { console.error('✖ tools/clubs.txt introuvable.'); process.exit(1); }

const entries = [];
let group = 'Clubs';
for (let line of raw.split('\n')) {
  line = line.trim();
  if (!line || (line.startsWith('#') && !line.startsWith('##'))) continue;
  if (line.startsWith('##')) { group = line.replace(/^#+\s*/, '').trim(); continue; }
  if (line.toLowerCase().startsWith('@league')) {
    entries.push({ kind: 'league', ref: line.slice(7).trim(), group });
  } else {
    if (line.startsWith('!')) {                 // club absent de Sportmonks
      entries.push({ kind: 'manual', name: line.slice(1).trim(), group });
      continue;
    }
    const forced = line.match(/#(\d+)\s*$/);
    if (forced) line = line.slice(0, forced.index).trim();
    const [name, country] = line.split('|').map(x => x && x.trim());
    entries.push({ kind: 'club', name, country, group, id: forced ? +forced[1] : null });
  }
}
console.log(`${entries.filter(e => e.kind === 'club').length} club(s), ` +
            `${entries.filter(e => e.kind === 'manual').length} saisie(s) manuelle(s) et ` +
            `${entries.filter(e => e.kind === 'league').length} ligue(s) à traiter` +
            `${DRY ? '  ·  SIMULATION' : ''}\n`);

await mkdir(join(ROOT, 'logos'), { recursive: true });
await mkdir(join(ROOT, 'data'), { recursive: true });

const clubs = new Map(), logos = {}, report = [];
let calls = 0, noCoords = 0, shaky = 0;

/** Transforme une équipe Sportmonks (avec venue + country) en club du jeu. */
async function push(team, group, confidence, wanted) {
  const v = team.venue;
  const idt = identity(team.country);
  const id = slug(team.name) || ('sm-' + team.id);
  if (clubs.has(id)) return 'doublon';
  const fix = fixes[id] || {};
  let lat = fix.lat != null ? fix.lat : coord(v && v.latitude);
  let lon = fix.lon != null ? fix.lon : coord(v && v.longitude);
  if (!(lat >= -90 && lat <= 90)) lat = null;          // filtre aussi les NaN
  if (!(lon >= -180 && lon <= 180)) lon = null;
  if (lat == null || lon == null) {
    noCoords++;
    report.push({ id, club: team.name, cherche: wanted ?? null, groupe: group, sm: team.id,
                  erreur: 'aucune coordonnée de stade — à renseigner dans tools/overrides.json' });
    return 'sans coordonnées';
  }
  const club = {
    id, name: fix.name || team.name,
    city: fix.city || (await cityOf(v)) || '?',
    cc: idt.cc, country: idt.country, flag: idt.flag,
    lat: +lat.toFixed(5), lon: +lon.toFixed(5),
    groups: [group], venue: (fix.venue || (v && v.name)) || null, sm: team.id,
  };
  // Le pays porte ses propres coordonnées : un club à plus de 2 500 km de son
  // pays est forcément une erreur de données côté Sportmonks.
  const cLat = team.country && team.country.latitude, cLon = team.country && team.country.longitude;
  if (cLat != null && cLon != null && !fix.lat) {
    const d = haversine({ lat: +cLat, lon: +cLon }, { lat: club.lat, lon: club.lon });
    // Le centre de la Russie est en Sibérie : Moscou en est à 3 600 km sans que
    // ce soit une erreur. Les pays-continents ont donc un seuil plus large.
    const huge = /^(Russia|United States|Brazil|China|Canada|Australia|Kazakhstan|Argentina|India|Algeria)$/
      .test(team.country.name || '');
    if (d > (huge ? 5200 : 2500)) club._suspect = Math.round(d);
  }
  clubs.set(id, club);
  if (!DRY && !NO_LOGOS) {
    const p = await saveLogo(team.image_path, id);
    if (p) logos[id] = p;
  }
  report.push({ id, club: team.name, cherche: wanted ?? null, groupe: group,
                pays: club.country, ville: club.city, confiance: confidence,
                ...(club.city === '?' ? { alerte: 'ville inconnue, à compléter à la main' } : {}) });
  if (confidence === 'à vérifier') shaky++;
  return 'ok';
}

for (const e of entries) {
  try {
    if (e.kind === 'manual') {
      const id = slug(e.name);
      const f = fixes[id];
      if (!f || f.lat == null || f.lon == null || !f.cc)
        throw new Error(`club manuel : renseignez cc, lat et lon sous « ${id} » dans tools/overrides.json`);
      if (clubs.has(id)) { console.log(`  · ${e.name.padEnd(28)} doublon`); continue; }
      const idt = identityFromCC(f.cc);
      clubs.set(id, { id, name: f.name || e.name, city: f.city || '?',
        cc: idt.cc, country: idt.country, flag: idt.flag,
        lat: +(+f.lat).toFixed(5), lon: +(+f.lon).toFixed(5),
        groups: [e.group], venue: f.venue || null, sm: null, manuel: true });
      report.push({ id, club: f.name || e.name, groupe: e.group, pays: idt.country,
                    ville: f.city || '?', confiance: 'manuel',
                    source: f.source || 'saisi à la main' });
      console.log(`  ✎ ${e.name.padEnd(28)} ← saisie manuelle           [${idt.country}]`);
      continue;
    }

    if (e.kind === 'league') {
      let lid = /^\d+$/.test(e.ref) ? +e.ref : null;
      let lname = e.ref;
      if (!lid) {
        const s = await api(`/leagues/search/${encodeURIComponent(e.ref)}`, { include: 'country' });
        calls++;
        const hit = (s.data || [])[0];
        if (!hit) throw new Error(`ligue « ${e.ref} » introuvable`);
        lid = hit.id; lname = hit.name;
      }
      const l = (await api(`/leagues/${lid}`, { include: 'currentseason' })).data; calls++;
      const sid = l?.currentseason?.id;
      if (!sid) throw new Error(`pas de saison en cours pour la ligue ${lid}`);
      lname = l.name;
      const t = await api(`/teams/seasons/${sid}`, { include: 'venue;country', per_page: 50 });
      calls++;
      let n = 0;
      for (const team of t.data || []) if (await push(team, e.group, 'ligue', null) === 'ok') n++;
      console.log(`  ✓ ${(e.group + ' — ' + lname).padEnd(40)} ${n} clubs`);
      await sleep(150);
      continue;
    }

    if (e.id) {                       // identifiant imposé : on saute la recherche
      const full = (await api(`/teams/${e.id}`, { include: 'venue;country' })).data; calls++;
      if (!full) throw new Error(`identifiant Sportmonks ${e.id} introuvable`);
      const r0 = await push(full, e.group, 'imposé', e.name);
      console.log(`  ⚑ ${e.name.padEnd(28)} ← ${String(full.name).padEnd(26)} [imposé]` +
                  (r0 !== 'ok' ? '  ' + r0.toUpperCase() : ''));
      await sleep(120);
      continue;
    }
    let best = null;
    for (const term of searchTerms(e.name)) {
      const res = await api(`/teams/search/${encodeURIComponent(term)}`, { include: 'country' });
      calls++;
      for (const cand of res.data || []) {
        const s = score(e.name, e.country, cand);
        if (!best || s > best.s) best = { s, cand };
      }
      if (best && best.s >= 95) break;
      await sleep(130);
    }
    if (!best || best.s < 50)
      throw new Error(best ? `pas de correspondance fiable (meilleur : « ${best.cand.name} », ${best.s})`
                           : 'aucun résultat');
    const full = (await api(`/teams/${best.cand.id}`, { include: 'venue;country' })).data; calls++;
    const conf = best.s >= 95 ? 'sûr' : best.s >= 75 ? 'probable' : 'à vérifier';
    const r = await push(full, e.group, conf, e.name);
    console.log(`  ${conf === 'sûr' ? '✓' : conf === 'probable' ? '·' : '⚠'} ` +
                `${e.name.padEnd(28)} ← ${String(full.name).padEnd(26)} [${conf}]` +
                (r !== 'ok' ? '  ' + r.toUpperCase() : ''));
    await sleep(130);
  } catch (err) {
    report.push({ cherche: e.name ?? e.ref, groupe: e.group, erreur: safe(err.message) });
    console.log(`  ✖ ${String(e.name ?? e.ref).padEnd(28)} ${safe(err.message)}`);
  }
}

/* un club présent dans plusieurs sections cumule ses groupes */
const list = [...clubs.values()].sort((a, b) => (a.country + a.name).localeCompare(b.country + b.name, 'fr'));
const groupOrder = [];
for (const e of entries) if (!groupOrder.includes(e.group)) groupOrder.push(e.group);

if (!DRY) {
  await writeFile(join(ROOT, 'data/clubs.json'), JSON.stringify(list, null, 0));
  await writeFile(join(ROOT, 'data/groups.json'), JSON.stringify(
    groupOrder.filter(g => list.some(c => c.groups.includes(g))), null, 1) + '\n');
  await writeFile(join(ROOT, 'data/logos.json'), JSON.stringify(logos, null, 1) + '\n');
}
await writeFile(join(ROOT, 'tools/build-report.json'), JSON.stringify(report, null, 1) + '\n');

const lat = list.map(c => c.lat), lon = list.map(c => c.lon);
console.log(`\n${list.length} clubs · ${new Set(list.map(c => c.cc)).size} pays · ` +
            `${Object.keys(logos).length} logos · ${calls} appels API`);
if (noCoords) console.log(`⚠ ${noCoords} club(s) écartés faute de coordonnées de stade`);
if (shaky) console.log(`⚠ ${shaky} correspondance(s) « à vérifier » dans tools/build-report.json`);
const suspects = list.filter(c => c._suspect);
if (suspects.length) {
  console.log(`\n⚠ ${suspects.length} club(s) très loin de leur pays — données de stade douteuses :`);
  for (const c of suspects)
    console.log(`   ${c.name} (${c.country}) → ${c.lat}, ${c.lon} · ${c._suspect} km du centre du pays`);
  console.log('   Corrigez-les dans tools/overrides.json puis relancez.');
}
for (const c of list) delete c._suspect;
const noCity = list.filter(c => c.city === '?');
if (noCity.length) console.log(`⚠ ${noCity.length} ville(s) inconnue(s) : ` +
  noCity.map(c => c.name).join(', '));
if (list.length) {
  console.log(`\nEmprise à couvrir par le fond de carte :`);
  console.log(`  longitude ${Math.min(...lon).toFixed(1)} → ${Math.max(...lon).toFixed(1)}` +
              `   latitude ${Math.min(...lat).toFixed(1)} → ${Math.max(...lat).toFixed(1)}`);
  console.log(`  python3 tools/build-map.py --west ${Math.floor(Math.min(...lon) - 6)} ` +
              `--east ${Math.ceil(Math.max(...lon) + 6)} ` +
              `--south ${Math.floor(Math.min(...lat) - 5)} --north ${Math.ceil(Math.max(...lat) + 5)}`);
}
