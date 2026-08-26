# Self-hosted AI backend (the Mac mini)

The Fabricator pipeline can run entirely on a local machine — Ollama compiles
specs, ComfyUI renders body sprites — costing nothing per fabrication. The
Worker tries the local backend first and degrades to Gemini/Anthropic (if
keys are configured), then the offline mock. See `.env.example` for the four
`LOCAL_*` vars.

## What runs where

| Service | Port | Role | Models |
|---|---|---|---|
| Ollama (brew service) | 11434 | Spec compiler — vision + JSON-schema-constrained output | `qwen3-vl:8b` (~6GB) |
| ComfyUI (LaunchAgent) | 8188 | Body sprites — img2img from the player sketch | `sdxl_lightning_4step` + `pixel-art-xl` LoRA (fast) / `flux1-schnell-fp8` (quality) |

Steady-state RAM with the fast image config ≈ 20GB on a 32GB machine. The
FLUX checkpoint is the quality alternative — heavier, slower, not loaded at
the same time as SDXL (ComfyUI swaps checkpoints per job).

## Measured on the M2 Pro 32GB (2026-08-25)

- Compiler `qwen3-vl:8b`: **30/30** on the eval (the recorded
  gemini-3.6-flash baseline is 29/29 with Mining Pick as a known failure).
  ~5-7s per compile warm, ~12s with a sketch. The 30B scored 27/30 — no
  better, and its cold load blows the 60s attempt budget; 8B is the default.
- Two provider details bought that score, both encoded in
  `providers/ollama.ts`: `think: false` (thinking + `format` makes Ollama
  re-process a full reasoning pass — ~90-190s per call), and the
  all-required/nullable schema transform (grammar-constrained decoding
  silently drops optional properties — capability blocks went from
  almost-never-emitted to correct).
- Sprites (SDXL-Lightning + pixel-art LoRA + rembg → magenta): **~7.5s**
  per attempt, ~9.1s per accepted sprite once re-rolls are counted.

## The sprite-sheet problem, and what fixed it (2026-08-26)

Asked for game art, SDXL answers about half the time with a sprite SHEET —
a grid of little variations, often with RPG characters thrown in. Nothing
caught it: keying a grid works fine, so every metric called it a pass. A
50-image matrix (5 prompt strategies x 5 subjects x 2 seeds) settled it:

- **The seed dominates.** Same prompt, same subject, different seed swings
  unity from 0.2 to 1.0; seed A beat seed B on 10 of 16 matched pairs. No
  prompt got the per-attempt rate past 60%.
- **Wording still matters, mostly qualitatively.** Never saying "sprite" or
  "game art" lifted mean unity 0.70 → 0.83 and removed the uninvited
  humanoids entirely. `buildLocalImagePrompt` now uses that framing.
- **The negative prompt was inert.** Lightning runs at cfg 1.0, where
  classifier-free guidance is off and the model never reads it. Raising cfg
  to 2.0 to switch it on cost 60% more time and bought no unity.
- **The LoRA is not the culprit.** Grids survive without it; the style does
  not. It stays.

So the fix is to look at the output and ask again — free, locally. The
pipeline decodes its own PNG (`png-decode.ts`), measures it
(`sprite-check.ts`), and re-rolls up to `attempts` times. Measured 10/10
single-object against 5/10 before.

Two acceptance rules, both learned from real rejections:

- `unity` ≥ 0.85 — the largest connected blob's share of the artwork.
  Catches grids.
- not a framed scene — a subject spanning ≥95% of BOTH axes is a backdrop,
  not a sprite. Thomas caught one by eye that every other number passed: a
  hut with trees behind it and a window-frame around the lot, 0.99 unity,
  because a scene is perfectly connected.

**FLUX.1-schnell**: ~70s per step, ~5 minutes per sprite against SDXL's
7.5s, and the pixel-art LoRA is SDXL-only so it has no style anchor. It
never has the sprite-sheet problem and its prompt adherence is visibly
better — one object, correct view, first try — so it is kept installed for
possible offline/"nicer asset" use, but it is far too slow for live
fabrication. Note it loads ~22GB and does not give it back: run
`POST /free {"unload_models":true,"free_memory":true}`, or restart ComfyUI,
before going back to SDXL or the next job will thrash.

## Install (once)

```sh
# Ollama
brew install ollama
brew services start ollama
ollama pull qwen3-vl:8b

# ComfyUI
mkdir -p ~/fabricator-ai && cd ~/fabricator-ai
git clone https://github.com/comfyanonymous/ComfyUI.git
git clone https://github.com/john-mnz/ComfyUI-Inspyrenet-Rembg.git \
  ComfyUI/custom_nodes/ComfyUI-Inspyrenet-Rembg
cd ComfyUI
/opt/homebrew/bin/python3.12 -m venv venv
./venv/bin/pip install torch torchvision torchaudio
./venv/bin/pip install -r requirements.txt
./venv/bin/pip install -r custom_nodes/ComfyUI-Inspyrenet-Rembg/requirements.txt

# Models
curl -L -o models/checkpoints/sdxl_lightning_4step.safetensors \
  https://huggingface.co/ByteDance/SDXL-Lightning/resolve/main/sdxl_lightning_4step.safetensors
curl -L -o models/loras/pixel-art-xl.safetensors \
  https://huggingface.co/nerijs/pixel-art-xl/resolve/main/pixel-art-xl.safetensors
curl -L -o models/checkpoints/flux1-schnell-fp8.safetensors \
  https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors
```

The compile provider sends `keep_alive: "30m"` per request, so the LLM stays
resident between fabrications without any Ollama service configuration.

## Run ComfyUI

Interactively:

```sh
cd ~/fabricator-ai/ComfyUI && ./venv/bin/python main.py --listen 127.0.0.1 --port 8188
```

As a LaunchAgent (starts at login, restarts on crash) — write
`~/Library/LaunchAgents/io.fabricator.comfyui.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.fabricator.comfyui</string>
  <key>ProgramArguments</key><array>
    <string>/Users/USERNAME/fabricator-ai/ComfyUI/venv/bin/python</string>
    <string>main.py</string>
    <string>--listen</string><string>127.0.0.1</string>
    <string>--port</string><string>8188</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/USERNAME/fabricator-ai/ComfyUI</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/comfyui.log</string>
  <key>StandardErrorPath</key><string>/tmp/comfyui.log</string>
</dict></plist>
```

then `launchctl load ~/Library/LaunchAgents/io.fabricator.comfyui.plist`.

Both services bind to `127.0.0.1` only — nothing on the LAN or internet can
reach them directly.

## Dev wiring

In `.env`:

```
LOCAL_AI_URL=http://127.0.0.1:11434
LOCAL_IMAGE_URL=http://127.0.0.1:8188
```

That's all — `wrangler dev` runs on the same machine, so no tunnel and no
token. Evals:

```sh
npx tsx scripts/eval-compiler.ts --live   # spec quality vs the recorded Gemini fixtures — free
npx tsx scripts/eval-art.ts --local       # sprite contact sheet → fixtures/art-local/
```

To compare FLUX against SDXL for sprites, run eval-art twice — the options
live in `shared/fabricator/image-local.ts` (`LocalImageOptions`): checkpoint
`flux1-schnell-fp8.safetensors`, steps 4, cfg 1.0.

## Production wiring (Cloudflare Tunnel) — do this LAST

The deployed Worker cannot reach localhost; a named tunnel exposes the two
services without opening any router port (outbound-only), and Cloudflare
Access rejects unauthenticated requests at the edge before they reach the
mini.

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create fabricator-ai
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: fabricator-ai
credentials-file: /Users/USERNAME/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: ollama.YOURDOMAIN
    service: http://localhost:11434
  - hostname: comfy.YOURDOMAIN
    service: http://localhost:8188
  - service: http_status:404
```

```sh
cloudflared tunnel route dns fabricator-ai ollama.YOURDOMAIN
cloudflared tunnel route dns fabricator-ai comfy.YOURDOMAIN
sudo cloudflared service install
```

Then in the Cloudflare dashboard (Zero Trust → Access):

1. Create a **service token**; note its Client ID and Client Secret.
2. Create one self-hosted **application** covering `ollama.YOURDOMAIN` and
   `comfy.YOURDOMAIN` whose only policy is Service Auth with that token.
   Verify the policy is NOT "allow everyone".

Worker config: put the URLs in `wrangler.jsonc` `vars`
(`LOCAL_AI_URL=https://ollama.YOURDOMAIN`, `LOCAL_IMAGE_URL=https://comfy.YOURDOMAIN`)
and the token in a secret:

```sh
npx wrangler secret put LOCAL_AI_TOKEN   # value: <client-id>:<client-secret>
```

Sanity checks: `curl https://ollama.YOURDOMAIN/api/version` from another
network must return an Access challenge, not the Ollama version; with the
two `CF-Access-Client-*` headers it must return the version.

## Known limits

- One Mac mini serializes concurrent fabrications (Ollama and ComfyUI both
  queue internally); the per-room `MAX_PER_HOUR` cap is the guard, and a
  busy multi-room deployment will feel it.
- The first fabrication after a restart pays a cold model load (~15-60s);
  the 60s compile timeout and the 120s ComfyUI budget absorb it.
- Sprite polling costs ~10-40 Worker subrequests; fine on the paid plan
  (1000/request), tight on free (50).
