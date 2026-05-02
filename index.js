/* ============================================================
   LUMINORBIT — BACKEND INTEGRATION FIX (All 9 Issues)
   ============================================================
   IMPORTANT: Replace the BACKEND CONFIGURATION block at the
   bottom of index.html with this code. Or paste the key
   functions into the existing <script> block.

   Fixes applied:
   1. processWithAI() uses base64 JSON (CF Worker has no multipart)
   2. Authorization header included in all API calls
   3. originalImage/resultImage tracked separately
   4. showOriginal() / showResult() never show same image
   5. Orange "Result" label CSS removed
   6. Tool mapping: UI names → backend exact keys
   7. callBackend() kept for JSON-only (GET) endpoints
   8. processWithAI() is the upload/processing function
   9. Preview updates with real AI output
   ============================================================ */

/* ── BACKEND CONSTANTS ────────────────────────────────────── */
const BACKEND_URL = 'https://luminorbit-backend.onrender.com';
const BACKEND_KEY = 'luminorbit_secure_123';
const AUTH_HEADER = { 'Authorization': 'Bearer ' + BACKEND_KEY };

/* ── PREVIEW STATE ────────────────────────────────────────── */
let originalImage = '';   // blob: URL of the uploaded file
let resultImage   = '';   // data: URL or URL of AI-processed output
let _resultReady  = false; // prevents showing result before processing

/* ── TOOL NAME MAPPING: UI label → backend exact key ────────
   Source of truth: VALID_TOOLS object in both index.js and
   luminorbit_backend.py. These are the exact keys accepted.  */
const TOOL_NAME_MAP = {
  /* Common UI labels that differ from backend keys */
  'AI Enhance':           'Flux 1.1 Pro',
  'Upscale':              'Real-ESRGAN',
  'Upscaler':             'Real-ESRGAN',
  'Image Upscale':        'Real-ESRGAN',
  '4K Upscale':           'Real-ESRGAN',
  'AI 4K Image Upscaler': 'Real-ESRGAN',
  'Enhance':              'Flux 1.1 Pro',
  'Generate':             'Flux 1.1 Pro',
  'AI Generate':          'Flux 1.1 Pro',
  'Background Remove':    'Background Remover',
  'BG Remove':            'Background Remover',
  'Face Restore':         'GFPGAN',
  'Face Enhance':         'GFPGAN',
  'Restore':              'CodeFormer',
  'Sharpen':              'Sharpen Tool',
  'Denoise':              'Noise Reducer',
  'Noise Reduce':         'Noise Reducer',
  'Color Correct':        'Color Corrector',
  'Color Grade':          'Color Grader',
  'HDR':                  'HDR Master',
  'Portrait':             'Portrait Pro',
  'Retouch':              'Face Retouch',
  'Style':                'Style Transfer',
  'Cartoon':              'Cartoonizer',
  'Sketch':               'Sketch Maker',
  'Vintage':              'Vintage Maker',
  'Object Remove':        'Object Remover',
  'Watermark Remove':     'Watermark Remover',
  'Sky Replace':          'Sky Replacer',
  /* Default fallback */
  'default':              'Flux 1.1 Pro',
};

/* Backend VALID_TOOLS — exact keys the backend accepts.
   Used to validate before sending. Derived from index.js §1. */
const BACKEND_VALID_TOOLS = new Set([
  'Flux 1.1 Pro','Seedream 5.0','SDXL 1.0','Stable Diffusion 3.5',
  'Adobe Firefly','Midjourney v7','ControlNet','InstructPix2Pix',
  'SUPIR','Real-ESRGAN','GFPGAN','CodeFormer','RestoreFormer',
  'SwinIR','BSRGAN','SAM 2','Grounding DINO','Florence-2',
  'Runway Gen-5','Seedance 2.0','Kling AI 3.0','Luma Dream Machine',
  'Pika 2.5','Hailuo MiniMax','Sora Edit','Stable Video Diffusion',
  'LivePortrait','Topaz Video AI 5','TecoGAN','RIFE','DAIN',
  'RAFT + ESRGAN','Temporal GAN','AnimateDiff','Wonder Dynamics',
  'Auto Caption Generator','Audio Extractor Tool','Video Compressor Pro',
  'Video Speed Controller','MultiCam Sync','Match Cut Flow',
  'Beat Sync Drop','Sound Wave Viz','Audio Reactive Viz',
  // Photo tools
  'Background Remover','Background Changer','Object Remover',
  'Object Remover Pro','Watermark Remover','Photo Restorer',
  'Image Enhancer','Image Enhancer Plus','HDR Master','Noise Reducer',
  'Face Retouch','Portrait Pro','Style Transfer','Cartoonizer',
  'Sky Replacer','Image Cropper','Photo Resizer','Image UpScaler',
  'Smart Crop','Color Corrector','Color Grader','Sketch Maker',
  'Lens Distortion Fix','Black & White','Sepia Filter','Vintage Maker',
  'Vignette Tool','Sharpen Tool','Blur Tool','Mosaic Tool',
  'Exposure Fixer','Shadow Fixer','Lighting Fixer','Detail Enhancer',
  // Video tools
  'Video Trimmer Pro','Video Crop Studio','Color Grade Pro',
  'Slow-Mo Magic','Fast-Forward Flash','Cinematic Pulse',
  'VHS Nostalgia','Neon Pulse','Glitch Pop','Retro Reel',
  'Motion Blur Trail','Photo to Video Creator',
  'AI Motion Transfer Engine','AI Cinematic Action Generator',
  'AI Consistent Motion Animator',
]);

/**
 * Resolves a UI tool name to the exact backend key.
 * Falls back to 'Flux 1.1 Pro' if unrecognised.
 */
function resolveToolName(uiToolName) {
  if (!uiToolName) return 'Flux 1.1 Pro';

  // Already a valid backend key?
  if (BACKEND_VALID_TOOLS.has(uiToolName)) return uiToolName;

  // Try explicit map
  const mapped = TOOL_NAME_MAP[uiToolName];
  if (mapped && BACKEND_VALID_TOOLS.has(mapped)) return mapped;

  // Fuzzy: lowercase comparison
  const lower = uiToolName.toLowerCase();
  for (const key of BACKEND_VALID_TOOLS) {
    if (key.toLowerCase() === lower) return key;
  }

  // Partial match (first word)
  const firstWord = lower.split(/\s+/)[0];
  for (const key of BACKEND_VALID_TOOLS) {
    if (key.toLowerCase().startsWith(firstWord)) return key;
  }

  console.warn('[resolveToolName] No match for "' + uiToolName + '" — defaulting to Flux 1.1 Pro');
  return 'Flux 1.1 Pro';
}

/**
 * Converts a File/Blob to a base64 string (without data: prefix).
 */
function fileToBase64(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload  = function() { resolve(reader.result.split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * processWithAI(file, tool)
 * ─────────────────────────
 * Sends the file to the backend AI pipeline.
 * Uses JSON body with base64-encoded file_data.
 * The CF Worker backend (/api/process) accepts JSON — NOT multipart.
 *
 * NOTE: The Python backend also has /api/process/upload (multipart),
 * but the Render deployment serves the CF Worker (index.js) which
 * only has /api/process (JSON). We use JSON everywhere for compat.
 *
 * Returns: output_url string (data: URI or https: URL), or null on failure.
 */
async function processWithAI(file, tool) {
  if (!file) {
    console.error('[processWithAI] No file provided');
    return null;
  }

  const backendTool = resolveToolName(tool || currentTool || 'Flux 1.1 Pro');
  console.log('[processWithAI] tool:', tool, '→', backendTool, '| file:', file.name, file.size + 'B');

  // Convert file to base64 for JSON transport
  let fileData = null;
  try {
    fileData = await fileToBase64(file);
  } catch (e) {
    console.error('[processWithAI] base64 encode failed:', e);
    return null;
  }

  // Build request body — matches CF Worker handleProcess() expectations
  const body = {
    tool:       backendTool,
    capability: 'image',       // hint; backend auto-resolves via VALID_TOOLS map
    params: {
      prompt:     buildToolPromptForBackend(backendTool),
      resolution: '4K',
    },
    file_data:  fileData,
    file_mime:  file.type || 'image/jpeg',
    resolution: '4K',
    inputType:  file.type || 'image/jpeg',
    inputSize:  file.size,
    timestamp:  Date.now(),
  };

  // NOTE: DO NOT set Content-Type manually — fetch sets it with boundary
  // But since this is JSON, Content-Type: application/json is correct.
  try {
    const response = await fetch(BACKEND_URL + '/api/process', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH_HEADER,
      },
      body: JSON.stringify(body),
    });

    console.log('[processWithAI] HTTP', response.status);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('[processWithAI] Backend error', response.status, errText);
      return null;
    }

    const data = await response.json();
    console.log('[processWithAI] Response:', {
      success:   data.success,
      provider:  data.provider,
      status:    data.status,
      has_output: !!(data.output_url || data.output),
    });

    if (!data.success) {
      console.error('[processWithAI] Backend returned success=false:', data.error);
      return null;
    }

    // Backend returns output_url (alias for output)
    const outputUrl = data.output_url || data.output;
    if (!outputUrl) {
      console.error('[processWithAI] No output_url in response');
      return null;
    }

    return outputUrl;

  } catch (e) {
    console.error('[processWithAI] Fetch failed:', e.message);
    return null;
  }
}

/**
 * Build a rich, tool-specific prompt for maximum AI quality.
 * Mirrors the _buildToolPrompt function already in index.js but
 * returns a plain string without requiring the UI state.
 */
function buildToolPromptForBackend(toolName) {
  const prompts = {
    'Flux 1.1 Pro':        'Generate a stunning ultra-realistic 4K photograph, professional studio lighting, photorealistic',
    'Real-ESRGAN':         'AI super-resolution 4K upscaling, add realistic details, ultra-sharp output at 3840x2160',
    'GFPGAN':              'AI face restoration: sharp facial details, clear eyes, remove blur, enhance to 4K',
    'CodeFormer':          'Face restoration: ultra-high quality facial details, natural skin texture, 4K upscaling',
    'Background Remover':  'Remove background completely, isolate subject with pixel-perfect edges, transparent output',
    'Object Remover':      'Remove object seamlessly using AI inpainting, reconstruct background, no artifacts',
    'Watermark Remover':   'Remove watermark completely using AI inpainting, restore original content, 4K',
    'Sky Replacer':        'Replace sky with dramatic golden hour sunset, volumetric clouds, cinematic HDR',
    'Face Retouch':        'Professional face retouching: smooth skin, reduce blemishes, enhance eyes, natural beauty',
    'Portrait Pro':        'Studio-quality portrait enhancement: perfect skin, sharp eyes, professional lighting',
    'Image Enhancer':      'AI enhancement: ultra-sharp details, perfect exposure, vivid colors, 4K studio quality',
    'Image Enhancer Plus': 'Advanced AI: maximum detail recovery, HDR tone mapping, professional color grade',
    'HDR Master':          'Full HDR: expand dynamic range, recover highlights and shadows, cinematic tone mapping',
    'Noise Reducer':       'AI noise reduction: remove grain completely, preserve fine detail, clean output',
    'Detail Enhancer':     'Ultra-sharp detail: reveal micro-textures, professional sharpening, clarity boost',
    'Photo Restorer':      'Old photo restoration: remove damage, colorize, enhance to modern 4K quality',
    'Style Transfer':      'Artistic style transfer: apply painterly style while preserving content, high quality',
    'Cartoonizer':         'Cartoon cel-shading: bold outlines, flat vibrant colors, anime-style rendering',
    'Sketch Maker':        'Pencil sketch effect: detailed line art, realistic texture, black and white',
    'Vintage Maker':       'Vintage film effect: faded colors, film grain, light leaks, analog look',
    'Color Grader':        'Cinematic color grade: teal-orange LUT, film emulation, Hollywood look',
    'Sharpen Tool':        'Professional sharpening: enhance edges, reveal detail, crisp studio quality',
    'Exposure Fixer':      'Correct exposure: histogram equalization, recover highlights, lift shadows',
    'Shadow Fixer':        'Lift shadows, recover detail, balanced exposure, professional post-processing',
    'Lighting Fixer':      'Professional lighting correction, fix flat lighting, studio quality illumination',
    'Image UpScaler':      'AI super-resolution: quadruple resolution, add realistic details, ultra-sharp',
    'SAM 2':               'Precise AI segmentation: isolate subject with perfect edge detection',
    'InstructPix2Pix':     'Instruction-guided image editing: apply changes while preserving structure',
  };
  return prompts[toolName] || ('Professional ' + toolName + ' processing: ultra high quality 4K studio output');
}

/**
 * UPLOAD HANDLER — call this when user selects a file.
 * Sets originalImage from createObjectURL, shows it immediately,
 * then calls processWithAI() and stores result in resultImage.
 *
 * Usage: replace / wrap your existing handleFileSelect or
 * the "Continue to Editor" / initCanvasPreview flow with this.
 */
async function handleUploadAndProcess(file) {
  if (!file) return;

  // Store file globally (existing code depends on window.uploadedFile)
  window.uploadedFile = file;

  // Revoke previous object URLs to prevent memory leaks
  if (originalImage && originalImage.startsWith('blob:')) {
    URL.revokeObjectURL(originalImage);
  }

  // Set original immediately so preview shows without waiting for AI
  originalImage = URL.createObjectURL(file);
  resultImage   = '';
  _resultReady  = false;

  // Show original in preview right away
  showOriginal();

  // Show loading state in result tab
  _setResultLoading(true);

  console.log('[handleUploadAndProcess] Starting AI processing for:', file.name);

  try {
    const outputUrl = await processWithAI(file, window.currentTool);

    if (outputUrl) {
      resultImage  = outputUrl;
      _resultReady = true;
      console.log('[handleUploadAndProcess] AI result received, showing result');
      // Switch to result view after processing
      showResult();
    } else {
      console.warn('[handleUploadAndProcess] AI processing returned no output — showing original');
      _resultReady = false;
      _setResultLoading(false);
      showOriginal();
      alert('AI processing failed. The backend may be cold-starting — please try again in a moment.');
    }
  } catch (e) {
    console.error('[handleUploadAndProcess] Unexpected error:', e);
    _resultReady = false;
    _setResultLoading(false);
    alert('Processing error: ' + e.message);
  }
}

/**
 * Show the ORIGINAL (uploaded) image in the preview.
 */
function showOriginal() {
  if (!originalImage) {
    console.warn('[showOriginal] No original image set');
    return;
  }

  const imgOrig   = document.getElementById('preview-img-original');
  const imgResult = document.getElementById('preview-img-result');
  const vidOrig   = document.getElementById('preview-vid-original');
  const vidResult = document.getElementById('preview-vid-result');
  const stage     = document.getElementById('preview-stage');
  const wrapper   = document.getElementById('canvas-wrapper');
  const stageLabel = document.getElementById('preview-stage-label');

  // Show stage, hide canvas wrapper
  if (stage)   { stage.style.display   = 'flex'; }
  if (wrapper) { wrapper.style.display = 'none'; }

  // Determine media type
  const isVideo = window.uploadedFile && window.uploadedFile.type.startsWith('video/');

  if (isVideo) {
    if (vidOrig)   { vidOrig.src = originalImage; vidOrig.style.display   = 'block'; }
    if (vidResult) { vidResult.style.display = 'none'; }
    if (imgOrig)   { imgOrig.style.display   = 'none'; }
    if (imgResult) { imgResult.style.display = 'none'; }
  } else {
    if (imgOrig)   { imgOrig.src = originalImage; imgOrig.style.display   = 'block'; imgOrig.style.filter = ''; }
    if (imgResult) { imgResult.style.display = 'none'; }
    if (vidOrig)   { vidOrig.style.display   = 'none'; }
    if (vidResult) { vidResult.style.display = 'none'; }
  }

  // Update label
  if (stageLabel) {
    stageLabel.textContent = 'ORIGINAL';
    stageLabel.style.color = '#aab4be';
    stageLabel.style.background = 'rgba(13,17,23,.7)';
    stageLabel.style.border = '1px solid rgba(255,255,255,.08)';
  }

  // Update tabs
  _setActiveTab('original');

  // Update hint
  const hint = document.getElementById('preview-hint');
  if (hint) hint.textContent = 'Viewing original — no adjustments applied';
  const zoomInfo = document.getElementById('preview-zoom-info');
  if (zoomInfo) zoomInfo.textContent = 'Original file';
}

/**
 * Show the AI-PROCESSED result image.
 * Guards against showing before processing is complete.
 */
function showResult() {
  if (!_resultReady || !resultImage) {
    if (!_resultReady) {
      console.warn('[showResult] Result not ready yet — processing still in progress');
      // Don't alert — user may click tab while processing
    }
    return;
  }

  const imgOrig   = document.getElementById('preview-img-original');
  const imgResult = document.getElementById('preview-img-result');
  const vidOrig   = document.getElementById('preview-vid-original');
  const vidResult = document.getElementById('preview-vid-result');
  const stage     = document.getElementById('preview-stage');
  const wrapper   = document.getElementById('canvas-wrapper');
  const stageLabel = document.getElementById('preview-stage-label');

  // Show stage
  if (stage)   { stage.style.display   = 'flex'; }
  if (wrapper) { wrapper.style.display = 'none'; }

  const isVideoResult = resultImage.startsWith('data:video/') ||
                        /\.(mp4|webm|mov)([\?#]|$)/i.test(resultImage);

  if (isVideoResult) {
    if (vidResult) { vidResult.src = resultImage; vidResult.style.display = 'block'; }
    if (vidOrig)   { vidOrig.style.display   = 'none'; }
    if (imgOrig)   { imgOrig.style.display   = 'none'; }
    if (imgResult) { imgResult.style.display = 'none'; }
  } else {
    if (imgResult) {
      imgResult.src = resultImage;
      imgResult.style.display = 'block';
      imgResult.style.filter  = '';  // Never apply CSS filter to real AI output
    }
    if (imgOrig)   { imgOrig.style.display   = 'none'; }
    if (vidOrig)   { vidOrig.style.display   = 'none'; }
    if (vidResult) { vidResult.style.display = 'none'; }
  }

  // Update label — NO orange "Result" badge, just resolution info
  if (stageLabel) {
    stageLabel.textContent = 'RESULT \u2022 4K';
    stageLabel.style.color      = 'var(--action-color)';
    stageLabel.style.background = 'rgba(13,17,23,.7)';
    stageLabel.style.border     = '1px solid rgba(255,153,0,.3)';
  }

  // Update tabs
  _setActiveTab('result');

  const hint = document.getElementById('preview-hint');
  if (hint) hint.textContent = 'Viewing AI result — real backend output';
  const zoomInfo = document.getElementById('preview-zoom-info');
  if (zoomInfo) zoomInfo.textContent = 'AI processed at 4K';
}

/* ── Preview tab helpers ──────────────────────────────────── */
function _setActiveTab(mode) {
  const tabOrig   = document.getElementById('tab-original');
  const tabResult = document.getElementById('tab-result');
  if (tabOrig)   tabOrig.classList.toggle('active',   mode === 'original');
  if (tabResult) tabResult.classList.toggle('active', mode === 'result');
}

function _setResultLoading(loading) {
  const overlay = document.getElementById('preview-processing-overlay');
  if (overlay) overlay.style.display = loading ? 'flex' : 'none';
  const overlayText = document.getElementById('overlay-status-text');
  if (overlayText) overlayText.textContent = 'AI Processing — 4K Studio Quality...';
}

/* ── callBackend — kept for JSON (GET) endpoints only ─────── */
window.callBackend = async function(endpoint, body, opts) {
  opts = opts || {};
  const url = BACKEND_URL + endpoint;
  try {
    const res = await fetch(url, {
      method:  opts.method || (body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...AUTH_HEADER,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    console.error('[callBackend] ' + endpoint + ' failed:', e.message);
    throw e;
  }
};

/* ── Fetch tools from backend on load ────────────────────── */
(function loadBackendTools() {
  // /api/tools is public (no auth required per both backends)
  fetch(BACKEND_URL + '/api/tools')
    .then(r => r.json())
    .then(data => {
      const keys = Object.keys(data.tools || {});
      console.log('[loadBackendTools] ' + keys.length + ' tools available from backend');
      // Sync BACKEND_VALID_TOOLS with live data
      keys.forEach(k => BACKEND_VALID_TOOLS.add(k));
    })
    .catch(e => console.warn('[loadBackendTools] Could not load from backend:', e.message));
})();

/* ── Remove orange "Result" label from bottom-right ─────────
   The .preview-mode-label.right element with "RESULT" text is
   the orange badge. We hide it via CSS override here.
   The stage label (#preview-stage-label) we keep but control
   its content via showOriginal()/showResult() above.          */
(function removeOrangeResultLabel() {
  const style = document.createElement('style');
  style.textContent = [
    /* Hide the right-side .preview-mode-label (orange "RESULT" badge) */
    '.preview-mode-label.right { display: none !important; }',
    /* Also hide .preview-mode-label.left (BEFORE label) — redundant in 2-tab UI */
    '.preview-mode-label.left  { display: none !important; }',
    /* Ensure no CSS filter leaks onto real AI output images */
    '#preview-img-result[src^="data:image/"] { filter: none !important; }',
    '#preview-img-result[src^="https://"]   { filter: none !important; }',
    '#preview-img-result[src^="http://"]    { filter: none !important; }',
  ].join('\n');
  document.head.appendChild(style);
  console.log('[removeOrangeResultLabel] CSS injected — orange label hidden');
})();

/* ── Wire tab buttons to new showOriginal/showResult ────────
   Overwrites the default setPreviewMode for these two tabs.   */
(function wirePreviewTabs() {
  function _wire() {
    const tabOrig   = document.getElementById('tab-original');
    const tabResult = document.getElementById('tab-result');
    if (tabOrig) {
      tabOrig.onclick = function() { showOriginal(); };
    }
    if (tabResult) {
      tabResult.onclick = function() { showResult(); };
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire);
  } else {
    _wire();
  }
  // Re-wire when editor page opens
  const _origNavigate = window.navigate;
  if (typeof _origNavigate === 'function') {
    window.navigate = function(page) {
      const r = _origNavigate.apply(window, arguments);
      if (page === 'editor') setTimeout(_wire, 150);
      return r;
    };
  }
})();

/* ── Patch initCanvasPreview to use new upload flow ─────────
   When a file is present and we're on the editor, trigger
   processWithAI automatically so result is always generated.  */
(function patchInitCanvasPreview() {
  const _orig = window.initCanvasPreview;
  window.initCanvasPreview = function() {
    try { _orig.apply(window, arguments); } catch(e) { /* safe */ }

    const file = window.uploadedFile;
    if (!file) return;

    // Set originalImage from current uploadedFile
    if (originalImage && originalImage.startsWith('blob:')) {
      URL.revokeObjectURL(originalImage);
    }
    originalImage = URL.createObjectURL(file);
    resultImage   = '';
    _resultReady  = false;

    // Show original immediately in the new result slot too (so it's not blank)
    const imgResult = document.getElementById('preview-img-result');
    const imgOrig   = document.getElementById('preview-img-original');
    if (imgOrig)   imgOrig.src   = originalImage;
    if (imgResult) imgResult.src = originalImage;  // temp — will be replaced by AI result

    // Trigger real AI processing
    if (window.LUMINORBIT_API_URL) {
      _setResultLoading(true);
      processWithAI(file, window.currentTool).then(function(outputUrl) {
        _setResultLoading(false);
        if (outputUrl) {
          resultImage  = outputUrl;
          _resultReady = true;
          // Update result img src to real AI output (don't show yet — user decides via tab)
          if (imgResult) {
            imgResult.src           = outputUrl;
            imgResult.style.filter  = '';
            imgResult.style.display = 'none';  // hidden until user clicks Result tab
          }
          console.log('[patchInitCanvasPreview] AI result ready');
        } else {
          console.warn('[patchInitCanvasPreview] No AI result — original preserved');
          resultImage  = originalImage;  // fallback: same as original (no AI change)
          _resultReady = false;          // keep false so Result tab shows warning
        }
      }).catch(function(e) {
        _setResultLoading(false);
        console.error('[patchInitCanvasPreview] processWithAI error:', e);
      });
    }
  };
})();

/* ── Override LUMINORBIT_API_URL ─────────────────────────── */
window.LUMINORBIT_API_URL = BACKEND_URL;
window.LUMINORBIT_API_KEY = BACKEND_KEY;

/* Expose for use by existing code */
window.processWithAI      = processWithAI;
window.showOriginal       = showOriginal;
window.showResult         = showResult;
window.resolveToolName    = resolveToolName;
window.originalImage_ref  = function() { return originalImage; };
window.resultImage_ref    = function() { return resultImage; };

console.log('[luminorbit_fixed.js] All 9 fixes loaded.',
  '| Backend:', BACKEND_URL,
  '| Auth: Bearer ****' + BACKEND_KEY.slice(-4),
  '| processWithAI: JSON/base64 (not FormData)',
  '| Orange label: removed via CSS',
  '| Tool mapping: ' + Object.keys(TOOL_NAME_MAP).length + ' aliases',
);
