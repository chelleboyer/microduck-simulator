// Jump Forward: a dedicated one-shot slot for the community hop policy
// (chelleboyer/microduck-hop-once, manifest kind "episodic", 3.0 s, entry
// pose "standing", all-zero command). It rides the community-move loader
// (custom-policy.js) but mounts in its OWN session slot, so it never
// replaces the walker, the sit policy or a ?move= trick.
//
// One press = one jump, driven by a small state machine stepped once per
// 50 Hz control step:
//
//   idle ──press──> loading ──ok──> preparing ──settled──> jumping
//     ^               │fail                                   │duration_s
//     │               v                                       v
//     │             error ──press (retry)──> loading        landing
//     │                                                       │upright on
//   ready <──────────────────────────────────────────────────┘the walker
//
//   preparing  the walker holds the duck in place (zero command) until it
//              is upright and still - the policy was trained from a
//              standing spawn. A duck that never settles aborts the jump.
//   jumping    the hop ONNX policy drives every step for its manifest
//              duration (no repeat: the slot hands back on its own).
//   landing    control is back on the standing walker (or the fall
//              recovery if the landing tipped it); "ready" once it has
//              been upright on the walker for a beat.
//
// Framework-free and game-free on purpose (no MuJoCo, no ort): the game
// feeds it plain samples, which keeps every transition unit-testable.

export const JUMP_MOVE_REF = "chelleboyer/microduck-hop-once";

// Actuator latency the hop was trained with, in 5 ms physics substeps.
// The model card (and the training task's --match-training-delays
// rehearsal) runs the policy with a 3-5 substep delay between an action
// and the servos; the playground applies every other policy with zero
// delay. Measured on this exact MJCF/ONNX pair: at 0 substeps the hop
// collapses into a ~3 cm shuffle with ~1 cm foot clearance, at 3 it is
// the card's ~8 cm hop with ~0.12 s of flight. Applied ONLY while the hop
// policy drives (mode "jump"); 3 = the clean-landing end of the range.
export const JUMP_ACTUATOR_LATENCY_SUBSTEPS = 3;

// Step counts at the 50 Hz control rate.
export const JUMP_PREP_MIN_STEPS = 25; // 0.5 s minimum stand before the hop
export const JUMP_PREP_STILL_STEPS = 15; // 0.3 s of consecutive stillness
export const JUMP_PREP_TIMEOUT_STEPS = 250; // 5 s (covers a 2 s stand-up from sit)
export const JUMP_SETTLE_STEPS = 25; // 0.5 s upright on the walker after landing

// "Still and standing" thresholds for the preparation phase.
const PREP_MAX_TILT_GZ = -0.95; // projected gravity z (~18 deg of tilt)
const PREP_MAX_SPEED = 0.06; // m/s, trunk horizontal speed
const PREP_MAX_ANG = 0.8; // rad/s, trunk angular speed
const LAND_UPRIGHT_GZ = -0.85; // same bar as the fall recovery's exit

// Why a loaded move can't be the jump (null = good to mount). The jump
// slot needs a real ONNX session (not a command script) from an episodic
// manifest: a perpetual gait has no end and would never hand back.
export function jumpPolicyProblem(loaded) {
  if (!loaded) return "no policy";
  if (loaded.kind !== "episodic" || loaded.slot !== "trick") {
    return `expected an episodic one-shot policy, got kind "${loaded.kind}"`;
  }
  if (!loaded.session) return "policy has no ONNX session";
  if (!(Number.isFinite(loaded.durationS) && loaded.durationS > 0)) {
    return "policy has no episode duration";
  }
  return null;
}

export function createJumpRunner({ ctrlDt }) {
  const r = {
    status: "idle", // idle | loading | ready | preparing | jumping | landing | error
    error: null, // last failure / abort reason (cleared by the next press)
    steps: 0,
    stillSteps: 0,
    jumpSteps: 0,
    jumps: 0, // completed hops (reached "landing")
    pendingPrepare: false, // a press is waiting on the policy download
  };

  const hasPolicy = () => r.jumpSteps > 0;
  const enter = (status) => {
    r.status = status;
    r.steps = 0;
    r.stillSteps = 0;
  };

  // A press. Returns what the game must do: "load" (start the download),
  // "prepare" (hold the duck still), or null (busy - ignored, never queued).
  r.request = () => {
    if (r.status === "idle" || r.status === "error") {
      if (hasPolicy()) {
        r.error = null;
        enter("preparing");
        return "prepare";
      }
      r.error = null;
      r.pendingPrepare = true;
      enter("loading");
      return "load";
    }
    if (r.status === "ready") {
      r.error = null;
      enter("preparing");
      return "prepare";
    }
    return null;
  };

  // The download finished and the policy passed validation.
  r.policyLoaded = (durationS) => {
    r.jumpSteps = Math.max(1, Math.round(durationS / ctrlDt));
    const go = r.pendingPrepare;
    r.pendingPrepare = false;
    enter(go ? "preparing" : "ready");
    return go ? "prepare" : null;
  };

  r.policyFailed = (message) => {
    r.pendingPrepare = false;
    r.error = message || "unknown error";
    enter("error");
  };

  // Interrupt a jump in flight (sim reset, loco switch, non-finite action,
  // a fall during the preparation). A download keeps going.
  r.abort = (reason = null) => {
    if (r.status !== "preparing" && r.status !== "jumping" && r.status !== "landing") return;
    r.error = reason;
    enter(hasPolicy() ? "ready" : "idle");
  };

  // One control step. sample = { canPrepare, onWalker, gz, speed, angSpeed }:
  //   canPrepare  the game may hold the duck for a jump (legs, walk or the
  //               prep mode, no stand-up / recovery / input lock pending)
  //   onWalker    the standing walker is driving (no recovery, walk mode)
  //   gz          projected gravity z (-1 = perfectly upright)
  //   speed       trunk horizontal speed, m/s
  //   angSpeed    trunk angular speed, rad/s
  // Returns the transition the game must apply: "start" (swap the jump
  // policy in), "land" (hand back to the walker), "ready", "timeout" (the
  // duck never settled), or null.
  r.tick = (s) => {
    if (r.status === "preparing") {
      r.steps++;
      if (s.canPrepare) {
        const still = s.gz < PREP_MAX_TILT_GZ && s.speed < PREP_MAX_SPEED &&
          s.angSpeed < PREP_MAX_ANG;
        r.stillSteps = still ? r.stillSteps + 1 : 0;
        if (r.steps >= JUMP_PREP_MIN_STEPS && r.stillSteps >= JUMP_PREP_STILL_STEPS) {
          enter("jumping");
          return "start";
        }
      }
      if (r.steps >= JUMP_PREP_TIMEOUT_STEPS) {
        r.error = "the duck did not settle into a stand - try again";
        enter("ready");
        return "timeout";
      }
      return null;
    }
    if (r.status === "jumping") {
      r.steps++;
      if (r.steps >= r.jumpSteps) {
        r.jumps++;
        enter("landing");
        return "land";
      }
      return null;
    }
    if (r.status === "landing") {
      r.steps++;
      const upright = s.onWalker && s.gz < LAND_UPRIGHT_GZ;
      r.stillSteps = upright ? r.stillSteps + 1 : 0;
      if (r.stillSteps >= JUMP_SETTLE_STEPS) {
        enter("ready");
        return "ready";
      }
    }
    return null;
  };

  // Plain projection for the UI store.
  r.snapshot = () => ({ status: r.status, error: r.error, jumps: r.jumps });

  return r;
}
