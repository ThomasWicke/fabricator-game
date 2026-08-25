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
- Sprites (SDXL-Lightning + pixel-art LoRA + rembg → magenta): **~7.5s
  each** warm, 7-8 of 9 eval subjects key cleanly per run. Failures are
  seed variance (occasional variations-grid or empty rembg mask), and the
  game already falls back to the sketch; a retry-on-refusal would close
  the gap since generation is free.

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
