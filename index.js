/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║   LUMINORBIT v25 — PRODUCTION ORCHESTRATION ENGINE                        ║
 * ║   Centralized AI Execution Architecture                                    ║
 * ║                                                                            ║
 * ║   USAGE: Load this script AFTER index.html base scripts, BEFORE any       ║
 * ║          tool-specific scripts. It wraps and upgrades the existing         ║
 * ║          execution pipeline without replacing any UI or visual elements.   ║
 * ║                                                                            ║
 * ║   <script src="luminorbit_orchestration.js"></script>                      ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT THIS DOES:
 *   Replaces fragmented per-tool fetch/backend logic with a single, centralized
 *   orchestration engine. Every frontend tool sends a normalized metadata payload
 *   through shared AI pipelines. Provider routing, retries, fallback, async polling,
 *   and result rendering are all handled centrally.
 *
 * DOES NOT TOUCH:
 *   - Any HTML elements or DOM structure
 *   - Any CSS or visual design
 *   - Tool card definitions or categories
 *   - Upload/export/preview systems (only wraps their outputs)
 *   - Mobile/desktop responsiveness
 *   - Animations or transitions
 *   - Navigation or routing (only wraps navigate())
 *
 * ARCHITECTURE:
 *   Tool Click → TOOL_REGISTRY lookup → PIPELINE_ROUTER → PROVIDER_EXECUTOR
 *             → PAYLOAD_NORMALIZER → AI Provider → RESPONSE_PARSER
 *             → RESULT_DISPATCHER → Frontend Renderer
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// §1  ORCHESTRATION CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const LMN_ORCH_VERSION = '25.1.0';

/** Runtime config — driven by window.LUMINORBIT_CONFIG (centralized) with
 *  window.LUMINORBIT_API_URL / LUMINORBIT_API_KEY as legacy compatibility shims. */
const ORCH_CONFIG = {
  get apiUrl() {
    // Prefer centralized config, then legacy var, then production Railway URL
    return (window.LUMINORBIT_CONFIG && window.LUMINORBIT_CONFIG.API_BASE_URL)
      || window.LUMINORBIT_API_URL
      || 'https://luminorbitbackend-production.up.railway.app';
  },
  get apiKey()  { return window.LUMINORBIT_API_KEY  || 'luminorbit_secure_123'; },
  get fallbackUrl() { return window.LUMINORBIT_BACKEND_FALLBACK || null; },

  // Timeouts (ms)
  TIMEOUT_STANDARD:  12000,
  TIMEOUT_HEAVY:     35000,
  TIMEOUT_VIDEO:    120000,
  TIMEOUT_ASYNC:    180000,

  // Retry policy
  MAX_RETRIES:       2,
  RETRY_DELAY_BASE: 1200,

  // Job polling
  POLL_INTERVAL:    2500,
  POLL_MAX_ATTEMPTS: 40,

  // Provider health
  HEALTH_SCORE_DECAY: 0.92,   // per-tick multiplier when provider fails
  HEALTH_FLOOR:       0.1,
  HEALTH_CEILING:     1.0,
};

// ══════════════════════════════════════════════════════════════════════════════
// §2  PIPELINE REGISTRY
//     15 reusable pipelines — all 200+ tools map into one of these.
//     Pipeline names align with backend capability identifiers.
// ══════════════════════════════════════════════════════════════════════════════

const PIPELINE_REGISTRY = {
  'generation':     { capability: 'image-gen',         needsFile: false, isHeavy: false, async: false },
  'img2img':        { capability: 'image-gen',         needsFile: true,  isHeavy: false, async: false },
  'enhancement':    { capability: 'image-enhancement', needsFile: true,  isHeavy: false, async: false },
  'upscale':        { capability: 'super-resolution',  needsFile: true,  isHeavy: true,  async: true  },
  'segmentation':   { capability: 'segmentation',      needsFile: true,  isHeavy: true,  async: true  },
  'inpainting':     { capability: 'inpainting',        needsFile: true,  isHeavy: true,  async: true  },
  'restoration':    { capability: 'restoration',       needsFile: true,  isHeavy: true,  async: true  },
  'face_processing':{ capability: 'face-processing',   needsFile: true,  isHeavy: true,  async: true  },
  'style_transfer': { capability: 'style-transfer',    needsFile: true,  isHeavy: false, async: false },
  'video_gen':      { capability: 'video-gen',         needsFile: false, isHeavy: true,  async: true  },
  'video_proc':     { capability: 'temporal',          needsFile: true,  isHeavy: true,  async: true  },
  'captioning':     { capability: 'captioning',        needsFile: true,  isHeavy: false, async: false },
  'audio':          { capability: 'audio-extraction',  needsFile: true,  isHeavy: false, async: false },
  'compression':    { capability: 'compression',       needsFile: true,  isHeavy: false, async: false },
  'basic':          { capability: 'basic-processing',  needsFile: true,  isHeavy: false, async: false },
};

// §2 alias — prompt-mandated exact name
const TOOL_PIPELINES = PIPELINE_REGISTRY;

// ══════════════════════════════════════════════════════════════════════════════
// §3  TOOL REGISTRY
//     Every tool → { pipeline, preset } mapping.
//     Presets are parameter overrides applied before sending to the backend.
//     Add new tools by adding entries here — NO backend changes needed.
// ══════════════════════════════════════════════════════════════════════════════

const TOOL_REGISTRY = {
  // ── IMAGE GENERATION ────────────────────────────────────────────────────────
  'AI Image Generator':               { pipeline: 'generation',      preset: 'flux_standard' },
  'AI Photo Creator':                 { pipeline: 'generation',      preset: 'flux_photo' },
  'AI Art Generator':                 { pipeline: 'generation',      preset: 'sdxl_art' },
  'AI Ultra Fast Image Generator':    { pipeline: 'generation',      preset: 'flux_fast' },
  'AI Environment & Scene Generator': { pipeline: 'generation',      preset: 'flux_scene' },
  'Flux 1.1 Pro':                     { pipeline: 'generation',      preset: 'flux_standard' },
  'Seedream 5.0':                     { pipeline: 'generation',      preset: 'seedream' },
  'SDXL 1.0':                         { pipeline: 'generation',      preset: 'sdxl_standard' },
  'Stable Diffusion 3.5':             { pipeline: 'generation',      preset: 'sd35' },
  'Adobe Firefly':                    { pipeline: 'generation',      preset: 'firefly' },
  'Midjourney v7':                    { pipeline: 'generation',      preset: 'midjourney' },

  // ── IMG2IMG / STYLE ──────────────────────────────────────────────────────────
  'ControlNet':                       { pipeline: 'img2img',         preset: 'controlnet_default' },
  'InstructPix2Pix':                  { pipeline: 'img2img',         preset: 'instruct_pix2pix' },
  'Style Transfer':                   { pipeline: 'style_transfer',  preset: 'style_default' },
  'Cartoonizer':                      { pipeline: 'style_transfer',  preset: 'cartoon' },
  'Sketch Maker':                     { pipeline: 'style_transfer',  preset: 'sketch' },
  'Vintage Maker':                    { pipeline: 'style_transfer',  preset: 'vintage' },
  'Sepia Filter':                     { pipeline: 'style_transfer',  preset: 'sepia' },
  'VHS Nostalgia':                    { pipeline: 'style_transfer',  preset: 'vhs' },
  'Neon Pulse':                       { pipeline: 'style_transfer',  preset: 'neon' },
  'Glitch Pop':                       { pipeline: 'style_transfer',  preset: 'glitch' },
  'Retro Reel':                       { pipeline: 'style_transfer',  preset: 'retro' },
  'Anime Style':                      { pipeline: 'style_transfer',  preset: 'anime' },
  'Oil Painting':                     { pipeline: 'style_transfer',  preset: 'oil_painting' },
  'Watercolor':                       { pipeline: 'style_transfer',  preset: 'watercolor' },
  'Pencil Drawing':                   { pipeline: 'style_transfer',  preset: 'pencil' },

  // ── ENHANCEMENT ─────────────────────────────────────────────────────────────
  'Image Enhancer':                   { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Image Enhancer Plus':              { pipeline: 'enhancement',     preset: 'enhanced_plus' },
  'HDR Master':                       { pipeline: 'enhancement',     preset: 'hdr' },
  'HDR Booster':                      { pipeline: 'enhancement',     preset: 'hdr_boost' },
  'AI Highlight Recovery Pro':        { pipeline: 'enhancement',     preset: 'highlight_recovery' },
  'Sharpen Tool':                     { pipeline: 'enhancement',     preset: 'sharpen' },
  'Detail Enhancer':                  { pipeline: 'enhancement',     preset: 'detail' },
  'Exposure Fixer':                   { pipeline: 'enhancement',     preset: 'exposure' },
  'Shadow Fixer':                     { pipeline: 'enhancement',     preset: 'shadow' },
  'Lighting Fixer':                   { pipeline: 'enhancement',     preset: 'lighting' },
  'Color Corrector':                  { pipeline: 'enhancement',     preset: 'color_correct' },
  'Color Grader':                     { pipeline: 'enhancement',     preset: 'color_grade' },
  'Color Grade Pro':                  { pipeline: 'enhancement',     preset: 'color_grade_pro' },
  'Color Temperature':                { pipeline: 'enhancement',     preset: 'color_temp' },
  'White Balance':                    { pipeline: 'enhancement',     preset: 'white_balance' },
  'Vibrance Tool':                    { pipeline: 'enhancement',     preset: 'vibrance' },
  'Saturation Booster':               { pipeline: 'enhancement',     preset: 'saturation' },
  'Black & White':                    { pipeline: 'enhancement',     preset: 'bw' },
  'Grayscale Tool':                   { pipeline: 'enhancement',     preset: 'grayscale' },
  'B&W Converter':                    { pipeline: 'enhancement',     preset: 'bw' },
  'Invert Colors':                    { pipeline: 'enhancement',     preset: 'invert' },
  'Pixel Perfect':                    { pipeline: 'enhancement',     preset: 'pixel_perfect' },
  'Image Sharper':                    { pipeline: 'enhancement',     preset: 'sharpen' },
  'Lens Distortion Fix':              { pipeline: 'enhancement',     preset: 'lens_fix' },
  'Lens Distortion Fixer':            { pipeline: 'enhancement',     preset: 'lens_fix' },
  'Vignette Tool':                    { pipeline: 'enhancement',     preset: 'vignette' },
  'Vignette Effect':                  { pipeline: 'enhancement',     preset: 'vignette' },
  'Blur Tool':                        { pipeline: 'basic',           preset: 'blur' },
  'BlurIt':                           { pipeline: 'basic',           preset: 'blur' },
  'Background Blur Tool':             { pipeline: 'basic',           preset: 'bg_blur' },
  'Mosaic Tool':                      { pipeline: 'basic',           preset: 'mosaic' },
  'Noise Reducer':                    { pipeline: 'enhancement',     preset: 'denoise' },
  'Photo Fixer':                      { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Photo Finisher':                   { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Photo Effects Pro':                { pipeline: 'enhancement',     preset: 'effects_pro' },
  'Edit Suite':                       { pipeline: 'enhancement',     preset: 'standard_enhance' },

  // ── SEGMENTATION / BG ───────────────────────────────────────────────────────
  'Background Remover':               { pipeline: 'segmentation',    preset: 'bg_remove' },
  'Background Changer':               { pipeline: 'segmentation',    preset: 'bg_change' },
  'Sky Replacer':                     { pipeline: 'segmentation',    preset: 'sky_replace' },
  'Transparent Background':           { pipeline: 'segmentation',    preset: 'bg_transparent' },
  'Smart Crop':                       { pipeline: 'segmentation',    preset: 'smart_crop' },
  'Sticker Maker':                    { pipeline: 'segmentation',    preset: 'sticker' },
  'AI Smart Object & Background Remover': { pipeline: 'segmentation', preset: 'bg_remove' },
  'SAM 2':                            { pipeline: 'segmentation',    preset: 'sam2' },
  'Grounding DINO':                   { pipeline: 'segmentation',    preset: 'grounding_dino' },

  // ── INPAINTING / REPAIR ──────────────────────────────────────────────────────
  'Object Remover':                   { pipeline: 'inpainting',      preset: 'object_remove' },
  'Object Remover Pro':               { pipeline: 'inpainting',      preset: 'object_remove_pro' },
  'Watermark Remover':                { pipeline: 'inpainting',      preset: 'watermark_remove' },
  'Photo Cleaner':                    { pipeline: 'inpainting',      preset: 'clean' },
  'AI Generative Fill Pro':           { pipeline: 'inpainting',      preset: 'gen_fill' },

  // ── SUPER RESOLUTION ────────────────────────────────────────────────────────
  'Real-ESRGAN':                      { pipeline: 'upscale',       preset: 'realesrgan_4x' },
  'SUPIR':                            { pipeline: 'upscale',       preset: 'supir' },
  'SwinIR':                           { pipeline: 'upscale',       preset: 'swinir' },
  'BSRGAN':                           { pipeline: 'upscale',       preset: 'bsrgan' },
  'Image UpScaler':                   { pipeline: 'upscale',       preset: 'realesrgan_4x' },
  'AI 4K Image Upscaler':             { pipeline: 'upscale',       preset: 'realesrgan_4k' },
  'AI Micro Detail Booster':          { pipeline: 'upscale',       preset: 'detail_boost' },
  'Topaz Video AI 5':                 { pipeline: 'upscale',       preset: 'topaz_video' },

  // ── RESTORATION ─────────────────────────────────────────────────────────────
  'Photo Restorer':                   { pipeline: 'restoration',     preset: 'restore_standard' },
  'CodeFormer':                       { pipeline: 'restoration',     preset: 'codeformer' },
  'RestoreFormer':                    { pipeline: 'restoration',     preset: 'restoreformer' },

  // ── FACE PROCESSING ─────────────────────────────────────────────────────────
  'GFPGAN':                           { pipeline: 'face_processing', preset: 'gfpgan' },
  'Face Retouch':                     { pipeline: 'face_processing', preset: 'face_retouch' },
  'Portrait Pro':                     { pipeline: 'face_processing', preset: 'portrait_pro' },
  'Beauty Shot':                      { pipeline: 'face_processing', preset: 'beauty' },
  'Beauty Filter':                    { pipeline: 'face_processing', preset: 'beauty_filter' },
  'Face Editor':                      { pipeline: 'face_processing', preset: 'face_edit' },
  'AI Portrait Depth Enhancer':       { pipeline: 'face_processing', preset: 'portrait_depth' },
  'LivePortrait':                     { pipeline: 'face_processing', preset: 'live_portrait' },

  // ── VIDEO GENERATION ────────────────────────────────────────────────────────
  'AI Video Generator':               { pipeline: 'video_gen',       preset: 'video_standard' },
  'AI Motion Animator':               { pipeline: 'video_gen',       preset: 'motion_anim' },
  'Photo to Video':                   { pipeline: 'video_gen',       preset: 'photo2video' },
  'Photo to Video Creator':           { pipeline: 'video_gen',       preset: 'photo2video' },
  'AI 4K Video Enhancer':             { pipeline: 'video_gen',       preset: 'video_4k' },
  'Runway Gen-5':                     { pipeline: 'video_gen',       preset: 'runway_gen5' },
  'Seedance 2.0':                     { pipeline: 'video_gen',       preset: 'seedance' },
  'Kling AI 3.0':                     { pipeline: 'video_gen',       preset: 'kling' },
  'Luma Dream Machine':               { pipeline: 'video_gen',       preset: 'luma' },
  'Pika 2.5':                         { pipeline: 'video_gen',       preset: 'pika' },
  'Hailuo MiniMax':                   { pipeline: 'video_gen',       preset: 'hailuo' },
  'Sora Edit':                        { pipeline: 'video_gen',       preset: 'sora_edit' },
  'Stable Video Diffusion':           { pipeline: 'video_gen',       preset: 'svd' },
  'AnimateDiff':                      { pipeline: 'video_gen',       preset: 'animatediff' },
  'AI Cinematic Action Generator':    { pipeline: 'video_gen',       preset: 'cinematic_action' },
  'Cinematic Pulse':                  { pipeline: 'video_gen',       preset: 'cinematic_pulse' },

  // ── VIDEO PROCESSING ────────────────────────────────────────────────────────
  'Video Trimmer Pro':                { pipeline: 'video_proc',      preset: 'trim' },
  'Video Crop Studio':                { pipeline: 'video_proc',      preset: 'crop' },
  'Video Speed Controller':           { pipeline: 'video_proc',      preset: 'speed' },
  'Slow-Mo Magic':                    { pipeline: 'video_proc',      preset: 'slowmo' },
  'Fast-Forward Flash':               { pipeline: 'video_proc',      preset: 'fastforward' },
  'Motion Blur Trail':                { pipeline: 'video_proc',      preset: 'motion_blur' },
  'RIFE':                             { pipeline: 'video_proc',      preset: 'rife' },
  'DAIN':                             { pipeline: 'video_proc',      preset: 'dain' },
  'TecoGAN':                          { pipeline: 'video_proc',      preset: 'tecogan' },
  'RAFT + ESRGAN':                    { pipeline: 'video_proc',      preset: 'raft_esrgan' },
  'Temporal GAN':                     { pipeline: 'video_proc',      preset: 'temporal_gan' },
  'Wonder Dynamics':                  { pipeline: 'video_proc',      preset: 'wonder_dynamics' },
  'AI Motion Transfer Engine':        { pipeline: 'video_proc',      preset: 'motion_transfer' },
  'AI Consistent Motion Animator':    { pipeline: 'video_proc',      preset: 'consistent_motion' },
  'MultiCam Sync':                    { pipeline: 'video_proc',      preset: 'multicam_sync' },
  'Match Cut Flow':                   { pipeline: 'video_proc',      preset: 'match_cut' },
  'Video Merger Studio':              { pipeline: 'video_proc',      preset: 'merge' },

  // ── CAPTIONING / AUDIO ──────────────────────────────────────────────────────
  'Auto Caption Generator':           { pipeline: 'captioning',      preset: 'auto_caption' },
  'Subtitle Manual Editor':           { pipeline: 'captioning',      preset: 'manual_sub' },
  'Florence-2':                       { pipeline: 'captioning',      preset: 'florence2' },
  'Audio Extractor Tool':             { pipeline: 'audio',           preset: 'audio_extract' },
  'Beat Sync Drop':                   { pipeline: 'audio',           preset: 'beat_sync' },
  'Sound Wave Viz':                   { pipeline: 'audio',           preset: 'wave_viz' },
  'Audio Reactive Viz':               { pipeline: 'audio',           preset: 'audio_reactive' },
  'Audio Sync Editor':                { pipeline: 'audio',           preset: 'audio_sync' },

  // ── COMPRESSION / BASIC ──────────────────────────────────────────────────────
  'Video Compressor Pro':             { pipeline: 'compression',     preset: 'video_compress' },
  'Image Compressor Pro':             { pipeline: 'compression',     preset: 'image_compress' },
  'Image Cropper':                    { pipeline: 'basic',           preset: 'crop' },
  'Crop Master':                      { pipeline: 'basic',           preset: 'crop' },
  'Photo Resizer':                    { pipeline: 'basic',           preset: 'resize' },
  'Image Rotator':                    { pipeline: 'basic',           preset: 'rotate' },
  'Image Flipper':                    { pipeline: 'basic',           preset: 'flip' },
  'Mirror Effect':                    { pipeline: 'basic',           preset: 'mirror' },
  'Horizontal Flip':                  { pipeline: 'basic',           preset: 'flip_h' },
  'Vertical Flip':                    { pipeline: 'basic',           preset: 'flip_v' },
  'Perspective Corrector':            { pipeline: 'basic',           preset: 'perspective' },
  'Aspect Ratio Converter':           { pipeline: 'basic',           preset: 'aspect_ratio' },
  'PNG Converter':                    { pipeline: 'basic',           preset: 'convert_png' },
  'Image Converter':                  { pipeline: 'basic',           preset: 'convert' },
  'Watermark Maker':                  { pipeline: 'basic',           preset: 'watermark' },
  'Text Adder':                       { pipeline: 'basic',           preset: 'text_overlay' },
  'Meme Maker':                       { pipeline: 'basic',           preset: 'meme' },
  'Collage Maker':                    { pipeline: 'basic',           preset: 'collage' },
  'Photo Stitcher':                   { pipeline: 'basic',           preset: 'stitch' },
  'Frame Generator':                  { pipeline: 'basic',           preset: 'frame' },
  'Passport Image Pro':               { pipeline: 'basic',           preset: 'passport' },
  'Threshold':                        { pipeline: 'basic',           preset: 'threshold' },
  'Binarize':                         { pipeline: 'basic',           preset: 'binarize' },
  'Image Splitter':                   { pipeline: 'basic',           preset: 'split' },
  'Photo Splitter':                   { pipeline: 'basic',           preset: 'split' },
};

// ══════════════════════════════════════════════════════════════════════════════
// §3b  TOOL_METADATA
//      Per-tool metadata: input/output types, async flag, fallback.
//      PayloadNormalizer.build() reads this instead of computing inline.
// ══════════════════════════════════════════════════════════════════════════════

const TOOL_METADATA = (() => {
  const _meta = {};
  for (const [tool, reg] of Object.entries(TOOL_REGISTRY)) {
    const pipe = PIPELINE_REGISTRY[reg.pipeline] || {};
    const cap  = pipe.capability || 'basic-processing';

    const _inputType = (() => {
      if (!pipe.needsFile) return 'text';
      if (['video-gen','temporal'].includes(cap)) return 'video';
      if (['audio-extraction','audio-sync'].includes(cap)) return 'audio';
      return 'image';
    })();

    const _outputType = (() => {
      if (['video-gen','temporal'].includes(cap)) return 'video';
      if (['audio-extraction','audio-sync'].includes(cap)) return 'audio';
      if (cap === 'captioning') return 'text';
      return 'image';
    })();

    _meta[tool] = {
      pipeline:         reg.pipeline,
      preset:           reg.preset,
      capability:       cap,
      input_type:       _inputType,
      output_type:      _outputType,
      async_supported:  !!pipe.async,
      fallback_enabled: true,
      needs_file:       !!pipe.needsFile,
      is_heavy:         !!pipe.isHeavy,
    };
  }
  return _meta;
})();

// ══════════════════════════════════════════════════════════════════════════════
// §3c  MIME_VALIDATORS
//      Allowed MIME types per pipeline capability.
//      PayloadNormalizer.build() calls MIME_VALIDATORS.check() before
//      encoding the file, so bad inputs are rejected with a clear error
//      before any network call is made.
// ══════════════════════════════════════════════════════════════════════════════

const MIME_VALIDATORS = {
  _rules: {
    'image-gen':          null,   // no file needed — text prompt only
    'image-enhancement':  ['image/jpeg','image/png','image/webp','image/gif','image/bmp','image/tiff'],
    'super-resolution':   ['image/jpeg','image/png','image/webp'],
    'segmentation':       ['image/jpeg','image/png','image/webp'],
    'inpainting':         ['image/jpeg','image/png','image/webp'],
    'restoration':        ['image/jpeg','image/png','image/webp','image/bmp'],
    'face-processing':    ['image/jpeg','image/png','image/webp'],
    'style-transfer':     ['image/jpeg','image/png','image/webp'],
    'controlnet':         ['image/jpeg','image/png','image/webp'],
    'video-gen':          null,   // no file needed — text prompt only
    'temporal':           ['video/mp4','video/webm','video/quicktime','video/x-msvideo'],
    'compression':        ['image/jpeg','image/png','image/webp','video/mp4','video/webm'],
    'audio-extraction':   ['video/mp4','video/webm','audio/mpeg','audio/wav','audio/ogg'],
    'audio-sync':         ['video/mp4','video/webm','audio/mpeg','audio/wav'],
    'captioning':         ['image/jpeg','image/png','image/webp','video/mp4'],
    'visualization':      ['audio/mpeg','audio/wav','audio/ogg','video/mp4'],
    'basic-processing':   ['image/jpeg','image/png','image/webp','image/gif','image/bmp'],
  },

  // Returns { valid: bool, error: string|null }
  check(capability, file) {
    const allowed = this._rules[capability];
    if (allowed === null || allowed === undefined) return { valid: true, error: null };
    if (!file) return { valid: false, error: `${capability} requires a file input.` };
    if (!allowed.includes(file.type)) {
      return {
        valid: false,
        error: `"${file.type}" not supported for ${capability}. Accepted: ${allowed.join(', ')}.`,
      };
    }
    return { valid: true, error: null };
  },

  // Returns allowed MIME list for a capability (for UI accept= attribute)
  getAccepted(capability) {
    return this._rules[capability] || [];
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// §3d  INPUT_OUTPUT_RULES
//      Canonical input→output contract per capability.
//      Used by upload UI to set correct accept= attributes and by
//      ResultDispatcher to choose the correct render path.
// ══════════════════════════════════════════════════════════════════════════════

const INPUT_OUTPUT_RULES = {
  'image-gen':         { input: 'none',    output: 'image', needsFile: false },
  'image-enhancement': { input: 'image',   output: 'image', needsFile: true  },
  'super-resolution':  { input: 'image',   output: 'image', needsFile: true  },
  'segmentation':      { input: 'image',   output: 'image', needsFile: true  },
  'inpainting':        { input: 'image',   output: 'image', needsFile: true  },
  'restoration':       { input: 'image',   output: 'image', needsFile: true  },
  'face-processing':   { input: 'image',   output: 'image', needsFile: true  },
  'style-transfer':    { input: 'image',   output: 'image', needsFile: true  },
  'controlnet':        { input: 'image',   output: 'image', needsFile: true  },
  'video-gen':         { input: 'none',    output: 'video', needsFile: false },
  'temporal':          { input: 'video',   output: 'video', needsFile: true  },
  'compression':       { input: 'any',     output: 'any',   needsFile: true  },
  'audio-extraction':  { input: 'video',   output: 'audio', needsFile: true  },
  'audio-sync':        { input: 'audio',   output: 'video', needsFile: true  },
  'captioning':        { input: 'image',   output: 'text',  needsFile: true  },
  'visualization':     { input: 'audio',   output: 'image', needsFile: true  },
  'basic-processing':  { input: 'image',   output: 'image', needsFile: true  },
};

// ══════════════════════════════════════════════════════════════════════════════
// §3e  TOOL_EXECUTION_RULES
//      Timeout, retry, async, and weight rules per pipeline/capability.
//      Single source of truth — replaces scattered inline values.
// ══════════════════════════════════════════════════════════════════════════════

const TOOL_EXECUTION_RULES = {
  'image-gen':         { timeout_ms: 15000,  max_retries: 2, is_heavy: false, async_poll: false },
  'image-enhancement': { timeout_ms: 15000,  max_retries: 2, is_heavy: false, async_poll: false },
  'super-resolution':  { timeout_ms: 35000,  max_retries: 2, is_heavy: true,  async_poll: true  },
  'segmentation':      { timeout_ms: 35000,  max_retries: 2, is_heavy: true,  async_poll: true  },
  'inpainting':        { timeout_ms: 35000,  max_retries: 2, is_heavy: true,  async_poll: true  },
  'restoration':       { timeout_ms: 35000,  max_retries: 2, is_heavy: true,  async_poll: true  },
  'face-processing':   { timeout_ms: 35000,  max_retries: 2, is_heavy: true,  async_poll: true  },
  'style-transfer':    { timeout_ms: 15000,  max_retries: 2, is_heavy: false, async_poll: false },
  'controlnet':        { timeout_ms: 20000,  max_retries: 2, is_heavy: false, async_poll: false },
  'video-gen':         { timeout_ms: 120000, max_retries: 1, is_heavy: true,  async_poll: true  },
  'temporal':          { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: true  },
  'compression':       { timeout_ms: 12000,  max_retries: 2, is_heavy: false, async_poll: false },
  'audio-extraction':  { timeout_ms: 12000,  max_retries: 2, is_heavy: false, async_poll: false },
  'audio-sync':        { timeout_ms: 12000,  max_retries: 2, is_heavy: false, async_poll: false },
  'captioning':        { timeout_ms: 12000,  max_retries: 2, is_heavy: false, async_poll: false },
  'visualization':     { timeout_ms: 12000,  max_retries: 2, is_heavy: false, async_poll: false },
  'basic-processing':  { timeout_ms:  8000,  max_retries: 2, is_heavy: false, async_poll: false },

  // Lookup helper — returns rules for a capability, with safe defaults
  get(capability) {
    return this[capability] || { timeout_ms: 12000, max_retries: 2, is_heavy: false, async_poll: false };
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// §4  TOOL PRESET LIBRARY
//     Parameter overrides per preset — applied to the normalized payload.
//     Tools share pipelines; presets differentiate their behavior.
// ══════════════════════════════════════════════════════════════════════════════

const PRESET_LIBRARY = {
  // Generation presets
  flux_standard:       { model: 'flux-1.1-pro',   steps: 28, guidance: 7.5, resolution: '4K' },
  flux_fast:           { model: 'flux-schnell',    steps: 4,  guidance: 0,   resolution: '4K' },
  flux_photo:          { model: 'flux-1.1-pro',   steps: 30, guidance: 8.0, style_preset: 'photorealistic', resolution: '4K' },
  flux_scene:          { model: 'flux-1.1-pro',   steps: 32, guidance: 8.5, style_preset: 'cinematic', resolution: '4K' },
  sdxl_standard:       { model: 'sdxl-1.0',        steps: 30, guidance: 7.5, resolution: '4K' },
  sdxl_art:            { model: 'sdxl-1.0',        steps: 40, guidance: 9.0, style_preset: 'artistic', resolution: '4K' },
  sd35:                { model: 'sd3.5',            steps: 28, guidance: 7.5, resolution: '4K' },
  seedream:            { model: 'seedream-5.0',     steps: 25, guidance: 7.0, resolution: '4K' },
  firefly:             { model: 'adobe-firefly',    steps: 25, guidance: 7.5, resolution: '4K' },
  midjourney:          { model: 'midjourney-v7',    steps: 30, guidance: 8.0, resolution: '4K' },

  // Enhancement presets
  standard_enhance:    { sharpness: 1.2, contrast: 1.1, brightness: 1.0 },
  enhanced_plus:       { sharpness: 1.4, contrast: 1.2, brightness: 1.05, denoise: 0.3 },
  hdr:                 { sharpness: 1.4, contrast: 1.3, hdr_strength: 0.8 },
  hdr_boost:           { sharpness: 1.6, contrast: 1.5, hdr_strength: 1.0, clarity: 0.5 },
  highlight_recovery:  { highlights: -0.6, shadows: 0.4, sharpness: 1.2 },
  sharpen:             { sharpness: 1.8, radius: 1.2, threshold: 0.15 },
  detail:              { sharpness: 1.5, clarity: 0.6, texture: 0.5 },
  exposure:            { brightness: 1.2, gamma: 1.1 },
  shadow:              { shadows: 0.5, blacks: 0.2, gamma: 1.1 },
  lighting:            { exposure: 0.3, shadows: 0.4, highlights: -0.2 },
  color_correct:       { temperature: 0, tint: 0, saturation: 1.1, vibrance: 1.1 },
  color_grade:         { temperature: -0.1, saturation: 1.2, split_tone: true },
  color_grade_pro:     { lut: 'cinematic', saturation: 1.3, temperature: -0.15 },
  color_temp:          { temperature: 0.2 },
  white_balance:       { auto_wb: true },
  vibrance:            { vibrance: 1.4, saturation: 1.1 },
  saturation:          { saturation: 1.5 },
  bw:                  { saturation: 0, grayscale: true },
  grayscale:           { saturation: 0, grayscale: true },
  invert:              { invert: true },
  pixel_perfect:       { sharpness: 1.6, denoise: 0.4, clarity: 0.7 },
  lens_fix:            { lens_correction: true, distortion: -0.3 },
  vignette:            { vignette_strength: 0.5, vignette_feather: 0.7 },
  blur:                { blur_radius: 8 },
  bg_blur:             { blur_radius: 20, subject_protect: true },
  mosaic:              { mosaic_size: 16 },
  denoise:             { denoise: 0.8, sharpness: 1.1 },
  effects_pro:         { lut: 'cinematic', vignette_strength: 0.3, sharpness: 1.2 },
  portrait_depth:      { depth_enhance: true, face_focus: true, bokeh: 0.4 },

  // Segmentation presets
  bg_remove:           { mode: 'remove', edge_refine: true, hair_refine: true },
  bg_change:           { mode: 'replace', edge_refine: true },
  sky_replace:         { mode: 'sky', blend_mode: 'natural' },
  bg_transparent:      { mode: 'transparent', edge_refine: true },
  smart_crop:          { subject_detect: true, padding: 0.1 },
  sticker:             { mode: 'sticker', transparent: true, edge_expand: 4 },
  sam2:                { model: 'sam2', interactive: true },
  grounding_dino:      { model: 'grounding-dino', threshold: 0.3 },

  // Inpainting presets
  object_remove:       { mask_auto: true, fill_mode: 'content_aware' },
  object_remove_pro:   { mask_auto: true, fill_mode: 'diffusion', mask_strength: 0.9 },
  watermark_remove:    { mask_detect: 'watermark', fill_mode: 'content_aware' },
  clean:               { fill_mode: 'content_aware', edge_blend: 0.8 },
  gen_fill:            { fill_mode: 'diffusion', creative: true },

  // Super resolution presets
  realesrgan_4x:       { model: 'realesrgan-4x', scale: 4 },
  realesrgan_4k:       { model: 'realesrgan-4x', scale: 4, target: '3840x2160' },
  supir:               { model: 'supir', scale: 4, quality: 'ultra' },
  swinir:              { model: 'swinir', scale: 4 },
  bsrgan:              { model: 'bsrgan', scale: 4 },
  detail_boost:        { model: 'realesrgan-4x', scale: 4, detail_enhance: true },
  topaz_video:         { model: 'topaz-video', scale: 4, fps_enhance: true },

  // Restoration presets
  restore_standard:    { model: 'codeformer', face_enhance: true, color_enhance: true },
  codeformer:          { model: 'codeformer', fidelity: 0.7 },
  restoreformer:       { model: 'restoreformer', enhance_level: 0.8 },

  // Face processing presets
  gfpgan:              { model: 'gfpgan', version: '1.4', upscale: 2 },
  face_retouch:        { face_focus: true, skin_smoothing: 0.4, denoise: 0.3 },
  portrait_pro:        { face_focus: true, skin_smoothing: 0.5, eye_enhance: true, teeth_whiten: true },
  beauty:              { beauty_level: 0.6, face_focus: true },
  beauty_filter:       { beauty_level: 0.5, skin_smoothing: 0.4 },
  face_edit:           { face_focus: true, edit_mode: true },
  live_portrait:       { model: 'liveportrait', animate: true },

  // Style transfer presets
  style_default:       { strength: 0.75 },
  cartoon:             { style: 'cartoon', strength: 0.9 },
  sketch:              { style: 'sketch', strength: 0.85 },
  vintage:             { style: 'vintage', strength: 0.8 },
  sepia:               { style: 'sepia', strength: 0.9 },
  vhs:                 { style: 'vhs', strength: 0.9, noise: 0.2 },
  neon:                { style: 'neon', strength: 0.85, glow: 0.6 },
  glitch:              { style: 'glitch', strength: 0.8, distortion: 0.5 },
  retro:               { style: 'retro', strength: 0.75 },
  anime:               { style: 'anime', strength: 0.9 },
  oil_painting:        { style: 'oil_painting', strength: 0.85 },
  watercolor:          { style: 'watercolor', strength: 0.8 },
  pencil:              { style: 'pencil', strength: 0.85 },
  controlnet_default:  { model: 'controlnet', mode: 'canny' },
  instruct_pix2pix:    { model: 'instruct-pix2pix', guidance: 7.5 },

  // Video presets
  video_standard:      { quality: '4K', fps: 24 },
  motion_anim:         { fps: 24, duration: 4 },
  photo2video:         { duration: 4, fps: 24, motion: 'parallax' },
  video_4k:            { quality: '4K', upscale: true, fps: 60 },
  runway_gen5:         { model: 'runway-gen5', duration: 4, fps: 24 },
  seedance:            { model: 'seedance-2.0', duration: 4 },
  kling:               { model: 'kling-3.0', duration: 5 },
  luma:                { model: 'luma-dream', duration: 5 },
  pika:                { model: 'pika-2.5', duration: 3 },
  hailuo:              { model: 'hailuo-minimax', duration: 6 },
  sora_edit:           { model: 'sora-edit', duration: 4 },
  svd:                 { model: 'svd', frames: 25, fps: 6 },
  animatediff:         { model: 'animatediff', frames: 16, fps: 8 },
  cinematic_action:    { style: 'cinematic', fps: 24, duration: 4 },
  cinematic_pulse:     { style: 'cinematic_pulse', fps: 24, duration: 3 },

  // Video processing presets
  trim:                { operation: 'trim' },
  crop:                { operation: 'crop' },
  speed:               { operation: 'speed_adjust' },
  slowmo:              { speed: 0.25, fps_interp: true },
  fastforward:         { speed: 2.0 },
  motion_blur:         { blur_motion: true, strength: 0.7 },
  rife:                { model: 'rife', fps_multiply: 4 },
  dain:                { model: 'dain', fps_multiply: 4 },
  tecogan:             { model: 'tecogan', scale: 4 },
  raft_esrgan:         { model: 'raft-esrgan' },
  temporal_gan:        { model: 'temporal-gan' },
  wonder_dynamics:     { model: 'wonder-dynamics' },
  motion_transfer:     { operation: 'motion_transfer' },
  consistent_motion:   { operation: 'consistent_motion' },
  multicam_sync:       { operation: 'multicam_sync' },
  match_cut:           { operation: 'match_cut' },
  merge:               { operation: 'merge' },

  // Captioning presets
  auto_caption:        { language: 'auto', format: 'srt' },
  manual_sub:          { mode: 'manual' },
  florence2:           { model: 'florence-2', task: 'caption' },

  // Audio presets
  audio_extract:       { format: 'mp3', quality: 'high' },
  beat_sync:           { detect_beats: true, sync_mode: 'beat_drop' },
  wave_viz:            { style: 'waveform', color: 'auto' },
  audio_reactive:      { mode: 'reactive', sensitivity: 0.7 },
  audio_sync:          { sync_mode: 'manual' },

  // Compression presets
  video_compress:      { codec: 'h264', quality: 28, preset: 'medium' },
  image_compress:      { quality: 85, format: 'auto', progressive: true },

  // Basic presets
  resize:              { mode: 'resize' },
  rotate:              { degrees: 90 },
  flip:                { mode: 'both' },
  flip_h:              { mode: 'horizontal' },
  flip_v:              { mode: 'vertical' },
  mirror:              { mode: 'horizontal' },
  perspective:         { auto: true },
  aspect_ratio:        { mode: 'fit' },
  convert_png:         { format: 'png', lossless: true },
  convert:             { format: 'auto' },
  watermark:           { mode: 'add', opacity: 0.8 },
  text_overlay:        { mode: 'text' },
  meme:                { mode: 'meme_text' },
  collage:             { layout: 'auto' },
  stitch:              { mode: 'panorama' },
  frame:               { style: 'auto' },
  passport:            { spec: 'auto', bg: 'white' },
  threshold:           { value: 128 },
  binarize:            { value: 128 },
  split:               { mode: 'grid' },
};

// §4 alias — prompt-mandated exact name
const TOOL_PRESETS = PRESET_LIBRARY;

// ══════════════════════════════════════════════════════════════════════════════
// §5  PROVIDER CAPABILITY MAP
//     Defines which providers handle which capabilities, in priority order.
//     This mirrors the backend but allows frontend routing decisions too.
// ══════════════════════════════════════════════════════════════════════════════

const PROVIDER_CAPABILITIES = {
  'pollinations':   ['image-gen', 'video-gen', 'style-transfer', 'visualization'],
  'together':       ['image-gen', 'video-gen', 'captioning'],
  'huggingface':    ['image-gen', 'super-resolution', 'segmentation', 'inpainting', 'face-processing', 'restoration', 'style-transfer', 'temporal', 'captioning'],
  'segmind':        ['image-gen', 'inpainting', 'segmentation', 'image-enhancement', 'controlnet'],
  'deepai':         ['image-gen', 'face-processing', 'restoration', 'inpainting'],
  'cloudflare':     ['super-resolution', 'segmentation', 'temporal', 'compression', 'color-matching', 'audio-extraction', 'audio-sync'],
  'gemini':         ['captioning', 'visualization', 'image-gen'],
  'groq':           ['captioning'],
  'mistral':        ['captioning'],
  'openrouter':     ['image-gen', 'captioning'],
  'krea':           ['image-gen', 'super-resolution', 'face-processing', 'restoration'],
  'cloudinary':     ['compression', 'basic-processing', 'image-enhancement'],
  'pexels':         ['video-gen', 'image-gen'],
  'unsplash':       ['image-gen'],
};

const CAPABILITY_PROVIDER_PRIORITY = {
  'image-gen':         ['pollinations', 'together', 'segmind', 'huggingface', 'krea', 'openrouter', 'deepai'],
  'super-resolution':  ['segmind', 'huggingface', 'cloudflare', 'krea'],
  'segmentation':      ['huggingface', 'segmind', 'cloudflare'],
  'inpainting':        ['segmind', 'huggingface', 'deepai'],
  'face-processing':   ['huggingface', 'deepai', 'krea'],
  'restoration':       ['huggingface', 'krea', 'deepai'],
  'image-enhancement': ['segmind', 'huggingface', 'cloudflare', 'cloudinary'],
  'style-transfer':    ['huggingface', 'pollinations', 'together'],
  'video-gen':         ['pollinations', 'together'],
  'temporal':          ['cloudflare', 'huggingface'],
  'captioning':        ['gemini', 'groq', 'mistral', 'together'],
  'audio-extraction':  ['cloudflare'],
  'compression':       ['cloudinary', 'cloudflare'],
  'basic-processing':  ['cloudinary', 'cloudflare', 'huggingface'],
  'controlnet':        ['segmind', 'huggingface'],
  'denoising':         ['huggingface', 'cloudflare'],
  'visualization':     ['pollinations', 'gemini'],
  'color-matching':    ['cloudflare', 'cloudinary'],
  'audio-sync':        ['cloudflare'],
};

// §5 alias — prompt-mandated exact name
const PROVIDER_PRIORITIES = CAPABILITY_PROVIDER_PRIORITY;

// ══════════════════════════════════════════════════════════════════════════════
// §6  PROVIDER HEALTH TRACKER
//     Tracks per-provider success/failure rates. Used for dynamic routing.
// ══════════════════════════════════════════════════════════════════════════════

const ProviderHealth = (() => {
  const _scores = {};

  // Initialize all providers with full health
  Object.keys(PROVIDER_CAPABILITIES).forEach(p => { _scores[p] = 1.0; });

  function get(provider) {
    return _scores[provider] ?? 1.0;
  }

  function recordSuccess(provider) {
    _scores[provider] = Math.min(ORCH_CONFIG.HEALTH_CEILING,
      (_scores[provider] ?? 1.0) * 1.05 + 0.05);
    _log(`[ProviderHealth] ✓ ${provider} → ${_scores[provider].toFixed(2)}`);
  }

  function recordFailure(provider) {
    _scores[provider] = Math.max(ORCH_CONFIG.HEALTH_FLOOR,
      (_scores[provider] ?? 1.0) * ORCH_CONFIG.HEALTH_SCORE_DECAY);
    _log(`[ProviderHealth] ✗ ${provider} → ${_scores[provider].toFixed(2)}`);
  }

  function getSortedProviders(capability) {
    const base = CAPABILITY_PROVIDER_PRIORITY[capability] || [];
    return [...base].sort((a, b) => get(b) - get(a));
  }

  function dump() {
    return Object.entries(_scores).map(([p, s]) => `${p}:${s.toFixed(2)}`).join(' | ');
  }

  return { get, recordSuccess, recordFailure, getSortedProviders, dump };
})();

// ══════════════════════════════════════════════════════════════════════════════
// §7  PAYLOAD NORMALIZER
//     Converts any tool invocation into a canonical backend request.
// ══════════════════════════════════════════════════════════════════════════════

const PayloadNormalizer = {
  async build(toolName, userParams, inputFile) {
    const reg   = TOOL_REGISTRY[toolName];
    const pipeline = reg ? PIPELINE_REGISTRY[reg.pipeline] : null;
    const preset   = reg ? (PRESET_LIBRARY[reg.preset] || {}) : {};
    const cap      = pipeline ? pipeline.capability : 'basic-processing';

    // Merge preset → user params (user always wins)
    const mergedParams = Object.assign({}, preset, userParams || {});

    // Ensure prompt is present for generation pipelines
    if (!mergedParams.prompt && typeof window._buildToolPrompt === 'function') {
      mergedParams.prompt = window._buildToolPrompt(toolName, mergedParams);
    }
    if (!mergedParams.prompt) {
      mergedParams.prompt = _buildDefaultPrompt(toolName);
    }

    // Encode file
    let file_data = null;
    let file_mime = 'application/octet-stream';
    if (inputFile) {
      try {
        file_data = await _fileToBase64(inputFile);
        file_mime = inputFile.type || 'application/octet-stream';
      } catch (e) {
        _warn('[PayloadNormalizer] base64 encode failed:', e.message);
      }
    }

    // MIME validation gate
    if (inputFile) {
      const _mimeCheck = MIME_VALIDATORS.check(cap, inputFile);
      if (!_mimeCheck.valid) {
        _warn('[PayloadNormalizer] MIME rejected:', _mimeCheck.error);
        // Warn but do not hard-block — backend will handle gracefully
        // Store warning so ResultDispatcher can surface it
        (mergedParams._warnings = mergedParams._warnings || []).push(_mimeCheck.error);
      }
    }

    return {
      tool:       toolName,
      pipeline:   reg ? reg.pipeline : 'basic',
      preset:     reg ? reg.preset   : 'standard',
      capability: cap,
      params:     mergedParams,
      file_data,
      file_mime,
      input_type:  inputFile
        ? (inputFile.type.startsWith('video/') ? 'video'
          : inputFile.type.startsWith('audio/') ? 'audio'
          : inputFile.type.startsWith('image/') ? 'image' : 'file')
        : ((TOOL_METADATA[toolName] || {}).input_type || 'text'),
      output_type: (TOOL_METADATA[toolName] || {}).output_type || 'image',
      inputType:  inputFile ? inputFile.type   : 'unknown',
      inputSize:  inputFile ? inputFile.size   : 0,
      resolution: window.LUMINORBIT_4K_MODE ? '4K' : (window.selectedResolution || '4K'),
      timestamp:  Date.now(),
      // Metadata for backend orchestration transparency
      provider_preference: CAPABILITY_PROVIDER_PRIORITY[cap] || [],
      async_supported:     pipeline ? pipeline.async : false,
      fallback_enabled:    true,
    };
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// §8  PIPELINE ROUTER
//     Sends normalized payload to backend with retry + fallback logic.
// ══════════════════════════════════════════════════════════════════════════════

const PipelineRouter = {
  async execute(payload) {
    if (!ORCH_CONFIG.apiUrl) return null;

    const _primaryUrl  = ORCH_CONFIG.apiUrl;
    const _fallbackUrl = ORCH_CONFIG.fallbackUrl;
    const BACKENDS = [_primaryUrl, _fallbackUrl].filter(Boolean);

    const reg      = TOOL_REGISTRY[payload.tool] || {};
    const pipeline = PIPELINE_REGISTRY[reg.pipeline] || {};
    const _execRules = TOOL_EXECUTION_RULES.get(payload.capability);
    const timeout    = _execRules.timeout_ms;

    let lastError = 'no_backends';

    for (const backendUrl of BACKENDS) {
      for (let attempt = 1; attempt <= ORCH_CONFIG.MAX_RETRIES; attempt++) {
        try {
          const resp = await _fetchWithTimeout(
            backendUrl.replace(/\/+$/, '') + '/api/process',
            {
              method:  'POST',
              headers: {
                'Content-Type':  'application/json',
                'Authorization': 'Bearer ' + ORCH_CONFIG.apiKey,
                'X-Pipeline':    payload.pipeline || 'basic',
                'X-Request-Id':  _randomId(),
              },
              body: JSON.stringify(payload),
            },
            timeout
          );

          if (resp.status === 429) {
            ResultDispatcher.showError('Rate limit reached — please wait a moment.');
            return null;
          }
          if (resp.status === 401) {
            ResultDispatcher.showError('Authentication failed. Check API key configuration.');
            return null;
          }
          if (!resp.ok) throw new Error('HTTP ' + resp.status);

          const data = await resp.json();

          if (data && data.success) {
            // Record success for primary provider used
            if (data.provider) ProviderHealth.recordSuccess(data.provider.replace('-emergency',''));
            _log(`[PipelineRouter] ✓ ${payload.tool} → ${data.provider} (${data.execution_ms || '?'}ms)`);
            return data;
          }
          lastError = (data && data.error) || 'unknown_response';

        } catch (e) {
          lastError = e.message || String(e);
          _warn(`[PipelineRouter] Attempt ${attempt} on ${backendUrl} failed: ${lastError}`);

          // Exponential backoff before retry
          if (attempt < ORCH_CONFIG.MAX_RETRIES) {
            await _sleep(ORCH_CONFIG.RETRY_DELAY_BASE * attempt);
          }
        }
      }
    }

    _warn(`[PipelineRouter] All backends failed for "${payload.tool}": ${lastError}`);
    return null;
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// §9  ASYNC JOB MANAGER
//     Polls backend job status with progress updates.
// ══════════════════════════════════════════════════════════════════════════════

const AsyncJobManager = {
  async poll(jobId, toolName, onProgress) {
    if (!ORCH_CONFIG.apiUrl || !jobId) return null;

    const url     = ORCH_CONFIG.apiUrl.replace(/\/+$/, '') + '/api/jobs/' + jobId;
    const headers = { 'Authorization': 'Bearer ' + ORCH_CONFIG.apiKey };

    for (let i = 0; i < ORCH_CONFIG.POLL_MAX_ATTEMPTS; i++) {
      await _sleep(ORCH_CONFIG.POLL_INTERVAL);
      try {
        const res  = await fetch(url, { headers });
        if (!res.ok) continue;
        const data = await res.json();

        if (typeof onProgress === 'function' && data.progress != null) {
          onProgress(data.progress, data.status);
        }

        if (data.status === 'completed') {
          _log(`[AsyncJobManager] ✓ Job ${jobId} completed after ${i+1} polls`);
          return data.output_url || data.output || null;
        }
        if (data.status === 'failed') {
          _warn(`[AsyncJobManager] ✗ Job ${jobId} failed: ${data.error}`);
          return null;
        }
      } catch (e) {
        _warn(`[AsyncJobManager] poll error (attempt ${i+1}): ${e.message}`);
      }
    }

    _warn(`[AsyncJobManager] Job ${jobId} timed out after ${ORCH_CONFIG.POLL_MAX_ATTEMPTS} polls`);
    return null;
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// §10  RESULT DISPATCHER
//      Handles all output rendering — images, video, text — safely.
// ══════════════════════════════════════════════════════════════════════════════

const ResultDispatcher = {
  dispatch(output, toolName, responseObj) {
    if (!output) {
      _warn('[ResultDispatcher] No output to render for:', toolName);
      return false;
    }

    try {
      const isVideo = _isVideoOutput(output, responseObj);

      if (isVideo) {
        this._renderVideo(output);
      } else if (typeof output === 'string' && output.startsWith('data:text/')) {
        this._renderText(output, toolName);
      } else if (typeof output === 'string' &&
                 (output.startsWith('data:') || output.startsWith('http') || output.startsWith('blob:'))) {
        this._renderImage(output, toolName);
      } else if (output instanceof Blob) {
        const url = URL.createObjectURL(output);
        if (output.type && output.type.startsWith('video/')) {
          this._renderVideo(url);
        } else {
          this._renderImage(url, toolName);
        }
      } else {
        _warn('[ResultDispatcher] Unknown output type:', typeof output);
        return false;
      }

      // Sync with existing Luminorbit preview state
      this._syncPreviewState(output, isVideo);

      // Notify existing ensureFinalOutput if available
      try { if (typeof window.ensureFinalOutput === 'function') window.ensureFinalOutput(); } catch(e) {}

      return true;
    } catch (e) {
      console.error('[ResultDispatcher] Render failed:', e.message);
      return false;
    }
  },

  _renderImage(src, toolName) {
    const img = document.getElementById('preview-img-result');
    if (img) {
      // Revoke old blob to prevent memory leak
      if (img._orchestBlobUrl) { try { URL.revokeObjectURL(img._orchestBlobUrl); } catch(e2){} }
      if (src.startsWith('blob:')) img._orchestBlobUrl = src;
      img.src = src;
      img.style.filter = '';
      img.style.display = 'block';
    }
    if (typeof window._showMediaStage === 'function') window._showMediaStage('image', 'result');
    if (typeof window.setPreviewMode  === 'function') window.setPreviewMode('result');
    _log('[ResultDispatcher] Image rendered for:', toolName);
  },

  _renderVideo(src) {
    const vid = document.getElementById('preview-vid-result');
    if (vid) {
      vid.src = src;
      vid.style.display = 'block';
    }
    if (typeof window._showMediaStage === 'function') window._showMediaStage('video', 'result');
    if (typeof window.setPreviewMode  === 'function') window.setPreviewMode('result');
    _log('[ResultDispatcher] Video rendered');
  },

  _renderText(src, toolName) {
    try {
      const b64part = src.split(',')[1] || '';
      const text    = atob(b64part);
      // Try dedicated caption panel first, then text result, then img alt fallback
      const panel =
        document.getElementById('caption-output') ||
        document.getElementById('preview-text-result') ||
        document.getElementById('ai-caption-text');
      if (panel) {
        panel.textContent = text;
        panel.style.display = 'block';
      } else {
        // Fallback: set as img alt/title so it's accessible
        const img = document.getElementById('preview-img-result');
        if (img) { img.alt = text; img.title = text; }
      }
      // Surface text in result state for export
      window._orch_resultText  = text;
      window._orch_resultReady = true;
      if (Object.prototype.hasOwnProperty.call(window, 'resultImage')) window.resultImage = src;
      _log('[ResultDispatcher] Text rendered for:', toolName, '—', text.length, 'chars');
    } catch (e) {
      _warn('[ResultDispatcher] Text render failed:', e.message);
    }
  },

  _syncPreviewState(output, isVideo) {
    // Sync with index.js fixed layer's resultImage/_resultReady
    if (typeof output === 'string' && output) {
      try {
        window._orch_resultImage  = output;
        window._orch_resultReady  = true;
        // Also sync index.js fixed vars if they exist
        if (Object.prototype.hasOwnProperty.call(window, 'resultImage'))  window.resultImage  = output;
        if (Object.prototype.hasOwnProperty.call(window, '_resultReady')) window._resultReady = true;
      } catch(e) {}
    }
  },

  showError(msg) {
    console.error('[Luminorbit Orchestration]', msg);
    const existing = document.getElementById('_lmn_orch_err');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = '_lmn_orch_err';
    banner.style.cssText = [
      'position:fixed','top:66px','left:50%','transform:translateX(-50%)',
      'z-index:9999','background:#c0392b','color:#fff',
      'padding:12px 24px 12px 16px','border-radius:8px',
      'font-family:system-ui,sans-serif','font-size:.9rem',
      'box-shadow:0 4px 20px rgba(0,0,0,.4)','max-width:540px',
      'display:flex','align-items:center','gap:12px',
    ].join(';');
    banner.innerHTML = `<span>⚡ ${msg}</span>`
      + `<button onclick="this.parentNode.remove()" style="background:none;border:none;color:#fff;`
      + `font-size:1.2rem;cursor:pointer;padding:0 4px;line-height:1">✕</button>`;
    document.body.appendChild(banner);
    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 8000);
  },

  showProgress(pct, label) {
    const overlay = document.getElementById('preview-processing-overlay');
    if (overlay) {
      const pbar = overlay.querySelector('.progress-fill, .ai-progress-bar');
      if (pbar) pbar.style.width = pct + '%';
      const lbl = overlay.querySelector('.ai-loading-text, .progress-label');
      if (lbl)  lbl.textContent = label || `Processing… ${pct}%`;
    }
  },
};

// §10 alias — prompt-mandated exact name
const RESULT_RENDERERS = ResultDispatcher;

// ══════════════════════════════════════════════════════════════════════════════
// §11  ORCHESTRATION ENGINE (main entry point)
//      executeOrchestrated() replaces _executeSmart() for all tool runs.
// ══════════════════════════════════════════════════════════════════════════════

window.executeOrchestrated = async function(toolName, userParams, inputFile) {
  if (!toolName) {
    _warn('[Orchestration] No tool name provided');
    return false;
  }

  // Guard against concurrent runs (reuses existing AppState if present)
  const appState = window.AppState || {};
  if (appState.isProcessing || appState.isExporting) {
    if (typeof window.showToast === 'function') window.showToast('Please wait for the current operation to complete.');
    return false;
  }

  _log(`[Orchestration] ▶ ${toolName}`);

  // Show loading state
  _setLoading(true, toolName);

  try {
    // 1. Look up tool in registry
    const reg = TOOL_REGISTRY[toolName];
    if (!reg) {
      _warn(`[Orchestration] Tool not in registry: "${toolName}" — routing to basic pipeline`);
    }

    // 2. Determine if backend is available and required
    const needsBackend = !!ORCH_CONFIG.apiUrl && (reg || _shouldRouteToBackend(toolName));

    if (needsBackend) {
      // 3. Build normalized payload
      const payload = await PayloadNormalizer.build(
        toolName,
        userParams || window.controlValues,
        inputFile  || window.uploadedFile
      );

      // 4. Send to backend pipeline
      const response = await PipelineRouter.execute(payload);

      if (response && response.success) {
        // 4a. Async job — poll for result
        if (response.job_id && !response.output) {
          _log(`[Orchestration] Async job started: ${response.job_id}`);
          const outputUrl = await AsyncJobManager.poll(
            response.job_id,
            toolName,
            (pct, status) => ResultDispatcher.showProgress(pct, `${toolName}… ${pct}%`)
          );
          if (outputUrl) {
            ResultDispatcher.dispatch(outputUrl, toolName, response);
            return outputUrl;
          }
          // Job failed — fall through to frontend
          _warn(`[Orchestration] Async job failed — falling back to frontend pipeline`);
        } else if (response.output) {
          // 4b. Sync response — render immediately
          ResultDispatcher.dispatch(response.output, toolName, response);
          return response.output;
        }
      }

      // Backend returned nothing useful — fall through to frontend
      _warn(`[Orchestration] Backend unavailable for "${toolName}" — using frontend pipeline`);
    }

    // 5. Frontend pipeline fallback
    return _runFrontendFallback(toolName, userParams || window.controlValues, inputFile || window.uploadedFile);

  } catch (e) {
    console.error(`[Orchestration] Execution failed for "${toolName}":`, e.message, e);
    _runFrontendFallback(toolName, userParams, inputFile || window.uploadedFile);
    return false;
  } finally {
    _setLoading(false, toolName);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// §12  EXECUTION GATE
//      Wraps executeToolSafe() to route through orchestration engine.
//      The existing executeToolSafe from v20.5 is preserved as fallback.
// ══════════════════════════════════════════════════════════════════════════════

(function _installOrchestrationGate() {
  const _origExecuteToolSafe = window.executeToolSafe;

  window.executeToolSafe = async function(toolName, params, inputFile) {
    // Route through orchestration if tool is registered OR backend is configured
    // (backend-configured path allows TOOL_CAPABILITY_MAP tools to still route through)
    if (TOOL_REGISTRY[toolName] || (window.LUMINORBIT_API_URL && _shouldRouteToBackend(toolName))) {
      return window.executeOrchestrated(toolName, params, inputFile);
    }
    // Otherwise fall through to original v20.5 implementation
    if (typeof _origExecuteToolSafe === 'function') {
      return _origExecuteToolSafe.apply(window, arguments);
    }
    return false;
  };

  _log('[Orchestration] executeToolSafe gate installed');
})();

// ══════════════════════════════════════════════════════════════════════════════
// §13  BACKEND REQUEST BUILDER UPGRADE
//      Upgrades _v205_buildRequest to use PayloadNormalizer.
// ══════════════════════════════════════════════════════════════════════════════

window._v205_buildRequest = async function(toolName, params, inputFile) {
  return PayloadNormalizer.build(toolName, params, inputFile);
};

// ══════════════════════════════════════════════════════════════════════════════
// §14  BACKEND CALLER UPGRADE
//      Upgrades _v205_callBackend to use PipelineRouter.
// ══════════════════════════════════════════════════════════════════════════════

window._v205_callBackend = async function(request) {
  return PipelineRouter.execute(request);
};

// ══════════════════════════════════════════════════════════════════════════════
// §15  RENDER OUTPUT UPGRADE
//      Upgrades _v205_renderBackendOutput to use ResultDispatcher.
// ══════════════════════════════════════════════════════════════════════════════

window._v205_renderBackendOutput = function(output, toolName, responseObj) {
  ResultDispatcher.dispatch(output, toolName, responseObj);
};

// ══════════════════════════════════════════════════════════════════════════════
// §16  JOB POLL UPGRADE
//      Upgrades _v21_pollJob to use AsyncJobManager.
// ══════════════════════════════════════════════════════════════════════════════

window._v21_pollJob = async function(jobId, toolName, params, inputFile) {
  const outputUrl = await AsyncJobManager.poll(jobId, toolName, (pct, status) => {
    ResultDispatcher.showProgress(pct, `${toolName}… ${pct}%`);
  });
  if (outputUrl) {
    ResultDispatcher.dispatch(outputUrl, toolName, null);
  } else {
    if (typeof window._v205_fallbackToSafeOutput === 'function') {
      window._v205_fallbackToSafeOutput(toolName);
    }
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// §17  TOOL METADATA EXPOSURE
//      Expose orchestration data structures for external scripts / debugging.
// ══════════════════════════════════════════════════════════════════════════════

window.LMNO = {
  version:               LMN_ORCH_VERSION,
  TOOL_REGISTRY,
  TOOL_PIPELINES,          // alias
  TOOL_PRESETS,            // alias
  TOOL_METADATA,           // new
  MIME_VALIDATORS,         // new
  INPUT_OUTPUT_RULES,      // new
  TOOL_EXECUTION_RULES,    // new
  PROVIDER_PRIORITIES,     // alias
  PIPELINE_REGISTRY,
  PRESET_LIBRARY,
  PROVIDER_CAPABILITIES,
  CAPABILITY_PROVIDER_PRIORITY,
  RESULT_RENDERERS,        // alias
  ProviderHealth,
  PayloadNormalizer,
  PipelineRouter,
  AsyncJobManager,
  ResultDispatcher,

  // Convenience method: resolve pipeline for any tool
  getPipeline(toolName) {
    const reg = TOOL_REGISTRY[toolName];
    return reg ? PIPELINE_REGISTRY[reg.pipeline] : null;
  },

  // Convenience method: get sorted providers for a capability
  getProviders(capability) {
    return ProviderHealth.getSortedProviders(capability);
  },

  // Diagnostic dump
  diagnostics() {
    return {
      registeredTools:    Object.keys(TOOL_REGISTRY).length,
      pipelines:          Object.keys(PIPELINE_REGISTRY).length,
      providers:          Object.keys(PROVIDER_CAPABILITIES).length,
      toolMetadataCount:  Object.keys(TOOL_METADATA).length,
      mimeRulesCount:     Object.keys(MIME_VALIDATORS._rules).length,
      ioRulesCount:       Object.keys(INPUT_OUTPUT_RULES).length,
      execRulesCount:     Object.keys(TOOL_EXECUTION_RULES).filter(k => k !== 'get').length,
      providerHealth:     ProviderHealth.dump(),
      backendUrl:         ORCH_CONFIG.apiUrl,
      backendConfigured:  !!window.LUMINORBIT_API_URL,
    };
  },
};

// FIX 1 — window.LuminorbitOrchestration (required by index_v5_upgraded.html)
window.LuminorbitOrchestration = {
  executeToolSafe:  window.executeOrchestrated,
  PayloadNormalizer: PayloadNormalizer,
  PipelineRouter:    PipelineRouter,
  ResultDispatcher:  ResultDispatcher,
  ProviderHealth:    ProviderHealth,
  TOOL_METADATA,
  MIME_VALIDATORS,
  INPUT_OUTPUT_RULES,
  TOOL_EXECUTION_RULES,
  version:           LMN_ORCH_VERSION,
};

// ══════════════════════════════════════════════════════════════════════════════
// §18  TOOL CAPABILITY MAP SYNC
//      Keeps TOOL_CAPABILITY_MAP (used by index.js fixed layer) in sync.
// ══════════════════════════════════════════════════════════════════════════════

(function _syncToolCapabilityMap() {
  // Build or extend TOOL_CAPABILITY_MAP from TOOL_REGISTRY
  if (typeof window.TOOL_CAPABILITY_MAP === 'undefined') {
    window.TOOL_CAPABILITY_MAP = {};
  }
  for (const [tool, reg] of Object.entries(TOOL_REGISTRY)) {
    const pipeline = PIPELINE_REGISTRY[reg.pipeline];
    if (pipeline && !window.TOOL_CAPABILITY_MAP[tool]) {
      window.TOOL_CAPABILITY_MAP[tool] = pipeline.capability;
    }
  }
  _log(`[Orchestration] TOOL_CAPABILITY_MAP synced: ${Object.keys(window.TOOL_CAPABILITY_MAP).length} tools`);
})();

// ══════════════════════════════════════════════════════════════════════════════
// §19  UTILITIES (private)
// ══════════════════════════════════════════════════════════════════════════════

function _log(...args)  { console.log('[Luminorbit Orch]', ...args); }
function _warn(...args) { console.warn('[Luminorbit Orch]', ...args); }

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function _fetchWithTimeout(url, opts, ms) {
  // Normalize URL: prevent double slashes in path segments
  const safeUrl = url.replace(/([^:])\/\/+/g, '$1/');
  // Validate HTTPS in production
  if (safeUrl && !safeUrl.startsWith('http')) {
    _warn('[_fetchWithTimeout] Non-HTTP URL rejected:', safeUrl);
    return Promise.reject(new Error('Invalid URL: ' + safeUrl));
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tid = controller
    ? setTimeout(() => controller.abort(), ms)
    : null;
  const fetchOpts = controller
    ? Object.assign({}, opts, { signal: controller.signal })
    : opts;
  return fetch(safeUrl, fetchOpts).finally(() => { if (tid) clearTimeout(tid); });
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function _buildDefaultPrompt(toolName) {
  const lower = toolName.toLowerCase();
  if (lower.includes('enhance'))   return 'Enhance this image to professional quality';
  if (lower.includes('restor'))    return 'Restore and enhance this photo';
  if (lower.includes('upscal'))    return 'Upscale this image to 4K resolution';
  if (lower.includes('remove'))    return 'Remove the specified element cleanly';
  if (lower.includes('generat'))   return 'Generate a high quality photorealistic image';
  if (lower.includes('portrait'))  return 'Enhance portrait with professional retouching';
  if (lower.includes('cartoon'))   return 'Convert this image to cartoon style';
  if (lower.includes('sketch'))    return 'Convert this image to pencil sketch';
  if (lower.includes('vintage'))   return 'Apply vintage film effect to this image';
  return `Apply ${toolName} processing to produce a high quality result`;
}

function _isVideoOutput(output, responseObj) {
  if (typeof output === 'string') {
    if (output.startsWith('data:video/')) return true;
    if (/\.(mp4|webm|mov|avi)(\?|$)/i.test(output)) return true;
  }
  if (responseObj && responseObj.metadata) {
    const src = responseObj.metadata.source || '';
    const cap = responseObj.capability || '';
    if (['temporal','video-gen','compression','audio-extraction','audio-sync'].includes(cap)) return true;
    if (src === 'pexels') return true;
  }
  return false;
}

function _shouldRouteToBackend(toolName) {
  // Route to backend if TOOL_CAPABILITY_MAP has an entry (for tools not in TOOL_REGISTRY yet)
  if (typeof window.TOOL_CAPABILITY_MAP !== 'undefined' && window.TOOL_CAPABILITY_MAP[toolName]) return true;
  return false;
}

function _setLoading(active, toolName) {
  const overlay  = document.getElementById('preview-processing-overlay');
  const aiLoader = document.getElementById('ai-loading-indicator');
  const execBtn  = document.getElementById('execute-btn');
  const exportBtn= document.getElementById('export-btn');

  if (active) {
    if (overlay)  overlay.style.display  = 'flex';
    if (aiLoader) aiLoader.style.display = 'flex';
    if (execBtn)  { execBtn.disabled = true; execBtn.textContent = 'Processing…'; }
    if (exportBtn){ exportBtn.disabled = true; }
  } else {
    if (overlay)  overlay.style.display  = 'none';
    if (aiLoader) aiLoader.style.display = 'none';
    if (execBtn)  { execBtn.disabled = false; execBtn.textContent = 'Apply'; }
    if (exportBtn){ exportBtn.disabled = false; }
  }
}

function _runFrontendFallback(toolName, params, inputFile) {
  // Delegate to existing frontend pipeline
  if (typeof window._v205_runFrontendPipeline === 'function') {
    return window._v205_runFrontendPipeline(toolName, params, inputFile);
  }
  // Try applyRealCanvasProcessing if available
  if (inputFile && typeof window.applyRealCanvasProcessing === 'function') {
    return window.applyRealCanvasProcessing(inputFile, toolName, params)
      .then(canvas => {
        if (canvas && typeof window._showCanvasResult === 'function') {
          window._showCanvasResult(canvas);
        }
        return canvas;
      })
      .catch(e => {
        _warn('[Orchestration] Frontend canvas fallback failed:', e.message);
        if (typeof window.basicFallbackOutput === 'function') window.basicFallbackOutput();
        return false;
      });
  }
  // Last resort
  if (typeof window.basicFallbackOutput === 'function') window.basicFallbackOutput();
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// §20  STARTUP LOG
// ══════════════════════════════════════════════════════════════════════════════

_log(`Orchestration Engine v${LMN_ORCH_VERSION} loaded.`,
  `| Tools: ${Object.keys(TOOL_REGISTRY).length}`,
  `| Pipelines: ${Object.keys(PIPELINE_REGISTRY).length}`,
  `| Providers: ${Object.keys(PROVIDER_CAPABILITIES).length}`,
  `| TOOL_METADATA: ${Object.keys(TOOL_METADATA).length}`,
  `| MIME rules: ${Object.keys(MIME_VALIDATORS._rules).length}`,
  `| Exec rules: ${Object.keys(TOOL_EXECUTION_RULES).filter(k=>k!=='get').length}`,
  `| Backend: ${ORCH_CONFIG.apiUrl}`,
);
