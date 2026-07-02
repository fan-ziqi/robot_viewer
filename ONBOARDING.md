# Robot Viewer — Contributor Onboarding

RobCo's fork of [robot_viewer](https://github.com/fan-ziqi/robot_viewer): a web-based 3D
viewer/editor/simulator for robot models (URDF, Xacro, MJCF, USD), with RobCo-specific
live-connection and rendering features layered on top. Pure client-side Vite + Three.js —
no backend.

## Live environments

| Branch | What | URL |
|---|---|---|
| `main` | Production | https://orrerium.web.app |
| `develop` | Shared dev preview | https://orrerium--develop-l94bjumj.web.app |

Both deploy automatically via GitHub Actions on every push (Firebase Hosting). You don't
run any deploy commands — pushing is the deploy.

## Prerequisites

- **Node 24** (CI builds on 24; 20+ works locally)
- **pnpm 9** — run `corepack enable pnpm` once; the repo pins `pnpm@9.0.0`
- **git** + a GitHub account with access to this repo (ask Florian for an invite)
- **Claude Code** (recommended) — for building features; see "Working with Claude Code" below

## Get the code running

```bash
git clone https://github.com/zorian-f/robot_viewer.git
cd robot_viewer
corepack enable pnpm
pnpm install
pnpm dev            # serves http://localhost:3000 and opens a browser
```

```bash
pnpm build          # production build -> dist/
pnpm preview        # serve the built dist/ locally
```

The dev server sets `COOP`/`COEP` headers (required for the USD WebAssembly viewer's
`SharedArrayBuffer`); production hosting mirrors this.

## Running the RobCo features locally

The RobCo tools (teach pendant, IK pose finder, dynamics dashboard + per-joint graphs,
waypoints, TCP trace, robot-config picker, camera view) only load when you ask for them via a
`?robco=` query param — `http://localhost:3000/?robco=…`. With no param you get the plain
upstream viewer. The loader is [src/robco/devLoad.js](src/robco/devLoad.js).

| URL | What it does |
|---|---|
| `?robco=live` | Build a **full 6-DOF demo arm** statically from the public module CDN (`robco.studio/modules`), posed to a lifelike angle. Online, read-only — no session needed. **Use this to exercise the whole tool stack.** |
| `?robco=fixtures` | Build **fully offline** from `public/robco-fixtures/` — no network. Only two modules are bundled (`0001_D86`, `0005_I86-150`), so it loads a single module by default; useful for adapter/loader work, not a full arm. |
| `?robco=fixtures&ids=0001,0005` | Offline chain from the bundled fixtures (4-digit ids). |
| `?robco=<base_url>&ids=…` | Static build from any geometry base URL + id chain. |
| `?robco=session&sid=<SID>` | **Live**: connect the WebSocket, build from the session's `robotModuleIds`, mirror joint angles in real time. Needs a valid session (see the Connect dialog / session clipper). |
| `?robco=local&host=<ip>&port=8000` | **Live** against a robot on your LAN. |
| `?robco=connect` | Open the connect dialog and pick a session interactively. |

Extras: with **no** `?robco=` param the app auto-restores your last saved workspace / live
session; append `?chrome=1` to keep the original upstream viewer UI (top bar, side panels,
code editor) alongside the RobCo panels for debugging.

Applying a robot config *to* a connected RobCo Studio session goes through
`POST https://api.robco.studio/public/virtual-robot/configure` with a Cognito **ID** token
(account-level — not the session/editor token); see [src/robco/liveConnect.js](src/robco/liveConnect.js).

## Repository layout

```
src/
  loaders/      URDF / Xacro / MJCF / USD / glTF / STL / OBJ / Collada loaders
  renderer/     Three.js scene, environment/IBL, MuJoCo simulation
  adapters/     format adapters (e.g. MJCFAdapter)
  controllers/  interaction / camera / joint controllers
  dynamics/     kinematics & dynamics
  models/       in-memory model/state
  editor/       CodeMirror code editor
  ui/ views/    panels and layout
  robco/        RobCo integration: connect, render settings, teach pendant, waypoints
  transport/    live WebSocket session/auth to RobCo robots
  utils/
public/         served verbatim: USD WASM viewer, robco-fixtures, favicon
scripts/        validation helpers (ik_validate, mj_validate, ws_probe)
docs/           screenshots & docs
vite.config.js  build/dev config (base './', manual chunks, terser)
firebase.json   hosting config (COOP/COEP headers, caching, asset rules)
```

**Do not commit:** secrets, `dist/`, `node_modules/`, or `public/env/*.exr` / `*.hdr`.
`public/env/studio.exr` is a proprietary RobCo HDRI — it's gitignored and excluded from
all deploys; the app falls back to a built-in procedural environment when it's absent
(which is always the case in CI/production).

## Branch & contribution model

- **`main`** → production. Treat as always-releasable; don't push directly.
- **`develop`** → the shared dev preview link above.
- **Feature work:**
  1. `git checkout develop && git pull`
  2. `git checkout -b feat/short-description`
  3. Make focused changes; run `pnpm dev` to verify and `pnpm build` to catch build errors.
  4. Commit with [conventional commits](https://www.conventionalcommits.org/)
     (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`, `perf:`).
  5. Push the branch and open a **Pull Request into `develop`**.
  6. If per-PR preview deploys are enabled, each PR gets its own **temporary preview URL**
     (commented on the PR by the deploy bot); otherwise check the `develop` preview after
     merge.
  7. Merge the PR → the `develop` preview updates. When a batch is ready to ship, open a
     PR `develop` → `main` to release to production.

> **Heads-up — `gh` CLI and this fork.** This repo is a fork of `fan-ziqi/robot_viewer`, so
> `gh` commands (PRs, runs, API) default to the **upstream** repo and will silently act on the
> wrong one. Always pass `-R zorian-f/robot_viewer` (e.g. `gh run list -R zorian-f/robot_viewer`,
> `gh pr create -R zorian-f/robot_viewer`).

## Working with Claude Code

This repo is set up so you can build features with Claude Code:

1. Install Claude Code, then in the project directory run `claude` (or use the VS Code /
   JetBrains extension).
2. Start each feature on a fresh branch off `develop` (see above).
3. Good loop: **ask Claude to plan first**, confirm the plan, then implement in small steps;
   run the app locally to verify; let Claude write the commit and open the PR.
4. Keep changes small and cohesive (this codebase favors many small, focused files).
5. Production strips `console.*` (terser `drop_console`), so don't rely on console logging
   in prod — verify behavior on the dev server or a PR preview.

Useful context to point Claude at: `vite.config.js`, `firebase.json`, the `src/robco/` and
`src/transport/` folders for RobCo-specific behavior, and `scripts/` for validation tools.

## Help

- Questions / access requests: ask Florian (florian.zeilhofer@robco.de).
- Bug reports: _(reporting channel — to be finalized)_.
