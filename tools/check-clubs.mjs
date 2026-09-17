#!/usr/bin/env node
/* ============================================================================
   Audit géographique : chaque club tombe-t-il bien dans son pays ?

     node tools/check-clubs.mjs

   Le contrôle intégré à build-clubs.mjs compare la distance au centre du pays,
   ce qui est grossier : le CS Sfaxien pointé au Caire n'était qu'à 2 100 km du
   centre de la Tunisie, sous le seuil de 2 500 km. Ici on teste l'appartenance
   réelle au polygone du pays, via Natural Earth.

   Un club signalé « en mer » est souvent un stade côtier que le trait de côte
   simplifié rejette de peu — à distinguer d'un club carrément dans le mauvais pays.
   ========================================================================== */
import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'tools/.cache/countries-50m.json');
try { await access(SRC); } catch {
  console.error('✖ Fond Natural Earth absent. Lancez d’abord tools/build-map.py.');
  process.exit(1);
}

/* ── décodage TopoJSON ─────────────────────────────────────────────────── */
const topo = JSON.parse(await readFile(SRC, 'utf8'));
const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
const ARCS = topo.arcs.map(arc => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
});
const ringOf = idx => {
  const pts = [];
  for (const i of idx) {
    const a = i < 0 ? ARCS[~i].slice().reverse() : ARCS[i];
    pts.push(...(pts.length ? a.slice(1) : a));
  }
  return pts;
};

/** Déroule les longitudes d'un anneau qui franchit l'antiméridien. Sans cela
    l'anneau russe traverse toute la carte et avale Bodø, en Norvège. */
const unwrap = ring => {
  const out = [ring[0].slice()];
  let off = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] - ring[i - 1][0];
    if (d > 180) off -= 360; else if (d < -180) off += 360;
    out.push([ring[i][0] + off, ring[i][1]]);
  }
  return out;
};

const pays = [];
for (const g of topo.objects.countries.geometries) {
  if (!g.type) continue;
  const polys = g.type === 'MultiPolygon' ? g.arcs : [g.arcs];
  const rings = [];
  for (const poly of polys) for (const r of poly) {
    const pts = unwrap(ringOf(r));
    if (pts.length < 4) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    rings.push({ pts, x0, x1, y0, y1 });
  }
  if (rings.length) pays.push({ nom: g.properties.name, rings });
}

const dedans = (lon, lat, r) => {
  if (lon < r.x0 || lon > r.x1 || lat < r.y0 || lat > r.y1) return false;
  let c = false, p = r.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > lat) !== (p[j][1] > lat) &&
        lon < (p[j][0] - p[i][0]) * (lat - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
};
const localiser = (lon, lat) => pays
  .filter(c => c.rings.some(r => dedans(lon, lat, r) || dedans(lon + 360, lat, r) || dedans(lon - 360, lat, r)))
  .map(c => c.nom);

/* ── nom attendu : Sportmonks parle ISO, Natural Earth parle anglais ─────── */
const EN = new Intl.DisplayNames(['en'], { type: 'region' });
const ALIAS = {                       // là où les deux sources divergent
  ENG: 'United Kingdom', SCO: 'United Kingdom', WAL: 'United Kingdom', NIR: 'United Kingdom',
  CZ: 'Czechia', MK: 'Macedonia', BA: 'Bosnia and Herz.', XK: 'Kosovo', FO: 'Faeroe Is.',
  KR: 'South Korea', KP: 'North Korea', TR: 'Turkey', CD: 'Dem. Rep. Congo', CI: "Côte d'Ivoire",
  AE: 'United Arab Emirates', DO: 'Dominican Rep.', SV: 'El Salvador', EH: 'W. Sahara',
  GB: 'United Kingdom', US: 'United States of America', RU: 'Russia',
};
/* GeoConf identifie les pays par leur code UEFA à trois lettres, GeoClubs par
   l'ISO2. Le script sert les deux jeux, il doit donc comprendre les deux. */
const UEFA = {
  ALB:'Albania', AND:'Andorra', ARM:'Armenia', AUT:'Austria', AZE:'Azerbaijan', BEL:'Belgium',
  BIH:'Bosnia and Herz.', BLR:'Belarus', BUL:'Bulgaria', CRO:'Croatia', CYP:'Cyprus',
  CZE:'Czechia', DEN:'Denmark', ENG:'United Kingdom', ESP:'Spain', EST:'Estonia',
  FIN:'Finland', FRA:'France', FRO:'Faeroe Is.', GEO:'Georgia', GER:'Germany',
  GIB:'Gibraltar', GRE:'Greece', HUN:'Hungary', IRL:'Ireland', ISL:'Iceland', ISR:'Israel',
  ITA:'Italy', KAZ:'Kazakhstan', KOS:'Kosovo', LIE:'Liechtenstein', LTU:'Lithuania',
  LVA:'Latvia', MDA:'Moldova', MKD:'Macedonia', MLT:'Malta', MNE:'Montenegro',
  NED:'Netherlands', NIR:'United Kingdom', NOR:'Norway', POL:'Poland', POR:'Portugal',
  ROU:'Romania', RUS:'Russia', SCO:'United Kingdom', SRB:'Serbia', SUI:'Switzerland',
  SVK:'Slovakia', SVN:'Slovenia', SWE:'Sweden', TUR:'Turkey', UKR:'Ukraine',
  WAL:'United Kingdom',
};
const attendu = cc => {
  if (ALIAS[cc]) return ALIAS[cc];
  if (cc && cc.length === 3 && UEFA[cc]) return UEFA[cc];
  try { return EN.of(cc) || cc; } catch { return cc; }
};

/* ── audit ──────────────────────────────────────────────────────────────── */
const clubs = JSON.parse(await readFile(join(ROOT, 'data/clubs.json'), 'utf8'));
const mauvais = [], enMer = [];
for (const c of clubs) {
  const trouve = localiser(c.lon, c.lat);
  const veut = attendu(c.cc);
  if (!trouve.length) { enMer.push({ c, veut }); continue; }
  if (!trouve.some(n => n === veut)) mauvais.push({ c, veut, trouve });
}

console.log(`${clubs.length} clubs vérifiés contre les frontières Natural Earth\n`);
if (mauvais.length) {
  console.log(`✖ ${mauvais.length} club(s) DANS LE MAUVAIS PAYS :`);
  for (const { c, veut, trouve } of mauvais)
    console.log(`   ${c.flag} ${c.name.padEnd(24)} attendu ${veut.padEnd(22)} trouvé ${trouve.join(', ')}` +
                `   (${c.lat}, ${c.lon} · ville annoncée : ${c.city})`);
} else console.log('✓ aucun club dans le mauvais pays');

if (enMer.length) {
  console.log(`\n⚠ ${enMer.length} club(s) hors de toute terre — souvent un stade côtier` +
              ` que le trait de côte simplifié rejette de peu :`);
  for (const { c } of enMer) console.log(`   ${c.flag} ${c.name.padEnd(24)} ${c.city} (${c.lat}, ${c.lon})`);
}
process.exit(mauvais.length ? 1 : 0);
