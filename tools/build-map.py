#!/usr/bin/env python3
"""Génère data/basemap.json : le fond de carte, découpé sur l'emprise du jeu.

    python3 tools/build-map.py --west -33 --east 90 --south 6 --north 80

L'emprise doit DÉBORDER de la zone où tombent les clubs : sur un écran en
portrait, la vue est plus haute que large et laisserait voir le bord du
découpage. build-clubs.mjs affiche la commande à lancer avec les bonnes marges.

Source : Natural Earth 1:50m via world-atlas (domaine public), téléchargé et
mis en cache dans tools/.cache/ au premier appel.
"""
import json, math, sys, argparse, os, urllib.request
sys.setrecursionlimit(100000)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")
SRC = os.path.join(CACHE, "countries-50m.json")
URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json"

ap = argparse.ArgumentParser()
ap.add_argument("--west", type=float, default=-33.0)
ap.add_argument("--east", type=float, default=90.0)
ap.add_argument("--south", type=float, default=6.0)
ap.add_argument("--north", type=float, default=80.0)
ap.add_argument("--eps", type=float, default=0.005, help="tolérance Douglas-Peucker en degrés")
ap.add_argument("--out", default=os.path.join(ROOT, "data", "basemap.json"))
A = ap.parse_args()

if not os.path.exists(SRC):
    os.makedirs(CACHE, exist_ok=True)
    print("téléchargement du fond Natural Earth…")
    urllib.request.urlretrieve(URL, SRC)

topo = json.load(open(SRC))
sx, sy = topo["transform"]["scale"]; tx, ty = topo["transform"]["translate"]

def decode(arc):
    x = y = 0; out = []
    for dx, dy in arc:
        x += dx; y += dy
        out.append((x*sx+tx, y*sy+ty))
    return out
ARCS = [decode(a) for a in topo["arcs"]]

def ring_of(idx):
    pts = []
    for i in idx:
        a = ARCS[~i][::-1] if i < 0 else ARCS[i]
        pts.extend(a if not pts else a[1:])
    return pts

# --- viewport clip rect (a bit larger than the playable extent) ---
W, E, S, N = A.west, A.east, A.south, A.north


def unwrap(ring):
    """Déroule les longitudes d'un anneau qui franchit l'antiméridien.
    Sans cela, le saut +180 → -180 (Russie/Tchoukotka) produit un segment
    horizontal qui traverse toute la carte et remplit l'Arctique."""
    out = [list(ring[0])]
    off = 0.0
    for i in range(1, len(ring)):
        d = ring[i][0] - ring[i-1][0]
        if d > 180: off -= 360
        elif d < -180: off += 360
        out.append([ring[i][0] + off, ring[i][1]])
    return out

def clip(poly, edge, val, keep):
    if not poly: return []
    out = []
    def inside(p):
        v = p[0] if edge == 'x' else p[1]
        return v >= val if keep == 'ge' else v <= val
    def isect(a, b):
        if edge == 'x':
            t = (val - a[0]) / (b[0] - a[0]); return (val, a[1] + t*(b[1]-a[1]))
        t = (val - a[1]) / (b[1] - a[1]); return (a[0] + t*(b[0]-a[0]), val)
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i+1) % n]
        ia, ib = inside(a), inside(b)
        if ia: out.append(a)
        if ia != ib: out.append(isect(a, b))
    return out

def clip_rect(poly):
    poly = clip(poly, 'x', W, 'ge'); poly = clip(poly, 'x', E, 'le')
    poly = clip(poly, 'y', S, 'ge'); poly = clip(poly, 'y', N, 'le')
    return poly

def dp(pts, eps):
    if len(pts) < 3: return pts
    dmax, idx = 0.0, 0
    a, b = pts[0], pts[-1]
    dx, dy = b[0]-a[0], b[1]-a[1]
    den = math.hypot(dx, dy)
    for i in range(1, len(pts)-1):
        p = pts[i]
        d = abs(dx*(a[1]-p[1]) - (a[0]-p[0])*dy)/den if den else math.hypot(p[0]-a[0], p[1]-a[1])
        if d > dmax: dmax, idx = d, i
    if dmax > eps:
        return dp(pts[:idx+1], eps)[:-1] + dp(pts[idx:], eps)
    return [a, b]

def area(r):
    s = 0.0
    for i in range(len(r)):
        x1,y1 = r[i]; x2,y2 = r[(i+1)%len(r)]
        s += x1*y2 - x2*y1
    return abs(s)/2

EPS = A.eps
MIN_AREA = 0.0035    # drop specks, but keep Gibraltar/Malta-sized features
KEEP_ALWAYS = {"Gibraltar", "Malta", "Monaco", "San Marino", "Liechtenstein", "Andorra", "Faroe Is."}

feats = []
for g in topo["objects"]["countries"]["geometries"]:
    name = g["properties"]["name"]
    if g.get("type") is None: continue
    if g["type"] == "MultiPolygon":
        raw = [[ring_of(r) for r in poly] for poly in g["arcs"]]
    else:
        raw = [[ring_of(r) for r in g["arcs"]]]
    rings = []
    for poly in raw:
      for r0 in poly:
        r0 = unwrap(r0)
        # Un anneau déroulé peut sortir de [-180, 180] : la Tchoukotka part à
        # 190°E, les Fidji à -185°. On le teste aussi décalé de ±360° pour qu'il
        # réapparaisse de l'autre côté de la carte.
        for shift in (-360.0, 0.0, 360.0):
            r = [[q[0] + shift, q[1]] for q in r0] if shift else r0
            xs = [q[0] for q in r]; ys = [q[1] for q in r]
            if max(xs) < W or min(xs) > E or max(ys) < S or min(ys) > N: continue
            c = clip_rect(r)
            if len(c) < 4: continue
            sm = dp(c + [c[0]], EPS)[:-1]
            if len(sm) < 3: continue
            if area(sm) < MIN_AREA and name not in KEEP_ALWAYS: continue
            rings.append([[round(x, 3), round(y, 3)] for x, y in sm])
    if rings:
        feats.append({"n": name, "r": rings})

feats.sort(key=lambda f: f["n"])
os.makedirs(os.path.dirname(A.out), exist_ok=True)
json.dump(feats, open(A.out, "w"), separators=(",", ":"))
pts = sum(len(r) for f in feats for r in f["r"])
import os
print(f"{len(feats)} pays · {sum(len(f['r']) for f in feats)} anneaux · {pts} points · "
      f"{os.path.getsize(A.out)/1024:.0f} Ko → {os.path.relpath(A.out, ROOT)}")
print("emprise : lon %g→%g  lat %g→%g" % (W, E, S, N))
