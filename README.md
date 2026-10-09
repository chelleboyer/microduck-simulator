---
title: Microduck Sandbox
emoji: 🐤
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 8080
pinned: false
---

# Microduck RL playground

Real trained RL policies for the Microduck robot, running fully in the
browser: MuJoCo compiled to WebAssembly steps the physics, onnxruntime-web
runs the policy network at 50 Hz. No server, no backend.

Two locomotion variants of the same robot are included: **legs** (walking,
the default) and **rollers** (the wheeled skating variant). Press `M` (or
hold D-pad up ~1 s on a gamepad) to switch; the roller model, meshes and
policies are lazy-loaded on the first switch.

## Policies

| Mode | Checkpoint | What it does |
|--------|-----------|--------------|
| Run (legs) | `BEST_alpha_walking.onnx` | Velocity-tracking locomotion (arrows / WASD to steer) |
| Sit | `BEST_alpha_sitstand.onnx` | Sits down on its hull, stands back up |
| Roll | `roulade.onnx` | Rolls over and recovers |
| Kick | `ball_kick_left.onnx` / `ball_kick_right.onnx` | Blind one-shot kick (0.5 s window, zeroed commands), left or right leg |
| Drive (rollers) | `BEST_roller.onnx` | Velocity-tracking skating on 4 passive wheels (higher top speed: 0.6 m/s) |
| Crouch (rollers) | `BEST_roller_crouch.onnx` | One-shot crouch-glide: sinks low over ~3.5 s and stands back up (phase-encoded command) |
| Jump Forward (legs) | [`chelleboyer/microduck-hop-once`](https://huggingface.co/chelleboyer/microduck-hop-once) | One forward hop, then stand. Fetched from the Hub on the first press; see below |

Policies and MJCF model from
[pollen-robotics/microduck](https://github.com/pollen-robotics/microduck)
and [pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl).

## Controls

- Arrows or WASD / ZQSD: forward / back + turn
- M: switch legs <-> rollers
- Q / E (A / E on AZERTY): kick left / right (legs only)
- F: alternate left / right kicks (legs only)
- R: sit / stand (legs) / crouch-glide (rollers)
- G: ground pick (legs only)
- J or the **Jump Forward** button: one forward hop (legs only)
- C: toggle the chase camera (on by default; dragging detaches it)
- Space: reset
- Drag to orbit, scroll to zoom
- Colour dots: repaint the duck (it quacks)

In roller mode the legs-only actions (kicks, sit) are disabled and their
hints fade out; play the ball by driving into it.

### Jump Forward

The **Jump Forward** button (bottom centre on desktop, above the A/B caps
on touch screens) plays the community episodic policy
[`chelleboyer/microduck-hop-once`](https://huggingface.co/chelleboyer/microduck-hop-once)
once per press. It loads through the same validated community-move loader as
`?move=` (manifest checks + ONNX smoke run) but mounts in its own slot, so
walking, sitting, rolling, kicks and any `?move=` trick are untouched:

1. **Loading**: the first press downloads `manifest.json` + `policy.onnx`
   from the Hub. Failures (network/CORS, missing file, incompatible
   manifest, broken ONNX) print under the button with a **Retry** - no
   stock behavior is substituted.
2. **Preparing**: the walking policy holds the duck still (zero command;
   a sitting duck is stood up first) until it is upright and settled.
3. **Jumping**: the hop policy drives for its manifest duration (3.0 s),
   all-zero command, fresh action history.
4. **Landing**: control returns to the standing walker (or the fall
   recovery after a rough landing); the button re-arms once the duck has
   been upright for 0.5 s.

The hop was trained with a 3-5 physics-substep actuator delay. The playground
applies a 3-substep delay **only while the hop policy drives**: with zero
delay the same network produces a ~3 cm shuffle instead of a hop. Every
other policy keeps the zero-delay actuation.

### URL parameters

- `?boot=1`: skip the welcome modal and land straight on the BIOS console,
  which then shows the real loading progress live (honest loader) before
  the normal entrance plays. Boot failures (missing asset, policy fetch
  error...) freeze the console on a `SYSTEM HALTED` screen with the error
  detail - handy for debugging.

The ball's physics are local to your tab, but its pose is broadcast with
your duck's, so other visitors see a translucent copy of your ball next
to your ghost (and you see theirs). A square arena (3 x 3 m) fences the
play area so neither the ball nor the duck can wander off.

### Gamepad

Plug in a controller and the same mapping as the real robot runtime applies:

- Left stick: forward / back + turn
- Right stick: orbit the camera (detaches the chase cam)
- R3 (right stick click): toggle the chase cam back on
- X or D-pad down: sit / stand (legs) / crouch-glide (rollers)
- A: ground pick (legs only)
- Y: toggle head control
- RB / LB: right / left kick (legs only)
- D-pad up: hold ~1 s to switch legs <-> rollers (the real robot uses a 3 s hold)
- Right trigger: mouth (analog) + quack
- Left trigger: hold for wheee
- A: enter / resume the game while the title or pause overlay is up
- Menu/Start (or Select): exit back to the title overlay while in-game

## Multiplayer ghosts

Other people visiting the Space at the same time show up as translucent
ducks, live. Peer-to-peer WebRTC via [Trystero](https://github.com/dmotz/trystero)
(serverless signaling over public Nostr relays), so it works from a static
Space with no backend. Each tab broadcasts its duck's pose (trunk + 14
joints + jaw + colour + locomotion variant) at 10 Hz; up to 3 ghosts are
rendered, extra peers stay connected but invisible. The camcorder-style OSD
in the top-right corner shows "N ONLINE" when peers are around.

Ghost limitations in v1: a peer in roller mode renders with the roller rig
only if your tab has already loaded it (otherwise it falls back to the leg
rig), and ghost wheels don't spin (passive wheel joints aren't broadcast).
Old clients simply ignore the new variant flag.

## How it works

The app is a Vite + React + MUI shell around an imperative game core:
React/MUI renders the UI chrome (title menu, BIOS console, HUD, touch
overlay), react-three-fiber owns the canvas/lights/environment, and the
physics/policy/rig loop lives in framework-agnostic modules under
`app/src/game/`. A zustand store bridges the two (game state out,
UI intents in).

- `app/src/game/game.js` fetches the MJCF (`robot_allcollisions.xml`, or
  `robot_allcollisions_rollers.xml` for the roller variant), strips the
  visual geoms, injects a floor, arena walls, a ball, a collision box for
  the arcade cabinet row and a STAND keyframe, and compiles it with the
  official `@mujoco/mujoco` WASM bindings.
- Both variants share the exact same policy interface: 61D observation
  (gyro, projected gravity, 14 joint pos/vel, last action, 13D command)
  and 14 position-targets, matching [`microduck_rl/scripts/infer_policy.py`](https://github.com/pollen-robotics/microduck_rl/blob/main/scripts/infer_policy.py).
  The roller variant adds 4 passive wheel hinges that appear in `qpos`
  (zeroed in the keyframe) but not in the observation.
- Rendering is a three.js rig built from `kinematics.json` /
  `kinematics_rollers.json` + decimated STL meshes, driven directly from
  MuJoCo `qpos` (including the passive wheel spin).
- Switching variants swaps the compiled model + data + rig + ONNX sessions
  wholesale; both stay resident after the first load so toggling back and
  forth is instant.

## Development

Large binary assets (robot meshes, GLB models, ONNX policies) are stored
with [Git LFS](https://git-lfs.com/). Clone with LFS installed, or pull
the real files after a plain clone - otherwise the app boots against
text pointer files and fails with errors like
`SyntaxError: Unexpected token 'v', "version ht"... is not valid JSON`
(that string is the start of an LFS pointer, not your model):

```bash
git lfs install   # once per machine
git lfs pull      # fetch the actual binaries in an existing clone
```

```bash
cd app
npm install
npm run dev     # dev server on http://localhost:5173
npm run build   # production bundle in app/dist/
```

The Space builds with the included `Dockerfile` (Vite build, served by
nginx-unprivileged on port 8080). Static assets (meshes, policies, audio,
images) live in `app/public/` and keep their historical URLs.
