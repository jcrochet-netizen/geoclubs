# GeoClubs — Le GeoGuessr du football mondial

> Des cinq grands championnats à Rrogozhinë, Almaty et Guayaquil.

Un club s'affiche. Vous le placez sur une carte du monde. **Chaque kilomètre
d'écart vaut un point — et le meilleur score est le plus petit.**

Site statique, sans dépendance, sans build. Déclinaison de
[GeoConf](../GeoGuessr) (Conference League) avec une base bien plus large et une
carte mondiale.

---

## Ce qu'il y a dedans

- **318 clubs, 91 pays, six continents**, de Vancouver à Auckland.
- Six ensembles cumulables : Big 5 Europe (96 clubs), le reste de l'Europe (108),
  l'Asie & Océanie (36), l'Amérique du Sud (32), l'Afrique (25) et l'Amérique du
  Nord (21). Leur ordre à l'écran suit celui des sections de `tools/clubs.txt`,
  conservé dans `data/groups.json`.
- **Le pays n'est jamais affiché** — des indices permettent de l'acheter, à raison
  d'un par tranche de dix clubs, plafonné à dix : 10 clubs → 1 indice, 20 → 2,
  50 → 5, 100 → 10, tout le paquet → 10.
- Une case **« Mix de pays »** tire au hasard, mais **deux clubs au maximum par
  pays du Big 5**. Sans ce plafond, un tirage de 20 manches sort jusqu'à 5 clubs
  d'un même pays ; mesuré sur 120 tirages, le plafond n'est jamais dépassé.
  Le plafond ne s'affiche nulle part dans le jeu : c'est un réglage d'équilibrage,
  pas une information utile au joueur.
- Rien n'est coché au départ : au joueur de composer sa partie.
- Carte du monde **en Canvas**, zoom et déplacement à 60 images/seconde.
- 10, 20, 50, 100 ou tous les clubs, tirage **sans remise**.
- Score en kilomètres orthodromiques, récapitulatif, boutons de partage.

## Essayer en local

```bash
node tools/serve.mjs
```

Puis <http://localhost:8413>. Un vrai serveur HTTP est nécessaire : le jeu charge
ses données en `fetch`.

## La carte

Le fond est dessiné en **Canvas** et non en SVG. À l'échelle du monde il y a
~60 000 points, que le SVG ne retransforme pas à 60 images/seconde.

Trois choses rendent le rendu fluide :

1. la projection Web Mercator est appliquée **une fois** au chargement, le
   pan/zoom n'étant ensuite qu'un `setTransform` ;
2. **deux niveaux de détail** — `data/basemap.json` (grossier, 27 000 points,
   165 Ko gzip) pour la vue mondiale, `data/basemap-detail.json` (fin, 61 000
   points, 351 Ko gzip) chargé en arrière-plan et utilisé au-delà de 8× de zoom ;
3. au zoom, seuls les anneaux dont la boîte englobante croise la vue sont redessinés.

Mesuré en conditions réelles : **61 à 63 images/seconde** à tous les niveaux de
zoom, du monde entier au stade. `perf.html` rejoue la mesure.

Pour régénérer le fond (par exemple après avoir ajouté des clubs en Océanie) :

```bash
python3 tools/build-map.py --west -180 --east 180 --south -58 --north 84 --eps 0.05  --out data/basemap.json
python3 tools/build-map.py --west -180 --east 180 --south -58 --north 84 --eps 0.012 --out data/basemap-detail.json
```

Source : Natural Earth 1:50m via `world-atlas` (domaine public), mis en cache
dans `tools/.cache/`.

## Ajouter ou modifier des clubs

Tout part de `tools/clubs.txt`, puis :

```bash
node tools/build-clubs.mjs
```

Le script interroge Sportmonks et récupère d'un seul coup le club, son stade
géolocalisé, sa ville et son logo. Format du fichier :

```
## Amérique du Sud        une section : devient le « groupe », qui sert de filtre
@league 301               tous les clubs de cette ligue (saison en cours)
@league Eredivisie        idem, par nom de ligue
Celtic | Scotland         un club ; le pays fiabilise la recherche
Sporting Kansas City #323 identifiant Sportmonks imposé, quand la recherche se trompe
```

Le script affiche à la fin la commande `build-map.py` avec les marges calculées
sur vos clubs.

Options : `--dry-run` (cherche sans télécharger), `--no-logos`,
`--search="terme"` (voir ce que Sportmonks renvoie), `--terms` (hors ligne).

### La clé Sportmonks

Elle vient de `SPORTMONKS_TOKEN` ou d'un fichier `.env` à la racine, déjà exclu
par `.gitignore`. Elle ne quitte jamais votre machine : seules les images
partent sur GitHub. Toute sortie passe par un filtre de masquage, pour qu'une
erreur réseau ne puisse pas la recracher dans un fichier commité.

### Corriger les données

Les données de stade de Sportmonks comportent des erreurs. `tools/overrides.json`
corrige au cas par cas, par identifiant de club :

```json
{ "karpaty": { "city": "Lviv", "lat": 49.7986, "lon": 23.9989 } }
```

Champs acceptés : `lat`, `lon`, `city`, `name`, `venue`.

Pour un club **absent de Sportmonks** — Atlético Ottawa, Herrera FC, Fuerte San
Francisco et Dreams FC le sont — écrivez `!Nom du club` dans `tools/clubs.txt` et
définissez-le entièrement dans `overrides.json`, avec au minimum `cc`, `lat` et
`lon`. Ces quatre-là ont leurs coordonnées reprises de Wikidata, pas saisies de
mémoire ; le champ `source` le note.

Trois garde-fous tournent à chaque construction et signalent ce qui cloche :

- **cohérence géographique** — un club à plus de 2 500 km du centre de son pays
  est signalé (5 200 km pour les pays-continents, dont le centre est loin de
  tout). C'est ce qui a rattrapé Karpaty Lviv donné en Australie et l'América de
  Cali donné à São Paulo.
- **lecture des coordonnées** — Sportmonks mélange `45.583` et `"84.4000° W"`.
  Sans lire l'hémisphère, Seattle passe de −122° à +122°, soit la Chine.
- **écusson générique** — l'image grise que Sportmonks sert faute de vrai logo
  est détectée par empreinte et refusée.

Relisez toujours `tools/build-report.json` : chaque correspondance y porte son
niveau de confiance.

## Mise en ligne et intégration

Identiques à GeoConf : *Settings → Pages → Source : GitHub Actions*, puis une
`iframe` de 900 px de large maximum. Le jeu envoie sa hauteur au parent via
`postMessage` avec le type `geoclubs:height`. Voir [`embed.html`](embed.html).

| Paramètre | Effet | Exemple |
|---|---|---|
| `g` | Ensembles présélectionnés (`mix` pour le mix de pays) | `?g=afrique` |
| `n` | Nombre de clubs : `10`, `20`, `50`, `100`, `0` | `?n=20` |
| `share` | Force l'URL du texte de partage (facultatif : le jeu détecte la page hôte) | `?share=https://exemple.fr/jeu` |

## Structure

```
index.html                  le jeu
perf.html                   mesure des images par seconde
assets/map.js               moteur Canvas : projection, deux LOD, culling
assets/app.js               logique de jeu, indices, score, partage
assets/style.css            thème sombre
data/clubs.json             318 clubs
data/groups.json            l'ordre des ensembles à l'écran
data/basemap.json           fond grossier (vue mondiale)
data/basemap-detail.json    fond fin (zoom)
data/logos.json             id du club → chemin du logo
tools/clubs.txt             LA liste — tout part d'ici
tools/build-clubs.mjs       résolution Sportmonks + logos
tools/overrides.json        corrections manuelles
tools/build-map.py          génération du fond de carte
```

## Licence & crédits

Code : faites-en ce que vous voulez.
Fond de carte : Natural Earth (domaine public).
Données clubs et logos : Sportmonks — vérifiez les conditions de votre
abonnement avant publication.
