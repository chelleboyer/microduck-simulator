import test from "node:test";
import assert from "node:assert/strict";

import {
  createJumpRunner, jumpPolicyProblem, JUMP_MOVE_REF,
  JUMP_PREP_MIN_STEPS, JUMP_PREP_STILL_STEPS, JUMP_PREP_TIMEOUT_STEPS, JUMP_SETTLE_STEPS,
} from "../src/game/jump.js";

const CTRL_DT = 0.02;
const STILL = { canPrepare: true, onWalker: false, gz: -1, speed: 0, angSpeed: 0 };
const MOVING = { ...STILL, speed: 0.2 };
const LANDED = { canPrepare: false, onWalker: true, gz: -0.99, speed: 0, angSpeed: 0 };
const TIPPED = { ...LANDED, gz: -0.3 };

// Tick n times with the same sample; returns the non-null events.
function run(r, sample, n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const ev = r.tick(sample);
    if (ev) events.push(ev);
  }
  return events;
}

// A runner with the 3 s hop loaded and idle ("ready").
function loadedRunner() {
  const r = createJumpRunner({ ctrlDt: CTRL_DT });
  assert.equal(r.request(), "load");
  assert.equal(r.policyLoaded(3.0), "prepare");
  run(r, STILL, JUMP_PREP_MIN_STEPS);
  run(r, STILL, 150);
  run(r, LANDED, JUMP_SETTLE_STEPS);
  assert.equal(r.status, "ready");
  return r;
}

test("targets the published hop repo", () => {
  assert.equal(JUMP_MOVE_REF, "chelleboyer/microduck-hop-once");
});

test("first press downloads the policy, then prepares without a second press", () => {
  const r = createJumpRunner({ ctrlDt: CTRL_DT });
  assert.equal(r.status, "idle");
  assert.equal(r.request(), "load");
  assert.equal(r.status, "loading");
  // Presses while downloading are ignored, not queued.
  assert.equal(r.request(), null);
  assert.equal(r.tick(STILL), null, "nothing runs while loading");
  assert.equal(r.policyLoaded(3.0), "prepare");
  assert.equal(r.status, "preparing");
  assert.equal(r.jumpSteps, 150, "3.0 s at 50 Hz");
});

test("full single jump: prepare -> jumping -> landing -> ready, exactly once", () => {
  const r = createJumpRunner({ ctrlDt: CTRL_DT });
  r.request();
  r.policyLoaded(3.0);

  // Never starts before the minimum stand, even when perfectly still.
  const early = run(r, STILL, JUMP_PREP_MIN_STEPS - 1);
  assert.deepEqual(early, []);
  assert.equal(r.tick(STILL), "start");
  assert.equal(r.status, "jumping");

  // Runs for exactly the manifest duration, then hands back.
  const during = run(r, STILL, 149);
  assert.deepEqual(during, []);
  assert.equal(r.tick(STILL), "land");
  assert.equal(r.status, "landing");
  assert.equal(r.jumps, 1);

  // Ready once upright on the walker for the settle window.
  assert.deepEqual(run(r, LANDED, JUMP_SETTLE_STEPS - 1), []);
  assert.equal(r.tick(LANDED), "ready");
  assert.equal(r.status, "ready");

  // No repeat: a ready runner stays put without another press.
  assert.deepEqual(run(r, STILL, 500), []);
  assert.equal(r.jumps, 1);
});

test("presses during preparing / jumping / landing are ignored", () => {
  const r = loadedRunner();
  assert.equal(r.request(), "prepare");
  assert.equal(r.request(), null);
  run(r, STILL, JUMP_PREP_MIN_STEPS);
  assert.equal(r.status, "jumping");
  assert.equal(r.request(), null);
  run(r, STILL, 150);
  assert.equal(r.status, "landing");
  assert.equal(r.request(), null);
  assert.equal(r.jumps, 2);
});

test("permits another jump once ready, without re-downloading", () => {
  const r = loadedRunner();
  assert.equal(r.request(), "prepare", "no second load");
  run(r, STILL, JUMP_PREP_MIN_STEPS);
  run(r, STILL, 150);
  run(r, LANDED, JUMP_SETTLE_STEPS);
  assert.equal(r.status, "ready");
  assert.equal(r.jumps, 2);
});

test("preparation waits for the duck to be still and upright", () => {
  const r = loadedRunner();
  r.request();
  assert.deepEqual(run(r, MOVING, JUMP_PREP_MIN_STEPS + 20), []);
  assert.deepEqual(run(r, { ...STILL, gz: -0.9 }, 20), [], "tilted ~25 deg is not a stand");
  assert.deepEqual(run(r, { ...STILL, angSpeed: 2 }, 20), [], "spinning is not still");
  // Stillness must be consecutive.
  assert.deepEqual(run(r, STILL, JUMP_PREP_STILL_STEPS - 1), []);
  r.tick(MOVING);
  assert.deepEqual(run(r, STILL, JUMP_PREP_STILL_STEPS - 1), []);
  assert.equal(r.tick(STILL), "start");
});

test("preparation does not count until the game can hold the duck (e.g. standing up from sit)", () => {
  const r = loadedRunner();
  r.request();
  const sitting = { ...STILL, canPrepare: false };
  assert.deepEqual(run(r, sitting, 100), []);
  assert.equal(r.status, "preparing");
  assert.deepEqual(run(r, STILL, JUMP_PREP_STILL_STEPS), ["start"]);
});

test("a duck that never settles times out with a message and stays jumpable", () => {
  const r = loadedRunner();
  r.request();
  const events = run(r, MOVING, JUMP_PREP_TIMEOUT_STEPS);
  assert.deepEqual(events, ["timeout"]);
  assert.equal(r.status, "ready");
  assert.match(r.error, /did not settle/);
  // The next press clears the message and tries again.
  assert.equal(r.request(), "prepare");
  assert.equal(r.error, null);
});

test("landing waits for an upright duck back on the walker", () => {
  const r = loadedRunner();
  r.request();
  run(r, STILL, JUMP_PREP_MIN_STEPS);
  run(r, STILL, 150);
  assert.equal(r.status, "landing");
  // Tipped, or still in the fall recovery: not ready.
  assert.deepEqual(run(r, TIPPED, 100), []);
  assert.deepEqual(run(r, { ...LANDED, onWalker: false }, 100), []);
  assert.equal(r.status, "landing");
  assert.deepEqual(run(r, LANDED, JUMP_SETTLE_STEPS), ["ready"]);
});

test("load failure surfaces the error and a retry downloads again", () => {
  const r = createJumpRunner({ ctrlDt: CTRL_DT });
  r.request();
  r.policyFailed("could not reach the Hub: Failed to fetch");
  assert.equal(r.status, "error");
  assert.equal(r.error, "could not reach the Hub: Failed to fetch");
  assert.equal(r.tick(STILL), null, "no fallback behavior runs");
  assert.equal(r.request(), "load");
  assert.equal(r.status, "loading");
  assert.equal(r.error, null);
  assert.equal(r.policyLoaded(3.0), "prepare");
});

test("abort (reset, non-finite actions) returns to ready with the reason", () => {
  const r = loadedRunner();
  r.request();
  run(r, STILL, JUMP_PREP_MIN_STEPS);
  assert.equal(r.status, "jumping");
  r.abort("the jump policy produced non-finite actions");
  assert.equal(r.status, "ready");
  assert.equal(r.error, "the jump policy produced non-finite actions");
  assert.equal(r.tick(STILL), null);
  // Aborting when nothing is in flight is a no-op (keeps load errors).
  const failed = createJumpRunner({ ctrlDt: CTRL_DT });
  failed.request();
  failed.policyFailed("boom");
  failed.abort(null);
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "boom");
});

test("snapshot is a plain store projection", () => {
  const r = loadedRunner();
  assert.deepEqual(r.snapshot(), { status: "ready", error: null, jumps: 1 });
});

test("jumpPolicyProblem only accepts an episodic ONNX one-shot with a duration", () => {
  const session = {};
  assert.equal(jumpPolicyProblem({ kind: "episodic", slot: "trick", session, durationS: 3 }), null);
  assert.match(jumpPolicyProblem({ kind: "perpetual", slot: "walk", session, durationS: null }), /episodic/);
  assert.match(jumpPolicyProblem({ kind: "script", slot: "script", durationS: 3 }), /episodic/);
  assert.match(jumpPolicyProblem({ kind: "episodic", slot: "trick", durationS: 3 }), /ONNX session/);
  assert.match(jumpPolicyProblem({ kind: "episodic", slot: "trick", session, durationS: 0 }), /duration/);
  assert.equal(jumpPolicyProblem(null), "no policy");
});
