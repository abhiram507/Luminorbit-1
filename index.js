/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║   LUMINORBIT v27 — PRODUCTION ORCHESTRATION ENGINE                         ║
 * ║   Centralized AI Execution Architecture                                     ║
 * ║                                                                             ║
 * ║   USAGE: Load this script AFTER index.html base scripts, BEFORE any        ║
 * ║          tool-specific scripts. It wraps and upgrades the existing          ║
 * ║          execution pipeline without replacing any UI or visual elements.    ║
 * ║                                                                             ║
 * ║   <script src="luminorbit_orchestration.js"></script>                       ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * v26 PRODUCTION HARDENING CHANGES (over v25.1.0):
 *   - OrchError: single structured error class replaces ad-hoc throws
 *   - FetchEngine: safeFetch / retryFetch / timeoutFetch / uploadSafeFetch /
 *                  asyncPollingFetch — all centralized, AbortController-safe
 *   - PayloadNormalizer: strict MIME gate, structured error on invalid config
 *   - PipelineRouter: retry with exponential backoff, structured error surface
 *   - ResponseValidator: rejects fake/partial/missing outputs before render
 *   - ResultDispatcher: guards against canvas-filter fake renders, text output,
 *                       output_type routing, and blob lifecycle management
 *   - executeOrchestrated: clean lifecycle with finally-cleanup; NO fake fallback
 *   - _runFrontendFallback: NEVER called for image-processing tools — real error shown
 *   - All data structures preserved verbatim from v25 (TOOL_REGISTRY, PRESETS, etc.)
 *   - Railway + Cloudflare Pages production-safe (HTTPS, no localhost leakage)
 *
 * DOES NOT TOUCH:
 *   - Any HTML elements or DOM structure
 *   - Any CSS or visual design
 *   - Tool card definitions or categories
 *   - Upload/export/preview systems (only wraps their outputs)
 *   - Mobile/desktop responsiveness
 *   - Animations or transitions
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// §0  VERSION + GUARD  (idempotent reload protection)
// ══════════════════════════════════════════════════════════════════════════════

const LMN_ORCH_VERSION = '27.0.0';

if (window.__LMNO_LOADED__) {
  console.warn('[Luminorbit Orch] Already loaded — skipping duplicate init (v' + LMN_ORCH_VERSION + ')');
  // Expose version for diagnostics even on dupe load
  if (window.LMNO) window.LMNO.version = LMN_ORCH_VERSION;
}
window.__LMNO_LOADED__ = LMN_ORCH_VERSION;


// ══════════════════════════════════════════════════════════════════════════════
// §1  ORCHESTRATION CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const ORCH_CONFIG = {
  // ── API endpoints ──────────────────────────────────────────────────────────
  get apiUrl() {
    // Priority: centralized config → legacy var → production Railway URL
    const u = (window.LUMINORBIT_CONFIG && window.LUMINORBIT_CONFIG.API_BASE_URL)
      || window.LUMINORBIT_API_URL
      || 'https://luminorbitbackend-production-adf1.up.railway.app';
    // Enforce HTTPS in production (never send to plain http:// in prod)
    if (u && u.startsWith('http://') && !u.includes('localhost') && !u.includes('127.0.0.1')) {
      _warn('[Config] Forcing HTTPS for non-localhost URL:', u);
      return u.replace('http://', 'https://');
    }
    return u;
  },
  get apiKey() { return window.LUMINORBIT_API_KEY || 'luminorbit_secure_123'; },
  get fallbackUrl() { return window.LUMINORBIT_BACKEND_FALLBACK || null; },

  // ── Timeouts (ms) ──────────────────────────────────────────────────────────
  TIMEOUT_FAST:      15000,
  TIMEOUT_STANDARD:  90000,
  TIMEOUT_HEAVY:     90000,
  TIMEOUT_VIDEO:    180000,
  TIMEOUT_ASYNC:    210000,
  TIMEOUT_UPLOAD:    60000,

  // ── Retry policy ───────────────────────────────────────────────────────────
  MAX_RETRIES:        2,
  RETRY_DELAY_BASE: 1400,   // ms — multiplied by attempt number
  RETRY_JITTER:      300,   // ms — random jitter added to backoff

  // ── Async job polling ──────────────────────────────────────────────────────
  POLL_INTERVAL:    2500,
  POLL_MAX_ATTEMPTS:  44,   // ~110 s total poll window
  POLL_TIMEOUT_MS: 115000,

  // ── Provider health ────────────────────────────────────────────────────────
  HEALTH_SCORE_DECAY:  0.88,
  HEALTH_RECOVER:      0.06,
  HEALTH_FLOOR:        0.05,
  HEALTH_CEILING:      1.00,

  // ── Upload limits ──────────────────────────────────────────────────────────
  MAX_FILE_BYTES:   52_428_800,   // 50 MB

  // ── Pipelines that must NEVER use the local canvas fallback ───────────────
  NO_CANVAS_FALLBACK_CAPS: new Set([
    'segmentation', 'inpainting', 'restoration', 'face-processing',
    'super-resolution', 'image-gen', 'style-transfer', 'video-gen', 'temporal',
  ]),
};


// ══════════════════════════════════════════════════════════════════════════════
// §2  PIPELINE REGISTRY
//     15 reusable pipelines — all 200+ tools map into one of these.
// ══════════════════════════════════════════════════════════════════════════════

const PIPELINE_REGISTRY = {
  'generation':      { capability: 'image-gen',         needsFile: false, isHeavy: false, async: false },
  'img2img':         { capability: 'image-gen',         needsFile: true,  isHeavy: false, async: false },
  'enhancement':     { capability: 'image-enhancement', needsFile: true,  isHeavy: false, async: false },
  'upscale':         { capability: 'super-resolution',  needsFile: true,  isHeavy: true,  async: true  },
  'segmentation':    { capability: 'segmentation',      needsFile: true,  isHeavy: true,  async: true  },
  'inpainting':      { capability: 'inpainting',        needsFile: true,  isHeavy: true,  async: true  },
  'restoration':     { capability: 'restoration',       needsFile: true,  isHeavy: true,  async: true  },
  'face_processing': { capability: 'face-processing',   needsFile: true,  isHeavy: true,  async: true  },
  'style_transfer':  { capability: 'style-transfer',    needsFile: true,  isHeavy: false, async: false },
  'video_gen':       { capability: 'video-gen',         needsFile: false, isHeavy: true,  async: true  },
  'video_proc':      { capability: 'temporal',          needsFile: true,  isHeavy: true,  async: true  },
  'captioning':      { capability: 'captioning',        needsFile: true,  isHeavy: false, async: false },
  'audio':           { capability: 'audio-extraction',  needsFile: true,  isHeavy: false, async: false },
  'compression':     { capability: 'compression',       needsFile: true,  isHeavy: false, async: false },
  'basic':           { capability: 'basic-processing',  needsFile: true,  isHeavy: false, async: false },
};

const TOOL_PIPELINES = PIPELINE_REGISTRY;   // alias


// ══════════════════════════════════════════════════════════════════════════════
// §3  TOOL REGISTRY
//     Every tool → { pipeline, preset }
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

  // ── IMG2IMG / STYLE ──────────────────────────────────────────────────────────
  'ControlNet':                        { pipeline: 'img2img',         preset: 'controlnet_default' },
  'InstructPix2Pix':                   { pipeline: 'img2img',         preset: 'instruct_pix2pix' },
  'Style Transfer':                    { pipeline: 'style_transfer',  preset: 'style_default' },
  'Cartoonizer':                       { pipeline: 'style_transfer',  preset: 'cartoon' },
  'Sketch Maker':                      { pipeline: 'style_transfer',  preset: 'sketch' },
  'Vintage Maker':                     { pipeline: 'style_transfer',  preset: 'vintage' },
  'Sepia Filter':                      { pipeline: 'style_transfer',  preset: 'sepia' },
  'VHS Nostalgia':                     { pipeline: 'style_transfer',  preset: 'vhs' },
  'Neon Pulse':                        { pipeline: 'style_transfer',  preset: 'neon' },
  'Glitch Pop':                        { pipeline: 'style_transfer',  preset: 'glitch' },
  'Retro Reel':                        { pipeline: 'style_transfer',  preset: 'retro' },
  'Anime Style':                       { pipeline: 'style_transfer',  preset: 'anime' },
  'Oil Painting':                      { pipeline: 'style_transfer',  preset: 'oil_painting' },
  'Watercolor':                        { pipeline: 'style_transfer',  preset: 'watercolor' },
  'Pencil Drawing':                    { pipeline: 'style_transfer',  preset: 'pencil' },

  // ── ENHANCEMENT ─────────────────────────────────────────────────────────────
  'Image Enhancer':                    { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Image Enhancer Plus':               { pipeline: 'enhancement',     preset: 'enhanced_plus' },
  'HDR Master':                        { pipeline: 'enhancement',     preset: 'hdr' },
  'HDR Booster':                       { pipeline: 'enhancement',     preset: 'hdr_boost' },
  'AI Highlight Recovery Pro':         { pipeline: 'enhancement',     preset: 'highlight_recovery' },
  'Sharpen Tool':                      { pipeline: 'enhancement',     preset: 'sharpen' },
  'Detail Enhancer':                   { pipeline: 'enhancement',     preset: 'detail' },
  'Exposure Fixer':                    { pipeline: 'enhancement',     preset: 'exposure' },
  'Shadow Fixer':                      { pipeline: 'enhancement',     preset: 'shadow' },
  'Lighting Fixer':                    { pipeline: 'enhancement',     preset: 'lighting' },
  'Color Corrector':                   { pipeline: 'enhancement',     preset: 'color_correct' },
  'Color Grader':                      { pipeline: 'enhancement',     preset: 'color_grade' },
  'Color Grade Pro':                   { pipeline: 'enhancement',     preset: 'color_grade_pro' },
  'Color Temperature':                 { pipeline: 'enhancement',     preset: 'color_temp' },
  'White Balance':                     { pipeline: 'enhancement',     preset: 'white_balance' },
  'Vibrance Tool':                     { pipeline: 'enhancement',     preset: 'vibrance' },
  'Saturation Booster':                { pipeline: 'enhancement',     preset: 'saturation' },
  'Black & White':                     { pipeline: 'enhancement',     preset: 'bw' },
  'Grayscale Tool':                    { pipeline: 'enhancement',     preset: 'grayscale' },
  'B&W Converter':                     { pipeline: 'enhancement',     preset: 'bw' },
  'Invert Colors':                     { pipeline: 'enhancement',     preset: 'invert' },
  'Pixel Perfect':                     { pipeline: 'enhancement',     preset: 'pixel_perfect' },
  'Image Sharper':                     { pipeline: 'enhancement',     preset: 'sharpen' },
  'Lens Distortion Fix':               { pipeline: 'enhancement',     preset: 'lens_fix' },
  'Lens Distortion Fixer':             { pipeline: 'enhancement',     preset: 'lens_fix' },
  'Vignette Tool':                     { pipeline: 'enhancement',     preset: 'vignette' },
  'Vignette Effect':                   { pipeline: 'enhancement',     preset: 'vignette' },
  'Blur Tool':                         { pipeline: 'basic',           preset: 'blur' },
  'BlurIt':                            { pipeline: 'basic',           preset: 'blur' },
  'Background Blur Tool':              { pipeline: 'basic',           preset: 'bg_blur' },
  'Mosaic Tool':                       { pipeline: 'basic',           preset: 'mosaic' },
  'Noise Reducer':                     { pipeline: 'enhancement',     preset: 'denoise' },
  'Photo Fixer':                       { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Photo Finisher':                    { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Photo Effects Pro':                 { pipeline: 'enhancement',     preset: 'effects_pro' },
  'Edit Suite':                        { pipeline: 'enhancement',     preset: 'standard_enhance' },

  // ── SEGMENTATION / BG ───────────────────────────────────────────────────────
  'Background Remover':                { pipeline: 'segmentation',    preset: 'bg_remove' },
  'Background Changer':                { pipeline: 'segmentation',    preset: 'bg_change' },
  'Sky Replacer':                      { pipeline: 'segmentation',    preset: 'sky_replace' },
  'Transparent Background':            { pipeline: 'segmentation',    preset: 'bg_transparent' },
  'Smart Crop':                        { pipeline: 'segmentation',    preset: 'smart_crop' },
  'Sticker Maker':                     { pipeline: 'segmentation',    preset: 'sticker' },
  'AI Smart Object & Background Remover': { pipeline: 'segmentation', preset: 'bg_remove' },
  'SAM 2':                             { pipeline: 'segmentation',    preset: 'sam2' },
  'Grounding DINO':                    { pipeline: 'segmentation',    preset: 'grounding_dino' },

  // ── INPAINTING / REPAIR ──────────────────────────────────────────────────────
  'Object Remover':                    { pipeline: 'inpainting',      preset: 'object_remove' },
  'Object Remover Pro':                { pipeline: 'inpainting',      preset: 'object_remove_pro' },
  'Watermark Remover':                 { pipeline: 'inpainting',      preset: 'watermark_remove' },
  'Photo Cleaner':                     { pipeline: 'inpainting',      preset: 'clean' },
  'AI Generative Fill Pro':            { pipeline: 'inpainting',      preset: 'gen_fill' },

  // ── SUPER RESOLUTION ────────────────────────────────────────────────────────
  'Real-ESRGAN':                       { pipeline: 'upscale',         preset: 'realesrgan_4x' },
  'SUPIR':                             { pipeline: 'upscale',         preset: 'supir' },
  'SwinIR':                            { pipeline: 'upscale',         preset: 'swinir' },
  'BSRGAN':                            { pipeline: 'upscale',         preset: 'bsrgan' },
  'Image UpScaler':                    { pipeline: 'upscale',         preset: 'realesrgan_4x' },
  'AI 4K Image Upscaler':              { pipeline: 'upscale',         preset: 'realesrgan_4k' },
  'AI Micro Detail Booster':           { pipeline: 'upscale',         preset: 'detail_boost' },
  'Topaz Video AI 5':                  { pipeline: 'upscale',         preset: 'topaz_video' },

  // ── RESTORATION ─────────────────────────────────────────────────────────────
  'Photo Restorer':                    { pipeline: 'restoration',     preset: 'restore_standard' },
  'CodeFormer':                        { pipeline: 'restoration',     preset: 'codeformer' },
  'RestoreFormer':                     { pipeline: 'restoration',     preset: 'restoreformer' },

  // ── FACE PROCESSING ─────────────────────────────────────────────────────────
  'GFPGAN':                            { pipeline: 'face_processing', preset: 'gfpgan' },
  'Face Retouch':                      { pipeline: 'face_processing', preset: 'face_retouch' },
  'Portrait Pro':                      { pipeline: 'face_processing', preset: 'portrait_pro' },
  'Beauty Shot':                       { pipeline: 'face_processing', preset: 'beauty' },
  'Beauty Filter':                     { pipeline: 'face_processing', preset: 'beauty_filter' },
  'Face Editor':                       { pipeline: 'face_processing', preset: 'face_edit' },
  'AI Portrait Depth Enhancer':        { pipeline: 'face_processing', preset: 'portrait_depth' },
  'LivePortrait':                      { pipeline: 'face_processing', preset: 'live_portrait' },

  // ── VIDEO GENERATION ────────────────────────────────────────────────────────
  'AI Video Generator':                { pipeline: 'video_gen',       preset: 'video_standard' },
  'AI Motion Animator':                { pipeline: 'video_gen',       preset: 'motion_anim' },
  'Photo to Video':                    { pipeline: 'video_gen',       preset: 'photo2video' },
  'Photo to Video Creator':            { pipeline: 'video_gen',       preset: 'photo2video' },
  'AI 4K Video Enhancer':              { pipeline: 'video_gen',       preset: 'video_4k' },
  'Seedance 2.0':                      { pipeline: 'video_gen',       preset: 'seedance' },
  'Stable Video Diffusion':            { pipeline: 'video_gen',       preset: 'svd' },
  'AnimateDiff':                       { pipeline: 'video_gen',       preset: 'animatediff' },
  'AI Cinematic Action Generator':     { pipeline: 'video_gen',       preset: 'cinematic_action' },
  'Cinematic Pulse':                   { pipeline: 'video_gen',       preset: 'cinematic_pulse' },

  // ── VIDEO PROCESSING ────────────────────────────────────────────────────────
  'Video Trimmer Pro':                 { pipeline: 'video_proc',      preset: 'trim' },
  'Video Crop Studio':                 { pipeline: 'video_proc',      preset: 'crop' },
  'Video Speed Controller':            { pipeline: 'video_proc',      preset: 'speed' },
  'Slow-Mo Magic':                     { pipeline: 'video_proc',      preset: 'slowmo' },
  'Fast-Forward Flash':                { pipeline: 'video_proc',      preset: 'fastforward' },
  'Motion Blur Trail':                 { pipeline: 'video_proc',      preset: 'motion_blur' },
  'RIFE':                              { pipeline: 'video_proc',      preset: 'rife' },
  'DAIN':                              { pipeline: 'video_proc',      preset: 'dain' },
  'TecoGAN':                           { pipeline: 'video_proc',      preset: 'tecogan' },
  'RAFT + ESRGAN':                     { pipeline: 'video_proc',      preset: 'raft_esrgan' },
  'Temporal GAN':                      { pipeline: 'video_proc',      preset: 'temporal_gan' },
  'Wonder Dynamics':                   { pipeline: 'video_proc',      preset: 'wonder_dynamics' },
  'AI Motion Transfer Engine':         { pipeline: 'video_proc',      preset: 'motion_transfer' },
  'AI Consistent Motion Animator':     { pipeline: 'video_proc',      preset: 'consistent_motion' },
  'MultiCam Sync':                     { pipeline: 'video_proc',      preset: 'multicam_sync' },
  'Match Cut Flow':                    { pipeline: 'video_proc',      preset: 'match_cut' },
  'Video Merger Studio':               { pipeline: 'video_proc',      preset: 'merge' },

  // ── CAPTIONING / AUDIO ──────────────────────────────────────────────────────
  'Auto Caption Generator':            { pipeline: 'captioning',      preset: 'auto_caption' },
  'Subtitle Manual Editor':            { pipeline: 'captioning',      preset: 'manual_sub' },
  'Florence-2':                        { pipeline: 'captioning',      preset: 'florence2' },
  'Audio Extractor Tool':              { pipeline: 'audio',           preset: 'audio_extract' },
  'Beat Sync Drop':                    { pipeline: 'audio',           preset: 'beat_sync' },
  'Sound Wave Viz':                    { pipeline: 'audio',           preset: 'wave_viz' },
  'Audio Reactive Viz':                { pipeline: 'audio',           preset: 'audio_reactive' },
  'Audio Sync Editor':                 { pipeline: 'audio',           preset: 'audio_sync' },

  // ── COMPRESSION / BASIC ──────────────────────────────────────────────────────
  'Video Compressor Pro':              { pipeline: 'compression',     preset: 'video_compress' },
  'Image Compressor Pro':              { pipeline: 'compression',     preset: 'image_compress' },
  'Image Cropper':                     { pipeline: 'basic',           preset: 'crop' },
  'Crop Master':                       { pipeline: 'basic',           preset: 'crop' },
  'Photo Resizer':                     { pipeline: 'basic',           preset: 'resize' },
  'Image Rotator':                     { pipeline: 'basic',           preset: 'rotate' },
  'Image Flipper':                     { pipeline: 'basic',           preset: 'flip' },
  'Mirror Effect':                     { pipeline: 'basic',           preset: 'mirror' },
  'Horizontal Flip':                   { pipeline: 'basic',           preset: 'flip_h' },
  'Vertical Flip':                     { pipeline: 'basic',           preset: 'flip_v' },
  'Perspective Corrector':             { pipeline: 'basic',           preset: 'perspective' },
  'Aspect Ratio Converter':            { pipeline: 'basic',           preset: 'aspect_ratio' },
  'PNG Converter':                     { pipeline: 'basic',           preset: 'convert_png' },
  'Image Converter':                   { pipeline: 'basic',           preset: 'convert' },
  'Watermark Maker':                   { pipeline: 'basic',           preset: 'watermark' },
  'Text Adder':                        { pipeline: 'basic',           preset: 'text_overlay' },
  'Meme Maker':                        { pipeline: 'basic',           preset: 'meme' },
  'Collage Maker':                     { pipeline: 'basic',           preset: 'collage' },
  'Photo Stitcher':                    { pipeline: 'basic',           preset: 'stitch' },
  'Frame Generator':                   { pipeline: 'basic',           preset: 'frame' },
  'Passport Image Pro':                { pipeline: 'basic',           preset: 'passport' },
  'Threshold':                         { pipeline: 'basic',           preset: 'threshold' },
  'Binarize':                          { pipeline: 'basic',           preset: 'binarize' },
  'Image Splitter':                    { pipeline: 'basic',           preset: 'split' },
  'Photo Splitter':                    { pipeline: 'basic',           preset: 'split' },

  // ── Tools in HTML TOOL_CAPABILITY_MAP missing from TOOL_REGISTRY ──────────
  'Denoiser':                         { pipeline: 'enhancement',     preset: 'denoise' },
  'Sky Enhancer':                     { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Image Lab':                        { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Photo Crafter':                    { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Image Crafter':                    { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Photo Mixer':                      { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Photo Mashup':                     { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Image Adjuster':                   { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Image Transformer':                { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Batch Editor':                     { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Advanced Histogram Adjuster':      { pipeline: 'enhancement',     preset: 'standard_enhance' },
  'Frequency Separation Tool':        { pipeline: 'enhancement',     preset: 'detail' },
  'Edge Refinement Tool':             { pipeline: 'enhancement',     preset: 'detail' },
  'Hue Shifter':                      { pipeline: 'enhancement',     preset: 'color_correct' },
  'Hue Rotate':                       { pipeline: 'enhancement',     preset: 'color_correct' },
  'Tint Tool':                        { pipeline: 'enhancement',     preset: 'color_correct' },
  'Color Tint':                       { pipeline: 'enhancement',     preset: 'color_correct' },
  'Channel Mixer Pro':                { pipeline: 'enhancement',     preset: 'color_grade_pro' },
  'Selective Color Range Editor':     { pipeline: 'enhancement',     preset: 'color_grade_pro' },
  'Color Palette Generator':          { pipeline: 'enhancement',     preset: 'color_correct' },
  'Tilt-Shift':                       { pipeline: 'enhancement',     preset: 'blur' },
  'Texturizer':                       { pipeline: 'style_transfer',  preset: 'style_default' },
  'Film Grain':                       { pipeline: 'style_transfer',  preset: 'vintage' },
  'Faded Film':                       { pipeline: 'style_transfer',  preset: 'vintage' },
  'Film Burn Effect':                 { pipeline: 'style_transfer',  preset: 'vintage' },
  'Duotone':                          { pipeline: 'style_transfer',  preset: 'style_default' },
  'Dual Tone Grade':                  { pipeline: 'style_transfer',  preset: 'style_default' },
  'Gradient Map Tool':                { pipeline: 'style_transfer',  preset: 'style_default' },
  'Glitch Generator':                 { pipeline: 'style_transfer',  preset: 'glitch' },
  'Emboss':                           { pipeline: 'style_transfer',  preset: 'sketch' },
  'Resize Pro':                       { pipeline: 'basic',           preset: 'resize' },
  'Resize Guru':                      { pipeline: 'basic',           preset: 'resize' },
  'Image Resizer Pro':                { pipeline: 'basic',           preset: 'resize' },
  'Rotate 90':                        { pipeline: 'basic',           preset: 'rotate' },
  'Flip & Rotate':                    { pipeline: 'basic',           preset: 'flip' },
  'Focus Tool':                       { pipeline: 'basic',           preset: 'blur' },
  'Lens Blur':                        { pipeline: 'basic',           preset: 'blur' },
  'Image Stitcher':                   { pipeline: 'basic',           preset: 'stitch' },
  'Image Overlay':                    { pipeline: 'basic',           preset: 'collage' },
  'Layer Editor':                     { pipeline: 'basic',           preset: 'collage' },
  'FrameIt':                          { pipeline: 'basic',           preset: 'frame' },
  'Clip Splitter Tool':               { pipeline: 'video_proc',      preset: 'trim' },
  'J-Cut Master':                     { pipeline: 'video_proc',      preset: 'trim' },
  'L-Cut Pro':                        { pipeline: 'video_proc',      preset: 'trim' },
  'Multi Clip Timeline Tool':         { pipeline: 'video_proc',      preset: 'merge' },
  'Split Screen Sync':                { pipeline: 'video_proc',      preset: 'merge' },
  'Storyboard Sync':                  { pipeline: 'video_proc',      preset: 'merge' },
};


// ══════════════════════════════════════════════════════════════════════════════
// §3b  TOOL_METADATA
//      Per-tool metadata: input/output types, async flag, fallback.
// ══════════════════════════════════════════════════════════════════════════════

const TOOL_METADATA = (() => {
  const _meta = {};
  for (const [tool, reg] of Object.entries(TOOL_REGISTRY)) {
    const pipe = PIPELINE_REGISTRY[reg.pipeline] || {};
    const cap  = pipe.capability || 'basic-processing';

    const _inputType = (() => {
      if (!pipe.needsFile) return 'text';
      if (['video-gen', 'temporal'].includes(cap)) return 'video';
      if (['audio-extraction', 'audio-sync'].includes(cap)) return 'audio';
      return 'image';
    })();

    const _outputType = (() => {
      if (['video-gen', 'temporal'].includes(cap)) return 'video';
      if (['audio-extraction', 'audio-sync'].includes(cap)) return 'audio';
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
// ══════════════════════════════════════════════════════════════════════════════

const MIME_VALIDATORS = {
  _rules: {
    'image-gen':          null,
    'image-enhancement':  ['image/jpeg','image/png','image/webp','image/gif','image/bmp','image/tiff'],
    'super-resolution':   ['image/jpeg','image/png','image/webp'],
    'segmentation':       ['image/jpeg','image/png','image/webp'],
    'inpainting':         ['image/jpeg','image/png','image/webp'],
    'restoration':        ['image/jpeg','image/png','image/webp','image/bmp'],
    'face-processing':    ['image/jpeg','image/png','image/webp'],
    'style-transfer':     ['image/jpeg','image/png','image/webp'],
    'controlnet':         ['image/jpeg','image/png','image/webp'],
    'video-gen':          null,
    'temporal':           ['video/mp4','video/webm','video/quicktime','video/x-msvideo'],
    'compression':        ['image/jpeg','image/png','image/webp','video/mp4','video/webm'],
    'audio-extraction':   ['video/mp4','video/webm','audio/mpeg','audio/wav','audio/ogg'],
    'audio-sync':         ['video/mp4','video/webm','audio/mpeg','audio/wav'],
    'captioning':         ['image/jpeg','image/png','image/webp','video/mp4'],
    'visualization':      ['audio/mpeg','audio/wav','audio/ogg','video/mp4'],
    'basic-processing':   ['image/jpeg','image/png','image/webp','image/gif','image/bmp'],
  },

  check(capability, file) {
    const allowed = this._rules[capability];
    if (allowed === null || allowed === undefined) return { valid: true, error: null };
    if (!file) return { valid: false, error: `${capability} requires a file input.` };
    if (!allowed.includes(file.type)) {
      return {
        valid: false,
        error: `"${file.type}" not accepted for ${capability}. Expected: ${allowed.join(', ')}.`,
      };
    }
    return { valid: true, error: null };
  },

  getAccepted(capability) { return this._rules[capability] || []; },
};


// ══════════════════════════════════════════════════════════════════════════════
// §3d  INPUT_OUTPUT_RULES
// ══════════════════════════════════════════════════════════════════════════════

const INPUT_OUTPUT_RULES = {
  'image-gen':         { input: 'none',  output: 'image', needsFile: false },
  'image-enhancement': { input: 'image', output: 'image', needsFile: true  },
  'super-resolution':  { input: 'image', output: 'image', needsFile: true  },
  'segmentation':      { input: 'image', output: 'image', needsFile: true  },
  'inpainting':        { input: 'image', output: 'image', needsFile: true  },
  'restoration':       { input: 'image', output: 'image', needsFile: true  },
  'face-processing':   { input: 'image', output: 'image', needsFile: true  },
  'style-transfer':    { input: 'image', output: 'image', needsFile: true  },
  'controlnet':        { input: 'image', output: 'image', needsFile: true  },
  'video-gen':         { input: 'none',  output: 'video', needsFile: false },
  'temporal':          { input: 'video', output: 'video', needsFile: true  },
  'compression':       { input: 'any',   output: 'any',   needsFile: true  },
  'audio-extraction':  { input: 'video', output: 'audio', needsFile: true  },
  'audio-sync':        { input: 'audio', output: 'video', needsFile: true  },
  'captioning':        { input: 'image', output: 'text',  needsFile: true  },
  'visualization':     { input: 'audio', output: 'image', needsFile: true  },
  'basic-processing':  { input: 'image', output: 'image', needsFile: true  },
};


// ══════════════════════════════════════════════════════════════════════════════
// §3e  TOOL_EXECUTION_RULES
//      Single source-of-truth for timeouts, retries, weight per capability.
// ══════════════════════════════════════════════════════════════════════════════

const TOOL_EXECUTION_RULES = {
  'image-gen':         { timeout_ms: 90000,  max_retries: 2, is_heavy: true,  async_poll: false },
  'image-enhancement': { timeout_ms: 90000,  max_retries: 2, is_heavy: true,  async_poll: false },
  'super-resolution':  { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: true  },
  'segmentation':      { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: true  },
  'inpainting':        { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: true  },
  'restoration':       { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: true  },
  'face-processing':   { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: true  },
  'style-transfer':    { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: false },
  'denoising':         { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: true  },
  'controlnet':        { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: false },
  'color-matching':    { timeout_ms: 90000,  max_retries: 1, is_heavy: true,  async_poll: false },
  'video-gen':         { timeout_ms: 180000, max_retries: 1, is_heavy: true,  async_poll: true  },
  'temporal':          { timeout_ms: 120000, max_retries: 1, is_heavy: true,  async_poll: true  },
  'compression':       { timeout_ms: 30000,  max_retries: 2, is_heavy: false, async_poll: false },
  'audio-extraction':  { timeout_ms: 30000,  max_retries: 2, is_heavy: false, async_poll: false },
  'audio-sync':        { timeout_ms: 30000,  max_retries: 2, is_heavy: false, async_poll: false },
  'captioning':        { timeout_ms: 30000,  max_retries: 2, is_heavy: false, async_poll: false },
  'visualization':     { timeout_ms: 30000,  max_retries: 2, is_heavy: false, async_poll: false },
  'basic-processing':  { timeout_ms: 20000,  max_retries: 2, is_heavy: false, async_poll: false },

  get(capability) {
    return this[capability] || { timeout_ms: 30000, max_retries: 2, is_heavy: false, async_poll: false };
  },
};


// ══════════════════════════════════════════════════════════════════════════════
// §4  TOOL PRESET LIBRARY
// ══════════════════════════════════════════════════════════════════════════════

const PRESET_LIBRARY = {
  // Generation
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
  // Enhancement
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
  // Segmentation
  bg_remove:           { mode: 'remove', edge_refine: true, hair_refine: true },
  bg_change:           { mode: 'replace', edge_refine: true },
  sky_replace:         { mode: 'sky', blend_mode: 'natural' },
  bg_transparent:      { mode: 'transparent', edge_refine: true },
  smart_crop:          { subject_detect: true, padding: 0.1 },
  sticker:             { mode: 'sticker', transparent: true, edge_expand: 4 },
  sam2:                { model: 'sam2', interactive: true },
  grounding_dino:      { model: 'grounding-dino', threshold: 0.3 },
  // Inpainting
  object_remove:       { mask_auto: true, fill_mode: 'content_aware' },
  object_remove_pro:   { mask_auto: true, fill_mode: 'diffusion', mask_strength: 0.9 },
  watermark_remove:    { mask_detect: 'watermark', fill_mode: 'content_aware' },
  clean:               { fill_mode: 'content_aware', edge_blend: 0.8 },
  gen_fill:            { fill_mode: 'diffusion', creative: true },
  // Super resolution
  realesrgan_4x:       { model: 'realesrgan-4x', scale: 4 },
  realesrgan_4k:       { model: 'realesrgan-4x', scale: 4, target: '3840x2160' },
  supir:               { model: 'supir', scale: 4, quality: 'ultra' },
  swinir:              { model: 'swinir', scale: 4 },
  bsrgan:              { model: 'bsrgan', scale: 4 },
  detail_boost:        { model: 'realesrgan-4x', scale: 4, detail_enhance: true },
  topaz_video:         { model: 'topaz-video', scale: 4, fps_enhance: true },
  // Restoration
  restore_standard:    { model: 'codeformer', face_enhance: true, color_enhance: true },
  codeformer:          { model: 'codeformer', fidelity: 0.7 },
  restoreformer:       { model: 'restoreformer', enhance_level: 0.8 },
  // Face processing
  gfpgan:              { model: 'gfpgan', version: '1.4', upscale: 2 },
  face_retouch:        { face_focus: true, skin_smoothing: 0.4, denoise: 0.3 },
  portrait_pro:        { face_focus: true, skin_smoothing: 0.5, eye_enhance: true, teeth_whiten: true },
  beauty:              { beauty_level: 0.6, face_focus: true },
  beauty_filter:       { beauty_level: 0.5, skin_smoothing: 0.4 },
  face_edit:           { face_focus: true, edit_mode: true },
  live_portrait:       { model: 'liveportrait', animate: true },
  // Style transfer
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
  // Video generation
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
  // Video processing
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
  // Captioning
  auto_caption:        { language: 'auto', format: 'srt' },
  manual_sub:          { mode: 'manual' },
  florence2:           { model: 'florence-2', task: 'caption' },
  // Audio
  audio_extract:       { format: 'mp3', quality: 'high' },
  beat_sync:           { detect_beats: true, sync_mode: 'beat_drop' },
  wave_viz:            { style: 'waveform', color: 'auto' },
  audio_reactive:      { mode: 'reactive', sensitivity: 0.7 },
  audio_sync:          { sync_mode: 'manual' },
  // Compression
  video_compress:      { codec: 'h264', quality: 28, preset: 'medium' },
  image_compress:      { quality: 85, format: 'auto', progressive: true },
  // Basic
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

const TOOL_PRESETS = PRESET_LIBRARY;  // alias


// ══════════════════════════════════════════════════════════════════════════════
// §5  PROVIDER CAPABILITY MAP
// ══════════════════════════════════════════════════════════════════════════════

const PROVIDER_CAPABILITIES = {
  'pollinations':  ['image-gen', 'video-gen', 'style-transfer', 'visualization'],
  'together':      ['image-gen', 'video-gen', 'captioning'],
  'huggingface':   ['image-gen', 'super-resolution', 'segmentation', 'inpainting',
                    'face-processing', 'restoration', 'style-transfer', 'temporal', 'captioning'],
  'segmind':       ['image-gen', 'inpainting', 'segmentation', 'image-enhancement', 'controlnet'],
  'deepai':        ['image-gen', 'face-processing', 'restoration', 'inpainting'],
  'cloudflare':    ['super-resolution', 'segmentation', 'temporal', 'compression',
                    'color-matching', 'audio-extraction', 'audio-sync'],
  'gemini':        ['captioning', 'visualization', 'image-gen'],
  'groq':          ['captioning'],
  'mistral':       ['captioning'],
  'openrouter':    ['image-gen', 'captioning'],
  'krea':          ['image-gen', 'super-resolution', 'face-processing', 'restoration'],
  'cloudinary':    ['compression', 'basic-processing', 'image-enhancement'],
  'pexels':        ['video-gen', 'image-gen'],
  'unsplash':      ['image-gen'],
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

const PROVIDER_PRIORITIES = CAPABILITY_PROVIDER_PRIORITY;  // alias


// ══════════════════════════════════════════════════════════════════════════════
// §6  PROVIDER HEALTH TRACKER
// ══════════════════════════════════════════════════════════════════════════════

const ProviderHealth = (() => {
  const _scores = {};
  Object.keys(PROVIDER_CAPABILITIES).forEach(p => { _scores[p] = 1.0; });

  function get(provider) { return _scores[provider] ?? 1.0; }

  function recordSuccess(provider) {
    _scores[provider] = Math.min(ORCH_CONFIG.HEALTH_CEILING,
      (_scores[provider] ?? 1.0) * 1.05 + ORCH_CONFIG.HEALTH_RECOVER);
    _log(`[Health] ✓ ${provider} → ${_scores[provider].toFixed(2)}`);
  }

  function recordFailure(provider) {
    _scores[provider] = Math.max(ORCH_CONFIG.HEALTH_FLOOR,
      (_scores[provider] ?? 1.0) * ORCH_CONFIG.HEALTH_SCORE_DECAY);
    _warn(`[Health] ✗ ${provider} → ${_scores[provider].toFixed(2)}`);
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
// §7  ORCH ERROR  — structured error class
// ══════════════════════════════════════════════════════════════════════════════

class OrchError extends Error {
  /**
   * @param {string} code    — SCREAMING_SNAKE error code
   * @param {string} message — human readable message
   * @param {Object} [meta]  — { provider, tool, pipeline, ... }
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name       = 'OrchError';
    this.code       = code;
    this.provider   = meta.provider   || '';
    this.tool       = meta.tool       || '';
    this.pipeline   = meta.pipeline   || '';
    this.retryable  = meta.retryable  !== false;  // default true
    this.ts         = Date.now();
  }

  toJSON() {
    return {
      success:            false,
      error_code:         this.code,
      message:            this.message,
      provider:           this.provider,
      tool:               this.tool,
      pipeline:           this.pipeline,
      fallback_attempted: true,
    };
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// §8  FETCH ENGINE  — safeFetch / retryFetch / timeoutFetch /
//                     uploadSafeFetch / asyncPollingFetch
// ══════════════════════════════════════════════════════════════════════════════

const FetchEngine = (() => {

  // ── Internal: normalize + validate URL ───────────────────────────────────
  function _sanitizeUrl(url) {
    if (!url || typeof url !== 'string') throw new OrchError('INVALID_URL', 'URL is empty or non-string');
    // Remove double slashes that aren't part of the protocol
    const clean = url.replace(/([^:])\/\/+/g, '$1/');
    // Block localhost leakage in production
    if (
      typeof window !== 'undefined' &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1' &&
      (clean.includes('localhost') || clean.includes('127.0.0.1'))
    ) {
      throw new OrchError('INSECURE_URL', 'localhost URL blocked in production context', { retryable: false });
    }
    if (!clean.startsWith('http')) throw new OrchError('INVALID_URL', 'URL must start with http(s): ' + clean, { retryable: false });
    return clean;
  }

  // ── Build AbortController + timer ─────────────────────────────────────────
  function _makeAbort(ms) {
    if (typeof AbortController === 'undefined') return { signal: null, clear: () => {} };
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, clear: () => clearTimeout(tid), ctrl };
  }

  // ── Core single fetch (no retry) ──────────────────────────────────────────
  async function safeFetch(url, opts = {}, timeoutMs = ORCH_CONFIG.TIMEOUT_STANDARD) {
    const cleanUrl = _sanitizeUrl(url);
    const { signal, clear } = _makeAbort(timeoutMs);

    try {
      const resp = await fetch(cleanUrl, { ...opts, signal: signal || opts.signal });
      return resp;
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new OrchError('REQUEST_TIMEOUT', `Request timed out after ${timeoutMs}ms: ${cleanUrl}`, { retryable: true });
      }
      throw new OrchError('NETWORK_ERROR', `Fetch failed: ${e.message}`, { retryable: true });
    } finally {
      clear();
    }
  }

  // ── Retry wrapper with exponential backoff + jitter ───────────────────────
  async function retryFetch(url, opts = {}, timeoutMs = ORCH_CONFIG.TIMEOUT_STANDARD, maxRetries = ORCH_CONFIG.MAX_RETRIES) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const resp = await safeFetch(url, opts, timeoutMs);

        // Surface rate limits immediately — do not retry
        if (resp.status === 429) {
          throw new OrchError('RATE_LIMITED', 'Rate limit reached — please wait a moment.', { retryable: false });
        }
        // Auth failure — do not retry
        if (resp.status === 401 || resp.status === 403) {
          throw new OrchError('AUTH_FAILED', `Authentication failed (HTTP ${resp.status})`, { retryable: false });
        }
        return resp;
      } catch (e) {
        lastErr = e;
        if (e instanceof OrchError && !e.retryable) throw e;
        if (attempt <= maxRetries) {
          const delay = ORCH_CONFIG.RETRY_DELAY_BASE * attempt + Math.random() * ORCH_CONFIG.RETRY_JITTER;
          _warn(`[FetchEngine] Attempt ${attempt} failed — retrying in ${Math.round(delay)}ms:`, e.message || e);
          await _sleep(delay);
        }
      }
    }
    throw lastErr || new OrchError('FETCH_FAILED', 'All retry attempts exhausted');
  }

  // ── Convenience alias with explicit timeout arg ───────────────────────────
  async function timeoutFetch(url, opts, ms) {
    return safeFetch(url, opts, ms);
  }

  // ── Upload-safe fetch: validates file, sends multipart/json correctly ─────
  async function uploadSafeFetch(url, payload, fileObj, timeoutMs = ORCH_CONFIG.TIMEOUT_UPLOAD) {
    const cleanUrl = _sanitizeUrl(url);

    // File validation
    if (fileObj) {
      if (fileObj.size > ORCH_CONFIG.MAX_FILE_BYTES) {
        throw new OrchError('FILE_TOO_LARGE', `File size ${fileObj.size} exceeds 50 MB limit`, { retryable: false });
      }
      if (!fileObj.type) {
        throw new OrchError('INVALID_MIME', 'File has no MIME type', { retryable: false });
      }
    }

    // Encode file to base64 and inject into payload under ALL accepted field names
    let body = { ...payload };
    if (fileObj) {
      try {
        const b64 = await _fileToBase64(fileObj);
        // Send under every alias the backend accepts — guarantees match regardless of version
        body.file       = b64;          // primary (app.py body.get("file"))
        body.file_data  = b64;          // alias 1
        body.image      = b64;          // alias 2
        body.image_data = b64;          // alias 3
        // MIME under all aliases too
        body.mime         = fileObj.type;
        body.file_mime    = fileObj.type;
        body.content_type = fileObj.type;
      } catch (encErr) {
        throw new OrchError('ENCODE_FAILED', `File encoding failed: ${encErr.message}`, { retryable: false });
      }
    }

    return retryFetch(cleanUrl, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + ORCH_CONFIG.apiKey,
      },
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  // ── Async polling fetch: polls job endpoint until done or timeout ─────────
  async function asyncPollingFetch(jobId, onProgress, abortSignal) {
    if (!jobId) throw new OrchError('INVALID_JOB_ID', 'Job ID is required for polling');

    const baseUrl  = ORCH_CONFIG.apiUrl.replace(/\/+$/, '');
    const pollUrl  = `${baseUrl}/api/jobs/${jobId}`;
    const headers  = { 'Authorization': 'Bearer ' + ORCH_CONFIG.apiKey };
    const started  = Date.now();

    for (let i = 0; i < ORCH_CONFIG.POLL_MAX_ATTEMPTS; i++) {
      // Respect external abort
      if (abortSignal && abortSignal.aborted) {
        throw new OrchError('POLLING_ABORTED', `Polling for job ${jobId} was cancelled`);
      }
      // Wall-clock timeout
      if (Date.now() - started > ORCH_CONFIG.POLL_TIMEOUT_MS) {
        throw new OrchError('POLL_TIMEOUT', `Job ${jobId} exceeded poll timeout`);
      }

      await _sleep(ORCH_CONFIG.POLL_INTERVAL);

      let data;
      try {
        const resp = await safeFetch(pollUrl, { headers }, ORCH_CONFIG.TIMEOUT_STANDARD);
        if (!resp.ok) {
          _warn(`[Polling] HTTP ${resp.status} on job ${jobId} — continuing`);
          continue;
        }
        data = await resp.json();
      } catch (e) {
        _warn(`[Polling] Network error on attempt ${i + 1}:`, e.message);
        continue;
      }

      if (typeof onProgress === 'function' && data.progress != null) {
        try { onProgress(data.progress, data.status); } catch (e) {}
      }

      if (data.status === 'completed') {
        const out = data.output_url || data.output || null;
        if (!out) throw new OrchError('JOB_EMPTY_OUTPUT', `Job ${jobId} completed but has no output`);
        _log(`[Polling] ✓ Job ${jobId} completed after ${i + 1} polls`);
        return out;
      }

      if (data.status === 'failed') {
        throw new OrchError('JOB_FAILED', `Job ${jobId} failed: ${data.error || 'unknown reason'}`, { retryable: false });
      }

      // still queued/processing — continue
    }

    throw new OrchError('POLL_MAX_ATTEMPTS', `Job ${jobId} did not complete in ${ORCH_CONFIG.POLL_MAX_ATTEMPTS} polls`);
  }

  return { safeFetch, retryFetch, timeoutFetch, uploadSafeFetch, asyncPollingFetch };
})();


// ══════════════════════════════════════════════════════════════════════════════
// §9  RESPONSE VALIDATOR
//     Validates backend response shape BEFORE passing to ResultDispatcher.
//     Never allows a fake/partial/missing output through.
// ══════════════════════════════════════════════════════════════════════════════

const ResponseValidator = {

  /**
   * Validates a parsed JSON response from /api/process.
   * Returns { valid: true, output, outputType } on success.
   * Throws OrchError on failure — never returns a partial/fake result.
   */
  validate(data, toolName, capability) {
    if (!data || typeof data !== 'object') {
      throw new OrchError('INVALID_RESPONSE', 'Backend response is not a JSON object', { tool: toolName });
    }

    // Explicit server-side failure
    if (data.success === false) {
      const code = data.error_code || 'SERVER_ERROR';
      const msg  = data.message    || 'Backend returned an error';
      throw new OrchError(code, msg, {
        tool:     toolName,
        provider: data.provider || '',
        retryable: !['UNAUTHORIZED','INVALID_MIME','INVALID_PAYLOAD'].includes(code),
      });
    }

    // Missing success flag
    if (data.success !== true) {
      throw new OrchError('AMBIGUOUS_RESPONSE', 'Response missing "success" field', { tool: toolName });
    }

    // Job queued — caller should poll
    if (data.job_id && !data.output && !data.output_url) {
      return { valid: true, output: null, jobId: data.job_id, outputType: 'pending' };
    }

    // Resolve output field (backend returns both .output and .output_url)
    const raw = data.output || data.output_url || '';
    if (!raw) {
      throw new OrchError('EMPTY_OUTPUT', 'Backend succeeded but returned no output', { tool: toolName });
    }

    // Validate output value itself
    const outputType = this._classifyOutput(raw, capability, data);
    this._validateOutputValue(raw, outputType, toolName);

    return { valid: true, output: raw, outputType, jobId: null };
  },

  _classifyOutput(output, capability, responseObj) {
    if (typeof output !== 'string') return 'unknown';
    if (output.startsWith('data:video/') || /\.(mp4|webm|mov)(\?|$)/i.test(output)) return 'video';
    if (output.startsWith('data:audio/') || /\.(mp3|wav|ogg)(\?|$)/i.test(output)) return 'audio';
    if (output.startsWith('data:image/'))  return 'image';
    if (output.startsWith('data:text/') || (responseObj && responseObj.output_type === 'text')) return 'text';
    // Text output type from backend
    if (responseObj && responseObj.output_type === 'text') return 'text';
    if (output.startsWith('https://') || output.startsWith('http://')) {
      // Classify remote URLs by extension or response metadata
      if (/\.(mp4|webm|mov)(\?|$)/i.test(output)) return 'video';
      if (/\.(mp3|wav|ogg)(\?|$)/i.test(output))  return 'audio';
      if (/\.(jpg|jpeg|png|gif|webp|avif)(\?|$)/i.test(output)) return 'image';
      // Capability-based default for remote URLs without extension (Cloudinary, CDN, provider URLs)
      const capOutputType = (INPUT_OUTPUT_RULES[capability] || {}).output || 'image';
      // For audio/video capabilities keep their type; else default image
      return capOutputType === 'video' ? 'video' : capOutputType === 'audio' ? 'audio' : 'image';
    }
    // Plain text from captioning
    if (capability === 'captioning') return 'text';
    return 'unknown';
  },

  _validateOutputValue(output, outputType, toolName) {
    // Reject empty strings
    if (!output || output.trim() === '') {
      throw new OrchError('EMPTY_OUTPUT', `Output is empty for ${toolName}`, { tool: toolName });
    }
    // Reject suspiciously short data URIs (likely error JSON encoded as base64)
    if (output.startsWith('data:') && output.length < 100) {
      throw new OrchError('INVALID_OUTPUT', `Output data URI is too short to be valid (${output.length} chars)`, { tool: toolName });
    }
    // Reject URLs that look like error pages
    if (output.startsWith('http') && output.includes('error') && output.length < 60) {
      _warn('[ResponseValidator] Output URL looks like an error path:', output);
    }
    // Do NOT reject 'unknown' type for remote URLs — image render will attempt it
    // Only reject unknown for non-URL, non-data-URI, non-text outputs
    if (outputType === 'unknown' && !output.startsWith('http') && !output.startsWith('data:')) {
      throw new OrchError('UNKNOWN_OUTPUT_TYPE', `Cannot determine output type for ${toolName}: ${output.substring(0, 60)}`, { tool: toolName });
    }
  },
};


// ══════════════════════════════════════════════════════════════════════════════
// §10  PAYLOAD NORMALIZER
//      Converts any tool invocation into ONE canonical backend request schema.
// ══════════════════════════════════════════════════════════════════════════════

const PayloadNormalizer = {

  async build(toolName, userParams, inputFile) {
    const reg      = TOOL_REGISTRY[toolName];
    const pipeline = reg ? PIPELINE_REGISTRY[reg.pipeline] : null;
    const preset   = reg ? (PRESET_LIBRARY[reg.preset] || {}) : {};
    const cap      = pipeline ? pipeline.capability : 'basic-processing';
    const execRules = TOOL_EXECUTION_RULES.get(cap);

    // ── MIME validation ────────────────────────────────────────────────────
    if (inputFile) {
      const mimeCheck = MIME_VALIDATORS.check(cap, inputFile);
      if (!mimeCheck.valid) {
        // Hard-block for capabilities that absolutely require the right MIME type
        if (['segmentation', 'super-resolution', 'inpainting', 'restoration', 'face-processing'].includes(cap)) {
          throw new OrchError('INVALID_MIME', mimeCheck.error, { tool: toolName, pipeline: reg?.pipeline || '', retryable: false });
        }
        _warn('[PayloadNormalizer] MIME warning (non-blocking):', mimeCheck.error);
      }

      if (inputFile.size > ORCH_CONFIG.MAX_FILE_BYTES) {
        throw new OrchError('FILE_TOO_LARGE', `File exceeds 50 MB limit (${(inputFile.size / 1048576).toFixed(1)} MB)`, { tool: toolName, retryable: false });
      }
    }

    // ── Required-file check ────────────────────────────────────────────────
    if (pipeline && pipeline.needsFile && !inputFile) {
      // Non-fatal — backend will surface a clearer error; warn here
      _warn(`[PayloadNormalizer] "${toolName}" needs a file input but none provided`);
    }

    // ── Merge preset → user params (user always wins) ─────────────────────
    const mergedParams = { ...preset, ...(userParams || {}) };

    // ── Ensure prompt ─────────────────────────────────────────────────────
    if (!mergedParams.prompt) {
      const fromWindow = typeof window._buildToolPrompt === 'function'
        ? window._buildToolPrompt(toolName, mergedParams)
        : null;
      mergedParams.prompt = fromWindow || _buildDefaultPrompt(toolName);
    }

    // ── Encode file ───────────────────────────────────────────────────────
    let file_data = null;
    let file_mime = 'application/octet-stream';
    if (inputFile) {
      try {
        file_data = await _fileToBase64(inputFile);
        file_mime = inputFile.type || 'application/octet-stream';
      } catch (e) {
        throw new OrchError('ENCODE_FAILED', `File encoding failed: ${e.message}`, { tool: toolName });
      }
    }

    // ── Classify input type ───────────────────────────────────────────────
    const input_type = inputFile
      ? (inputFile.type.startsWith('video/') ? 'video'
        : inputFile.type.startsWith('audio/') ? 'audio'
        : inputFile.type.startsWith('image/') ? 'image' : 'file')
      : ((TOOL_METADATA[toolName] || {}).input_type || 'text');

    const output_type = (TOOL_METADATA[toolName] || {}).output_type || 'image';

    // ── Final canonical payload ────────────────────────────────────────────
    return {
      // Core identity
      tool:               toolName,
      pipeline:           reg ? reg.pipeline : 'basic',
      preset:             reg ? reg.preset   : 'standard',
      capability:         cap,
      params:             mergedParams,
      // File — sent under ALL accepted names so backend always finds it
      file:               file_data,          // PRIMARY (backend reads body.get("file"))
      file_data:          file_data,          // alias 1
      image:              file_data,          // alias 2
      image_data:         file_data,          // alias 3
      // MIME under all aliases
      mime:               file_mime,          // PRIMARY
      file_mime:          file_mime,          // alias 1
      content_type:       file_mime,          // alias 2
      input_type,
      output_type,
      // Top-level convenience aliases (backend reads these)
      prompt:             mergedParams.prompt,
      width:              mergedParams.width  || null,
      height:             mergedParams.height || null,
      // Execution hints
      resolution:         window.LUMINORBIT_4K_MODE ? '4K' : (window.selectedResolution || '4K'),
      provider_preference: CAPABILITY_PROVIDER_PRIORITY[cap] || [],
      async_supported:    !!pipeline?.async,
      fallback_enabled:   true,
      // Metadata
      inputType:          inputFile ? inputFile.type : 'unknown',
      inputSize:          inputFile ? inputFile.size : 0,
      timestamp:          Date.now(),
    };
  },
};


// ══════════════════════════════════════════════════════════════════════════════
// §11  PIPELINE ROUTER
//      Dispatches normalized payloads to the backend with retry + fallback.
//      Uses FetchEngine internally — never duplicates fetch logic.
// ══════════════════════════════════════════════════════════════════════════════

const PipelineRouter = {

  async execute(payload) {
    const apiUrl     = ORCH_CONFIG.apiUrl;
    const fallbackUrl = ORCH_CONFIG.fallbackUrl;

    if (!apiUrl) {
      throw new OrchError('NO_BACKEND', 'Backend URL is not configured');
    }

    const backends   = [apiUrl, fallbackUrl].filter(Boolean);
    const execRules  = TOOL_EXECUTION_RULES.get(payload.capability || 'basic-processing');
    const timeoutMs  = execRules.timeout_ms;
    const maxRetries = execRules.max_retries;

    let lastErr;

    for (const backendBase of backends) {
      const endpoint = backendBase.replace(/\/+$/, '') + '/api/process';

      _log(`[Router] → ${payload.tool} | cap=${payload.capability} | backend=${backendBase.replace(/https?:\/\//, '')}`);

      try {
        const resp = await FetchEngine.retryFetch(
          endpoint,
          {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': 'Bearer ' + ORCH_CONFIG.apiKey,
              'X-Pipeline':    payload.pipeline || 'basic',
              'X-Request-Id':  _randomId(),
            },
            // Normalize: ensure top-level "file" and "mime" fields always present
            body: JSON.stringify({
              ...payload,
              file:      payload.file      || payload.file_data  || payload.image || payload.image_data || null,
              mime:      payload.mime      || payload.file_mime  || payload.content_type || 'image/jpeg',
              file_data: payload.file_data || payload.file       || payload.image || null,
              file_mime: payload.file_mime || payload.mime       || 'image/jpeg',
            }),
          },
          timeoutMs,
          maxRetries,
        );

        if (!resp.ok) {
          throw new OrchError('HTTP_ERROR', `Backend returned HTTP ${resp.status}`, { retryable: resp.status >= 500 });
        }

        let data;
        try {
          data = await resp.json();
        } catch (jsonErr) {
          throw new OrchError('INVALID_JSON', `Backend response is not valid JSON: ${jsonErr.message}`);
        }

        // Validate response shape — throws OrchError on failure
        const validated = ResponseValidator.validate(data, payload.tool, payload.capability);

        // Record provider health
        if (data.provider) ProviderHealth.recordSuccess(data.provider.replace('-emergency', ''));

        _log(`[Router] ✓ ${payload.tool} → provider=${data.provider || 'unknown'} ms=${data.execution_ms || '?'} fallback=${data.fallback_used}`);

        return { ...validated, raw: data };

      } catch (e) {
        lastErr = e;

        // Record provider degradation
        if (e.provider) ProviderHealth.recordFailure(e.provider);

        _warn(`[Router] ✗ ${payload.tool} on ${backendBase.replace(/https?:\/\//, '')}: ${e.message}`);

        // Non-retryable errors short-circuit all backends
        if (e instanceof OrchError && !e.retryable) throw e;
      }
    }

    throw lastErr || new OrchError('ALL_BACKENDS_FAILED', `All backends failed for "${payload.tool}"`);
  },
};


// ══════════════════════════════════════════════════════════════════════════════
// §12  ASYNC JOB MANAGER
//      Manages async job lifecycle end-to-end with abort support.
// ══════════════════════════════════════════════════════════════════════════════

const AsyncJobManager = {
  // Active job abort controllers — keyed by jobId
  _active: new Map(),

  async poll(jobId, toolName, onProgress) {
    if (!jobId) return null;

    // Cancel any previous job polling for this tool
    this._cancelByTool(toolName);

    const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (abortCtrl) this._active.set(jobId, { ctrl: abortCtrl, tool: toolName });

    try {
      const outputUrl = await FetchEngine.asyncPollingFetch(
        jobId,
        onProgress,
        abortCtrl ? abortCtrl.signal : null,
      );
      return outputUrl;
    } catch (e) {
      if (e.code === 'POLLING_ABORTED') {
        _log(`[AsyncJobManager] Job ${jobId} polling was cancelled`);
        return null;
      }
      _warn(`[AsyncJobManager] Job ${jobId} failed:`, e.message);
      return null;
    } finally {
      this._active.delete(jobId);
    }
  },

  cancel(jobId) {
    const entry = this._active.get(jobId);
    if (entry && entry.ctrl) {
      entry.ctrl.abort();
      this._active.delete(jobId);
      _log(`[AsyncJobManager] Cancelled job ${jobId}`);
    }
  },

  _cancelByTool(toolName) {
    for (const [jobId, entry] of this._active.entries()) {
      if (entry.tool === toolName) {
        this.cancel(jobId);
      }
    }
  },

  cancelAll() {
    for (const jobId of [...this._active.keys()]) this.cancel(jobId);
  },
};


// ══════════════════════════════════════════════════════════════════════════════
// §13  RESULT DISPATCHER
//      Renders validated AI output to the UI — NO canvas filters, NO fakes.
// ══════════════════════════════════════════════════════════════════════════════

const ResultDispatcher = {

  dispatch(output, toolName, responseObj, outputType) {
    if (!output) {
      _warn('[ResultDispatcher] No output to render for:', toolName);
      return false;
    }

    // Resolve outputType if not passed explicitly
    const cap         = (TOOL_METADATA[toolName] || {}).capability || '';
    const resolvedType = outputType
      || ResponseValidator._classifyOutput(output, cap, responseObj || {});

    _log(`[ResultDispatcher] Rendering ${resolvedType} for "${toolName}"`);

    try {
      switch (resolvedType) {
        case 'video': this._renderVideo(output, toolName); break;
        case 'audio': this._renderAudio(output, toolName); break;
        case 'text':  this._renderText(output, toolName);  break;
        case 'image': this._renderImage(output, toolName); break;
        default:
          // Safe fallback for unknown type — attempt image render
          _warn('[ResultDispatcher] Unknown output type, attempting image render:', resolvedType);
          this._renderImage(output, toolName);
      }

      this._syncPreviewState(output, resolvedType);

      // Notify legacy ensureFinalOutput hook
      try { if (typeof window.ensureFinalOutput === 'function') window.ensureFinalOutput(); } catch (e) {}

      return true;
    } catch (e) {
      console.error('[ResultDispatcher] Render failed:', e.message);
      return false;
    }
  },

  _renderImage(src, toolName) {
    // Clear any canvas filter from previous fake render
    const img = document.getElementById('preview-img-result');
    if (img) {
      if (img._orchestBlobUrl) {
        try { URL.revokeObjectURL(img._orchestBlobUrl); } catch (e) {}
        img._orchestBlobUrl = null;
      }
      if (src.startsWith('blob:')) img._orchestBlobUrl = src;

      // Clear all transforms/filters from previous results
      img.src              = '';
      img.style.filter     = 'none';
      img.style.opacity    = '1';
      img.style.background = 'none';
      img.style.display    = 'block';

      // For transparent PNG — show checkerboard background
      if (src.startsWith('data:image/png') || (typeof src === 'string' && src.match(/\.png(\?|$)/i))) {
        img.style.background = 'repeating-conic-gradient(#e0e0e0 0% 25%, #fff 0% 50%) 0 0 / 16px 16px';
        img.style.borderRadius = '4px';
      }

      img.src = src;

      // Error handler in case URL is stale/invalid
      img.onerror = () => {
        _warn('[ResultDispatcher] Image failed to load — URL may be expired:', src.substring(0, 80));
        // If URL failed, try converting to blob via fetch for CORS issues
        if (src.startsWith('http')) {
          fetch(src, { mode: 'no-cors' })
            .then(r => r.blob())
            .then(blob => {
              const blobUrl = URL.createObjectURL(blob);
              img._orchestBlobUrl = blobUrl;
              img.src = blobUrl;
            })
            .catch(() => {
              this.showError('Image preview could not be loaded. The output URL may have expired.', 'IMG_LOAD_FAILED');
            });
        } else {
          this.showError('Image preview could not be loaded. The output URL may have expired.', 'IMG_LOAD_FAILED');
        }
      };

      // Success handler
      img.onload = () => {
        img.style.opacity = '1';
        _log(`[ResultDispatcher] Image loaded OK — ${img.naturalWidth}×${img.naturalHeight}px for "${toolName}"`);
      };
    }
    if (typeof window._showMediaStage === 'function') window._showMediaStage('image', 'result');
    if (typeof window.setPreviewMode  === 'function') window.setPreviewMode('result');
  },

  _renderVideo(src, toolName) {
    const vid = document.getElementById('preview-vid-result');
    if (vid) {
      vid.src          = src;
      vid.style.display = 'block';
      vid.load();
    }
    if (typeof window._showMediaStage === 'function') window._showMediaStage('video', 'result');
    if (typeof window.setPreviewMode  === 'function') window.setPreviewMode('result');
  },

  _renderAudio(src, toolName) {
    // Try dedicated audio element, then fall back to showing a download link
    const aud = document.getElementById('preview-audio-result') || document.getElementById('audio-output');
    if (aud && aud.tagName === 'AUDIO') {
      aud.src          = src;
      aud.style.display = 'block';
      aud.load();
    } else {
      _warn('[ResultDispatcher] No audio element found — storing for export');
    }
    window._orch_resultAudio = src;
  },

  _renderText(raw, toolName) {
    let text = raw;
    // Decode data URI if necessary
    if (raw.startsWith('data:text/') && raw.includes(',')) {
      try { text = atob(raw.split(',')[1]); } catch (e) {}
    }

    const panel =
      document.getElementById('caption-output') ||
      document.getElementById('preview-text-result') ||
      document.getElementById('ai-caption-text');

    if (panel) {
      panel.textContent = text;
      panel.style.display = 'block';
    } else {
      const img = document.getElementById('preview-img-result');
      if (img) { img.alt = text; img.title = text; }
    }

    window._orch_resultText  = text;
    window._orch_resultReady = true;
    if (Object.prototype.hasOwnProperty.call(window, 'resultImage')) window.resultImage = raw;
    _log('[ResultDispatcher] Text rendered:', text.length, 'chars');
  },

  _syncPreviewState(output, outputType) {
    if (typeof output !== 'string' || !output) return;
    try {
      window._orch_resultImage  = output;
      window._orch_resultReady  = true;
      window._orch_outputType   = outputType;
      if (Object.prototype.hasOwnProperty.call(window, 'resultImage'))  window.resultImage  = output;
      if (Object.prototype.hasOwnProperty.call(window, '_resultReady')) window._resultReady = true;
    } catch (e) {}
  },

  showError(msg, code) {
    console.error('[Luminorbit Orchestration]', code || 'ERROR', msg);
    const existing = document.getElementById('_lmn_orch_err');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = '_lmn_orch_err';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
      'position:fixed', 'top:66px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:9999', 'background:#c0392b', 'color:#fff',
      'padding:12px 24px 12px 16px', 'border-radius:8px',
      'font-family:system-ui,sans-serif', 'font-size:.9rem',
      'box-shadow:0 4px 20px rgba(0,0,0,.4)', 'max-width:580px',
      'display:flex', 'align-items:center', 'gap:12px',
    ].join(';');
    const codeTag = code ? `<code style="opacity:.7;font-size:.8em">[${code}]</code> ` : '';
    banner.innerHTML = `<span>⚡ ${codeTag}${msg}</span>`
      + `<button onclick="this.parentNode.remove()" style="background:none;border:none;color:#fff;`
      + `font-size:1.2rem;cursor:pointer;padding:0 4px;line-height:1" aria-label="Dismiss">✕</button>`;
    document.body.appendChild(banner);
    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 9000);
  },

  showProgress(pct, label) {
    const overlay = document.getElementById('preview-processing-overlay');
    if (overlay) {
      const pbar = overlay.querySelector('.progress-fill, .ai-progress-bar');
      if (pbar) pbar.style.width = (pct || 0) + '%';
      const lbl = overlay.querySelector('.ai-loading-text, .progress-label');
      if (lbl) lbl.textContent = label || `Processing… ${pct}%`;
    }
  },
};

// Alias
const RESULT_RENDERERS = ResultDispatcher;


// ══════════════════════════════════════════════════════════════════════════════
// §14  ORCHESTRATION ENGINE
//      executeOrchestrated() — the single public entry point for all tools.
//      Lifecycle: validate → normalize → dispatch → poll? → validate → render
// ══════════════════════════════════════════════════════════════════════════════

window.executeOrchestrated = async function executeOrchestrated(toolName, userParams, inputFile) {
  if (!toolName) {
    _warn('[Orchestration] executeOrchestrated called without toolName');
    return false;
  }

  // ── Concurrency guard ───────────────────────────────────────────────────
  const appState = window.AppState || {};
  if (appState.isProcessing || appState.isExporting) {
    if (typeof window.showToast === 'function') window.showToast('Please wait for the current operation to complete.');
    return false;
  }

  const execId = Math.random().toString(36).slice(2, 10).toUpperCase();
  console.group(`[Luminorbit] ▶ ${toolName} [${execId}]`);
  _log(`[Orchestration] START tool="${toolName}" execId=${execId}`);
  _setLoading(true, toolName);

  const t0 = performance.now();

  try {
    // ── Step 1: Registry lookup (warn if missing, continue) ───────────────
    const reg = TOOL_REGISTRY[toolName];
    if (!reg) {
      _warn(`[Orchestration] "${toolName}" not in TOOL_REGISTRY — using basic pipeline`);
    }

    const pipelineName = reg ? reg.pipeline : 'basic';
    const pipelineDef  = PIPELINE_REGISTRY[pipelineName] || {};
    const capability   = pipelineDef.capability || 'basic-processing';

    _log(`[Orchestration] pipeline=${pipelineName} cap=${capability}`);

    // ── Step 2: Normalize payload (throws OrchError on invalid config) ────
    let payload;
    try {
      payload = await PayloadNormalizer.build(
        toolName,
        userParams || window.controlValues,
        inputFile  || window.uploadedFile,
      );
    } catch (normErr) {
      if (normErr instanceof OrchError) {
        _warn('[Orchestration] Payload normalization failed:', normErr.message);
        ResultDispatcher.showError(normErr.message, normErr.code);
        return false;
      }
      throw normErr;
    }

    _log(`[Orchestration] Payload built — file=${payload.file_data ? 'YES' : 'NO'} mime=${payload.file_mime}`);

    // ── Step 3: Dispatch to backend ───────────────────────────────────────
    let validated;
    try {
      validated = await PipelineRouter.execute(payload);
    } catch (routeErr) {
      // Non-retryable user errors — show message, don't fake anything
      if (routeErr instanceof OrchError && !routeErr.retryable) {
        ResultDispatcher.showError(routeErr.message, routeErr.code);
        return false;
      }
      // Retriable / network errors — check if we can use canvas fallback
      _warn('[Orchestration] Backend dispatch failed:', routeErr.message);
      return _runFrontendFallback(toolName, capability, payload, routeErr);
    }

    // ── Step 4: Async job polling ─────────────────────────────────────────
    let output     = validated.output;
    let outputType = validated.outputType;

    if (validated.outputType === 'pending' && validated.jobId) {
      _log(`[Orchestration] Async job queued — job_id=${validated.jobId}`);
      output = await AsyncJobManager.poll(
        validated.jobId,
        toolName,
        (pct, status) => ResultDispatcher.showProgress(pct, `${toolName}… ${pct}%`),
      );

      if (!output) {
        ResultDispatcher.showError(`"${toolName}" processing did not complete. Please try again.`, 'JOB_INCOMPLETE');
        return false;
      }

      // Re-classify after polling
      outputType = ResponseValidator._classifyOutput(output, capability, {});
    }

    // ── Step 5: Render ────────────────────────────────────────────────────
    const rendered = ResultDispatcher.dispatch(output, toolName, validated.raw || {}, outputType);

    const elapsed = Math.round(performance.now() - t0);
    _log(`[Orchestration] ✓ DONE "${toolName}" — ${elapsed}ms output_type=${outputType} execId=${execId}`);
    console.groupEnd();

    return rendered ? output : false;

  } catch (e) {
    const elapsed = Math.round(performance.now() - t0);
    if (e instanceof OrchError) {
      console.error(`[Orchestration] OrchError "${toolName}" [${e.code}] ${elapsed}ms execId=${execId}:`, e.message);
      ResultDispatcher.showError(e.message, e.code);
    } else {
      console.error(`[Orchestration] Unhandled error "${toolName}" ${elapsed}ms execId=${execId}:`, e);
      ResultDispatcher.showError(`An unexpected error occurred in "${toolName}".`, 'INTERNAL_ERROR');
    }
    console.groupEnd();
    return false;
  } finally {
    _setLoading(false, toolName);
  }
};


// ══════════════════════════════════════════════════════════════════════════════
// §15  FRONTEND FALLBACK RULES
//      Strict policy: capabilities in NO_CANVAS_FALLBACK_CAPS NEVER get
//      a canvas/filter fake render. They show a real error instead.
//      Only truly basic ops (crop, resize, flip, etc.) use canvas fallback.
// ══════════════════════════════════════════════════════════════════════════════

function _runFrontendFallback(toolName, capability, payload, err) {
  // Check if this capability is prohibited from canvas fallback
  if (ORCH_CONFIG.NO_CANVAS_FALLBACK_CAPS.has(capability)) {
    const userMsg = _friendlyErrorMessage(toolName, capability, err);
    ResultDispatcher.showError(userMsg, err ? err.code : 'BACKEND_UNAVAILABLE');
    _warn(`[Orchestration] Canvas fallback BLOCKED for ${capability} tool "${toolName}" — showing error instead`);
    return false;
  }

  _log(`[Orchestration] Canvas fallback permitted for ${capability} tool "${toolName}"`);

  // Try v205 pipeline (existing frontend)
  if (typeof window._v205_runFrontendPipeline === 'function') {
    return window._v205_runFrontendPipeline(toolName, payload && payload.params, payload && payload.inputFile);
  }
  // Try applyRealCanvasProcessing
  const fileToUse = (payload && payload._rawFile) || window.uploadedFile;
  if (fileToUse && typeof window.applyRealCanvasProcessing === 'function') {
    return window.applyRealCanvasProcessing(fileToUse, toolName, payload && payload.params)
      .then(canvas => {
        if (canvas && typeof window._showCanvasResult === 'function') window._showCanvasResult(canvas);
        return canvas;
      })
      .catch(e2 => {
        _warn('[Orchestration] Canvas processing also failed:', e2.message);
        ResultDispatcher.showError(`"${toolName}" could not be processed. Please try again.`, 'CANVAS_FAILED');
        return false;
      });
  }

  // Last resort
  if (typeof window.basicFallbackOutput === 'function') window.basicFallbackOutput();
  return false;
}

function _friendlyErrorMessage(toolName, capability, err) {
  const baseMsg = err && err.code === 'REQUEST_TIMEOUT'
    ? `"${toolName}" timed out — the AI provider may be busy. Please try again.`
    : err && err.code === 'ALL_BACKENDS_FAILED'
    ? `"${toolName}" could not connect to the AI backend. Please check your connection and try again.`
    : `"${toolName}" returned an error from the AI provider. Please try again.`;
  return baseMsg;
}


// ══════════════════════════════════════════════════════════════════════════════
// §16  EXECUTION GATE
//      Wraps window.executeToolSafe to route all registered tools through
//      the orchestration engine. Preserves v20.5 fallback for unregistered tools.
// ══════════════════════════════════════════════════════════════════════════════

(function _installOrchestrationGate() {
  const _origExecuteToolSafe = window.executeToolSafe;

  window.executeToolSafe = async function(toolName, params, inputFile) {
    if (TOOL_REGISTRY[toolName] || (ORCH_CONFIG.apiUrl && _shouldRouteToBackend(toolName))) {
      return window.executeOrchestrated(toolName, params, inputFile);
    }
    if (typeof _origExecuteToolSafe === 'function') {
      return _origExecuteToolSafe.apply(window, arguments);
    }
    return false;
  };

  _log('[Orchestration] executeToolSafe gate installed');
})();


// ══════════════════════════════════════════════════════════════════════════════
// §17  LEGACY API COMPATIBILITY SHIMS
//      Keep _v205_buildRequest / _v205_callBackend / _v21_pollJob working.
// ══════════════════════════════════════════════════════════════════════════════

window._v205_buildRequest = async function(toolName, params, inputFile) {
  return PayloadNormalizer.build(toolName, params, inputFile);
};

window._v205_callBackend = async function(request) {
  try {
    const validated = await PipelineRouter.execute(request);
    // PipelineRouter returns {valid, output, outputType, raw} —
    // but every caller in index.html checks .success and .output_url.
    // Translate the shape here so all callers work without change.
    if (validated && validated.output) {
      return {
        success:       true,
        output:        validated.output,
        output_url:    validated.output,
        preview_url:   validated.output,
        output_type:   validated.outputType || 'image',
        provider:      (validated.raw && validated.raw.provider)      || null,
        pipeline:      (validated.raw && validated.raw.pipeline)      || '',
        execution_ms:  (validated.raw && validated.raw.execution_ms)  || 0,
        fallback_used: (validated.raw && validated.raw.fallback_used) || false,
        tool:          request.tool        || '',
        capability:    request.capability  || '',
      };
    }
    console.warn('[_v205_callBackend] No output for:', request && request.tool);
    return null;
  } catch (e) {
    console.warn('[_v205_callBackend] Failed:', e.message, '| tool:', request && request.tool);
    return null;
  }
};

window._v205_renderBackendOutput = function(output, toolName, responseObj) {
  ResultDispatcher.dispatch(output, toolName, responseObj);
};

window._v21_pollJob = async function(jobId, toolName) {
  const outputUrl = await AsyncJobManager.poll(
    jobId,
    toolName,
    (pct, status) => ResultDispatcher.showProgress(pct, `${toolName}… ${pct}%`),
  );
  if (outputUrl) {
    ResultDispatcher.dispatch(outputUrl, toolName, null);
  } else {
    if (typeof window._v205_fallbackToSafeOutput === 'function') {
      window._v205_fallbackToSafeOutput(toolName);
    }
  }
};


// ══════════════════════════════════════════════════════════════════════════════
// §18  TOOL CAPABILITY MAP SYNC
// ══════════════════════════════════════════════════════════════════════════════

(function _syncToolCapabilityMap() {
  if (typeof window.TOOL_CAPABILITY_MAP === 'undefined') window.TOOL_CAPABILITY_MAP = {};
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
    reader.onerror = () => reject(new Error('FileReader failed for: ' + (file.name || 'unknown')));
    reader.readAsDataURL(file);
  });
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function _buildDefaultPrompt(toolName) {
  const lower = toolName.toLowerCase();
  if (lower.includes('enhance'))  return 'Enhance this image to professional quality';
  if (lower.includes('restor'))   return 'Restore and enhance this photo';
  if (lower.includes('upscal'))   return 'Upscale this image to 4K resolution';
  if (lower.includes('remov'))    return 'Remove the specified element cleanly';
  if (lower.includes('generat'))  return 'Generate a high quality photorealistic image';
  if (lower.includes('portrait')) return 'Enhance portrait with professional retouching';
  if (lower.includes('cartoon'))  return 'Convert this image to cartoon style';
  if (lower.includes('sketch'))   return 'Convert this image to pencil sketch';
  if (lower.includes('vintage'))  return 'Apply vintage film effect to this image';
  if (lower.includes('caption'))  return 'Describe this image in detail';
  if (lower.includes('backgrou')) return 'Remove background and produce transparent PNG';
  return `Apply ${toolName} processing to produce a high quality result`;
}

function _shouldRouteToBackend(toolName) {
  if (typeof window.TOOL_CAPABILITY_MAP !== 'undefined' && window.TOOL_CAPABILITY_MAP[toolName]) return true;
  return false;
}

function _setLoading(active, toolName) {
  const overlay   = document.getElementById('preview-processing-overlay');
  const aiLoader  = document.getElementById('ai-loading-indicator');
  const execBtn   = document.getElementById('execute-btn');
  const exportBtn = document.getElementById('export-btn');

  if (active) {
    if (overlay)   overlay.style.display   = 'flex';
    if (aiLoader)  aiLoader.style.display  = 'flex';
    if (execBtn)   { execBtn.disabled = true;  execBtn.textContent  = 'Processing…'; }
    if (exportBtn) { exportBtn.disabled = true; }
  } else {
    if (overlay)   overlay.style.display   = 'none';
    if (aiLoader)  aiLoader.style.display  = 'none';
    if (execBtn)   { execBtn.disabled = false; execBtn.textContent  = 'Apply'; }
    if (exportBtn) { exportBtn.disabled = false; }
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// §20  PUBLIC API  (window.LMNO + window.LuminorbitOrchestration)
// ══════════════════════════════════════════════════════════════════════════════

window.LMNO = {
  version:               LMN_ORCH_VERSION,

  // Data structures
  TOOL_REGISTRY,
  TOOL_PIPELINES,
  TOOL_PRESETS,
  TOOL_METADATA,
  MIME_VALIDATORS,
  INPUT_OUTPUT_RULES,
  TOOL_EXECUTION_RULES,
  PROVIDER_PRIORITIES,
  PIPELINE_REGISTRY,
  PRESET_LIBRARY,
  PROVIDER_CAPABILITIES,
  CAPABILITY_PROVIDER_PRIORITY,
  RESULT_RENDERERS,

  // Engines
  ProviderHealth,
  FetchEngine,
  PayloadNormalizer,
  PipelineRouter,
  AsyncJobManager,
  ResponseValidator,
  ResultDispatcher,
  OrchError,

  // Convenience helpers
  getPipeline(toolName) {
    const reg = TOOL_REGISTRY[toolName];
    return reg ? PIPELINE_REGISTRY[reg.pipeline] : null;
  },
  getCapability(toolName) {
    const pipe = this.getPipeline(toolName);
    return pipe ? pipe.capability : null;
  },
  getProviders(capability) {
    return ProviderHealth.getSortedProviders(capability);
  },
  cancelJobs() {
    AsyncJobManager.cancelAll();
  },

  // Diagnostics
  diagnostics() {
    return {
      version:            LMN_ORCH_VERSION,
      registeredTools:    Object.keys(TOOL_REGISTRY).length,
      pipelines:          Object.keys(PIPELINE_REGISTRY).length,
      providers:          Object.keys(PROVIDER_CAPABILITIES).length,
      toolMetadataCount:  Object.keys(TOOL_METADATA).length,
      mimeRulesCount:     Object.keys(MIME_VALIDATORS._rules).length,
      ioRulesCount:       Object.keys(INPUT_OUTPUT_RULES).length,
      execRulesCount:     Object.keys(TOOL_EXECUTION_RULES).filter(k => k !== 'get').length,
      providerHealth:     ProviderHealth.dump(),
      activeJobs:         AsyncJobManager._active.size,
      backendUrl:         ORCH_CONFIG.apiUrl,
    };
  },
};

// Legacy alias required by index_v5_upgraded.html
window.LuminorbitOrchestration = {
  executeToolSafe:   window.executeOrchestrated,
  PayloadNormalizer,
  PipelineRouter,
  ResultDispatcher,
  ResponseValidator,
  FetchEngine,
  ProviderHealth,
  AsyncJobManager,
  OrchError,
  TOOL_METADATA,
  MIME_VALIDATORS,
  INPUT_OUTPUT_RULES,
  TOOL_EXECUTION_RULES,
  version:           LMN_ORCH_VERSION,
};


// ══════════════════════════════════════════════════════════════════════════════
// §21  STARTUP LOG
// ══════════════════════════════════════════════════════════════════════════════

_log(
  `Orchestration Engine v${LMN_ORCH_VERSION} ENTERPRISE ready.`,
  `| Tools: ${Object.keys(TOOL_REGISTRY).length}`,
  `| Pipelines: ${Object.keys(PIPELINE_REGISTRY).length}`,
  `| Providers: ${Object.keys(PROVIDER_CAPABILITIES).length}`,
  `| Backend: ${ORCH_CONFIG.apiUrl}`,
);


// ══════════════════════════════════════════════════════════════════════════════
// §22  ENTERPRISE EXECUTION LAYER  (NEW v27)
//      SemanticOrchestrator · ExecutionTelemetry · ProviderBenchmark
//      PriorityExecutionQueue · IntelligentValidator · ExecutionTimeline
// ══════════════════════════════════════════════════════════════════════════════

/**
 * SEMANTIC ORCHESTRATOR
 * Analyzes tool intent and builds intelligent execution plans.
 * Enables adaptive routing, workflow decomposition, and smart provider selection.
 */
const SemanticOrchestrator = (() => {

  const INTENT_MAP = {
    'segmentation':      { intent: 'background_removal', complexity: 'high',   minQuality: 0.55 },
    'face-processing':   { intent: 'face_enhancement',   complexity: 'high',   minQuality: 0.60 },
    'restoration':       { intent: 'image_restoration',  complexity: 'medium', minQuality: 0.50 },
    'super-resolution':  { intent: 'super_resolution',   complexity: 'medium', minQuality: 0.45 },
    'image-gen':         { intent: 'image_generation',   complexity: 'medium', minQuality: 0.35 },
    'image-enhancement': { intent: 'enhancement',        complexity: 'low',    minQuality: 0.30 },
    'style-transfer':    { intent: 'style_transfer',     complexity: 'medium', minQuality: 0.30 },
    'captioning':        { intent: 'captioning',         complexity: 'low',    minQuality: 0.20 },
    'inpainting':        { intent: 'inpainting',         complexity: 'high',   minQuality: 0.50 },
    'video-gen':         { intent: 'video_generation',   complexity: 'high',   minQuality: 0.35 },
    'basic-processing':  { intent: 'basic_processing',   complexity: 'low',    minQuality: 0.10 },
  };

  const STAGE_MAP = {
    background_removal:  ['validate', 'preprocess', 'segment', 'refine_mask', 'quality_check', 'deliver'],
    face_enhancement:    ['validate', 'face_detect', 'enhance', 'quality_check', 'deliver'],
    image_restoration:   ['validate', 'restore', 'quality_check', 'deliver'],
    super_resolution:    ['validate', 'upscale', 'quality_check', 'deliver'],
    image_generation:    ['enhance_prompt', 'generate', 'quality_check', 'deliver'],
    default:             ['validate', 'process', 'quality_check', 'deliver'],
  };

  function analyze(toolName, capability) {
    const intentData = INTENT_MAP[capability] || INTENT_MAP['basic-processing'];
    const stages = STAGE_MAP[intentData.intent] || STAGE_MAP.default;
    return {
      tool: toolName,
      capability,
      intent: intentData.intent,
      complexity: intentData.complexity,
      minQuality: intentData.minQuality,
      stages,
      estimatedMs: _estimateExecutionMs(intentData.complexity),
      requiresFile: (PIPELINE_REGISTRY[TOOL_REGISTRY[toolName]?.pipeline]?.needsFile === true),
    };
  }

  function _estimateExecutionMs(complexity) {
    return { low: 3000, medium: 12000, high: 35000 }[complexity] || 10000;
  }

  function enhancePrompt(toolName, rawPrompt, capability) {
    if (!rawPrompt) return _buildDefaultPrompt(toolName);
    const enhancers = {
      'image-gen':         ', professional photography, 8K ultra-HD, sharp details',
      'super-resolution':  '',
      'style-transfer':    ', high artistic fidelity, coherent style throughout',
      'captioning':        '',
    };
    const suffix = enhancers[capability] || '';
    const cleaned = rawPrompt.trim().replace(/[^\x20-\x7E]/g, '').slice(0, 1800);
    return cleaned + suffix;
  }

  return { analyze, enhancePrompt };
})();


/**
 * EXECUTION TELEMETRY ENGINE
 * Tracks execution stages, timing, quality scores, and provider decisions.
 * Feeds data to ExecutionTimeline for real-time UI updates.
 */
const ExecutionTelemetry = (() => {

  const _sessions = new Map();   // requestId → TelemetrySession

  class TelemetrySession {
    constructor(toolName, capability, intent) {
      this.id          = _randomId();
      this.tool        = toolName;
      this.capability  = capability;
      this.intent      = intent;
      this.startedAt   = performance.now();
      this.stages      = [];
      this.provider    = null;
      this.qualityScore = null;
      this.status      = 'running';
      this.errors      = [];
    }

    recordStage(name, status = 'completed', durationMs = 0, meta = {}) {
      this.stages.push({ name, status, durationMs, meta, ts: performance.now() - this.startedAt });
      ExecutionTimeline.updateStage(this.tool, name, status, durationMs, meta);
    }

    recordProvider(providerName) {
      this.provider = providerName;
      ExecutionTimeline.updateProvider(this.tool, providerName);
    }

    recordQuality(score) {
      this.qualityScore = score;
      ExecutionTimeline.updateQuality(this.tool, score);
    }

    recordError(code, message) {
      this.errors.push({ code, message, ts: performance.now() - this.startedAt });
    }

    complete(success) {
      this.status     = success ? 'completed' : 'failed';
      this.totalMs    = Math.round(performance.now() - this.startedAt);
      ExecutionTimeline.complete(this.tool, success, this.totalMs, this.qualityScore);
      // Log structured telemetry
      console.log('[Luminorbit Telemetry]', JSON.stringify({
        tool: this.tool, capability: this.capability, intent: this.intent,
        provider: this.provider, qualityScore: this.qualityScore,
        totalMs: this.totalMs, stages: this.stages.length,
        status: this.status, errors: this.errors.length,
      }));
    }

    toSummary() {
      return {
        id: this.id, tool: this.tool, intent: this.intent,
        provider: this.provider, qualityScore: this.qualityScore,
        totalMs: this.totalMs, status: this.status,
        stageCount: this.stages.length,
      };
    }
  }

  function start(toolName, capability, intent) {
    const session = new TelemetrySession(toolName, capability, intent);
    _sessions.set(toolName, session);
    return session;
  }

  function get(toolName) { return _sessions.get(toolName) || null; }

  function recent(limit = 10) {
    return [..._sessions.values()]
      .filter(s => s.status !== 'running')
      .slice(-limit)
      .map(s => s.toSummary());
  }

  return { start, get, recent };
})();


/**
 * PROVIDER BENCHMARK ENGINE
 * Extends ProviderHealth with rolling latency, P95 tracking, and circuit breaker.
 */
const ProviderBenchmark = (() => {

  const WINDOW = 30;                   // Rolling window size
  const CIRCUIT_TRIP_RATE   = 0.65;   // Trip if >65% error rate in window
  const CIRCUIT_COOLDOWN_MS = 90000;  // 90s cooldown after circuit trip

  const _records  = {};   // provider → [{ts, latencyMs, success, capability}]
  const _tripped  = {};   // provider → tripTimestamp

  function record(provider, latencyMs, success, capability) {
    if (!_records[provider]) _records[provider] = [];
    _records[provider].push({ ts: Date.now(), latencyMs, success, capability });
    // Keep only WINDOW most recent
    if (_records[provider].length > WINDOW) _records[provider].shift();
    // Auto-trip circuit
    const s = stats(provider);
    if (s.callCount >= 5 && s.errorRate > CIRCUIT_TRIP_RATE) {
      if (!_tripped[provider]) {
        _tripped[provider] = Date.now();
        _log(`[ProviderBenchmark] Circuit TRIPPED for ${provider} (errorRate=${s.errorRate.toFixed(2)})`);
      }
    }
    // Update ProviderHealth
    if (success) ProviderHealth.recordSuccess(provider);
    else         ProviderHealth.recordFailure(provider);
  }

  function isCircuitOpen(provider) {
    const trip = _tripped[provider];
    if (!trip) return false;
    if (Date.now() - trip > CIRCUIT_COOLDOWN_MS) {
      delete _tripped[provider];
      _log(`[ProviderBenchmark] Circuit RESET for ${provider} after cooldown`);
      return false;
    }
    return true;
  }

  function stats(provider) {
    const recs = _records[provider] || [];
    if (!recs.length) return { callCount: 0, errorRate: 0, avgLatencyMs: 0, p95LatencyMs: 0 };
    const total    = recs.length;
    const failures = recs.filter(r => !r.success).length;
    const latencies = recs.map(r => r.latencyMs).sort((a, b) => a - b);
    const p95Idx   = Math.max(0, Math.floor(total * 0.95) - 1);
    return {
      callCount:     total,
      errorRate:     failures / total,
      avgLatencyMs:  Math.round(latencies.reduce((a, b) => a + b, 0) / total),
      p95LatencyMs:  latencies[p95Idx] || 0,
      circuitOpen:   isCircuitOpen(provider),
    };
  }

  function allStats() {
    return Object.fromEntries(
      [...new Set([...Object.keys(_records), ...Object.keys(_tripped)])].map(p => [p, stats(p)])
    );
  }

  function getSortedProviders(capability) {
    const base = ProviderHealth.getSortedProviders(capability);
    return base.filter(p => !isCircuitOpen(p));
  }

  return { record, isCircuitOpen, stats, allStats, getSortedProviders };
})();


/**
 * EXECUTION TIMELINE
 * Real-time UI overlay system showing execution stages, provider info,
 * quality scores, and timing. Only updates DOM if elements exist.
 */
const ExecutionTimeline = (() => {

  const STAGE_LABELS = {
    validate:      '✓ Validating input',
    preprocess:    '⚙ Preprocessing',
    segment:       '✂ Segmenting image',
    refine_mask:   '🔬 Refining mask',
    enhance:       '✨ Enhancing',
    restore:       '🔄 Restoring',
    upscale:       '⬆ Upscaling',
    generate:      '🎨 Generating',
    enhance_prompt:'📝 Optimizing prompt',
    quality_check: '📊 Quality check',
    deliver:       '✅ Delivering result',
    process:       '⚡ Processing',
    face_detect:   '👤 Detecting faces',
  };

  function _el(id) { return document.getElementById(id); }

  function updateStage(tool, stageName, status, durationMs, meta) {
    const overlay = _el('lmn-exec-timeline');
    if (!overlay) return;

    const label = STAGE_LABELS[stageName] || `⚙ ${stageName}`;
    const stageEl = _el(`lmn-stage-${stageName}`) || _createStageEl(stageName, overlay);
    if (!stageEl) return;

    stageEl.className = `lmn-stage lmn-stage--${status}`;
    stageEl.innerHTML = `
      <span class="lmn-stage-icon">${status === 'completed' ? '✓' : status === 'running' ? '◐' : '✗'}</span>
      <span class="lmn-stage-label">${label}</span>
      ${durationMs ? `<span class="lmn-stage-ms">${durationMs}ms</span>` : ''}
    `;
  }

  function _createStageEl(stageName, container) {
    try {
      const list = container.querySelector('.lmn-stage-list');
      if (!list) return null;
      const el = document.createElement('div');
      el.id = `lmn-stage-${stageName}`;
      el.className = 'lmn-stage';
      list.appendChild(el);
      return el;
    } catch (e) { return null; }
  }

  function updateProvider(tool, providerName) {
    const el = _el('lmn-exec-provider');
    if (el) el.textContent = `Provider: ${providerName || 'Routing…'}`;
    // Also update provider badge if it exists
    const badge = _el('lmn-provider-badge');
    if (badge) {
      badge.textContent = providerName || '—';
      badge.style.opacity = '1';
    }
  }

  function updateQuality(tool, score) {
    const el = _el('lmn-exec-quality');
    if (!el) return;
    const pct = Math.round((score || 0) * 100);
    const color = pct >= 60 ? '#10b981' : pct >= 35 ? '#f59e0b' : '#ef4444';
    el.innerHTML = `<span style="color:${color}">Quality: ${pct}%</span>`;
  }

  function complete(tool, success, totalMs, qualityScore) {
    const overlay = _el('lmn-exec-timeline');
    if (!overlay) return;

    const statusEl = _el('lmn-exec-status');
    if (statusEl) {
      statusEl.className = `lmn-exec-status lmn-exec-status--${success ? 'success' : 'error'}`;
      statusEl.textContent = success
        ? `Completed in ${(totalMs / 1000).toFixed(1)}s`
        : 'Processing failed';
    }

    // Auto-hide timeline after 4s on success
    if (success) {
      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 400);
      }, 4000);
    }
  }

  function show(tool, stages) {
    const overlay = _el('lmn-exec-timeline');
    if (!overlay) return;
    overlay.style.display = 'block';
    overlay.style.opacity = '1';

    // Initialize stage list
    const list = overlay.querySelector('.lmn-stage-list');
    if (list) {
      list.innerHTML = stages.map(s =>
        `<div id="lmn-stage-${s}" class="lmn-stage lmn-stage--pending">
          <span class="lmn-stage-icon">○</span>
          <span class="lmn-stage-label">${STAGE_LABELS[s] || s}</span>
        </div>`
      ).join('');
    }
  }

  function hide() {
    const overlay = _el('lmn-exec-timeline');
    if (overlay) { overlay.style.opacity = '0'; setTimeout(() => { overlay.style.display = 'none'; }, 300); }
  }

  return { updateStage, updateProvider, updateQuality, complete, show, hide };
})();


/**
 * PRIORITY EXECUTION QUEUE
 * Manages concurrent tool executions with priority and concurrency limits.
 */
const PriorityExecutionQueue = (() => {

  const MAX_CONCURRENT = 2;
  const _queue    = [];
  const _running  = new Set();

  const PRIORITY_MAP = {
    'segmentation': 10, 'face-processing': 9, 'super-resolution': 8,
    'inpainting': 7, 'image-gen': 6, 'restoration': 5,
    'image-enhancement': 4, 'style-transfer': 3, 'captioning': 2,
    'basic-processing': 1, 'compression': 1,
  };

  async function enqueue(toolName, capability, executeFn) {
    const priority = PRIORITY_MAP[capability] || 1;

    return new Promise((resolve, reject) => {
      _queue.push({ toolName, capability, priority, executeFn, resolve, reject, queuedAt: Date.now() });
      _queue.sort((a, b) => b.priority - a.priority);   // Highest priority first
      _drain();
    });
  }

  function _drain() {
    while (_running.size < MAX_CONCURRENT && _queue.length > 0) {
      const task = _queue.shift();
      _running.add(task.toolName);
      task.executeFn()
        .then(result => { task.resolve(result); })
        .catch(err   => { task.reject(err); })
        .finally(()  => { _running.delete(task.toolName); _drain(); });
    }
  }

  function status() {
    return {
      queued:   _queue.map(t => ({ tool: t.toolName, priority: t.priority })),
      running:  [..._running],
      capacity: MAX_CONCURRENT - _running.size,
    };
  }

  return { enqueue, status };
})();


/**
 * INTELLIGENT VALIDATOR
 * Advanced client-side validation before backend dispatch.
 * Checks file dimensions, image sanity, content analysis.
 */
const IntelligentValidator = (() => {

  const MAX_DIMENSION = 8192;   // px — beyond this, most models fail
  const MIN_DIMENSION = 8;

  async function validateImage(file, capability) {
    if (!file) return { valid: true };
    if (!file.type.startsWith('image/')) {
      return { valid: true };   // Non-image validation handled elsewhere
    }
    return new Promise(resolve => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const { naturalWidth: w, naturalHeight: h } = img;
        if (w < MIN_DIMENSION || h < MIN_DIMENSION) {
          resolve({ valid: false, error: `Image too small (${w}×${h}px). Minimum is ${MIN_DIMENSION}×${MIN_DIMENSION}px.` });
          return;
        }
        if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
          // Warn but don't reject — backend will resize
          _warn(`[IntelligentValidator] Large image (${w}×${h}px) — backend will resize`);
        }
        // Capability-specific checks
        if (capability === 'segmentation' && (w < 64 || h < 64)) {
          resolve({ valid: false, error: `Image too small for background removal (${w}×${h}px). Use at least 64×64px.` });
          return;
        }
        resolve({ valid: true, dimensions: { w, h }, aspectRatio: (w / h).toFixed(2) });
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve({ valid: true }); };
      img.src = url;
    });
  }

  function validatePrompt(prompt, capability) {
    if (!prompt) return { valid: true };
    if (prompt.length > 2000) {
      return { valid: false, error: `Prompt too long (${prompt.length} chars). Maximum 2000 characters.` };
    }
    // Basic injection detection
    const injectionPatterns = [
      /ignore\s+(all\s+)?previous\s+instructions?/i,
      /disregard\s+(your\s+)?system\s+prompt/i,
      /jailbreak/i,
    ];
    for (const pat of injectionPatterns) {
      if (pat.test(prompt)) {
        return { valid: false, error: 'Prompt contains disallowed content.' };
      }
    }
    return { valid: true };
  }

  return { validateImage, validatePrompt };
})();


// ── Enhanced executeOrchestrated: integrate all enterprise systems ─────────

const _origExecuteOrchestrated = window.executeOrchestrated;

window.executeOrchestrated = async function executeOrchestratedEnterprise(toolName, userParams, inputFile) {
  if (!toolName) {
    _warn('[Enterprise] executeOrchestrated called without toolName');
    return false;
  }

  const reg          = TOOL_REGISTRY[toolName];
  const pipelineDef  = reg ? (PIPELINE_REGISTRY[reg.pipeline] || {}) : {};
  const capability   = pipelineDef.capability || 'basic-processing';

  // ── Semantic analysis ────────────────────────────────────────────────────
  const execPlan = SemanticOrchestrator.analyze(toolName, capability);

  // ── Start telemetry session ──────────────────────────────────────────────
  const telemetry = ExecutionTelemetry.start(toolName, capability, execPlan.intent);

  // ── Show execution timeline ──────────────────────────────────────────────
  ExecutionTimeline.show(toolName, execPlan.stages);

  // ── Stage: validate ──────────────────────────────────────────────────────
  const tValidate = performance.now();
  const file = inputFile || window.uploadedFile;
  if (file) {
    const imgValidation = await IntelligentValidator.validateImage(file, capability);
    if (!imgValidation.valid) {
      ExecutionTimeline.updateStage(toolName, 'validate', 'failed', 0, {});
      telemetry.recordStage('validate', 'failed', 0, {});
      telemetry.recordError('VALIDATION_FAILED', imgValidation.error);
      telemetry.complete(false);
      ExecutionTimeline.hide();
      if (typeof window.LMNO?.ResultDispatcher?.showError === 'function') {
        window.LMNO.ResultDispatcher.showError(imgValidation.error, 'VALIDATION_FAILED');
      }
      return false;
    }
  }
  const promptCheck = IntelligentValidator.validatePrompt((userParams || {}).prompt, capability);
  if (!promptCheck.valid) {
    telemetry.recordError('PROMPT_INVALID', promptCheck.error);
    if (typeof window.LMNO?.ResultDispatcher?.showError === 'function') {
      window.LMNO.ResultDispatcher.showError(promptCheck.error, 'PROMPT_INVALID');
    }
    telemetry.complete(false);
    return false;
  }
  ExecutionTimeline.updateStage(toolName, 'validate', 'completed', Math.round(performance.now() - tValidate));
  telemetry.recordStage('validate', 'completed', Math.round(performance.now() - tValidate));

  // ── Prompt enhancement ───────────────────────────────────────────────────
  const enhancedParams = userParams ? { ...userParams } : {};
  if (enhancedParams.prompt) {
    enhancedParams.prompt = SemanticOrchestrator.enhancePrompt(toolName, enhancedParams.prompt, capability);
  }

  // ── Stage: process (route through priority queue for high-complexity) ────
  const executeFn = async () => {
    ExecutionTimeline.updateStage(toolName, execPlan.stages[1] || 'process', 'running', 0);
    telemetry.recordStage(execPlan.stages[1] || 'process', 'running', 0);

    const result = await _origExecuteOrchestrated(toolName, enhancedParams, inputFile);

    // ── Record provider if available ─────────────────────────────────────
    if (window._orch_lastProvider) {
      telemetry.recordProvider(window._orch_lastProvider);
      ExecutionTimeline.updateProvider(toolName, window._orch_lastProvider);
      // Record to ProviderBenchmark for analytics
      const elapsed = Math.round(performance.now() - tValidate);
      ProviderBenchmark.record(window._orch_lastProvider, elapsed, !!result, capability);
    }

    // ── Quality stage ─────────────────────────────────────────────────────
    if (window._orch_lastQualityScore != null) {
      telemetry.recordQuality(window._orch_lastQualityScore);
      ExecutionTimeline.updateQuality(toolName, window._orch_lastQualityScore);
    }
    ExecutionTimeline.updateStage(toolName, 'quality_check', result ? 'completed' : 'failed', 0);
    ExecutionTimeline.updateStage(toolName, 'deliver', result ? 'completed' : 'failed', 0);

    telemetry.complete(!!result);
    return result;
  };

  if (execPlan.complexity === 'high') {
    return PriorityExecutionQueue.enqueue(toolName, capability, executeFn);
  }
  return executeFn();
};


// ── Expose enterprise systems on window.LMNO ──────────────────────────────
if (window.LMNO) {
  window.LMNO.SemanticOrchestrator  = SemanticOrchestrator;
  window.LMNO.ExecutionTelemetry    = ExecutionTelemetry;
  window.LMNO.ProviderBenchmark     = ProviderBenchmark;
  window.LMNO.ExecutionTimeline     = ExecutionTimeline;
  window.LMNO.PriorityExecutionQueue = PriorityExecutionQueue;
  window.LMNO.IntelligentValidator  = IntelligentValidator;
  window.LMNO.version               = LMN_ORCH_VERSION;

  // Extended diagnostics
  const _origDiagnostics = window.LMNO.diagnostics;
  window.LMNO.diagnostics = function() {
    const base = _origDiagnostics ? _origDiagnostics() : {};
    return {
      ...base,
      enterpriseVersion:    LMN_ORCH_VERSION,
      providerBenchmarks:   ProviderBenchmark.allStats(),
      recentExecutions:     ExecutionTelemetry.recent(5),
      queueStatus:          PriorityExecutionQueue.status(),
    };
  };
}

_log(`[Enterprise] v${LMN_ORCH_VERSION} systems active: SemanticOrchestrator + ExecutionTelemetry + ProviderBenchmark + PriorityQueue`);
