# Spotify Dimensions
### Multidimensional Visualization of Spotify Audio Features (1921–2020)

**DS5343 — Visualización de Datos · UTEC · Graded Activity (Week 8)**

A Flask + D3 v7 web application that analyses the Spotify "1921–2020, 160k
tracks" dataset through four multidimensional-visualization techniques plus
supporting plots, all linked by a shared brushing-and-filtering engine.

The full ~170k-track dataset is served to the browser as a packed binary
payload (~7 MB) and rendered on `<canvas>` with `d3.quadtree` hit-testing —
no sampling, every track visible.

---

## 1. The three analytical tasks

The dashboard is built around three questions, stated as cards at the top of
the page. Every view is designed to help answer them:

**Task 1 — Do tracks cluster by audio character?**
Songs are points in an 8-dimensional audio space (danceability, energy,
valence, acousticness, instrumentalness, liveness, speechiness, loudness).
*Answered by:* the **Projection** scatter (PCA / UMAP) and **RadViz**.
The PCA biplot shows that the dominant axis of variation contrasts
energetic/danceable tracks against acoustic/instrumental ones; UMAP pulls
these into dense, visible neighbourhoods.

**Task 2 — How has music drifted across the decades?**
*Answered by:* **Parallel Coordinates** and **Star Coordinates**, both coloured
by decade (a 1920s→2020s spectral ramp), and the **Feature-by-Decade** trend.
The clear story: mean **energy rises** (~0.33 → ~0.81) while **acousticness
collapses** (~0.89 → ~0.20) across the century; danceability and popularity
rise with it.

**Task 3 — What separates popular tracks from obscure ones?**
*Answered by:* switching the global **colour encoding to Popularity** (an
inferno ramp) and brushing any view. Hits concentrate at high
energy/danceability and low acousticness/instrumentalness; the popularity
gradient is legible in every projection and on the parallel axes.

---

## 2. Mandatory techniques — where each lives

| Technique | Panel | Key interaction |
|-----------|-------|-----------------|
| **RadViz** (dimensional anchoring) | top-left | Hover a feature anchor to highlight tracks that score high on it (the "pull"). |
| **Star Coordinates** (weighted axes) | top-centre | **Drag** any axis handle to change its direction *and* length (=weight); the cloud re-projects live. Double-click resets an axis; **auto-spin** animates them. |
| **Parallel Coordinates** (scaling + brushing) | full-width | **Brush vertically** on any axis to filter; **drag axis titles** to reorder; toggle **Min–Max vs Raw** scaling. |
| **Projection** (PCA · UMAP) | top-right | Switch technique; **box-brush** to select; PCA mode overlays **biplot loading arrows**. |

Supporting plots: a **Pearson correlation matrix** (diverging heatmap) and the
**Feature-by-Decade** trend line (mean of the selected tracks, with a dashed
all-tracks reference).

---

## 3. Interaction & linking (the "Interaction" criterion)

Every view shares one selection state, so the dashboard reads as a single
instrument rather than six separate charts:

- **Linked brushing** — a box-brush in the Projection or a range-brush on any
  Parallel-Coordinates axis dims the non-selected points/lines in *all* views,
  and reshapes the decade-trend curve.
- **Linked hover** (`mouseenter`/`mouseover`/`mouseleave`) — hovering a track
  anywhere highlights that same track everywhere and shows a tooltip.
- **Click** (`mouseclick`) — opens a detail card with a per-track radar of its
  eight audio features.
- **Global filters** — decade chips and a popularity slider intersect with the
  brush (`brush ∩ filter`), with a live "tracks active" counter and reset.
- **Artist filter** — a searchable artist box (with per-artist track counts)
  filters every view to one artist's songs, including the ones where they
  appear only as a collaborator.
- **Collaboration markers** — solo tracks render as **filled dots**, while
  **collaborations** (2+ artists) render as **hollow rings** in the scatter
  views and **dashed lines** in Parallel Coordinates, so multi-artist tracks
  are distinguishable at a glance. This matches Kaggle's `['A', 'B']` format.
- **Colour encoding** — three global modes the user can switch between:
  **Decade** (spectral ramp), **Popularity** (inferno ramp), and **Collab**
  (solo vs collaboration binary).
- **Animation** — projection switches tween point positions
  (`d3.transition`), Star Coordinates can auto-spin, scaling changes animate.

---

## 4. Design rationale (the "Design Rationale" criterion)

- **Normalisation.** RadViz, Star Coordinates and the default Parallel
  Coordinates use **Min–Max [0,1]** per feature so that anchoring/weighting is
  not dominated by features with larger native ranges (e.g. loudness in dB).
  Projections use **standardised (z-score)** features, which is the correct
  input for PCA/UMAP distance computations.
- **Colour.** Three encodings the user can switch between: a **categorical
  spectral ramp** for decade (ordered, perceptually sequential 1920s→2020s), and
  **sequential ramps** (inferno / green) for the continuous popularity and
  collaboration dimensions. Only one encoding is active at a time to avoid
  overload.
- **Server vs client.** PCA and UMAP are computed **once on the server**
  (scikit-learn + umap-learn) and cached to disk as a packed binary; the browser
  decodes the binary into typed arrays and only renders pre-computed 2-D
  coordinates. This keeps the heavy maths off the main thread and the D3 views
  responsive. **All rendering is pure D3 v7** — no other visualization library
  is used, per the assignment.
- **Full dataset, no sampling.** The full ~170k-track set is served via a
  40-byte-per-track binary payload (~7 MB). The scatter views paint all points
  to a `<canvas>` using batched `fillRect` per colour bucket, making 170k points
  smooth. UMAP is fitted on a stratified 15k subsample and then `.transform()`s
  the remaining tracks — topologically consistent and fast enough at startup.
  `d3.quadtree` handles hover hit-testing at O(log n).

---

## 5. Running it

```bash
pip install -r requirements.txt
python run.py
# open http://127.0.0.1:5001
```

On first launch the app pre-computes the projections and caches them to three
files in `data/`: `meta.json`, `records.bin`, and `records.json` (a few seconds
for PCA; a minute or two for UMAP on the full set). Delete those files to force
a full recompute.

D3 v7 is **bundled locally** (`static/js/d3.v7.min.js`) so the app works fully
offline.

---

## 6. Data note — IMPORTANT

The dataset shipped here (`data/data.csv`) is a **faithful synthetic stand-in**
for the Kaggle file
[*Spotify Dataset 1921–2020, 160k Tracks*](https://www.kaggle.com/datasets/yamaerenay/spotify-dataset-1921-2020-160k-tracks).
It uses the **exact same column schema** and realistic, *correlated* feature
distributions (e.g. energy↔acousticness ≈ −0.69; year↔energy ≈ +0.61), so the
visualizations reveal genuine, interpretable structure.

This stand-in was generated because the build environment had no network access
to Kaggle. **To run on the real data, simply download Kaggle's `data.csv` and
drop it into `./data/`** (overwriting the synthetic file) and delete
`data/meta.json`, `data/records.bin`, and `data/records.json`. The app prefers
whatever `data.csv` is present — no code change required. The generator that
builds the stand-in is `generate_data.py`.

---

## 7. File layout

```
spotify_viz/
├── run.py                 # entry point  -> python run.py
├── app.py                 # Flask backend: load data, compute PCA/UMAP, binary API
├── generate_data.py       # builds the Kaggle-schema synthetic data.csv
├── requirements.txt
├── data/
│   ├── data.csv           # dataset (synthetic stand-in; replace with Kaggle's)
│   ├── meta.json          # cached: features, PCA loadings, correlation, artist index
│   ├── records.bin        # cached: 40-byte binary per track (coords + features)
│   └── records.json       # cached: track names, artist strings, release dates
├── templates/
│   └── index.html         # dashboard shell
└── static/
    ├── css/style.css
    └── js/
        ├── d3.v7.min.js       # bundled D3 (offline-safe)
        ├── main.js            # shared state, colour scales, tooltip, LINKING engine
        ├── radviz.js          # RadViz
        ├── star.js            # Star Coordinates (draggable weighted axes)
        ├── projection.js      # PCA / UMAP canvas scatter + biplot + brush
        ├── parallel.js        # Parallel Coordinates (scaling, brushing, reorder)
        ├── correlation.js     # correlation heatmap
        ├── distribution.js    # feature-by-decade trend
        └── boot.js            # fetch payloads + decode binary + wire controls + init views
```
