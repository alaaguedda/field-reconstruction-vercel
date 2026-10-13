"""
Field Reconstruction Lab — API server (Vercel serverless function build).

Loads the deployment_bundle/ produced by Stage 9 of the research notebook (real, selected,
early-stopped trained models for Kriging, tensor completion, and the physics-informed neural
network — for both moisture (VW) and temperature (T)) and serves live reconstructions over HTTP.

Deliberately dependency-light: the PINN is served with a hand-written numpy forward pass (not
torch) and the scaler is two plain arrays (not a scikit-learn/joblib object), because this process
only ever needs to *evaluate* an already-trained network, never train one — training happens once,
in the Colab notebook. That keeps the whole backend to fastapi + numpy + scipy + pykrige, which
fits comfortably inside Vercel's serverless function size/runtime limits (no torch wheel, no
sklearn).

Deployment layout (Vercel):
    /vercel.json        -> routes /api/* to this file, everything else to /public
    /requirements.txt   -> installed automatically for this function
    /deployment_bundle/ -> your Stage 9 export, included via vercel.json's includeFiles
    /public/            -> the static frontend (index.html, app.js), served directly by Vercel

Run locally (from the project root):
    pip install -r requirements.txt
    uvicorn api.index:app --reload --port 8000
    # then serve /public separately, e.g. `python -m http.server 5500` in that folder
"""
import json
import os
from datetime import date as date_cls
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pykrige.ok import OrdinaryKriging
from scipy.spatial.distance import cdist

# This file lives at <project root>/api/index.py, so the bundle sits one directory up.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE_DIR = os.environ.get("BUNDLE_DIR", os.path.join(PROJECT_ROOT, "deployment_bundle"))
VARIABLES = ["VW", "T"]
GRID_N_DEFAULT = 45


# ---------------------------------------------------------------------------
# PINN forward pass — plain numpy, matches the notebook's ReconstructionMLP
# (3x Linear(hidden)+Tanh, final Linear(1)) exactly; verified bit-for-bit
# against the torch model before export.
# ---------------------------------------------------------------------------
def mlp_forward(X, w):
    h = np.tanh(X @ w["W0"].T + w["b0"])
    h = np.tanh(h @ w["W2"].T + w["b2"])
    h = np.tanh(h @ w["W4"].T + w["b4"])
    return (h @ w["W6"].T + w["b6"]).ravel()


# ---------------------------------------------------------------------------
# Loading the deployment bundle
# ---------------------------------------------------------------------------
SYSTEM = {"loaded": False, "error": None}


def load_system():
    try:
        with open(os.path.join(BUNDLE_DIR, "metadata.json")) as f:
            metadata = json.load(f)

        per_variable = {}
        for var in VARIABLES:
            # Kriging: frozen variogram parameters per depth
            with open(os.path.join(BUNDLE_DIR, f"kriging_params_{var}.json")) as f:
                kriging_params = json.load(f)

            # Tensor completion factors
            tz = np.load(os.path.join(BUNDLE_DIR, f"tensor_factors_{var}.npz"), allow_pickle=True)
            tensor = {
                "A": tz["A"], "B": tz["B"], "C": tz["C"],
                "locations": list(tz["locations"]), "depths": [int(d) for d in tz["depths"]],
                "dates": np.array([np.datetime64(d) for d in tz["dates"]]),
            }

            # PINN: plain numpy weights + config (no torch/joblib needed to load or run)
            with open(os.path.join(BUNDLE_DIR, f"pinn_{var}_config.json")) as f:
                pinn_config = json.load(f)
            wz = np.load(os.path.join(BUNDLE_DIR, f"pinn_{var}_weights.npz"))
            pinn_weights = {k: wz[k] for k in ["W0", "b0", "W2", "b2", "W4", "b4", "W6", "b6"]}
            scaler_mean = np.array(pinn_config["scaler_mean"])
            scaler_scale = np.array(pinn_config["scaler_scale"])

            per_variable[var] = {
                "kriging_params": kriging_params,
                "tensor": tensor,
                "pinn_weights": pinn_weights,
                "scaler_mean": scaler_mean,
                "scaler_scale": scaler_scale,
                "pinn_config": pinn_config,
            }

        sensor_coords = {}
        coords_path = os.path.join(BUNDLE_DIR, "sensor_coords.csv")
        if os.path.exists(coords_path):
            import csv
            with open(coords_path) as f:
                for row in csv.DictReader(f):
                    sensor_coords[row["Location"]] = (float(row["x"]), float(row["y"]))

        SYSTEM.update({
            "loaded": True, "error": None,
            "metadata": metadata, "per_variable": per_variable, "sensor_coords": sensor_coords,
        })
    except Exception as e:
        SYSTEM.update({"loaded": False, "error": str(e)})


load_system()


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------
WEAK_STRUCTURE_SHARE = 0.05   # partial-sill / sill below this = "no spatial correlation detected"


def sanitize_variogram(params):
    """Return (nugget, sill, range, structure) with a *valid* variogram: sill >= nugget.

    PyKrige turns the parameters into a partial sill = sill - nugget. If a fit ever stored a nugget
    larger than its sill (an unconstrained curve fit can), that partial sill is negative, the
    variogram FALLS with distance, and kriging weights far-away sensors above near ones — the
    reconstructed field then looks inverted around every sensor. A variogram that is flat (no
    spatial structure in the training data) is the honest valid reading of such a fit, so we clamp
    to it and report structure="none" so the UI can say so.
    """
    nugget = max(0.0, float(params["nugget"]))
    sill = float(params["sill"])
    rng = max(float(params["range"]), 1e-6)
    total = max(sill, nugget, 1e-12)
    psill = max(sill - nugget, 0.0)
    structure = "none" if psill / total < WEAK_STRUCTURE_SHARE else "ok"
    psill = max(psill, 1e-9 * total)      # keep the kriging system well-posed
    return nugget, nugget + psill, rng, structure


def kriging_grid(var, depth, sensors, gx, gy):
    """Returns (grid, structure) — structure is "none" when the frozen variogram for this depth
    shows no usable spatial correlation, otherwise "ok"."""
    params = SYSTEM["per_variable"][var]["kriging_params"].get(str(depth))
    if not sensors:
        raise HTTPException(400, "Kriging needs at least one sensor.")
    xs = np.array([s["x"] for s in sensors])
    ys = np.array([s["y"] for s in sensors])
    vals = np.array([s["value"] for s in sensors])

    if len(sensors) == 1:
        return np.full((len(gy), len(gx)), vals[0]), "ok"

    structure = "ok"
    kwargs = dict(variogram_model="spherical", verbose=False, enable_plotting=False)
    if params and params.get("nugget") is not None and len(sensors) >= 3:
        nugget, sill, rng, structure = sanitize_variogram(params)
        kwargs["variogram_model"] = params["model"]
        kwargs["variogram_parameters"] = {"nugget": nugget, "sill": sill, "range": rng}
    try:
        ok = OrdinaryKriging(xs, ys, vals, **kwargs)
        grid, _ = ok.execute("grid", gx, gy)
        return np.asarray(grid), structure
    except Exception:
        # fall back to a simple IDW if Kriging's linear system is degenerate (e.g. collinear points)
        GX, GY = np.meshgrid(gx, gy)
        flat = np.stack([GX.ravel(), GY.ravel()], axis=1)
        d = cdist(flat, np.stack([xs, ys], axis=1))
        d = np.maximum(d, 1e-6)
        w = 1.0 / d ** 2
        pred = (w @ vals) / w.sum(axis=1)
        return pred.reshape(GX.shape), structure


def interpolate_location_factors(xy_query, coords_known, A, k=6, power=2):
    """IDW interpolation of the tensor's location-factor rows onto arbitrary new coordinates —
    a documented out-of-sample approximation (see Stage 9.3's markdown note)."""
    d = cdist(xy_query, coords_known)
    d = np.maximum(d, 1e-6)
    k = min(k, coords_known.shape[0])
    idx = np.argsort(d, axis=1)[:, :k]
    dk = np.take_along_axis(d, idx, axis=1)
    w = 1.0 / dk ** power
    w /= w.sum(axis=1, keepdims=True)
    # weighted sum of A rows: (n_query, k, rank) * (n_query, k, 1) -> (n_query, rank)
    A_rows = A[idx]  # (n_query, k, rank)
    return np.einsum("nkr,nk->nr", A_rows, w)


def interpolate_time_factor(query_date, known_dates, C):
    qd = np.datetime64(query_date)
    if qd <= known_dates[0]:
        return C[0]
    if qd >= known_dates[-1]:
        return C[-1]
    idx = np.searchsorted(known_dates, qd)
    d0, d1 = known_dates[idx - 1], known_dates[idx]
    span = (d1 - d0) / np.timedelta64(1, "D")
    t = (qd - d0) / np.timedelta64(1, "D") / span if span > 0 else 0.0
    return C[idx - 1] * (1 - t) + C[idx] * t


def tensor_grid(var, depth, query_date, gx, gy):
    tensor = SYSTEM["per_variable"][var]["tensor"]
    if depth not in tensor["depths"]:
        raise HTTPException(400, f"Depth {depth} not in trained depths {tensor['depths']}.")
    depth_idx = tensor["depths"].index(depth)
    coords_known = np.array([SYSTEM["sensor_coords"][loc] for loc in tensor["locations"]])

    GX, GY = np.meshgrid(gx, gy)
    flat = np.stack([GX.ravel(), GY.ravel()], axis=1)
    Aq = interpolate_location_factors(flat, coords_known, tensor["A"])
    Ct = interpolate_time_factor(query_date, tensor["dates"], tensor["C"])
    Bd = tensor["B"][depth_idx]
    pred = Aq @ (Bd * Ct)
    return pred.reshape(GX.shape)


def pinn_grid(var, depth, query_date, gx, gy):
    pv = SYSTEM["per_variable"][var]
    config = pv["pinn_config"]
    t0 = date_cls.fromisoformat(config["t0"])
    if isinstance(query_date, str):
        query_date = date_cls.fromisoformat(query_date)
    t_days = (query_date - t0).days

    GX, GY = np.meshgrid(gx, gy)
    flat_x, flat_y = GX.ravel(), GY.ravel()
    X = np.stack([flat_x, flat_y, np.full_like(flat_x, float(depth)), np.full_like(flat_x, float(t_days))], axis=1)
    Xs = (X - pv["scaler_mean"]) / pv["scaler_scale"]
    pred = mlp_forward(Xs, pv["pinn_weights"])
    return pred.reshape(GX.shape)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
app = FastAPI(title="Field Reconstruction Lab API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class Sensor(BaseModel):
    x: float
    y: float
    value: float


class ReconstructRequest(BaseModel):
    variable: str          # "VW" or "T"
    method: str            # "kriging" | "tensor" | "pinn"
    depth: int
    date: str              # "YYYY-MM-DD"
    sensors: Optional[List[Sensor]] = None
    grid_n: int = GRID_N_DEFAULT


@app.get("/api/health")
def health():
    return {"loaded": SYSTEM["loaded"], "error": SYSTEM["error"]}


@app.get("/api/meta")
def meta():
    if not SYSTEM["loaded"]:
        raise HTTPException(503, f"Models not loaded: {SYSTEM['error']}")
    m = SYSTEM["metadata"]
    return {
        **m,
        "sensor_coords": SYSTEM["sensor_coords"],
    }


@app.post("/api/reconstruct")
def reconstruct(req: ReconstructRequest):
    if not SYSTEM["loaded"]:
        raise HTTPException(503, f"Models not loaded: {SYSTEM['error']}")
    if req.variable not in VARIABLES:
        raise HTTPException(400, f"variable must be one of {VARIABLES}")

    extent = SYSTEM["metadata"]["field_extent_m"]
    gx = np.linspace(extent["x_min"], extent["x_max"], req.grid_n)
    gy = np.linspace(extent["y_min"], extent["y_max"], req.grid_n)

    structure = "ok"
    if req.method == "kriging":
        sensors = [s.dict() for s in (req.sensors or [])]
        grid, structure = kriging_grid(req.variable, req.depth, sensors, gx, gy)
    elif req.method == "tensor":
        grid = tensor_grid(req.variable, req.depth, req.date, gx, gy)
    elif req.method == "pinn":
        grid = pinn_grid(req.variable, req.depth, req.date, gx, gy)
    else:
        raise HTTPException(400, "method must be 'kriging', 'tensor', or 'pinn'")

    grid = np.nan_to_num(grid, nan=float(np.nanmean(grid)) if np.isfinite(np.nanmean(grid)) else 0.0)
    return {
        "grid": grid.tolist(),
        "x": gx.tolist(),
        "y": gy.tolist(),
        "min": float(grid.min()),
        "max": float(grid.max()),
        "spatial_structure": structure,   # "none" = kriging's frozen variogram for this depth is flat
    }


# Local dev only: if you run `uvicorn api.index:app` and keep a copy of the frontend at
# ../public, this lets http://localhost:8000/ also show the page. In production on Vercel,
# vercel.json routes everything except /api/* straight to /public and this function is never
# invoked for those paths, so it's harmless to leave in.
try:
    from fastapi.staticfiles import StaticFiles
    _PUBLIC_DIR = os.path.join(PROJECT_ROOT, "public")
    if os.path.isdir(_PUBLIC_DIR):
        app.mount("/", StaticFiles(directory=_PUBLIC_DIR, html=True), name="static")
except Exception:
    pass
