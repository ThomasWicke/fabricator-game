// Self-hosted body-sprite generation via a ComfyUI server (the Mac mini).
// Mirrors image.ts's contract — same inputs, same BodySprite-with-usage
// return shape — so party/fabricator.ts branches with one `if` and the
// Gemini path remains the untouched fallback.
//
// The magenta contract is kept IN THE GRAPH, not in the prompt: local
// diffusion models cannot be trusted to paint a flat #FF00FF, so the graph
// runs background removal on the decoded image and composites the subject
// onto a fresh flat magenta canvas. The client chroma keyer
// (client/src/screen/chroma-core.ts) then sees exactly what Gemini output
// gave it. `rembg: false` opts out (e.g. if the removal node erodes thin
// features) and falls back to a magenta init canvas + prompt.
//
// ISOMORPHIC — fetch/FormData/atob only, caller supplies baseUrl + token.

import { localAuthHeaders } from "./local-auth";
import { decodePngRgba } from "./png-decode";
import { silhouetteFromPngBase64 } from "./silhouette";
import { isFramedScene, magentaMask, measureUnity } from "./sprite-check";
import { STYLE_PALETTE } from "./style-refs";
import type { FabricatedSpec } from "./schema";
import type { ArtReferences, ArtTrace, BodySprite, ImageUsage } from "./image";

export type LocalImageEndpoint = { baseUrl: string; token: string };

export type LocalImageOptions = {
  /** Checkpoint filename in ComfyUI's models/checkpoints. */
  checkpoint?: string;
  /** LoRA filename in models/loras; empty string disables the LoRA. */
  lora?: string;
  steps?: number;
  cfg?: number;
  /** Background removal in-graph (needs the Inspyrenet rembg custom node).
   *  Off → magenta init canvas + prompt, and the client keyer's tolerance. */
  rembg?: boolean;
  /** Total wall-clock budget for the ComfyUI job, polling included. First
   *  run after a restart loads the checkpoint and needs the headroom. */
  timeoutMs?: number;
  /** Replace the spec-derived positive prompt. For prompt-strategy evals —
   *  production passes nothing and gets buildLocalImagePrompt(). */
  prompt?: string;
  /** Replace the negative prompt. Note it only bites above cfg 1.0. */
  negativePrompt?: string;
  /** Override the img2img denoise. Production derives it from which
   *  reference it got (SKETCH_DENOISE, or 0.45 for a parent); an eval sets
   *  it to make denoise the variable under test. */
  denoise?: number;
  /** Fill the sketch into a silhouette before using it as the init image.
   *  Production always does; an eval turns it off to reproduce the hollow
   *  bodies it was introduced to fix. */
  fillSketch?: boolean;
  /** Also save the frame BEFORE background removal, so the T console can
   *  show what the model drew rather than only what survived rembg. One
   *  extra local fetch per attempt; off for evals that only score the
   *  finished sprite. */
  traceFrames?: boolean;
  /** Empty-latent flavour. FLUX needs the 16-channel SD3 latent; feeding it
   *  a 4-channel one yields noise, not an error. */
  latentType?: "sd" | "sd3";
  sampler?: string;
  scheduler?: string;
  /** Fixed seed. Omit in production (each fabrication should roll its own);
   *  set it in evals so two arms differ by the variable under test. */
  seed?: number;
  /** How many times to re-roll a frame that holds more than one object.
   *  Ignored when `seed` is pinned. */
  attempts?: number;
  /** Largest-blob share that counts as a single object. 0.85 keeps a boat
   *  whose mast is a separate blob and rejects a 2x2 grid. */
  minUnity?: number;
  /** Main blob's share of its own bounding box that counts as a solid
   *  object rather than an outline of one. See MIN_SOLIDITY. */
  minSolidity?: number;
};

/**
 * Below this, the frame holds a drawing of an object instead of an object.
 *
 * Measured 2026-08-26 over the two hollow bodies Thomas reported and every
 * local sprite we have accepted: the wireframes scored 0.096 and 0.128, the
 * accepted sprites 0.455 to 0.882, and the airiest real subject — an
 * all-terrain bike, mostly spokes and open frame — 0.334. 0.25 sits in the
 * gap with room on both sides. Unity cannot see this at all: both wireframes
 * scored 0.94 and 0.98 there, because an outline is perfectly connected.
 */
export const MIN_SOLIDITY = 0.25;

/**
 * Denoise for the sketch init. Structure is decided at HIGH sigma, and
 * denoise starts the schedule below its own value — so the old 0.7 handed
 * the sampler a composition it could refine but never reconsider, and it
 * refined the player's strokes into rendered strokes. 0.85 re-enters the
 * range where form is chosen, leaving the sketch as a bias rather than a
 * tracing guide. Paired with silhouette.ts filling the sketch first: the
 * shape survives the higher denoise because it arrives as a mass, not as
 * lines that need preserving.
 */
const SKETCH_DENOISE = 0.85;

const DEFAULTS: Omit<
  Required<LocalImageOptions>,
  "prompt" | "negativePrompt" | "seed" | "denoise"
> = {
  checkpoint: "sdxl_lightning_4step.safetensors",
  lora: "pixel-art-xl.safetensors",
  steps: 4,
  cfg: 1.6,
  rembg: true,
  timeoutMs: 120_000,
  latentType: "sd",
  sampler: "euler",
  scheduler: "sgm_uniform",
  attempts: 3,
  minUnity: 0.85,
  minSolidity: MIN_SOLIDITY,
  fillSketch: true,
  traceFrames: true,
};

/** #FF00FF as the integer ComfyUI's EmptyImage color input takes. */
const MAGENTA = 0xff00ff;

/** Generation size buckets — same aspect thresholds as buildImagePrompt in
 *  image.ts, at SDXL-native resolutions. */
function bucketSize(spec: FabricatedSpec): { width: number; height: number } {
  if (spec.size.w > spec.size.h * 1.4) return { width: 896, height: 576 };
  if (spec.size.h > spec.size.w * 1.2) return { width: 576, height: 896 };
  return { width: 768, height: 768 };
}

/**
 * Tag-style SD prompt from the same facts buildImagePrompt uses. The
 * pixel-art LoRA is the style anchor, so no style-reference images here.
 *
 * It deliberately never says "sprite" or "game art". Asking SDXL for a
 * video-game sprite is asking for the thing that phrase labels in its
 * training data: a SHEET of little poses, and often a cast of RPG
 * characters to go with them. Naming one object and letting the LoRA carry
 * the style measurably raised the single-object rate and, more visibly,
 * stopped tiny humanoids appearing beside the vehicles.
 */
export function buildLocalImagePrompt(spec: FabricatedSpec): string {
  const RUNNING_GEAR: Record<string, string> = {
    wheels: "chunky rubber wheels along its underside",
    tracks: "caterpillar tracks along its underside",
    legs: "articulated walking legs",
    float: "pontoon floats",
  };
  const gear = RUNNING_GEAR[spec.locomotion.type];
  const view =
    spec.category === "vehicle"
      ? "strict side view, facing right, flat even lighting" +
        (gear ? `, complete with ${gear}` : "") +
        (spec.harvest ? ", visible cutting or drilling implement" : "")
      : spec.category === "tool"
        ? "inventory item icon, slight three-quarter angle, business end toward lower left, not held by anyone"
        : "high three-quarter top-down view";
  return (
    `a single ${spec.displayName}, alone. ${spec.flavor} ${view}. ` +
    "one whole object shown by itself against an empty background, centered, filling the frame. " +
    "pixel art, flat cel shading, chunky simplified shapes, solid opaque body "  +
    "filled with flat colour, thick dark outline around the exterior only" +
    (STYLE_PALETTE.length ? `, palette ${STYLE_PALETTE.join(" ")}` : "")
  );
}

const NEGATIVE_PROMPT =
  "person, driver, pilot, text, watermark, signature, shadow, ground, floor, " +
  "border, frame, photo, photorealistic, 3d render, blurry, multiple objects, " +
  // The pixel-art LoRA loves emitting a grid of variations when it hears
  // "sprite" — the tools on the first contact sheet came out as 12 tiny
  // drills. Name every collage shape it reaches for.
  "sprite sheet, grid, collage, multiple views, variations, tileset, icon set, " +
  // The hollow bodies of 2026-08-26. Worth naming even though the silhouette
  // fill and the prompt are the load-bearing halves of that fix: this is the
  // first build where cfg is above 1.0, so it is also the first build where
  // any of these words do anything at all.
  "wireframe, line art, outline drawing, blueprint, technical drawing, " +
  "coloring book, unfilled outline, hollow, empty interior, sketch, doodle";

const b64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  // Chunked: String.fromCharCode(...whole) overflows the arg limit on big images.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

async function upload(
  endpoint: LocalImageEndpoint,
  base64Png: string,
  name: string,
): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([b64ToBytes(base64Png)], { type: "image/png" }), name);
  form.append("overwrite", "true");
  const res = await fetch(`${endpoint.baseUrl}/upload/image`, {
    method: "POST",
    headers: localAuthHeaders(endpoint.token),
    body: form,
  });
  if (!res.ok) throw httpError("ComfyUI upload", res.status, await res.text());
  const body = (await res.json()) as { name: string };
  return body.name;
}

function httpError(what: string, status: number, text: string): Error {
  const err = new Error(`${what} API ${status}: ${text.slice(0, 200)}`);
  (err as Error & { status?: number }).status = status;
  return err;
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** SDXL(+LoRA) img2img graph. Node IDs are arbitrary string keys; outputs
 *  are referenced as [nodeId, outputIndex]. */
function buildGraph(
  spec: FabricatedSpec,
  initImage: string | null,
  denoise: number,
  opts: typeof DEFAULTS & Pick<LocalImageOptions, "prompt" | "negativePrompt" | "seed">,
): Graph {
  const { width, height } = bucketSize(spec);
  const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
  const g: Graph = {
    ckpt: {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: opts.checkpoint },
    },
  };
  let model: [string, number] = ["ckpt", 0];
  let clip: [string, number] = ["ckpt", 1];
  if (opts.lora) {
    g.lora = {
      class_type: "LoraLoader",
      inputs: {
        model,
        clip,
        lora_name: opts.lora,
        strength_model: 0.9,
        strength_clip: 0.9,
      },
    };
    model = ["lora", 0];
    clip = ["lora", 1];
  }
  g.pos = {
    class_type: "CLIPTextEncode",
    inputs: { clip, text: opts.prompt ?? buildLocalImagePrompt(spec) },
  };
  g.neg = {
    class_type: "CLIPTextEncode",
    inputs: { clip, text: opts.negativePrompt ?? NEGATIVE_PROMPT },
  };

  let latent: [string, number];
  if (initImage) {
    g.init = { class_type: "LoadImage", inputs: { image: initImage } };
    g.initScaled = {
      class_type: "ImageScale",
      inputs: {
        image: ["init", 0],
        upscale_method: "lanczos",
        width,
        height,
        crop: "disabled",
      },
    };
    g.encode = { class_type: "VAEEncode", inputs: { pixels: ["initScaled", 0], vae: ["ckpt", 2] } };
    latent = ["encode", 0];
  } else {
    g.empty = {
      class_type: opts.latentType === "sd3" ? "EmptySD3LatentImage" : "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    };
    latent = ["empty", 0];
    denoise = 1.0;
  }

  g.sample = {
    class_type: "KSampler",
    inputs: {
      model,
      positive: ["pos", 0],
      negative: ["neg", 0],
      latent_image: latent,
      seed,
      steps: opts.steps,
      cfg: opts.cfg,
      sampler_name: opts.sampler,
      scheduler: opts.scheduler,
      denoise,
    },
  };
  g.decode = { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["ckpt", 2] } };

  if (opts.rembg) {
    // Subject cut out, then laid onto a flat magenta canvas — the graph
    // enforces the background contract the prompt cannot.
    g.cut = {
      class_type: "InspyrenetRembg",
      inputs: { image: ["decode", 0], torchscript_jit: "default" },
    };
    g.canvas = {
      class_type: "EmptyImage",
      inputs: { width, height, batch_size: 1, color: MAGENTA },
    };
    g.flat = {
      class_type: "ImageCompositeMasked",
      inputs: {
        destination: ["canvas", 0],
        source: ["cut", 0],
        mask: ["cut", 1],
        x: 0,
        y: 0,
        resize_source: false,
      },
    };
    g.save = { class_type: "SaveImage", inputs: { images: ["flat", 0], filename_prefix: "fabricator" } };
    // The frame as the model drew it, before rembg cut it out and before it
    // was laid on magenta. Without this the two removals are indistinguishable
    // from the outside: a hollow body could be the model's doing or the
    // matte's, and the returned image cannot tell you which.
    if (opts.traceFrames) {
      g.saveRaw = {
        class_type: "SaveImage",
        inputs: { images: ["decode", 0], filename_prefix: "fabricator-raw" },
      };
    }
  } else {
    g.save = { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: "fabricator" } };
  }
  return g;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One trip through ComfyUI: submit, poll, fetch the bytes. */
async function renderOnce(
  spec: FabricatedSpec,
  initImage: string | null,
  denoise: number,
  opts: typeof DEFAULTS & LocalImageOptions,
  endpoint: LocalImageEndpoint,
): Promise<{ bytes: Uint8Array; preKey?: Uint8Array }> {
  const headers = localAuthHeaders(endpoint.token);
  const t0 = Date.now();
  const graph = buildGraph(spec, initImage, denoise, opts);
  const res = await fetch(`${endpoint.baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ prompt: graph, client_id: "fabricator" }),
  });
  if (!res.ok) throw httpError("ComfyUI prompt", res.status, await res.text());
  const { prompt_id } = (await res.json()) as { prompt_id: string };

  // Poll for completion. 5s head start (nothing finishes faster), then
  // 2.5s — roughly 10-40 subrequests per sprite, which matters on the
  // Workers free plan's 50-per-request cap.
  await sleep(5000);
  let images: { filename: string; subfolder: string; type: string }[] | undefined;
  let rawImages: { filename: string; subfolder: string; type: string }[] | undefined;
  while (!images) {
    if (Date.now() - t0 > opts.timeoutMs) {
      throw httpError("ComfyUI job", 504, `no result after ${opts.timeoutMs}ms`);
    }
    const hist = await fetch(`${endpoint.baseUrl}/history/${prompt_id}`, { headers });
    if (!hist.ok) throw httpError("ComfyUI history", hist.status, await hist.text());
    const body = (await hist.json()) as Record<
      string,
      {
        status?: { status_str?: string };
        outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
      }
    >;
    const entry = body[prompt_id];
    if (entry?.status?.status_str === "error") {
      throw new Error("ComfyUI job failed — check the server log for the failing node");
    }
    images = entry?.outputs?.save?.images;
    rawImages = entry?.outputs?.saveRaw?.images;
    if (!images) await sleep(2500);
  }

  const fetchImage = async (img: { filename: string; subfolder: string; type: string }) => {
    const view = await fetch(
      `${endpoint.baseUrl}/view?filename=${encodeURIComponent(img.filename)}` +
        `&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`,
      { headers },
    );
    if (!view.ok) throw httpError("ComfyUI view", view.status, await view.text());
    return new Uint8Array(await view.arrayBuffer());
  };
  const bytes = await fetchImage(images[0]);
  // A missing trace frame is not a failed fabrication — the sprite is the
  // product, this is only the evidence.
  const rawOut = rawImages?.[0];
  const preKey = rawOut ? await fetchImage(rawOut).catch(() => undefined) : undefined;
  return { bytes, preKey };
}

export async function generateBodySpriteLocal(
  spec: FabricatedSpec,
  refs: ArtReferences,
  endpoint: LocalImageEndpoint,
  options: LocalImageOptions = {},
): Promise<BodySprite & { usage: ImageUsage; trace: ArtTrace }> {
  const opts = { ...DEFAULTS, ...options };

  // One init image drives the img2img: the parent body when modifying (low
  // denoise — the machine must stay recognisable, mirroring image.ts), else
  // the player's sketch.
  //
  // The sketch is FILLED before it is uploaded. It arrives as strokes on a
  // transparent field and ComfyUI's LoadImage discards alpha rather than
  // compositing it, so the raw file reached the sampler as near-black lines
  // on pure black — and img2img returned exactly that, thin marks on
  // nothing. silhouette.ts closes the strokes and floods the inside, so what
  // the sampler is handed is the solid shape the player meant.
  let initImage: string | null = null;
  let denoise = 1.0;
  let sketchSolidity: number | undefined;
  let uploadedSketch: string | undefined;
  if (refs.parent) {
    initImage = await upload(endpoint, refs.parent, "fabricator-parent.png");
    denoise = 0.45;
  } else if (refs.sketch) {
    // A drawing we cannot read is not a reason to fail the fabrication —
    // fall through to a plain text-to-image render, which is what a player
    // who drew nothing already gets.
    const filled = opts.fillSketch
      ? await silhouetteFromPngBase64(refs.sketch).catch(() => null)
      : { base64: refs.sketch, solidity: NaN, thickened: false };
    if (filled) {
      uploadedSketch = filled.base64;
      initImage = await upload(endpoint, filled.base64, "fabricator-sketch.png");
      denoise = SKETCH_DENOISE;
      sketchSolidity = filled.solidity;
    }
  }
  if (options.denoise !== undefined && initImage) denoise = options.denoise;

  // Re-roll grids. Whether a frame holds one object or twelve is mostly the
  // seed's doing — the same prompt and subject swings between unity 0.2 and
  // 1.0 — and a local generation costs seconds and no money, so the honest
  // move is to look at the result and ask again. A pinned seed means an eval
  // wants that exact image, so it gets one attempt.
  const attempts = options.seed !== undefined ? 1 : opts.attempts;
  let best:
    | { bytes: Uint8Array; preKey?: Uint8Array; score: number; unity: number; solidity: number }
    | null = null;
  for (let i = 0; i < attempts; i++) {
    const { bytes, preKey } = await renderOnce(spec, initImage, denoise, opts, endpoint);
    // A frame we cannot read is not a frame we can reject; keep it and let
    // the client keyer have the final say.
    let score = 1;
    let ok = true;
    let unity = 1;
    let solidity = 1;
    try {
      const img = await decodePngRgba(bytes);
      const m = measureUnity(magentaMask(img.rgba, img.width, img.height), img.width, img.height);
      unity = m.unity;
      solidity = m.solidity;
      const scene = isFramedScene(m);
      ok = !scene && m.unity >= opts.minUnity && m.solidity >= opts.minSolidity;
      // Ranked on the WORSE of the two checks, each measured against its own
      // bar. One number cannot be allowed to carry a frame the other rejects:
      // a hollow wireframe scores ~0.96 unity precisely because an outline is
      // perfectly connected, and under a unity-only ranking it would beat
      // every solid attempt beside it.
      // Score 0 for a scene: it is a worse asset than a grid, since the grid
      // at least looks wrong immediately.
      score = scene ? 0 : Math.min(m.unity / opts.minUnity, m.solidity / opts.minSolidity);
    } catch {
      // keep the defaults above — unreadable means unjudged, not rejected
    }
    if (!best || score > best.score) best = { bytes, preKey, score, unity, solidity };
    if (ok) break;
  }

  const trace: ArtTrace = {
    // What the sampler was handed: the filled silhouette, not the strokes.
    input: initImage && refs.sketch ? uploadedSketch : undefined,
    preKey: best!.preKey ? bytesToB64(best!.preKey) : undefined,
    prompt: opts.prompt ?? buildLocalImagePrompt(spec),
  };
  return {
    dataUrl: `data:image/png;base64,${bytesToB64(best!.bytes)}`,
    mimeType: "image/png",
    trace,
    // Free — zero tokens is the honest number; the model field keeps the
    // existing per-fabrication log line meaningful.
    usage: {
      model: `comfyui/${opts.checkpoint}`,
      imageTokens: 0,
      totalTokens: 0,
      unity: best!.unity,
      solidity: best!.solidity,
      sketchSolidity,
    },
  };
}
