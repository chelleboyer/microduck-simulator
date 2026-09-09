// Community policy loading: resolve a Hub repo id (or a direct .onnx URL)
// into a validated onnxruntime session the game can drop into its walk
// slot. Mirrors the official publish pipeline's smoke run: shape checks,
// a zeros inference and two noisy inferences that must produce finite,
// non-constant actions before the session ever touches the duck.
//
// The module is deliberately framework-free (no game imports): the caller
// hands in the `ort` namespace it already booted, and pure helpers like
// manifestIncompatibility are reusable by standalone pages without pulling
// the game bundle in.

import { OBS_SIZE, NUM_JOINTS } from "./constants.js";

const HUB_BASE = "https://huggingface.co";

// Manifest claims the sim cannot satisfy (schema 2). Only present-and-wrong
// claims reject: an absent field is trusted to match the microduck defaults.
// Returns a human-readable reason, or null when the manifest is acceptable.
export function manifestIncompatibility(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  if (Array.isArray(manifest.policies)) {
    return "multi-policy set: not loadable in v1 (pick a single-policy repo)";
  }
  if (manifest.model_api != null && manifest.model_api > 2) {
    return `model_api ${manifest.model_api} is newer than this sim supports`;
  }
  if (manifest.obs_len != null && manifest.obs_len !== OBS_SIZE) {
    return `expects ${manifest.obs_len} observations (sim provides ${OBS_SIZE})`;
  }
  if (manifest.action_len != null && manifest.action_len !== NUM_JOINTS) {
    return `outputs ${manifest.action_len} actions (sim drives ${NUM_JOINTS})`;
  }
  const robotModel = manifest.robot?.model;
  if (robotModel != null && robotModel !== "microduck") {
    return `targets robot "${robotModel}", not microduck`;
  }
  // v1 only swaps the walk slot: perpetual, constant-command policies.
  if (manifest.kind != null && manifest.kind !== "perpetual") {
    return `"${manifest.kind}" policies are not supported yet (walk-slot only)`;
  }
  if (manifest.slot != null && manifest.slot !== "walk") {
    return `slot "${manifest.slot}" is not supported yet (walk-slot only)`;
  }
  const encoding = manifest.command?.encoding;
  if (encoding != null && encoding !== "constant") {
    return `command encoding "${encoding}" is not supported yet`;
  }
  if (manifest.mode != null && manifest.mode !== "walk") {
    return `mode "${manifest.mode}" is not supported yet (walk-slot only)`;
  }
  return null;
}

// A policy ref is either an org/repo Hub id or a direct URL to a .onnx.
// A direct URL may sit next to a manifest.json (the Academy's private-policy
// handoff serves both under one capability URL): it is probed best-effort.
export function resolvePolicyRef(ref) {
  const r = String(ref || "").trim();
  if (/^https?:\/\//i.test(r)) {
    let manifestUrl = null;
    try {
      const u = new URL(r);
      const name = u.pathname.split("/").pop() || "";
      if (/\.onnx$/i.test(name)) {
        u.pathname = u.pathname.slice(0, -name.length) + "manifest.json";
        manifestUrl = u.href;
      }
    } catch { /* unparsable: no manifest probe */ }
    return { kind: "url", name: r.split("/").pop()?.split("?")[0] || r, onnxUrl: r, manifestUrl, manifestOptional: true };
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) {
    throw new Error(`invalid policy ref "${r}" (expected org/repo or a .onnx URL)`);
  }
  return {
    kind: "hub",
    name: r,
    repoId: r,
    onnxUrl: `${HUB_BASE}/${r}/resolve/main/policy.onnx`,
    manifestUrl: `${HUB_BASE}/${r}/resolve/main/manifest.json`,
  };
}

// Manifest fetch for the loader (and any future policy-browsing page):
// 404 (no manifest) resolves to null, network/parse failures throw.
export async function fetchPolicyManifest(repoId) {
  const res = await fetch(`${HUB_BASE}/${repoId}/resolve/main/manifest.json`);
  if (res.status === 404) return null;
  // The Hub answers 401 for repos that don't exist (or are private).
  if (res.status === 401 || res.status === 403) {
    throw new Error(`repo "${repoId}" not found on the Hub (or private)`);
  }
  if (!res.ok) throw new Error(`manifest fetch failed (HTTP ${res.status})`);
  return res.json();
}

// Publish-pipeline smoke run: 1 input / 1 output, a zeros pass plus two
// small-noise passes; every output must be [1,14], finite, and the noisy
// passes must not produce identical actions (a constant net is a dud).
async function validateSession(ort, session) {
  const { inputNames, outputNames } = session;
  if (inputNames.length !== 1 || outputNames.length !== 1) {
    throw new Error(
      `expected 1 input / 1 output, got ${inputNames.length}/${outputNames.length}`,
    );
  }
  const runOnce = async (fill) => {
    const buf = new Float32Array(OBS_SIZE);
    if (fill) for (let i = 0; i < OBS_SIZE; i++) buf[i] = (Math.random() - 0.5) * 0.1;
    const feeds = { [inputNames[0]]: new ort.Tensor("float32", buf, [1, OBS_SIZE]) };
    const out = (await session.run(feeds))[outputNames[0]];
    const dims = out.dims;
    if (dims.length !== 2 || dims[0] !== 1 || dims[1] !== NUM_JOINTS) {
      throw new Error(`bad output shape [${dims.join(",")}] (expected [1,${NUM_JOINTS}])`);
    }
    const act = out.data;
    for (let j = 0; j < NUM_JOINTS; j++) {
      if (!Number.isFinite(act[j])) throw new Error("non-finite actions in smoke run");
    }
    return Float32Array.from(act);
  };
  await runOnce(false);
  const a = await runOnce(true);
  const b = await runOnce(true);
  let maxDiff = 0;
  for (let j = 0; j < NUM_JOINTS; j++) maxDiff = Math.max(maxDiff, Math.abs(a[j] - b[j]));
  if (maxDiff < 1e-9) throw new Error("constant output in smoke run (dead policy)");
}

// Load + validate a community policy. Resolves to everything the game needs
// to swap its walk slot; throws with a clear message on any failure.
// onProgress receives coarse stages for the HUD loading line.
export async function loadCustomPolicy(ref, { ort, onProgress = () => {} } = {}) {
  const resolved = resolvePolicyRef(ref);
  let name = resolved.name;
  let actionScale = 1.0;

  if (resolved.manifestUrl) {
    onProgress("manifest");
    let manifest = null;
    if (resolved.manifestOptional) {
      // Sibling manifest of a direct URL: any failure (404, CORS, bad JSON)
      // just means "no manifest", exactly like before the probe existed.
      // Only a present-and-incompatible manifest rejects below.
      try {
        const res = await fetch(resolved.manifestUrl);
        if (res.ok) manifest = await res.json();
      } catch { manifest = null; }
    } else {
      try {
        manifest = await fetchPolicyManifest(resolved.repoId);
      } catch (e) {
        // TypeError = the fetch itself failed (offline, CORS); anything else
        // already carries a specific message (missing repo, bad status).
        throw e instanceof TypeError ? new Error(`could not reach the Hub: ${e.message}`) : e;
      }
    }
    if (manifest) {
      const reason = manifestIncompatibility(manifest);
      if (reason) throw new Error(reason);
      if (typeof manifest.name === "string" && manifest.name) name = manifest.name;
      if (Number.isFinite(manifest.action_scale)) actionScale = manifest.action_scale;
    }
  }

  onProgress("download");
  const res = await fetch(resolved.onnxUrl);
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `no policy.onnx found at ${resolved.name}`
        : `policy download failed (HTTP ${res.status})`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  onProgress("session");
  let session;
  try {
    session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  } catch (e) {
    throw new Error(`not a loadable ONNX model: ${e?.message || e}`);
  }

  onProgress("validate");
  await validateSession(ort, session);

  return {
    session,
    name,
    ref: String(ref),
    actionScale,
    inputName: session.inputNames[0],
    outputName: session.outputNames[0],
  };
}
