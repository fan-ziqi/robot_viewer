# CLAUDE.md

Guidance for Claude Code (and any LLM/agent) working in this repo. Humans should start with
[README.md](README.md) and [ONBOARDING.md](ONBOARDING.md) — this file only adds the few things
an agent trips on. **Read `ONBOARDING.md` first**; it is the source of truth for setup, the
repo layout, the `?robco=` dev modes, and the branch/PR model.

## Ground rules

- **Plain ES-module JavaScript — there is NO TypeScript.** Don't introduce `.ts`, JSX, or a
  build step beyond Vite. Match the surrounding style (small, focused files; JSDoc where it helps).
- **Verify with `pnpm build`** (Vite) before declaring a change done. There is no test suite;
  the build is the gate. `scripts/` holds ad-hoc validators (`ik_validate`, `mj_validate`,
  `ws_probe`) you can run with Node.
- **Production strips `console.*`** (terser `drop_console`) — don't rely on console logging to
  verify prod behavior; check the dev server or a PR preview instead.
- **Never commit** secrets, `dist/`, `node_modules/`, or `public/env/*.exr` / `*.hdr`
  (the proprietary `studio.exr` HDRI is gitignored and excluded from all deploys).

## RobCo integration — where things live

- **Dev loader / entry modes:** [src/robco/devLoad.js](src/robco/devLoad.js) (`?robco=…`).
  For most work, run `pnpm dev` then open `http://localhost:3000/?robco=live` (full arm, online,
  no session) or `?robco=fixtures` (offline).
- **Build-and-wire source of truth:** [src/robco/robcoBuild.js](src/robco/robcoBuild.js)
  (static builds) and [src/robco/liveConnect.js](src/robco/liveConnect.js) (live sessions).
  Both wire the same panel/tool set, so a restored workspace matches a fresh load.
- **Applying a config to Studio:** `POST https://api.robco.studio/public/virtual-robot/configure`
  with a Cognito **ID** token (account-level — not the session/editor token). See `liveConnect.js`.
- **Preset catalog:** [src/robco/robotPresets.js](src/robco/robotPresets.js) (CDN + bundled
  fallback in `public/robco-fixtures/modular_robots.json`).

## Git / GitHub

- This repo is a **fork** of `fan-ziqi/robot_viewer`. `gh` defaults to upstream — always pass
  `-R zorian-f/robot_viewer` on every `gh` command.
- Branch off `develop`, PR into `develop`; `main` is production (auto-deploys to
  https://orrerium.web.app). Conventional-commit messages (`feat:`, `fix:`, `docs:`, …).
