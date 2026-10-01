# Field Reconstruction Lab — Vercel deployment guide

Same app as before (FastAPI backend loading the Stage 9 trained models + static frontend),
restructured for Vercel instead of Render:

```
api/index.py          <- the FastAPI app (was app.py)
public/index.html     <- the frontend (was static/index.html)
public/app.js         <- the frontend (was static/app.js)
deployment_bundle/    <- your Stage 9 export (put your real files here)
requirements.txt      <- trimmed Python deps (no uvicorn needed — Vercel runs the ASGI app itself)
vercel.json           <- routes /api/* to the function, everything else to /public
```

Vercel's Hobby (free) plan needs no credit card and comfortably fits this app (60s function
timeout vs. our sub-second reconstructions), as long as the project stays personal/non-commercial
— which a candidacy demo is.

## 1. Fill in the real model files

Run `full_project.ipynb` in Colab if you haven't already — Stage 9 writes `deployment_bundle.zip`.
Unzip it and copy its contents into this project's `deployment_bundle/` folder, replacing the
placeholder, so you have:

```
deployment_bundle/
  metadata.json
  kriging_params_VW.json   kriging_params_T.json
  tensor_factors_VW.npz    tensor_factors_T.npz
  pinn_VW_weights.npz      pinn_VW_config.json
  pinn_T_weights.npz       pinn_T_config.json
  sensor_coords.csv
```

## 2. Push this folder to a fresh GitHub repo

A brand-new repo avoids carrying over any of the stuck Render-era history:

```bash
cd field_reconstruction_lab_vercel   # this folder
git init
git add .
git commit -m "Field Reconstruction Lab (Vercel)"
git branch -M main
git remote add origin https://github.com/<your-username>/field-reconstruction-vercel.git
git push -u origin main
```

(No git experience needed either — GitHub's website lets you create a repo and drag-and-drop
upload every file and folder through the browser, `deployment_bundle/` included.)

## 3. Create the Vercel project

1. Go to <https://vercel.com/signup> and sign up free with your GitHub account (no credit card).
2. **Add New...** → **Project** → **Import** the repo you just pushed.
3. Vercel will show a configuration screen:
   - **Framework Preset:** choose **Other** (this isn't Next.js/React — it's a plain
     static+API project described entirely by `vercel.json`).
   - Leave **Build Command**, **Output Directory**, and **Install Command** on their defaults —
     `vercel.json` already tells Vercel exactly how to build `api/index.py` and where the
     static files are, so nothing else needs typing in.
   - No environment variables are required.
4. Click **Deploy**. The first deploy takes 1-3 minutes (installing `requirements.txt` into the
   Python function).

## 4. Verify it

- Open `https://<your-project-name>.vercel.app/api/health` — should show
  `{"loaded": true, "error": null}`. If `loaded` is `false`, `error` names the missing file —
  double check `deployment_bundle/` actually made it into the GitHub repo (open the repo on
  GitHub and look for the folder).
- Open the project's main URL — the Field Reconstruction Lab page should load with a green
  **API LIVE** badge. Click the field to add a sensor; the moisture surface should redraw within
  a second or two.

## Notes

- **No cold-start spin-down wait like Render.** Vercel's serverless functions do cold-start on
  the first request after idling, but it's typically under a second or two for a function this
  size — there's no 30-60s wake-up like Render's free tier.
- **Kriging** sensors are fully live — add, edit, or clear them and the field recomputes from
  your exact points using the frozen, cross-validated variogram per depth.
- **Tensor** and **PINN** reconstruct the real trained field by querying the model at a
  depth/date you choose; they show the historical sensor network for reference but don't react
  to new sensors (see the in-page "How this demo works" panel for why).
- **To update the models later:** re-run Stage 9 in Colab, replace the files in
  `deployment_bundle/` in your GitHub repo, and push to `main` — Vercel redeploys automatically
  on every push, same as Render did.
- **If a deploy ever fails on "Framework Preset" auto-detection:** go to Project Settings →
  General → Framework Preset and force it to **Other**, then redeploy. `vercel.json`'s
  `builds`/`routes` block is the explicit, documented way to describe a Python-function +
  static-site project and takes priority over auto-detection once set correctly.
- The old `Dockerfile` and Render-specific files aren't included here since Vercel doesn't use
  either — if you ever want to go back to a container-based host, the previous `hf_space/`
  bundle still has them.
