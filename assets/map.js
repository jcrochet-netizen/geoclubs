/* ============================================================================
   GeoClubs — moteur de carte mondiale

   Le fond est dessiné en Canvas et non en SVG : à l'échelle du monde il y a
   ~60 000 points, que le SVG ne retransforme pas à 60 images/seconde.

   Trois choses rendent le rendu fluide :
     1. la projection Web Mercator est appliquée UNE fois au chargement ; le
        pan/zoom n'est ensuite qu'un setTransform,
     2. deux niveaux de détail — un fond grossier pour la vue mondiale, un fond
        fin chargé en arrière-plan et utilisé une fois zoomé,
     3. au zoom, seuls les anneaux dont la boîte englobante croise la vue sont
        redessinés.

   Les marqueurs restent en SVG par-dessus : peu d'éléments, texte net,
   animations en CSS.
   ========================================================================== */
(function (global) {
  'use strict';

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var EARTH_KM = 6371.0088;
  var DETAIL_AT = 8;          // zoom à partir duquel on passe au fond fin

  function mercY(lat) {
    var l = Math.max(-85, Math.min(85, lat));
    return Math.log(Math.tan(Math.PI / 4 + l * D2R / 2)) * R2D;
  }
  function invMercY(y) { return (2 * Math.atan(Math.exp(y * D2R)) - Math.PI / 2) * R2D; }

  function haversine(a, b) {
    var p1 = a.lat * D2R, p2 = b.lat * D2R;
    var dp = (b.lat - a.lat) * D2R, dl = (b.lon - a.lon) * D2R;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function greatCircle(a, b, n) {
    var p1 = a.lat * D2R, l1 = a.lon * D2R, p2 = b.lat * D2R, l2 = b.lon * D2R;
    var d = 2 * Math.asin(Math.min(1, Math.sqrt(
      Math.pow(Math.sin((p2 - p1) / 2), 2) +
      Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin((l2 - l1) / 2), 2))));
    if (d < 1e-9) return [a, b];
    var out = [];
    for (var i = 0; i <= n; i++) {
      var f = i / n;
      var A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      var y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      var z = A * Math.sin(p1) + B * Math.sin(p2);
      out.push({ lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D, lon: Math.atan2(y, x) * R2D });
    }
    return out;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  /** Projette les anneaux en Mercator et prépare un Path2D + une boîte par anneau. */
  function buildLayer(features) {
    var rings = [], all = new Path2D();
    var box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      for (var r = 0; r < f.r.length; r++) {
        var src = f.r[r], n = src.length;
        if (n < 3) continue;
        var p = new Path2D();
        var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
        for (var j = 0; j < n; j++) {
          var x = src[j][0], y = mercY(src[j][1]);
          if (j === 0) p.moveTo(x, y); else p.lineTo(x, y);
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
          if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
        p.closePath();
        all.addPath(p);
        rings.push({ p: p, x0: bx0, x1: bx1, y0: by0, y1: by1 });
        if (bx0 < box.minX) box.minX = bx0; if (bx1 > box.maxX) box.maxX = bx1;
        if (by0 < box.minY) box.minY = by0; if (by1 > box.maxY) box.maxY = by1;
      }
    }
    return { rings: rings, all: all, box: box };
  }

  /* ------------------------------------------------------------------ */

  function GeoMap(host, opts) {
    opts = opts || {};
    this.host = host;
    this.onPick = opts.onPick || function () {};
    this.homeBox = opts.homeBox || { w: -170, e: 170, s: -50, n: 72 };
    this.maxZoom = opts.maxZoom || 3000;
    this.padding = opts.padding == null ? 8 : opts.padding;
    this.colors = opts.colors || { land: '#1C2846', stroke: '#36486F' };

    this.W = 1; this.H = 1; this.dpr = 1;
    this.k = 1; this.cx = 0; this.cy = 0;
    this.locked = false;
    this.markers = []; this.link = null;
    this.coarse = null; this.fine = null;
    this._anim = null; this._frame = null;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'm-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'm-overlay');
    this.gOverlay = el('g');
    this.svg.appendChild(this.gOverlay);

    host.appendChild(this.canvas);
    host.appendChild(this.svg);

    this._bindPointer();
    this._watchSize();
  }

  GeoMap.prototype.setGeo = function (features) {
    this.coarse = buildLayer(features);
    this.dataBox = this.coarse.box;
    this.resize();
    this.home(false);
    return this;
  };

  /** Fond détaillé, chargé après coup : il ne sert qu'une fois zoomé. */
  GeoMap.prototype.setDetail = function (features) {
    this.fine = buildLayer(features);
    this.draw();
    return this;
  };

  /* ---- conversions ---- */
  GeoMap.prototype.toScreen = function (lon, lat) {
    return { x: (lon - this.cx) * this.k + this.W / 2,
             y: this.H / 2 - (mercY(lat) - this.cy) * this.k };
  };
  GeoMap.prototype.toLonLat = function (x, y) {
    return { lon: (x - this.W / 2) / this.k + this.cx,
             lat: invMercY((this.H / 2 - y) / this.k + this.cy) };
  };

  /* ---- cadrage ---- */
  GeoMap.prototype._fitK = function (box) {
    var dx = box.e - box.w, dy = mercY(box.n) - mercY(box.s);
    var pw = Math.max(40, this.W - this.padding * 2), ph = Math.max(40, this.H - this.padding * 2);
    return Math.min(pw / dx, ph / dy);
  };
  GeoMap.prototype.home = function (animate) {
    var b = this.homeBox;
    this.minK = this._fitK(b);
    this._to({ k: this.minK, cx: (b.w + b.e) / 2, cy: (mercY(b.s) + mercY(b.n)) / 2 }, animate ? 520 : 0);
  };
  GeoMap.prototype.fitPoints = function (pts, animate, padPx) {
    if (!pts.length) return;
    var w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    pts.forEach(function (p) {
      w = Math.min(w, p.lon); e = Math.max(e, p.lon);
      s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    });
    var mx = Math.max(1.6, (e - w) * 0.45), my = Math.max(1.2, (n - s) * 0.45);
    var box = { w: w - mx, e: e + mx, s: Math.max(-84, s - my), n: Math.min(84, n + my) };
    var save = this.padding; this.padding = padPx == null ? 46 : padPx;
    var k = Math.min(this._fitK(box), this.minK * this.maxZoom);
    this.padding = save;
    this._to({ k: k, cx: (box.w + box.e) / 2, cy: (mercY(box.s) + mercY(box.n)) / 2 }, animate ? 660 : 0);
  };

  GeoMap.prototype._clamp = function (st) {
    st.k = Math.max(this.minK, Math.min(this.minK * this.maxZoom, st.k));
    var b = this.dataBox;
    if (!b) return st;
    var hw = this.W / 2 / st.k, hh = this.H / 2 / st.k;
    st.cx = (b.maxX - b.minX) < hw * 2 ? (b.minX + b.maxX) / 2
          : Math.max(b.minX + hw, Math.min(b.maxX - hw, st.cx));
    st.cy = (b.maxY - b.minY) < hh * 2 ? (b.minY + b.maxY) / 2
          : Math.max(b.minY + hh, Math.min(b.maxY - hh, st.cy));
    return st;
  };

  GeoMap.prototype._to = function (target, ms) {
    var self = this;
    if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
    this._clamp(target);
    if (!ms) { this.k = target.k; this.cx = target.cx; this.cy = target.cy; return this.render(); }
    var from = { k: this.k, cx: this.cx, cy: this.cy }, t0 = performance.now();
    var lk0 = Math.log(from.k), lk1 = Math.log(target.k);
    (function step(t) {
      var f = Math.min(1, (t - t0) / ms), e = easeInOut(f);
      self.k = Math.exp(lk0 + (lk1 - lk0) * e);
      self.cx = from.cx + (target.cx - from.cx) * e;
      self.cy = from.cy + (target.cy - from.cy) * e;
      self.render();
      self._anim = f < 1 ? requestAnimationFrame(step) : null;
    })(t0);
  };

  GeoMap.prototype.zoomBy = function (factor, sx, sy) {
    if (sx == null) { sx = this.W / 2; sy = this.H / 2; }
    var before = this.toLonLat(sx, sy), beforeY = mercY(before.lat);
    var st = this._clamp({ k: this.k * factor, cx: this.cx, cy: this.cy });
    st.cx = before.lon - (sx - this.W / 2) / st.k;
    st.cy = beforeY - (this.H / 2 - sy) / st.k;
    this._to(st, 0);
  };

  GeoMap.prototype.resize = function () {
    var r = this.host.getBoundingClientRect();
    this.W = Math.max(1, Math.round(r.width));
    this.H = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(2, global.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.svg.setAttribute('viewBox', '0 0 ' + this.W + ' ' + this.H);
    var wasHome = this.minK && Math.abs(this.k - this.minK) < 1e-6;
    this.minK = this._fitK(this.homeBox);
    if (wasHome || !this.k) this.home(false); else this._to({ k: this.k, cx: this.cx, cy: this.cy }, 0);
  };

  /* ---- rendu ---- */
  GeoMap.prototype.render = function () {
    var self = this;
    if (this._frame) return;
    this._frame = requestAnimationFrame(function () { self._frame = null; self.draw(); });
  };

  GeoMap.prototype.draw = function () {
    var ctx = this.ctx, k = this.k, d = this.dpr;
    if (!ctx || !this.coarse) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colors.sea || '#070D1A';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Mercator → écran : une seule matrice, y inversé
    ctx.setTransform(k * d, 0, 0, -k * d,
      (this.W / 2 - this.cx * k) * d, (this.H / 2 + this.cy * k) * d);
    ctx.fillStyle = this.colors.land;
    ctx.strokeStyle = this.colors.stroke;
    ctx.lineWidth = 0.9 / k;
    ctx.lineJoin = 'round';

    var zoom = k / this.minK;
    if (this.fine && zoom >= DETAIL_AT) {
      // zoomé : le fond fin, mais seulement ce qui croise la vue
      var hw = this.W / 2 / k, hh = this.H / 2 / k;
      var x0 = this.cx - hw, x1 = this.cx + hw, y0 = this.cy - hh, y1 = this.cy + hh;
      var rings = this.fine.rings;
      for (var i = 0; i < rings.length; i++) {
        var r = rings[i];
        if (r.x1 < x0 || r.x0 > x1 || r.y1 < y0 || r.y0 > y1) continue;
        ctx.fill(r.p); ctx.stroke(r.p);
      }
    } else {
      // vue large : un seul Path2D pour tout le fond grossier
      ctx.fill(this.coarse.all);
      ctx.stroke(this.coarse.all);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this._drawOverlay();
    if (this.onView) this.onView(zoom);
  };

  GeoMap.prototype._drawOverlay = function () {
    var g = this.gOverlay;
    while (g.firstChild) g.removeChild(g.firstChild);

    if (this.link) {
      var pts = greatCircle(this.link.from, this.link.to, 64).map(function (p) {
        var s = this.toScreen(p.lon, p.lat); return s.x.toFixed(1) + ',' + s.y.toFixed(1);
      }, this).join(' ');
      g.appendChild(el('polyline', { class: 'm-link', points: pts }));
    }
    for (var i = 0; i < this.markers.length; i++) {
      var m = this.markers[i], s = this.toScreen(m.lon, m.lat);
      var mg = el('g', { class: 'm-mk m-mk-' + m.kind,
        transform: 'translate(' + s.x.toFixed(1) + ',' + s.y.toFixed(1) + ')' });
      if (m.kind === 'truth') {
        mg.appendChild(el('circle', { class: 'm-halo', r: 16 }));
        mg.appendChild(el('circle', { class: 'm-ring', r: 9 }));
        mg.appendChild(el('circle', { class: 'm-core', r: 4 }));
      } else {
        mg.appendChild(el('circle', { class: 'm-shadow', r: 7, cy: 1 }));
        mg.appendChild(el('circle', { class: 'm-core', r: 6 }));
        mg.appendChild(el('circle', { class: 'm-dot', r: 2.2 }));
      }
      if (m.label) {
        var t = el('text', { class: 'm-label', y: m.kind === 'truth' ? -20 : -16 });
        t.textContent = m.label;
        mg.appendChild(t);
      }
      g.appendChild(mg);
    }
  };

  GeoMap.prototype.setMarkers = function (l) { this.markers = l || []; this._drawOverlay(); };
  GeoMap.prototype.setLink = function (l) { this.link = l; this._drawOverlay(); };
  GeoMap.prototype.clear = function () { this.markers = []; this.link = null; this._drawOverlay(); };

  /* ---- interactions ---- */
  GeoMap.prototype._bindPointer = function () {
    var self = this, host = this.host;
    var pts = new Map(), down = null, moved = false, pinch = null;
    function local(e) {
      var r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    host.addEventListener('pointerdown', function (e) {
      if (self.locked) return;
      host.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      if (pts.size === 1) { down = { p: local(e), t: performance.now(), cx: self.cx, cy: self.cy }; moved = false; }
      else if (pts.size === 2) {
        var a = Array.from(pts.values());
        pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), k: self.k };
        moved = true;
      }
      host.classList.add('is-grabbing');
    });
    host.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId) || self.locked) return;
      pts.set(e.pointerId, local(e));
      if (pts.size >= 2 && pinch) {
        var a = Array.from(pts.values());
        var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        if (pinch.d > 4) self.zoomBy((d / pinch.d) * (pinch.k / self.k), (a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2);
        return;
      }
      if (!down) return;
      var p = local(e), dx = p.x - down.p.x, dy = p.y - down.p.y;
      if (!moved && Math.hypot(dx, dy) > 4) moved = true;
      if (!moved) return;
      self._to({ k: self.k, cx: down.cx - dx / self.k, cy: down.cy + dy / self.k }, 0);
    });
    function end(e) {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      host.classList.remove('is-grabbing');
      if (pts.size === 0 && down) {
        if (!moved && performance.now() - down.t < 600 && !self.locked) {
          var p = local(e);
          self.onPick(self.toLonLat(p.x, p.y), p);
        }
        down = null;
      }
    }
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('wheel', function (e) {
      if (self.locked) return;
      e.preventDefault();
      var p = local(e);
      var d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      self.zoomBy(Math.exp(-d * 0.0022), p.x, p.y);
    }, { passive: false });
    host.addEventListener('dblclick', function (e) {
      if (self.locked) return;
      var p = local(e); self.zoomBy(1.9, p.x, p.y);
    });
  };

  GeoMap.prototype._watchSize = function () {
    if (!global.ResizeObserver) return;
    var self = this, queued = false;
    new ResizeObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; if (self.coarse) self.resize(); });
    }).observe(this.host);
  };

  global.GeoMap = GeoMap;
  global.geoUtil = { haversine: haversine, mercY: mercY, invMercY: invMercY };
})(window);
