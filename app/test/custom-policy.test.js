// loadCustomPolicy against the hop repo's real manifest, with fetch and
// onnxruntime stubbed: covers the success path the Jump Forward slot
// mounts, and every failure it must surface instead of falling back.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  loadCustomPolicy, manifestIncompatibility, slotForManifest, resolvePolicyRef,
} from "../src/game/custom-policy.js";
import { JUMP_MOVE_REF } from "../src/game/jump.js";

// manifest.json of chelleboyer/microduck-hop-once (Hub sha f4da0cf).
const HOP_MANIFEST = {
  schema_version: 2,
  model_api: 1,
  obs_len: 61,
  action_len: 14,
  robot: { model: "microduck", hw_rev: 1, servos: "xl330", control_hz: 50 },
  name: "hop-once",
  kind: "episodic",
  entry_pose: "standing",
  command: { encoding: "constant", idle: [0, 0, 0] },
  duration_s: 3.0,
  chain: false,
};

const BASE = `https://huggingface.co/${JUMP_MOVE_REF}/resolve/main`;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// routes: { "<file>": Response | (() => Response) | Error }.
function stubFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const file = String(url).split("/").pop();
    const r = routes[file];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r();
    if (r) return r;
    return new Response("Entry not found", { status: 404 });
  };
  return seen;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
const onnxBytes = () => new Response(new Uint8Array([8, 8, 18, 7]), { status: 200 });

// Minimal ort stand-in: a session whose run() returns `actions(obs)`.
function fakeOrt({ actions = (obs) => obs.slice(0, 14).map((v) => v * 2 + 0.01), dims = [1, 14], io = [["obs"], ["actions"]], createError = null } = {}) {
  class Tensor {
    constructor(type, data, d) { this.type = type; this.data = data; this.dims = d; }
  }
  return {
    Tensor,
    InferenceSession: {
      create: async (bytes, opts) => {
        if (createError) throw createError;
        assert.ok(bytes instanceof Uint8Array && bytes.length > 0, "bytes handed to ort");
        assert.deepEqual(opts.executionProviders, ["wasm"]);
        return {
          inputNames: io[0],
          outputNames: io[1],
          run: async (feeds) => {
            const t = feeds[io[0][0]];
            assert.deepEqual(t.dims, [1, 61], "61-D observation");
            return { [io[1][0]]: { dims, data: Float32Array.from(actions(Array.from(t.data))) } };
          },
        };
      },
    },
  };
}

test("the hop manifest is compatible and mounts as an episodic one-shot", () => {
  assert.equal(manifestIncompatibility(HOP_MANIFEST), null);
  assert.equal(slotForManifest(HOP_MANIFEST), "trick");
  const r = resolvePolicyRef(JUMP_MOVE_REF);
  assert.equal(r.onnxUrl, `${BASE}/policy.onnx`);
  assert.equal(r.manifestUrl, `${BASE}/manifest.json`);
});

test("loads the hop from the Hub: manifest, ONNX, smoke-validated session", async () => {
  const seen = stubFetch({ "manifest.json": json(HOP_MANIFEST), "policy.onnx": onnxBytes });
  const stages = [];
  const loaded = await loadCustomPolicy(JUMP_MOVE_REF, { ort: fakeOrt(), onProgress: (s) => stages.push(s) });
  assert.deepEqual(seen, [`${BASE}/manifest.json`, `${BASE}/policy.onnx`]);
  assert.deepEqual(stages, ["manifest", "download", "session", "validate"]);
  assert.equal(loaded.kind, "episodic");
  assert.equal(loaded.slot, "trick");
  assert.equal(loaded.name, "hop-once");
  assert.equal(loaded.author, "chelleboyer");
  assert.equal(loaded.durationS, 3.0);
  assert.equal(loaded.actionScale, 1.0);
  assert.equal(loaded.inputName, "obs");
  assert.equal(loaded.outputName, "actions");
  assert.ok(loaded.session);
});

test("network / CORS failure reports the Hub as unreachable", async () => {
  stubFetch({ "manifest.json": new TypeError("Failed to fetch") });
  await assert.rejects(loadCustomPolicy(JUMP_MOVE_REF, { ort: fakeOrt() }), /could not reach the Hub: Failed to fetch/);
});

test("missing / private repo is reported, not silently skipped", async () => {
  stubFetch({ "manifest.json": () => new Response("", { status: 401 }) });
  await assert.rejects(loadCustomPolicy(JUMP_MOVE_REF, { ort: fakeOrt() }), /not found on the Hub/);
});

test("missing policy.onnx is a load error", async () => {
  stubFetch({ "manifest.json": json(HOP_MANIFEST) });
  await assert.rejects(loadCustomPolicy(JUMP_MOVE_REF, { ort: fakeOrt() }), /no policy\.onnx found/);
});

test("ONNX download HTTP errors are reported with the status", async () => {
  stubFetch({ "manifest.json": json(HOP_MANIFEST), "policy.onnx": () => new Response("", { status: 503 }) });
  await assert.rejects(loadCustomPolicy(JUMP_MOVE_REF, { ort: fakeOrt() }), /policy\.onnx download failed \(HTTP 503\)/);
});

test("manifest claims the sim cannot satisfy are rejected before downloading", async () => {
  for (const [patch, re] of [
    [{ obs_len: 48 }, /expects 48 observations/],
    [{ action_len: 12 }, /outputs 12 actions/],
    [{ robot: { model: "go2" } }, /not microduck/],
    [{ model_api: 3 }, /newer than this sim/],
  ]) {
    const seen = stubFetch({ "manifest.json": json({ ...HOP_MANIFEST, ...patch }), "policy.onnx": onnxBytes });
    await assert.rejects(loadCustomPolicy(JUMP_MOVE_REF, { ort: fakeOrt() }), re);
    assert.equal(seen.length, 1, "no ONNX download for an incompatible manifest");
  }
});

test("a corrupt ONNX file (e.g. a git-lfs pointer) is rejected", async () => {
  stubFetch({ "manifest.json": json(HOP_MANIFEST), "policy.onnx": onnxBytes });
  const ort = fakeOrt({ createError: new Error("protobuf parsing failed") });
  await assert.rejects(loadCustomPolicy(JUMP_MOVE_REF, { ort }), /not a loadable ONNX model: protobuf parsing failed/);
});

test("smoke validation rejects wrong output shape, NaN and dead policies", async () => {
  const cases = [
    [fakeOrt({ dims: [1, 12] }), /bad output shape \[1,12\]/],
    [fakeOrt({ actions: () => new Array(14).fill(NaN) }), /non-finite actions/],
    [fakeOrt({ actions: () => new Array(14).fill(0.1) }), /constant output/],
    [fakeOrt({ io: [["obs", "h"], ["actions"]] }), /expected 1 input \/ 1 output/],
  ];
  for (const [ort, re] of cases) {
    stubFetch({ "manifest.json": json(HOP_MANIFEST), "policy.onnx": onnxBytes });
    await assert.rejects(loadCustomPolicy(JUMP_MOVE_REF, { ort }), re);
  }
});
