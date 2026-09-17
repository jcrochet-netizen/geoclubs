/* ============================================================================
   GeoClubs — Le GeoGuessr du football mondial
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var COUNT_OPTIONS = [10, 20, 50, 100, 0];   // 0 = tous

  /** Un indice par tranche de dix clubs, plafonné à dix :
      10 → 1, 20 → 2, 50 → 5, 100 → 10, et tout le paquet → 10. */
  function hintsFor(rounds) { return Math.min(10, Math.max(1, Math.round(rounds / 10))); }
  function plural(n, mot) { return n + ' ' + mot + (n > 1 ? 's' : ''); }

  /* Les paliers sont plus larges que sur un jeu européen : d'un continent à
     l'autre, se tromper de 1 000 km reste une approximation honorable. */
  var BUCKETS = [
    { max: 25,       sq: '⭐', label: 'Dans le rond central',       cls: 'b-ace' },
    { max: 120,      sq: '🟩', label: 'Excellent',                  cls: 'b-great' },
    { max: 450,      sq: '🟨', label: 'Solide',                     cls: 'b-good' },
    { max: 1400,     sq: '🟧', label: 'Approximatif',               cls: 'b-meh' },
    { max: 4500,     sq: '🟥', label: 'Perdu',                      cls: 'b-bad' },
    { max: Infinity, sq: '⬛', label: 'Mauvais continent',          cls: 'b-awful' }
  ];
  function bucket(km) { for (var i = 0; i < BUCKETS.length; i++) if (km < BUCKETS[i].max) return BUCKETS[i]; }

  var RANKS = [
    [150,      'Scout international', 'Vous avez vu jouer Always Ready à 3 600 m d\'altitude, avouez.'],
    [400,      'Recruteur confirmé', 'Le monde du ballon n\'a plus beaucoup de secrets.'],
    [900,      'Abonné à la 3e chaîne du bouquet', 'Solide sur l\'Europe, plus flottant ailleurs.'],
    [2000,     'Supporter du dimanche', 'Au-delà des cinq grands championnats, c\'est le brouillard.'],
    [4500,     'Le monde est vaste', 'Et visiblement plus grand que prévu.'],
    [Infinity, 'La géographie attendra', 'Mais le maillot était joli.']
  ];
  function rankFor(avg) { for (var i = 0; i < RANKS.length; i++) if (avg < RANKS[i][0]) return RANKS[i]; }

  var CREST_STOP = /^(fc|fk|sk|ac|as|af|cf|cs|sc|bk|if|kf|nk|hnk|gnk|pfc|kv|rc|ogc|ks|ss|sv|us|ca|cd|club|de|del|the|1|1\.|real|deportivo|atletico|atlético|sporting|union)$/i;

  var S = {
    clubs: [], groups: [], logos: {},
    sel: {}, mix: false, count: 10,
    deck: [], idx: 0, results: [], guess: null, revealed: false, map: null, parentURL: null,
    hintsLeft: 0, hintsTotal: 0, hintUsed: false, hintsSpent: 0
  };

  /* ---------- utilitaires ---------- */
  function fmtKm(km) {
    var v = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
    return v.toLocaleString('fr-FR');
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  function initials(name) {
    var words = name.replace(/[().']/g, ' ').split(/[\s/·-]+/).filter(Boolean);
    var keep = words.filter(function (w) { return !CREST_STOP.test(w); });
    if (!keep.length) keep = words;
    var out = keep.slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
    if (out.length < 2 && keep[0]) out = keep[0].slice(0, 2).toUpperCase();
    return out || '??';
  }

  function crestHTML(club) {
    var src = S.logos[club.id];
    var h = hash(club.id) % 360;
    var fb = '<span class="crest-fb" style="--h:' + h + '">' + initials(club.name) + '</span>';
    var img = src
      ? '<img alt="" src="' + src + '" loading="eager" ' +
        'onerror="this.closest(\'.crest\').classList.remove(\'has-logo\');this.remove()">'
      : '';
    return img + fb;
  }
  function paintCrest(club) {
    var el = $('crest');
    el.innerHTML = crestHTML(club);
    el.classList.toggle('has-logo', !!S.logos[club.id]);
  }

  /* ---------- écran d'accueil ---------- */
  function poolFor(sel) {
    if (S.mix) return S.clubs;
    var on = Object.keys(sel).filter(function (k) { return sel[k]; });
    if (!on.length) return [];
    return S.clubs.filter(function (c) {
      for (var i = 0; i < on.length; i++) if (c.groups.indexOf(on[i]) >= 0) return true;
      return false;
    });
  }

  var BIG5_CC = ['ENG', 'ES', 'IT', 'DE', 'FR'];   // Angleterre, Espagne, Italie, Allemagne, France
  var BIG5_MAX = 2;

  /** Tirage « Mix de pays » : aléatoire, mais deux clubs au maximum par pays du
      Big 5. Sans ce plafond, ces cinq pays pèsent 95 clubs sur 318 et raflent
      près d'un tirage sur trois. */
  function mixDeck(pool, n) {
    var used = {}, out = [], recales = [];
    shuffle(pool.slice()).forEach(function (c) {
      if (out.length >= n) return;
      if (BIG5_CC.indexOf(c.cc) >= 0) {
        if ((used[c.cc] || 0) >= BIG5_MAX) { recales.push(c); return; }
        used[c.cc] = (used[c.cc] || 0) + 1;
      }
      out.push(c);
    });
    // Pool trop étroit pour honorer le plafond : on complète plutôt que de
    // rendre moins de manches que promis.
    if (out.length < n) out = out.concat(recales.slice(0, n - out.length));
    return shuffle(out).slice(0, n);
  }

  function renderGroups() {
    var box = $('group-chips');
    box.innerHTML = '';

    var mix = document.createElement('button');
    mix.type = 'button';
    mix.className = 'chip chip-mix';
    mix.dataset.mix = '1';
    mix.innerHTML = '<span class="chip-main">Mix de pays</span>' +
                    '<span class="chip-sub">' + S.clubs.length + ' clubs</span>';
    mix.addEventListener('click', function () {
      S.mix = !S.mix;
      if (S.mix) S.groups.forEach(function (g) { S.sel[g.name] = false; });
      syncHome();
    });
    box.appendChild(mix);

    S.groups.forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.group = g.name;
      b.innerHTML = '<span class="chip-main">' + g.name + '</span>' +
                    '<span class="chip-sub">' + g.n + ' clubs</span>';
      b.addEventListener('click', function () {
        S.mix = false;                 // les continents et le mix s'excluent
        S.sel[g.name] = !S.sel[g.name];
        syncHome();
      });
      box.appendChild(b);
    });
  }

  function renderCounts() {
    var box = $('count-chips');
    box.innerHTML = '';
    COUNT_OPTIONS.forEach(function (n) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-num';
      b.dataset.count = n;
      b.innerHTML = '<span class="chip-main">' + (n || 'Tous') + '</span>' +
                    '<span class="chip-sub" data-hints></span>';
      b.addEventListener('click', function () { S.count = n; syncHome(); });
      box.appendChild(b);
    });
  }

  function syncHome() {
    var n = poolFor(S.sel).length;
    Array.prototype.forEach.call($('group-chips').children, function (b) {
      if (b.dataset.mix) b.classList.toggle('is-on', S.mix);
      else b.classList.toggle('is-on', !S.mix && !!S.sel[b.dataset.group]);
    });
    Array.prototype.forEach.call($('count-chips').children, function (b) {
      var c = +b.dataset.count, tooBig = c > 0 && c > n;
      b.classList.toggle('is-dim', tooBig);
      b.disabled = tooBig && n > 0;
      if (tooBig && c === S.count) S.count = 0;
    });
    Array.prototype.forEach.call($('count-chips').children, function (b) {
      var c = +b.dataset.count;
      b.classList.toggle('is-on', c === S.count);
      var r = c === 0 ? n : Math.min(c, n);
      b.querySelector('[data-hints]').textContent = n ? plural(hintsFor(r), 'indice') : 'clubs';
    });
    var rounds = S.count === 0 ? n : Math.min(S.count, n);
    var picked = S.groups.filter(function (g) { return S.sel[g.name]; });
    $('pool-info').textContent = n ? n + ' clubs disponibles' : '—';
    $('btn-play').disabled = n === 0;
    $('cta-sub').textContent = n === 0 ? 'Choisissez au moins un ensemble'
      : plural(rounds, 'manche') + ' · ' + plural(hintsFor(rounds), 'indice') + ' · ' +
        (S.mix ? 'mix de pays'
               : picked.length === S.groups.length ? 'tout le monde'
               : picked.map(function (g) { return g.name; }).join(' · '));
    $('btn-all-groups').textContent = (S.mix || picked.length) ? 'Tout décocher' : 'Tout mélanger';
  }

  function renderFacts() {
    var countries = {};
    S.clubs.forEach(function (c) { countries[c.cc] = 1; });

    // La vraie distance maximale entre deux clubs, pas l'écart de longitude :
    // avec l'Océanie dans le jeu, les deux ne disent pas du tout la même chose.
    var far = 0, a = null, b = null;
    for (var i = 0; i < S.clubs.length; i++)
      for (var j = i + 1; j < S.clubs.length; j++) {
        var d = window.geoUtil.haversine(S.clubs[i], S.clubs[j]);
        if (d > far) { far = d; a = S.clubs[i]; b = S.clubs[j]; }
      }
    var span = Math.round(far / 100) * 100;

    $('home-facts').innerHTML = [
      ['⚽', S.clubs.length + ' clubs', 'des 5 grands championnats aux confins'],
      ['🌍', Object.keys(countries).length + ' pays', 'aux quatre coins du monde'],
      ['📐', span.toLocaleString('fr-FR') + ' km', 'entre les deux clubs les plus éloignés']
    ].map(function (f) {
      return '<li><i>' + f[0] + '</i><b>' + f[1] + '</b><span>' + f[2] + '</span></li>';
    }).join('');
  }

  /* ---------- partie ---------- */
  function show(id) {
    ['scr-home', 'scr-play', 'scr-end'].forEach(function (s) {
      $(s).classList.toggle('is-active', s === id);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    postHeight();
  }

  function startGame() {
    var pool = poolFor(S.sel);
    var n = S.count === 0 ? pool.length : Math.min(S.count, pool.length);
    S.deck = S.mix ? mixDeck(pool, n) : shuffle(pool.slice()).slice(0, n);
    S.idx = 0; S.results = [];
    S.hintsTotal = hintsFor(n); S.hintsLeft = S.hintsTotal;
    S.hintUsed = false; S.hintsSpent = 0;
    show('scr-play');
    S.map.resize();
    nextRound();
  }

  function renderMeta(c, showCountry) {
    var tags = c.groups.filter(function (g) { return S.sel[g]; })
      .map(function (g) { return '<b>' + g + '</b>'; }).join('');
    var ctry = showCountry
      ? '<span class="ctry is-revealed"><span class="flag">' + (c.flag || '') + '</span>' + c.country + '</span>'
      : '';
    $('club-meta').innerHTML = ctry + '<span class="seas">' + tags + '</span>';
  }

  function syncHint() {
    var b = $('btn-hint'), t = b.querySelector('.hint-txt');
    $('hint-left').textContent = S.hintsLeft;
    b.hidden = S.revealed;
    if (S.hintUsed) { b.disabled = true; t.textContent = 'Pays révélé'; }
    else if (S.hintsLeft === 0) { b.disabled = true; t.textContent = "Plus d'indice"; }
    else { b.disabled = false; t.textContent = 'Indice'; }
    b.classList.toggle('is-spent', S.hintsLeft === 0 && !S.hintUsed);
  }

  function useHint() {
    if (S.revealed || S.hintUsed || S.hintsLeft <= 0) return;
    S.hintsLeft--; S.hintUsed = true; S.hintsSpent++;
    renderMeta(S.deck[S.idx], true);
    syncHint(); postHeight();
  }

  function nextRound() {
    if (S.idx >= S.deck.length) return endGame();
    var c = S.deck[S.idx];
    S.guess = null; S.revealed = false; S.hintUsed = false;

    paintCrest(c);
    $('club-name').textContent = c.name;
    renderMeta(c, false);
    $('stat-round').innerHTML = (S.idx + 1) + '<i>/' + S.deck.length + '</i>';
    $('progress-bar').style.width = (S.idx / S.deck.length * 100) + '%';
    updateScore();

    S.map.clear();
    S.map.home(true);
    syncHint();
    $('verdict').hidden = true;
    $('btn-guess').hidden = false; $('btn-guess').disabled = true;
    $('btn-next').hidden = true;
    $('map-hint').hidden = false;
    $('map-hint').textContent = S.idx === 0
      ? 'Cliquez sur la carte · molette ou pincement pour zoomer'
      : 'Cliquez sur la carte pour placer votre pronostic';
    $('actionbar').className = 'actionbar';
  }

  function onPick(ll) {
    if (S.revealed) return;
    S.guess = ll;
    S.map.setMarkers([{ lat: ll.lat, lon: ll.lon, kind: 'guess' }]);
    $('btn-guess').disabled = false;
    $('map-hint').textContent = 'Déplacez le point si besoin, puis validez';
  }

  function submit() {
    if (!S.guess || S.revealed) return;
    S.revealed = true;
    var c = S.deck[S.idx];
    var km = window.geoUtil.haversine(S.guess, c);
    var b = bucket(km);
    S.results.push({ club: c, km: km, guess: S.guess, bucket: b });

    S.map.setMarkers([
      { lat: S.guess.lat, lon: S.guess.lon, kind: 'guess', label: 'Vous' },
      { lat: c.lat, lon: c.lon, kind: 'truth', label: c.city }
    ]);
    S.map.setLink({ from: S.guess, to: c });
    S.map.fitPoints([S.guess, c], true);

    $('verdict').hidden = false;
    $('verdict-dist').textContent = fmtKm(km) + ' km';
    var badge = $('verdict-badge');
    badge.textContent = b.label;
    badge.className = 'badge ' + b.cls;
    var place = c.city === c.country ? '<strong>' + c.city + '</strong>'
                                     : '<strong>' + c.city + '</strong>, ' + c.country;
    $('verdict-sub').innerHTML = place + (c.venue ? ' · <em>' + c.venue + '</em>' : '');
    $('actionbar').className = 'actionbar is-revealed ' + b.cls;
    renderMeta(c, true);
    syncHint();
    $('btn-guess').hidden = true;
    $('btn-next').hidden = false;
    $('btn-next').textContent = S.idx + 1 >= S.deck.length ? 'Voir le résultat' : 'Suivant';
    $('btn-next').focus({ preventScroll: true });
    $('map-hint').hidden = true;
    updateScore();
    $('progress-bar').style.width = ((S.idx + 1) / S.deck.length * 100) + '%';
    postHeight();
  }

  function updateScore() {
    var t = S.results.reduce(function (a, r) { return a + r.km; }, 0);
    $('stat-score').innerHTML = fmtKm(t) + '<i> km</i>';
  }

  /* ---------- fin de partie ---------- */
  function endGame() {
    var total = S.results.reduce(function (a, r) { return a + r.km; }, 0);
    var avg = total / S.results.length;
    var sorted = S.results.slice().sort(function (a, b) { return a.km - b.km; });
    var rank = rankFor(avg);

    $('final-total').textContent = fmtKm(total);
    $('final-avg').textContent = fmtKm(avg) + ' km';
    $('final-best').innerHTML = fmtKm(sorted[0].km) + ' km<small>' + sorted[0].club.name + '</small>';
    $('final-worst').innerHTML = fmtKm(sorted[sorted.length - 1].km) + ' km<small>' +
      sorted[sorted.length - 1].club.name + '</small>';
    $('final-rank').innerHTML = '<b>' + rank[1] + '</b><span>' + rank[2] +
      (S.hintsSpent ? ' · ' + plural(S.hintsSpent, 'indice') + ' sur ' + S.hintsTotal
                    : ' · aucun indice utilisé') + '</span>';
    $('final-squares').textContent = S.results.map(function (r) { return r.bucket.sq; }).join('');

    $('recap-list').innerHTML = S.results.map(function (r) {
      return '<li class="' + r.bucket.cls + '"><span class="rc-sq">' + r.bucket.sq + '</span>' +
             '<span class="rc-name">' + r.club.name + '</span>' +
             '<span class="rc-city">' + (r.club.flag || '') + ' ' + r.club.city + '</span>' +
             '<span class="rc-km">' + fmtKm(r.km) + ' km</span></li>';
    }).join('');

    buildShare(total, avg);
    show('scr-end');
  }

  /** Une URL http(s) et rien d'autre : elle finira dans un href et dans un texte
      de partage, pas question d'y laisser passer un javascript:. */
  function httpURL(u) {
    if (!u || typeof u !== 'string') return null;   // sinon new URL(null,…) donne « /null »
    try { var x = new URL(u, location.href);
      return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null;
    } catch (e) { return null; }
  }

  /** Le partage doit pointer vers la page qui héberge l'iframe, jamais vers
      github.io. Par ordre de fiabilité : la consigne explicite, l'URL que la
      page hôte nous envoie, à défaut le référent, et en dernier recours nous. */
  function shareURL() {
    var q = new URLSearchParams(location.search);
    return httpURL(q.get('share'))
        || S.parentURL
        || (window.parent !== window ? httpURL(document.referrer) : null)
        || (location.origin + location.pathname);
  }

  function buildShare(total, avg) {
    var picked = S.groups.filter(function (g) { return S.sel[g.name]; });
    var eds = S.mix ? 'mix de pays'
            : picked.length === S.groups.length ? 'le monde entier'
            : picked.map(function (g) { return g.name; }).join(' + ');
    var txt =
      '🌍 GeoClubs — le GeoGuessr du football mondial\n' +
      eds + ' · ' + S.results.length + ' clubs\n' +
      S.results.map(function (r) { return r.bucket.sq; }).join('') + '\n' +
      'Score : ' + fmtKm(total) + ' km (moy. ' + fmtKm(avg) + ' km/club)\n' +
      (S.hintsSpent ? 'Indices : ' + S.hintsSpent + '/' + S.hintsTotal + '\n'
                    : 'Sans le moindre indice 😤\n') +
      '« ' + rankFor(avg)[1] + ' »\n';
    var url = shareURL();
    $('share-preview').textContent = txt + url;

    var enc = encodeURIComponent(txt + '\n'), eu = encodeURIComponent(url);
    $('sh-x').href = 'https://twitter.com/intent/tweet?text=' + enc + '&url=' + eu;
    $('sh-wa').href = 'https://api.whatsapp.com/send?text=' + encodeURIComponent(txt + '\n' + url);
    $('sh-bs').href = 'https://bsky.app/intent/compose?text=' + encodeURIComponent(txt + '\n' + url);
    $('sh-fb').href = 'https://www.facebook.com/sharer/sharer.php?u=' + eu;

    $('sh-copy').onclick = function () {
      var full = txt + url;
      var done = function () {
        $('sh-copy').textContent = 'Copié ✓';
        setTimeout(function () { $('sh-copy').textContent = 'Copier le score'; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(full).then(done, function () { legacyCopy(full); done(); });
      else { legacyCopy(full); done(); }
    };
    if (navigator.share) {
      $('sh-native').hidden = false;
      $('sh-native').onclick = function () {
        navigator.share({ title: 'GeoClubs', text: txt, url: url }).catch(function () {});
      };
    }
  }

  function legacyCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ---------- intégration iframe ---------- */
  var lastH = 0;
  function postHeight() {
    if (window.parent === window) return;
    var app = $('app');
    if (!app) return;
    var h = Math.ceil(app.getBoundingClientRect().height);
    if (!h || Math.abs(h - lastH) < 6) return;
    lastH = h;
    try { window.parent.postMessage({ type: 'geoclubs:height', height: h }, '*'); } catch (e) {}
  }
  function watchHeight() {
    if (window.parent === window || !window.ResizeObserver) return;
    var app = $('app');
    if (app) new ResizeObserver(postHeight).observe(app);
  }

  /* ---------- chargement ---------- */
  function json(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → ' + r.status);
      return r.json();
    });
  }

  function boot() {
    Promise.all([
      json('data/clubs.json'),
      json('data/basemap.json'),
      json('data/logos.json').catch(function () { return {}; }),
      json('data/groups.json').catch(function () { return null; })
    ]).then(function (res) {
      S.clubs = res[0]; S.logos = res[2] || {};

      // Les ensembles proposés à l'accueil sortent des données, dans l'ordre
      // où ils apparaissent : ajouter un continent ne touche pas au code.
      var order = [], count = {};
      S.clubs.forEach(function (c) {
        c.groups.forEach(function (g) {
          if (!(g in count)) { count[g] = 0; order.push(g); }
          count[g]++;
        });
      });
      // data/groups.json donne l'ordre des sections de clubs.txt ; sans lui on
      // retomberait sur l'ordre alphabétique des pays, qui n'a aucun sens ici.
      if (res[3] && res[3].length) {
        var fromFile = res[3].filter(function (g) { return g in count; });
        order = fromFile.concat(order.filter(function (g) { return fromFile.indexOf(g) < 0; }));
      }
      S.groups = order.map(function (g) { return { name: g, n: count[g] }; });

      // Rien n'est coché au départ : au joueur de composer sa partie.
      var q = new URLSearchParams(location.search);
      var preset = (q.get('g') || '').split(',').filter(Boolean).map(function (s) { return s.toLowerCase(); });
      S.groups.forEach(function (g) { S.sel[g.name] = preset.indexOf(g.name.toLowerCase()) >= 0; });
      if (preset.indexOf('mix') >= 0) S.mix = true;
      var pn = parseInt(q.get('n'), 10);
      if (COUNT_OPTIONS.indexOf(pn) >= 0) S.count = pn;

      // le cadrage initial épouse l'emprise réelle des clubs, avec une marge
      var lat = S.clubs.map(function (c) { return c.lat; });
      var lon = S.clubs.map(function (c) { return c.lon; });
      var box = {
        w: Math.max(-180, Math.min.apply(null, lon) - 8),
        e: Math.min(180, Math.max.apply(null, lon) + 8),
        s: Math.max(-84, Math.min.apply(null, lat) - 6),
        n: Math.min(84, Math.max.apply(null, lat) + 6)
      };

      // Les couleurs du fond viennent des mêmes variables CSS que le reste.
      var cs = getComputedStyle(document.documentElement);
      var col = function (n, d) { return (cs.getPropertyValue(n) || '').trim() || d; };
      S.map = new window.GeoMap($('map'), {
        onPick: onPick, maxZoom: 4000, homeBox: box,
        colors: { land: col('--land', '#1C2846'), stroke: col('--land-str', '#36486F'),
                  sea: col('--sea', '#070D1A') }
      });
      S.map.setGeo(res[1]);

      renderGroups(); renderCounts(); renderFacts(); syncHome();
      window.__geoclubs = S;
      document.body.classList.add('is-ready');
      watchHeight(); postHeight();

      // Le fond détaillé arrive après coup : le jeu est jouable sans lui.
      json('data/basemap-detail.json')
        .then(function (d) { S.map.setDetail(d); })
        .catch(function () {});
    }).catch(function (e) {
      console.error(e);
      document.body.innerHTML = '<p style="padding:2rem;font:15px system-ui;color:#e6ecff">' +
        'Impossible de charger les données du jeu.<br><small>' + e.message +
        '</small><br><br>Le jeu doit être servi via HTTP, pas ouvert en <code>file://</code>.</p>';
    });
  }

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'geoclubs:parent') return;
    var u = httpURL(e.data.url);
    if (!u) return;
    S.parentURL = u;
    var link = $('foot-link');
    if (link) link.href = u;
  });

  document.addEventListener('DOMContentLoaded', function () {
    $('btn-play').addEventListener('click', startGame);
    $('btn-guess').addEventListener('click', submit);
    $('btn-hint').addEventListener('click', useHint);
    $('btn-next').addEventListener('click', function () { S.idx++; nextRound(); postHeight(); });
    $('btn-again').addEventListener('click', startGame);
    $('btn-home').addEventListener('click', function () { show('scr-home'); syncHome(); });
    $('btn-all-groups').addEventListener('click', function () {
      var on = !S.mix && S.groups.filter(function (g) { return S.sel[g.name]; }).length <= 1;
      S.mix = false;
      S.groups.forEach(function (g) { S.sel[g.name] = on; });
      syncHome();
    });
    $('zoom-in').addEventListener('click', function () { S.map.zoomBy(1.7); });
    $('zoom-out').addEventListener('click', function () { S.map.zoomBy(1 / 1.7); });
    $('zoom-reset').addEventListener('click', function () {
      if (S.revealed) S.map.fitPoints([S.guess, S.deck[S.idx]], true); else S.map.home(true);
    });
    $('foot-link').href = shareURL();

    var t; window.addEventListener('resize', function () {
      clearTimeout(t); t = setTimeout(function () { if (S.map) S.map.resize(); postHeight(); }, 140);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !$('scr-play').classList.contains('is-active')) return;
      if (!$('btn-next').hidden) { S.idx++; nextRound(); }
      else if (!$('btn-guess').disabled) submit();
    });
    boot();
  });
})();
