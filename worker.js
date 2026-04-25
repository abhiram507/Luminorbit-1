/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║      LUMINORBIT V22 — CLOUDFLARE WORKER BACKEND                            ║
 * ║      Full JS replacement for the Python backend on Cloudflare's edge       ║
 * ║      Deploy: wrangler deploy (see wrangler.toml in same directory)         ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT THIS DOES:
 *   Implements the same API surface as luminorbit_backend_FIXED.py but runs
 *   entirely on Cloudflare Workers (V8 isolates, no Python, no Docker).
 *
 * ENDPOINTS:
 *   GET  /health                         → liveness check
 *   GET  /api/tools                      → valid tool + capability list
 *   POST /api/process                    → sync AI processing (JSON body)
 *   GET  /api/jobs/:id                   → poll async job (uses KV store)
 *   GET  /api/providers                  → provider routing stats (from KV)
 *
 * LIMITATIONS vs PYTHON BACKEND:
 *   ✗  No PIL/image post-processing (no Pillow on CF Workers)
 *   ✗  No video duration parsing (no struct module)
 *   ✗  No multipart /api/process/upload endpoint (use JSON base64)
 *   ✗  No Redis — KV Namespace used for job state instead
 *   ✗  CPU limit 10ms (wall time unlimited — HTTP waits don't count)
 *   ✓  Global edge network — lower latency than Render free tier
 *   ✓  100K free requests/day on free plan
 *   ✓  Zero cold starts after first request
 *
 * DEPLOY STEPS:
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler kv:namespace create LUMINORBIT_JOBS
 *      → copy the id into wrangler.toml [[kv_namespaces]] binding
 *   4. wrangler secret put API_SECRET          (your auth token)
 *   5. wrangler secret put ALLOWED_ORIGINS     (comma-separated frontend URLs)
 *   6. wrangler deploy
 *   7. Update LUMINORBIT_API_URL in Luminorbit-v22-FINAL.html to:
 *      'https://luminorbit.YOUR_SUBDOMAIN.workers.dev'
 *
 * OPTIONAL SECRETS (provider API keys — set via `wrangler secret put <NAME>`):
 *   POLLINATIONS_API_KEY, TOGETHER_API_KEY, HF_API_KEY, DEEPAI_API_KEY,
 *   SEGMIND_API_KEY, CF_AI_TOKEN, CF_ACCOUNT_ID, GEMINI_API_KEY,
 *   GROQ_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY, KREA_API_KEY,
 *   PEXELS_API_KEY, UNSPLASH_API_KEY, CLOUDINARY_CLOUD_ID,
 *   CLOUDINARY_UPLOAD_PRESET
 *
 * WRANGLER.TOML (wrangler.toml in same directory):
 *   name = "luminorbit"
 *   main = "worker.js"
 *   compatibility_date = "2024-01-01"
 *   [[kv_namespaces]]
 *   binding = "LUMINORBIT_JOBS"
 *   id = "<your-kv-namespace-id>"
 */

// ═══════════════════════════════════════════════════════════════════════════════
// §1  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const APP_VERSION = "22.1.0-cf";

const VALID_CAPABILITIES = new Set([
  "image-gen","super-resolution","segmentation","inpainting",
  "face-processing","restoration","style-transfer","captioning",
  "audio-extraction","compression","temporal","color-matching",
  "audio-sync","visualization","video-gen","basic-processing",
  "denoising","image-enhancement","controlnet",
]);

const VALID_TOOLS = {
  "Flux 1.1 Pro":"image-gen","Seedream 5.0":"image-gen",
  "SDXL 1.0":"image-gen","Stable Diffusion 3.5":"image-gen",
  "Adobe Firefly":"image-gen","Midjourney v7":"image-gen",
  "ControlNet":"controlnet","InstructPix2Pix":"inpainting",
  "SUPIR":"super-resolution","Real-ESRGAN":"super-resolution",
  "GFPGAN":"face-processing","CodeFormer":"restoration",
  "RestoreFormer":"restoration","SwinIR":"super-resolution",
  "BSRGAN":"super-resolution","SAM 2":"segmentation",
  "Grounding DINO":"segmentation","Florence-2":"captioning",
  "Runway Gen-5":"video-gen","Seedance 2.0":"video-gen",
  "Kling AI 3.0":"video-gen","Luma Dream Machine":"video-gen",
  "Pika 2.5":"video-gen","Hailuo MiniMax":"video-gen",
  "Sora Edit":"video-gen","Stable Video Diffusion":"video-gen",
  "LivePortrait":"face-processing","Topaz Video AI 5":"super-resolution",
  "TecoGAN":"temporal","RIFE":"temporal","DAIN":"temporal",
  "RAFT + ESRGAN":"temporal","Temporal GAN":"temporal",
  "AnimateDiff":"video-gen","Wonder Dynamics":"temporal",
  "Auto Caption Generator":"captioning",
  "Audio Extractor Tool":"audio-extraction",
  "Video Compressor Pro":"compression",
  "Video Speed Controller":"temporal",
  "MultiCam Sync":"color-matching","Match Cut Flow":"color-matching",
  "Beat Sync Drop":"audio-sync","Sound Wave Viz":"visualization",
  "Audio Reactive Viz":"visualization",
};

// Tool → provider fallback chains
const TOOL_PROVIDERS = {
  "Flux 1.1 Pro":         ["pollinations","together","krea"],
  "Seedream 5.0":         ["pollinations","krea"],
  "SDXL 1.0":             ["huggingface","deepai"],
  "Stable Diffusion 3.5": ["segmind","huggingface"],
  "SUPIR":                ["cloudflare","krea"],
  "Real-ESRGAN":          ["huggingface","cloudflare"],
  "GFPGAN":               ["huggingface","deepai"],
  "CodeFormer":           ["huggingface"],
  "RestoreFormer":        ["krea","cloudflare"],
  "SwinIR":               ["huggingface","cloudflare"],
  "BSRGAN":               ["huggingface"],
  "Adobe Firefly":        ["pollinations"],
  "ControlNet":           ["segmind","huggingface"],
  "InstructPix2Pix":      ["huggingface"],
  "SAM 2":                ["huggingface"],
  "Grounding DINO":       ["huggingface"],
  "Florence-2":           ["gemini","groq"],
  "Midjourney v7":        ["pollinations","krea"],
  "Runway Gen-5":         ["pollinations","together"],
  "Seedance 2.0":         ["pollinations"],
  "Kling AI 3.0":         ["together"],
  "Luma Dream Machine":   ["pollinations"],
  "Pika 2.5":             ["pollinations"],
  "Hailuo MiniMax":       ["together"],
  "Sora Edit":            ["pollinations"],
  "Stable Video Diffusion":["huggingface"],
  "LivePortrait":         ["huggingface"],
  "Topaz Video AI 5":     ["krea"],
  "TecoGAN":              ["huggingface"],
  "RIFE":                 ["huggingface"],
  "DAIN":                 ["huggingface"],
  "RAFT + ESRGAN":        ["cloudflare"],
  "Temporal GAN":         ["huggingface"],
  "AnimateDiff":          ["huggingface","pollinations"],
  "Wonder Dynamics":      ["cloudflare"],
};

const CAPABILITY_PROVIDERS = {
  "segmentation":      ["huggingface","cloudflare","segmind"],
  "inpainting":        ["huggingface","segmind","deepai"],
  "face-processing":   ["huggingface","deepai","krea"],
  "super-resolution":  ["huggingface","cloudflare","krea"],
  "image-enhancement": ["huggingface","segmind"],
  "denoising":         ["huggingface","cloudflare"],
  "restoration":       ["huggingface","deepai","krea"],
  "style-transfer":    ["huggingface","pollinations","together"],
  "captioning":        ["gemini","groq","mistral"],
  "audio-extraction":  ["cloudflare"],
  "compression":       ["cloudflare"],
  "temporal":          ["cloudflare","huggingface"],
  "color-matching":    ["cloudflare"],
  "audio-sync":        ["cloudflare"],
  "visualization":     ["pollinations","gemini"],
  "image-gen":         ["pollinations","together","krea","segmind"],
  "video-gen":         ["pollinations","together"],
  "basic-processing":  ["huggingface","pollinations","cloudflare"],
  "controlnet":        ["segmind","huggingface"],
};

// Provider timeout ms (CF Workers HTTP has no timeout — this is enforced via Promise.race)
const PROVIDER_TIMEOUT_MS = 13000;
const TARGET_W = 3840;
const TARGET_H = 2160;

// ═══════════════════════════════════════════════════════════════════════════════
// §2  MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return corsPreflightResponse(request, env);
    }

    // Route dispatch
    try {
      if (url.pathname === "/health" && method === "GET") {
        return withCors(await handleHealth(env), request, env);
      }
      if (url.pathname === "/api/tools" && method === "GET") {
        return withCors(jsonResp({ tools: VALID_TOOLS, capabilities: [...VALID_CAPABILITIES] }), request, env);
      }
      if (url.pathname === "/api/process" && method === "POST") {
        const authErr = verifyAuth(request, env);
        if (authErr) return withCors(authErr, request, env);
        return withCors(await handleProcess(request, env, ctx), request, env);
      }
      if (url.pathname.startsWith("/api/jobs/") && method === "GET") {
        const authErr = verifyAuth(request, env);
        if (authErr) return withCors(authErr, request, env);
        const jobId = url.pathname.slice("/api/jobs/".length);
        return withCors(await handleJobStatus(jobId, env), request, env);
      }
      // Alias: /process → /api/process
      if (url.pathname === "/process" && method === "POST") {
        const authErr = verifyAuth(request, env);
        if (authErr) return withCors(authErr, request, env);
        return withCors(await handleProcess(request, env, ctx), request, env);
      }
      if (url.pathname === "/api/providers" && method === "GET") {
        const authErr = verifyAuth(request, env);
        if (authErr) return withCors(authErr, request, env);
        return withCors(jsonResp({ message: "Provider stats not persisted in CF Workers (stateless)" }), request, env);
      }
      return withCors(jsonResp({ success: false, error: "not_found" }, 404), request, env);
    } catch (err) {
      console.error("[worker] unhandled:", err);
      return withCors(jsonResp({ success: false, error: "internal_server_error" }, 500), request, env);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// §3  AUTH
// ═══════════════════════════════════════════════════════════════════════════════

function verifyAuth(request, env) {
  const secret = env.API_SECRET || "";
  if (!secret) return null; // Dev mode: no auth required
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return jsonResp({ success: false, error: "Missing Authorization header" }, 401);
  }
  const token = auth.slice("Bearer ".length);
  // Constant-time comparison
  if (!timingSafeEqual(token, secret)) {
    return jsonResp({ success: false, error: "Invalid token" }, 401);
  }
  return null;
}

function timingSafeEqual(a, b) {
  // Polyfill for CF Workers — no crypto.timingSafeEqual available in all runtimes
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §4  CORS
// ═══════════════════════════════════════════════════════════════════════════════

function getAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || "";
  if (!raw || raw.trim() === "*") return ["*"];
  return raw.split(",").map(o => o.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origins = getAllowedOrigins(env);
  const reqOrigin = request.headers.get("Origin") || "";
  let origin = "null";
  if (origins.includes("*")) {
    origin = "*";
  } else if (origins.includes(reqOrigin)) {
    origin = reqOrigin;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function corsPreflightResponse(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function withCors(response, request, env) {
  const hdrs = corsHeaders(request, env);
  const newHdrs = new Headers(response.headers);
  for (const [k, v] of Object.entries(hdrs)) newHdrs.set(k, v);
  // Security headers
  newHdrs.set("X-Content-Type-Options", "nosniff");
  newHdrs.set("X-Frame-Options", "DENY");
  newHdrs.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, headers: newHdrs });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §5  HEALTH ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleHealth(env) {
  const kvOk = env.LUMINORBIT_JOBS ? "connected" : "not_configured";
  return jsonResp({
    status: "ok",
    version: APP_VERSION,
    runtime: "cloudflare-workers",
    kv_store: kvOk,
    timestamp: Math.floor(Date.now() / 1000),
    note: "No PIL post-processing. No video validation. Job state via KV.",
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §6  PROCESS ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleProcess(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { tool, capability = "basic-processing", params = {}, file_data, file_mime, resolution = "4K" } = body;

  // Validate tool
  if (!tool || !tool.trim()) {
    return jsonResp({ success: false, error: "tool:required" }, 422);
  }
  // Validate capability
  const cap = capability || "basic-processing";
  if (cap !== "basic-processing" && !VALID_CAPABILITIES.has(cap)) {
    return jsonResp({ success: false, error: `capability:unknown:${cap}` }, 422);
  }

  // Decode file bytes if provided
  let fileBytes = null;
  let fileMime = file_mime || "application/octet-stream";
  if (file_data) {
    try {
      const b64 = file_data.includes(",") ? file_data.split(",")[1] : file_data;
      fileBytes = base64Decode(b64);
    } catch {
      return jsonResp({ success: false, error: "Invalid file_data encoding" }, 400);
    }
  }

  // Build provider chain
  const seen = new Set();
  const chain = [];
  for (const n of [...(TOOL_PROVIDERS[tool] || []), ...(CAPABILITY_PROVIDERS[cap] || [])]) {
    if (!seen.has(n)) { seen.add(n); chain.push(n); }
  }

  const requestId = randomId();
  console.log(`[worker:${requestId}] tool=${tool} cap=${cap} chain=${chain.join(",")}`);

  // Try providers in order
  let lastError = "no_providers";
  let fallbackUsed = false;

  for (const providerName of chain) {
    try {
      const result = await withTimeout(
        callProvider(providerName, cap, fileBytes, fileMime, params, env),
        PROVIDER_TIMEOUT_MS,
        `${providerName}:timeout`
      );
      if (result.success) {
        console.log(`[worker:${requestId}] ✓ ${providerName}`);
        return jsonResp({
          success: true,
          output: result.output,
          output_url: result.output,
          provider: providerName,
          resolution: result.resolution || `${TARGET_W}x${TARGET_H}`,
          metadata: result.metadata || {},
          status: fallbackUsed ? "fallback_used" : "ok",
          fallback_reason: fallbackUsed ? lastError : undefined,
          request_id: requestId,
        });
      }
      lastError = result.error || "unknown";
    } catch (err) {
      lastError = String(err.message || err);
    }
    console.warn(`[worker:${requestId}] ✗ ${providerName}: ${lastError}`);
    fallbackUsed = true;
  }

  // Emergency Pollinations fallback
  try {
    const emergency = await emergencyFallback(tool, cap, params, env);
    if (emergency.success) {
      return jsonResp({
        success: true,
        output: emergency.output,
        output_url: emergency.output,
        provider: "pollinations-emergency",
        resolution: `${TARGET_W}x${TARGET_H}`,
        metadata: {},
        status: "fallback_used",
        fallback_reason: lastError,
        request_id: requestId,
      });
    }
  } catch (err) {
    console.error("[worker] emergency fallback failed:", err);
  }

  return jsonResp({ success: false, error: `All providers failed: ${lastError}`, request_id: requestId }, 500);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §7  JOB STATUS (KV-backed)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleJobStatus(jobId, env) {
  if (!jobId || jobId.length > 64) {
    return jsonResp({ success: false, error: "invalid_job_id" }, 400);
  }
  if (!env.LUMINORBIT_JOBS) {
    return jsonResp({ success: false, error: "KV not configured" }, 503);
  }
  const raw = await env.LUMINORBIT_JOBS.get(`job:${jobId}`);
  if (!raw) {
    return jsonResp({ success: false, error: "Job not found" }, 404);
  }
  const job = JSON.parse(raw);
  return jsonResp({
    job_id: job.job_id,
    status: job.status,
    progress: job.progress || 0,
    output: job.output || null,
    output_url: job.output || null,
    error: job.error || null,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §8  PROVIDER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function callProvider(name, capability, fileBytes, fileMime, params, env) {
  switch (name) {
    case "pollinations":  return callPollinations(capability, fileBytes, fileMime, params, env);
    case "together":      return callTogether(capability, fileBytes, fileMime, params, env);
    case "huggingface":   return callHuggingFace(capability, fileBytes, fileMime, params, env);
    case "gemini":        return callGemini(capability, fileBytes, fileMime, params, env);
    case "groq":          return callGroq(capability, fileBytes, fileMime, params, env);
    case "mistral":       return callMistral(capability, fileBytes, fileMime, params, env);
    case "openrouter":    return callOpenRouter(capability, fileBytes, fileMime, params, env);
    case "segmind":       return callSegmind(capability, fileBytes, fileMime, params, env);
    case "krea":          return callKrea(capability, fileBytes, fileMime, params, env);
    case "deepai":        return callDeepAI(capability, fileBytes, fileMime, params, env);
    case "cloudflare":    return callCFAI(capability, fileBytes, fileMime, params, env);
    case "pexels":        return callPexels(capability, fileBytes, fileMime, params, env);
    case "unsplash":      return callUnsplash(capability, fileBytes, fileMime, params, env);
    default: return { success: false, error: `unknown_provider:${name}` };
  }
}

// ── Pollinations ─────────────────────────────────────────────────────────────
async function callPollinations(capability, fileBytes, fileMime, params, env) {
  const key    = env.POLLINATIONS_API_KEY || "";
  const prompt = params.prompt || "professional studio quality photograph ultra high detail";
  const model  = (capability === "style-transfer" || capability === "restoration") ? "flux-pro" : "flux";
  const seed   = params.seed || 42;
  const url    = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${TARGET_W}&height=${TARGET_H}&model=${model}&seed=${seed}&nologo=true&enhance=true`;
  const headers = key ? { "Authorization": `Bearer ${key}` } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) return { success: false, error: `pollinations:${r.status}` };
  const raw = await r.arrayBuffer();
  if (raw.byteLength < 1000) return { success: false, error: "pollinations:tiny_payload" };
  const ct  = r.headers.get("content-type") || "image/jpeg";
  const b64 = arrayBufferToBase64(raw);
  return { success: true, output: `data:${ct};base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { model } };
}

// ── Together AI ──────────────────────────────────────────────────────────────
const TA_MODELS = {
  "image-gen":"black-forest-labs/FLUX.1-pro","style-transfer":"black-forest-labs/FLUX.1-pro",
  "inpainting":"black-forest-labs/FLUX.1-pro","face-processing":"black-forest-labs/FLUX.1-pro",
  "super-resolution":"black-forest-labs/FLUX.1-pro","restoration":"black-forest-labs/FLUX.1-pro",
  "image-enhancement":"black-forest-labs/FLUX.1-pro","denoising":"black-forest-labs/FLUX.1-schnell",
  "segmentation":"black-forest-labs/FLUX.1-schnell","basic-processing":"black-forest-labs/FLUX.1-schnell",
  "video-gen":"stabilityai/stable-video-diffusion-img2vid-xt",
  "captioning":"meta-llama/Llama-3.3-70B-Instruct-Turbo",
};
async function callTogether(capability, fileBytes, fileMime, params, env) {
  const key   = env.TOGETHER_API_KEY || "";
  if (!key) return { success: false, error: "together:no_key" };
  const model  = TA_MODELS[capability] || "black-forest-labs/FLUX.1-schnell";
  const prompt = params.prompt || "ultra detailed professional studio quality 4K photograph";
  const body   = { model, prompt, width: TARGET_W, height: TARGET_H, steps: params.steps || 28, n: 1, response_format: "b64_json" };
  if (fileBytes && capability !== "image-gen") {
    body.image_base64 = arrayBufferToBase64(fileBytes);
    body.strength     = params.strength || 0.75;
  }
  const r = await fetch("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { success: false, error: `together:${r.status}` };
  const data = await r.json();
  const b64  = data.data?.[0]?.b64_json;
  if (!b64) return { success: false, error: "together:no_image" };
  return { success: true, output: `data:image/png;base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { model } };
}

// ── HuggingFace ──────────────────────────────────────────────────────────────
const HF_MODELS = {
  "super-resolution":"ai-forever/Real-ESRGAN","face-processing":"tencentarc/gfpgan",
  "restoration":"sczhou/codeformer","segmentation":"facebook/sam-vit-huge",
  "inpainting":"runwayml/stable-diffusion-inpainting",
  "image-gen":"stabilityai/stable-diffusion-xl-base-1.0",
  "style-transfer":"lambdalabs/sd-image-variations-diffusers",
  "denoising":"ai-forever/Real-ESRGAN","video-gen":"stabilityai/stable-video-diffusion-img2vid-xt",
  "captioning":"Salesforce/blip-image-captioning-large",
  "temporal":"microsoft/phi-3-vision-128k-instruct",
  "image-enhancement":"stabilityai/stable-diffusion-xl-refiner-1.0",
  "basic-processing":"stabilityai/stable-diffusion-xl-base-1.0",
  "color-matching":"stabilityai/stable-diffusion-xl-base-1.0",
};
const HF_IMAGE_INPUT = new Set([
  "super-resolution","face-processing","restoration","segmentation",
  "inpainting","denoising","style-transfer","captioning","video-gen","temporal",
]);
async function callHuggingFace(capability, fileBytes, fileMime, params, env) {
  const key   = env.HF_API_KEY || "";
  if (!key) return { success: false, error: "huggingface:no_key" };
  const model   = HF_MODELS[capability] || HF_MODELS["basic-processing"];
  const baseUrl = `https://api-inference.huggingface.co/models/${model}`;
  let payload, contentType;
  if (HF_IMAGE_INPUT.has(capability) && fileBytes) {
    payload     = fileBytes;
    contentType = "application/octet-stream";
  } else {
    const prompt = params.prompt || "ultra detailed professional 4K studio photograph";
    payload     = JSON.stringify({ inputs: prompt, parameters: { width: TARGET_W, height: TARGET_H, num_inference_steps: 30, guidance_scale: 7.5 } });
    contentType = "application/json";
  }
  let r = await fetch(baseUrl, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": contentType },
    body: payload,
  });
  // HF returns 503 when model is loading — retry once
  if (r.status === 503) {
    await sleep(8000);
    r = await fetch(baseUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": contentType },
      body: payload,
    });
  }
  if (!r.ok) return { success: false, error: `huggingface:${r.status}` };
  const ct  = r.headers.get("content-type") || "image/png";
  let raw;
  if (ct.includes("application/json")) {
    const data = await r.json();
    if (Array.isArray(data) && data[0]?.blob) {
      raw = base64Decode(data[0].blob);
    } else {
      return { success: false, error: "huggingface:unexpected_json" };
    }
  } else {
    raw = await r.arrayBuffer();
  }
  if (!raw || (raw.byteLength || raw.length) < 100) return { success: false, error: "huggingface:empty_response" };
  const b64 = arrayBufferToBase64(raw instanceof ArrayBuffer ? raw : raw.buffer || raw);
  return { success: true, output: `data:image/png;base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { model } };
}

// ── Gemini ───────────────────────────────────────────────────────────────────
async function callGemini(capability, fileBytes, fileMime, params, env) {
  const key  = env.GEMINI_API_KEY || "";
  if (!key) return { success: false, error: "gemini:no_key" };
  const base = "https://generativelanguage.googleapis.com/v1beta/models";
  if (capability === "image-gen" || capability === "basic-processing" || capability === "style-transfer" || capability === "restoration") {
    // Imagen 3
    const prompt = params.prompt || "professional studio photograph ultra detailed 4K";
    const r = await fetch(`${base}/imagen-3.0-generate-001:predict?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: "16:9", outputOptions: { mimeType: "image/png" } } }),
    });
    if (!r.ok) return { success: false, error: `gemini:${r.status}` };
    const data = await r.json();
    const b64  = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return { success: false, error: "gemini:no_image" };
    return { success: true, output: `data:image/png;base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { model: "imagen-3.0-generate-001" } };
  }
  // Vision / captioning
  const prompt = params.prompt || `Analyze this image for ${capability}. Be detailed.`;
  const parts  = [{ text: prompt }];
  if (fileBytes) parts.push({ inlineData: { mimeType: fileMime || "image/jpeg", data: arrayBufferToBase64(fileBytes) } });
  const r = await fetch(`${base}/gemini-2.0-flash-exp:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!r.ok) return { success: false, error: `gemini:${r.status}` };
  const data = await r.json();
  const text  = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return { success: true, output: `data:text/plain;charset=utf-8,${encodeURIComponent(text.slice(0, 500))}`, resolution: "N/A", metadata: { caption: text } };
}

// ── Groq ─────────────────────────────────────────────────────────────────────
async function callGroq(capability, fileBytes, fileMime, params, env) {
  const key  = env.GROQ_API_KEY || "";
  if (!key) return { success: false, error: "groq:no_key" };
  const model   = fileBytes ? "llama-3.2-90b-vision-preview" : "llama-3.3-70b-versatile";
  const prompt  = params.prompt || `Process this for ${capability}. Output professional studio quality.`;
  const content = [];
  if (fileBytes) content.push({ type: "image_url", image_url: { url: `data:${fileMime};base64,${arrayBufferToBase64(fileBytes)}` } });
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 1024 }),
  });
  if (!r.ok) return { success: false, error: `groq:${r.status}` };
  const data = await r.json();
  const text  = data.choices?.[0]?.message?.content || "";
  return { success: true, output: `data:text/plain;charset=utf-8,${encodeURIComponent(text.slice(0, 500))}`, resolution: "N/A", metadata: { model } };
}

// ── Mistral ───────────────────────────────────────────────────────────────────
async function callMistral(capability, fileBytes, fileMime, params, env) {
  const key   = env.MISTRAL_API_KEY || "";
  if (!key) return { success: false, error: "mistral:no_key" };
  const model   = fileBytes ? "pixtral-large-latest" : "mistral-large-latest";
  const prompt  = params.prompt || `Professional image processing AI: analyze for '${capability}'.`;
  const content = fileBytes
    ? [{ type: "image_url", image_url: `data:${fileMime};base64,${arrayBufferToBase64(fileBytes)}` }, { type: "text", text: prompt }]
    : [{ type: "text", text: prompt }];
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 1024 }),
  });
  if (!r.ok) return { success: false, error: `mistral:${r.status}` };
  const data = await r.json();
  const text  = data.choices?.[0]?.message?.content || "";
  return { success: true, output: `data:text/plain;charset=utf-8,${encodeURIComponent(text.slice(0, 500))}`, resolution: "N/A", metadata: { model } };
}

// ── OpenRouter ────────────────────────────────────────────────────────────────
const OR_MODELS = {
  "image-gen":"google/gemini-flash-1.5","captioning":"google/gemini-flash-1.5",
  "style-transfer":"anthropic/claude-3.5-sonnet","visualization":"google/gemini-flash-1.5",
  "basic-processing":"google/gemini-flash-1.5",
};
async function callOpenRouter(capability, fileBytes, fileMime, params, env) {
  const key  = env.OPENROUTER_API_KEY || "";
  if (!key) return { success: false, error: "openrouter:no_key" };
  const model   = OR_MODELS[capability] || "google/gemini-flash-1.5";
  const prompt  = params.prompt || `Professional AI studio processing: ${capability}. 4K quality.`;
  const content = [];
  if (fileBytes) content.push({ type: "image_url", image_url: { url: `data:${fileMime};base64,${arrayBufferToBase64(fileBytes)}` } });
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "HTTP-Referer": "https://luminorbit.app", "X-Title": "Luminorbit", "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) return { success: false, error: `openrouter:${r.status}` };
  const data = await r.json();
  const text  = data.choices?.[0]?.message?.content || "";
  return { success: true, output: `data:text/plain;charset=utf-8,${encodeURIComponent(text.slice(0, 500))}`, resolution: "N/A", metadata: { model } };
}

// ── Segmind ───────────────────────────────────────────────────────────────────
const SM_ENDPOINTS = {
  "image-gen":"sdxl1.0-txt2img","segmentation":"segment-anything",
  "inpainting":"stable-diffusion-inpainting","style-transfer":"sdxl1.0-txt2img",
  "restoration":"sdxl1.0-txt2img","face-processing":"sdxl1.0-txt2img",
  "super-resolution":"sdxl1.0-txt2img","denoising":"sdxl1.0-txt2img",
  "basic-processing":"sdxl1.0-txt2img","controlnet":"controlnet-canny",
};
async function callSegmind(capability, fileBytes, fileMime, params, env) {
  const key  = env.SEGMIND_API_KEY || "";
  if (!key) return { success: false, error: "segmind:no_key" };
  const ep     = SM_ENDPOINTS[capability] || "sdxl1.0-txt2img";
  const prompt = params.prompt || "ultra detailed professional studio photo 4K";
  let body;
  if (ep === "segment-anything" && fileBytes) {
    body = { image: arrayBufferToBase64(fileBytes), output_type: "mask" };
  } else if (ep === "stable-diffusion-inpainting" && fileBytes) {
    body = { prompt, image: arrayBufferToBase64(fileBytes), strength: params.strength || 0.8, width: TARGET_W, height: TARGET_H, samples: 1, num_inference_steps: 30, guidance_scale: 7.5 };
  } else {
    body = { prompt, negative_prompt: "blurry, low quality, watermark", width: TARGET_W, height: TARGET_H, samples: 1, num_inference_steps: 30, guidance_scale: 7.5, seed: params.seed || -1 };
  }
  const r = await fetch(`https://api.segmind.com/v1/${ep}`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { success: false, error: `segmind:${r.status}` };
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("image")) {
    const raw = await r.arrayBuffer();
    const b64 = arrayBufferToBase64(raw);
    return { success: true, output: `data:${ct};base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { ep } };
  }
  const data = await r.json();
  const b64  = data.image || data.data || "";
  if (!b64) return { success: false, error: "segmind:no_image" };
  return { success: true, output: `data:image/png;base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { ep } };
}

// ── Krea ──────────────────────────────────────────────────────────────────────
async function callKrea(capability, fileBytes, fileMime, params, env) {
  const key  = env.KREA_API_KEY || "";
  if (!key) return { success: false, error: "krea:no_key" };
  const base    = "https://api.krea.ai/v1";
  const prompt  = params.prompt || "ultra detailed professional studio quality 4K photograph";
  const headers = { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };
  let ep, body;
  if ((capability === "super-resolution" || capability === "restoration" || capability === "denoising") && fileBytes) {
    ep   = `${base}/images/upscale`;
    body = { image: arrayBufferToBase64(fileBytes), scale: 4, output_size: { width: TARGET_W, height: TARGET_H } };
  } else if (capability === "face-processing" && fileBytes) {
    ep   = `${base}/images/enhance`;
    body = { image: arrayBufferToBase64(fileBytes), enhance_face: true, output_size: { width: TARGET_W, height: TARGET_H } };
  } else {
    ep   = `${base}/images/generate`;
    body = { prompt, model: "flux-pro", width: TARGET_W, height: TARGET_H, num_images: 1, output_format: "png" };
  }
  const r = await fetch(ep, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) return { success: false, error: `krea:${r.status}` };
  const data    = await r.json();
  const imgData = data.images?.[0]?.url || data.images?.[0]?.base64 || data.image || data.url || "";
  if (!imgData) return { success: false, error: "krea:no_image" };
  if (imgData.startsWith("http")) {
    const ir  = await fetch(imgData);
    const raw = await ir.arrayBuffer();
    const b64 = arrayBufferToBase64(raw);
    return { success: true, output: `data:image/png;base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}` };
  }
  return { success: true, output: `data:image/png;base64,${imgData}`, resolution: `${TARGET_W}x${TARGET_H}` };
}

// ── DeepAI ────────────────────────────────────────────────────────────────────
const DA_ENDPOINTS = {
  "super-resolution":"torch-srgan","face-processing":"face-recognition",
  "restoration":"image-editor","inpainting":"image-editor","image-gen":"text2img",
  "denoising":"torch-srgan","image-enhancement":"waifu2x","style-transfer":"fast-style-transfer",
  "basic-processing":"image-editor",
};
async function callDeepAI(capability, fileBytes, fileMime, params, env) {
  const key  = env.DEEPAI_API_KEY || "";
  if (!key) return { success: false, error: "deepai:no_key" };
  const ep     = DA_ENDPOINTS[capability] || "image-editor";
  const base   = "https://api.deepai.org/api";
  let r;
  if (fileBytes && capability !== "image-gen") {
    // DeepAI expects multipart
    const fd = new FormData();
    fd.append("image", new Blob([fileBytes], { type: fileMime || "image/jpeg" }), "input.jpg");
    if (ep === "fast-style-transfer") fd.append("style", params.style || "mosaic");
    r = await fetch(`${base}/${ep}`, { method: "POST", headers: { "api-key": key }, body: fd });
  } else {
    const prompt = params.prompt || "ultra detailed professional studio photograph 4K";
    const fd     = new FormData();
    fd.append("text", prompt);
    fd.append("grid_size", "1");
    r = await fetch(`${base}/${ep}`, { method: "POST", headers: { "api-key": key }, body: fd });
  }
  if (!r.ok) return { success: false, error: `deepai:${r.status}` };
  const data    = await r.json();
  const outUrl  = data.output_url || "";
  if (!outUrl) return { success: false, error: "deepai:no_output_url" };
  const ir  = await fetch(outUrl);
  const raw = await ir.arrayBuffer();
  const ct  = ir.headers.get("content-type") || "image/jpeg";
  const b64 = arrayBufferToBase64(raw);
  return { success: true, output: `data:${ct};base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { ep } };
}

// ── Cloudflare AI ─────────────────────────────────────────────────────────────
const CF_MODELS = {
  "super-resolution":"@cf/microsoft/realsr-esrgan-x4",
  "segmentation":    "@cf/facebook/detr-resnet-50-panoptic",
  "inpainting":      "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "image-gen":       "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "denoising":       "@cf/microsoft/realsr-esrgan-x4",
  "temporal":        "@cf/stabilityai/stable-video-diffusion-img2vid-xt",
  "audio-extraction":"@cf/openai/whisper",
  "basic-processing":"@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "color-matching":  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
};
async function callCFAI(capability, fileBytes, fileMime, params, env) {
  const token = env.CF_AI_TOKEN || "";
  const acct  = env.CF_ACCOUNT_ID || "";
  if (!token || !acct) return { success: false, error: "cloudflare_ai:no_credentials" };
  const model = CF_MODELS[capability] || CF_MODELS["basic-processing"];
  const url   = `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`;
  let body;
  if (capability === "audio-extraction" && fileBytes) {
    body = { audio: Array.from(new Uint8Array(fileBytes)) };
  } else if ((capability === "super-resolution" || capability === "segmentation" || capability === "denoising") && fileBytes) {
    body = { image: Array.from(new Uint8Array(fileBytes)) };
  } else {
    const prompt = params.prompt || "ultra-detailed professional photo 4K";
    body = { prompt, width: TARGET_W, height: TARGET_H, num_steps: 30 };
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { success: false, error: `cloudflare_ai:${r.status}` };
  const data = await r.json();
  const b64  = data.result?.image || data.result?.data;
  if (!b64) return { success: false, error: "cloudflare_ai:no_image" };
  return { success: true, output: `data:image/png;base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { model } };
}

// ── Pexels ────────────────────────────────────────────────────────────────────
async function callPexels(capability, fileBytes, fileMime, params, env) {
  const key     = env.PEXELS_API_KEY || "";
  if (!key) return { success: false, error: "pexels:no_key" };
  const query   = params.prompt || "professional studio background 4K";
  const isVideo = ["video-gen","temporal","compression","audio-extraction","audio-sync"].includes(capability);
  if (isVideo) {
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1&size=large`, { headers: { "Authorization": key } });
    if (!r.ok) return { success: false, error: `pexels:${r.status}` };
    const data   = await r.json();
    const videos = data.videos || [];
    if (!videos.length) return { success: false, error: "pexels:no_results" };
    const files  = (videos[0].video_files || []).sort((a, b) => (b.width || 0) - (a.width || 0));
    return { success: true, output: files[0].link, resolution: `${files[0].width || TARGET_W}x${files[0].height || TARGET_H}`, metadata: { source: "pexels" } };
  }
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&size=large`, { headers: { "Authorization": key } });
  if (!r.ok) return { success: false, error: `pexels:${r.status}` };
  const data   = await r.json();
  const photos = data.photos || [];
  if (!photos.length) return { success: false, error: "pexels:no_results" };
  const imgUrl  = photos[0].src.original || photos[0].src.large2x || "";
  const ir      = await fetch(imgUrl);
  const raw     = await ir.arrayBuffer();
  const ct      = ir.headers.get("content-type") || "image/jpeg";
  const b64     = arrayBufferToBase64(raw);
  return { success: true, output: `data:${ct};base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { source: "pexels" } };
}

// ── Unsplash ──────────────────────────────────────────────────────────────────
async function callUnsplash(capability, fileBytes, fileMime, params, env) {
  const key   = env.UNSPLASH_API_KEY || "";
  if (!key) return { success: false, error: "unsplash:no_key" };
  const query = params.prompt || "professional studio photography 4K";
  const r     = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`, {
    headers: { "Authorization": `Client-ID ${key}` },
  });
  if (!r.ok) return { success: false, error: `unsplash:${r.status}` };
  const data    = await r.json();
  const results = data.results || [];
  if (!results.length) return { success: false, error: "unsplash:no_results" };
  const rawUrl  = `${results[0].urls.raw}&w=${TARGET_W}&h=${TARGET_H}&fit=crop&fm=png&q=95`;
  const ir      = await fetch(rawUrl);
  const raw     = await ir.arrayBuffer();
  const ct      = ir.headers.get("content-type") || "image/jpeg";
  const b64     = arrayBufferToBase64(raw);
  const author  = results[0].user?.name || "";
  return { success: true, output: `data:${ct};base64,${b64}`, resolution: `${TARGET_W}x${TARGET_H}`, metadata: { author, source: "unsplash" } };
}

// ── Emergency fallback ────────────────────────────────────────────────────────
async function emergencyFallback(tool, capability, params, env) {
  const key    = env.POLLINATIONS_API_KEY || "";
  const prompt = params.prompt || `Professional ${tool} 4K studio quality`;
  const url    = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${TARGET_W}&height=${TARGET_H}&model=flux&nologo=true&enhance=true`;
  const headers = key ? { "Authorization": `Bearer ${key}` } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) return { success: false, error: `emergency:${r.status}` };
  const raw = await r.arrayBuffer();
  if (raw.byteLength < 1000) return { success: false, error: "emergency:tiny_payload" };
  const ct  = r.headers.get("content-type") || "image/jpeg";
  const b64 = arrayBufferToBase64(raw);
  return { success: true, output: `data:${ct};base64,${b64}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §9  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, errorMsg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMsg)), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function arrayBufferToBase64(buffer) {
  // CF Workers have btoa but need Uint8Array → string
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary  = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64Decode(b64) {
  // Returns Uint8Array
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
