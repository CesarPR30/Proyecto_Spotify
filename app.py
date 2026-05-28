"""
app.py — Flask backend for the Spotify Multidimensional Visualization app.
DS5343 Visualización de Datos — Graded Activity (Week 8)

Responsibilities
----------------
1. Load the FULL Kaggle-schema dataset (~170k tracks) — no sampling.
2. Pre-compute the heavy dimensionality-reduction projections (PCA, UMAP) ONCE
   at startup and cache them. UMAP is fitted on a stratified 15k subsample and
   then transforms the remaining ~155k tracks (fitting UMAP on the full set is
   prohibitively slow; transform on the trained embedding is fast and
   topologically consistent).
3. Ship the per-track data to the browser in two payloads:
     - meta.json     : small JSON (features, decades, PCA loadings,
                       correlation, artist index, ranges)
     - records.bin   : packed binary (Float32 coords + Uint8 features +
                       Uint8 small ints + Uint16 year/tempo + Uint32 duration)
                       — ~40 bytes per track, ~7 MB total
     - records.json  : text fields (name + artist string) and detail fields
4. The browser renders all 170k points with canvas + d3.quadtree (SVG cannot
   handle that many DOM nodes).

All *rendering* is done client-side with D3 v7. The server is data prep +
projection math.
"""
import ast
import json
import os
import struct

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, send_file
import umap
from sklearn.decomposition import PCA
from sklearn.preprocessing import MinMaxScaler, StandardScaler

app = Flask(__name__)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
CSV_PATH = os.path.join(DATA_DIR, "data.csv")
META_CACHE = os.path.join(DATA_DIR, "meta.json")
BIN_CACHE = os.path.join(DATA_DIR, "records.bin")
TEXT_CACHE = os.path.join(DATA_DIR, "records.json")

# The audio features used across every multidimensional view.
FEATURES = [
    "danceability", "energy", "valence", "acousticness",
    "instrumentalness", "liveness", "speechiness", "loudness",
]
FEATURE_LABELS = {
    "danceability": "Danceability",
    "energy": "Energy",
    "valence": "Valence",
    "acousticness": "Acousticness",
    "instrumentalness": "Instrumentalness",
    "liveness": "Liveness",
    "speechiness": "Speechiness",
    "loudness": "Loudness",
}

# UMAP fitting on the full 170k set takes minutes. We fit on a stratified
# subsample of this size (representative across decades) then .transform()
# the remainder onto the trained embedding — much faster, same topology.
UMAP_FIT_N = 15000

# Per-record binary layout. Keep aligned, fixed-size for fast typed-array
# views on the browser side.
#   off  type     field
#    0   f32 ×4   pca_x, pca_y, umap_x, umap_y
#   16   u8  ×8   normalized features (0..255)
#   24   u8       popularity
#   25   u8       decade_idx (0=1920s, 10=2020s)
#   26   u8       collab (0/1)
#   27   u8       key (0..11)
#   28   u8       mode (0/1)
#   29   u8       explicit (0/1)
#   30   u16      year
#   32   u16      tempo × 10  (0..6553.5 BPM, ample headroom)
#   34   u16      _pad
#   36   u32      duration_ms
#   40   end
RECORD_BYTES = 40


def decade_of(year):
    return int(year // 10 * 10)


def load_data():
    if not os.path.exists(CSV_PATH):
        raise FileNotFoundError(
            f"No se encontro data: {CSV_PATH}. "
            "Coloca el archivo data.csv en la carpeta ./data/ antes de iniciar la app."
        )
    return pd.read_csv(CSV_PATH)


def _parse_artists(s):
    s = str(s)
    try:
        val = ast.literal_eval(s)
        if isinstance(val, (list, tuple)):
            return [str(a).strip() for a in val if str(a).strip()]
        return [str(val).strip()]
    except (ValueError, SyntaxError):
        cleaned = s.strip().strip("[]")
        parts = [p.strip().strip("'\"") for p in cleaned.split(",")]
        return [p for p in parts if p]


def _rebuild_text_cache(df):
    """Write only the text payload from an already-loaded dataframe."""
    from collections import defaultdict
    artist_to_idx = defaultdict(list)
    for i, lst in enumerate(df["artist_list"]):
        for a in lst:
            artist_to_idx[a].append(i)
    artist_index_full = [
        {"name": a, "count": len(idxs), "ids": idxs}
        for a, idxs in artist_to_idx.items()
    ]
    artist_to_ids = {d["name"]: d["ids"] for d in artist_index_full}
    text_payload = {
        "names": df["name"].astype(str).tolist(),
        "artists": df["artist_str"].tolist(),
        "release_dates": df["release_date"].astype(str).tolist(),
        "artist_to_ids": artist_to_ids,
    }
    with open(TEXT_CACHE, "w", encoding="utf-8") as f:
        json.dump(text_payload, f, ensure_ascii=False)


def build_payload():
    """Compute everything the front-end needs and cache to disk."""
    if (os.path.exists(META_CACHE)
            and os.path.exists(BIN_CACHE)
            and os.path.exists(TEXT_CACHE)):
        # Fast path: check if text cache has release_dates; if not, rebuild it
        # from the CSV without re-running the expensive UMAP computation.
        with open(TEXT_CACHE, encoding="utf-8") as f:
            tc = json.load(f)
        if "release_dates" not in tc:
            print("[build_payload] refreshing text cache with release_dates…")
            df = load_data()
            df = (df.sort_values("popularity", ascending=False)
                    .drop_duplicates(subset=["name", "artists"])
                    .reset_index(drop=True))
            df["artist_list"] = df["artists"].apply(_parse_artists)
            df["artist_str"] = df["artist_list"].apply(lambda lst: ", ".join(lst))
            _rebuild_text_cache(df)
        with open(META_CACHE, encoding="utf-8") as f:
            return json.load(f)

    print("[build_payload] loading CSV…")
    df = load_data()

    # Drop duplicates (same name+artists), keep highest popularity.
    df = (
        df.sort_values("popularity", ascending=False)
          .drop_duplicates(subset=["name", "artists"])
          .reset_index(drop=True)
    )

    print(f"[build_payload] parsing {len(df)} tracks…")
    df["artist_list"] = df["artists"].apply(_parse_artists)
    df["artist_str"] = df["artist_list"].apply(lambda lst: ", ".join(lst))
    df["is_collab"] = df["artist_list"].apply(lambda lst: len(lst) > 1)
    df["decade"] = df["year"].apply(decade_of)
    df = df.reset_index(drop=True)
    n = len(df)

    X = df[FEATURES].to_numpy(dtype=float)
    Xstd = StandardScaler().fit_transform(X)
    X01 = MinMaxScaler().fit_transform(X)

    # ---- PCA on the full set (fast) ----
    print("[build_payload] PCA…")
    pca = PCA(n_components=2, random_state=42)
    pca_xy = pca.fit_transform(Xstd)
    pca_var = (pca.explained_variance_ratio_ * 100).round(1).tolist()
    pca_loadings = pca.components_.T  # (n_features, 2)

    # ---- UMAP: fit on a stratified subsample, transform the rest ----
    print(f"[build_payload] UMAP fitting on {min(UMAP_FIT_N, n)} stratified samples…")
    if n > UMAP_FIT_N:
        frac = UMAP_FIT_N / n
        fit_idx = (
            df.groupby("decade", group_keys=False)
              .apply(lambda g: g.sample(frac=frac, random_state=42))
              .index.to_numpy()
        )
    else:
        fit_idx = np.arange(n)
    fit_mask = np.zeros(n, dtype=bool)
    fit_mask[fit_idx] = True

    reducer = umap.UMAP(
        n_components=2, n_neighbors=15, min_dist=0.1, random_state=42,
        low_memory=True,
    )
    umap_fit = reducer.fit_transform(Xstd[fit_mask])
    umap_xy = np.empty((n, 2), dtype=np.float32)
    umap_xy[fit_mask] = umap_fit
    rest_mask = ~fit_mask
    if rest_mask.any():
        print(f"[build_payload] UMAP transforming remaining {rest_mask.sum()}…")
        umap_xy[rest_mask] = reducer.transform(Xstd[rest_mask])

    def norm_xy(xy):
        xy = np.asarray(xy, dtype=np.float32)
        mn, mx = xy.min(0), xy.max(0)
        rng = np.where(mx - mn == 0, 1, mx - mn)
        return ((xy - mn) / rng).astype(np.float32)

    pca_n = norm_xy(pca_xy)
    umap_n = norm_xy(umap_xy)

    # ---- Correlation (on a sample if huge, ~identical to full) ----
    print("[build_payload] correlation matrix…")
    samp = X if n < 50000 else X[np.random.RandomState(0).choice(n, 50000, replace=False)]
    corr = np.corrcoef(samp, rowvar=False).round(3)

    # ---- Artist index ----
    print("[build_payload] artist index…")
    from collections import defaultdict
    artist_to_idx = defaultdict(list)
    for i, lst in enumerate(df["artist_list"]):
        for a in lst:
            artist_to_idx[a].append(i)
    # Sorted by count desc, name asc; cap the dropdown payload to top 5000.
    artist_index_full = [
        {"name": a, "count": len(idxs), "ids": idxs}
        for a, idxs in artist_to_idx.items()
    ]
    artist_index_full.sort(key=lambda d: (-d["count"], d["name"]))
    artist_index_dropdown = [
        {"name": d["name"], "count": d["count"]} for d in artist_index_full[:5000]
    ]
    # All artist -> indices (full map, for instant mask building on the client)
    artist_to_ids = {d["name"]: d["ids"] for d in artist_index_full}

    # ---- Pack binary records ----
    print(f"[build_payload] packing {n} records to binary ({n*RECORD_BYTES/1e6:.1f} MB)…")
    decades_sorted = sorted(df["decade"].unique().tolist())
    dec_to_idx = {d: i for i, d in enumerate(decades_sorted)}

    pop = df["popularity"].astype(int).clip(0, 100).to_numpy(dtype=np.uint8)
    dec_idx_arr = df["decade"].map(dec_to_idx).astype(np.uint8).to_numpy()
    collab = df["is_collab"].astype(np.uint8).to_numpy()
    key_arr = df["key"].astype(int).clip(0, 11).to_numpy(dtype=np.uint8)
    mode_arr = df["mode"].astype(int).clip(0, 1).to_numpy(dtype=np.uint8)
    expl_arr = df["explicit"].astype(int).clip(0, 1).to_numpy(dtype=np.uint8)
    year_arr = df["year"].astype(int).clip(0, 65535).to_numpy(dtype=np.uint16)
    tempo_arr = (df["tempo"].astype(float).clip(0, 6553.5) * 10).astype(np.uint16).to_numpy()
    dur_arr = df["duration_ms"].astype(int).clip(0, 2**32 - 1).to_numpy(dtype=np.uint32)
    feats_q = np.clip(X01 * 255 + 0.5, 0, 255).astype(np.uint8)

    buf = bytearray(n * RECORD_BYTES)
    # Use numpy structured writes for speed.
    arr = np.frombuffer(buf, dtype=np.uint8).reshape(n, RECORD_BYTES)
    # f32 ×4 → bytes 0..16
    coords = np.empty((n, 4), dtype=np.float32)
    coords[:, 0] = pca_n[:, 0]
    coords[:, 1] = pca_n[:, 1]
    coords[:, 2] = umap_n[:, 0]
    coords[:, 3] = umap_n[:, 1]
    arr[:, 0:16] = coords.view(np.uint8).reshape(n, 16)
    # u8 ×8 features → bytes 16..24
    arr[:, 16:24] = feats_q
    # u8 scalars
    arr[:, 24] = pop
    arr[:, 25] = dec_idx_arr
    arr[:, 26] = collab
    arr[:, 27] = key_arr
    arr[:, 28] = mode_arr
    arr[:, 29] = expl_arr
    # u16 year (30..32) and tempo*10 (32..34)
    arr[:, 30:32] = year_arr.view(np.uint8).reshape(n, 2)
    arr[:, 32:34] = tempo_arr.view(np.uint8).reshape(n, 2)
    # u32 duration_ms (36..40)
    arr[:, 36:40] = dur_arr.view(np.uint8).reshape(n, 4)

    with open(BIN_CACHE, "wb") as f:
        f.write(bytes(buf))

    # ---- Text payload (names + artists + release_dates + full artist index) ----
    print("[build_payload] writing text payload…")
    text_payload = {
        "names": df["name"].astype(str).tolist(),
        "artists": df["artist_str"].tolist(),
        "release_dates": df["release_date"].astype(str).tolist(),
        "artist_to_ids": artist_to_ids,
    }
    with open(TEXT_CACHE, "w", encoding="utf-8") as f:
        json.dump(text_payload, f, ensure_ascii=False)

    # ---- Meta (small) ----
    meta = {
        "features": FEATURES,
        "feature_labels": FEATURE_LABELS,
        "pca_variance": pca_var,
        "pca_loadings": [[float(pca_loadings[k, 0]), float(pca_loadings[k, 1])]
                         for k in range(len(FEATURES))],
        "correlation": corr.tolist(),
        "decades": decades_sorted,
        "n": int(n),
        "n_collabs": int(df["is_collab"].sum()),
        "artists": artist_index_dropdown,
        "n_artists_total": len(artist_index_full),
        "ranges": {f: [float(df[f].min()), float(df[f].max())] for f in FEATURES},
        "record_bytes": RECORD_BYTES,
    }
    with open(META_CACHE, "w", encoding="utf-8") as f:
        json.dump(meta, f)
    print(f"[build_payload] done. n={n}, bin={n*RECORD_BYTES/1e6:.1f} MB")
    return meta


# Build once at import (so the first request is instant after caching).
try:
    META = build_payload()
except FileNotFoundError as e:
    import sys
    print(f"[error] {e}")
    sys.exit(1)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meta")
def api_meta():
    return jsonify(META)


@app.route("/api/records.bin")
def api_records_bin():
    return send_file(BIN_CACHE, mimetype="application/octet-stream")


@app.route("/api/records.json")
def api_records_text():
    return send_file(TEXT_CACHE, mimetype="application/json")


if __name__ == "__main__":
    print(f"Loaded {META['n']} tracks. PCA variance: {META['pca_variance']}")
    app.run(debug=False, host="0.0.0.0", port=5000)
