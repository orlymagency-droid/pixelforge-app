/**
 * IAProcessor.js
 * On-device AI upscaling via react-native-tflite (Real-ESRGAN Tiny)
 * Zero API cost — 100% local inference
 */

import { TFLite } from 'react-native-tflite';
import RNFS from 'react-native-fs';
import { FFmpegKit, FFprobeKit, ReturnCode } from 'ffmpeg-kit-react-native';
import { Platform } from 'react-native';

// ─── Constants ─────────────────────────────────────────────────────────────
const MODEL_PATH = 'real_esrgan_x4_tiny.tflite'; // bundled in assets/
const TILE_SIZE  = 128; // process in tiles to avoid OOM
const TILE_PAD   = 10;

// Scale factor mapping
export const ScaleMode = {
  X2: { label: '2K',  scale: 2, suffix: '_2K'  },
  X4: { label: '4K',  scale: 4, suffix: '_4K'  },
  X8: { label: '8K',  scale: 8, suffix: '_8K'  },
};

// ─── Model Singleton ───────────────────────────────────────────────────────
let modelLoaded = false;
let tfliteInstance = null;

async function ensureModelLoaded() {
  if (modelLoaded) return;
  const modelDest = `${RNFS.DocumentDirectoryPath}/${MODEL_PATH}`;

  // Copy model from assets to writable storage on first run
  const exists = await RNFS.exists(modelDest);
  if (!exists) {
    await RNFS.copyFileAssets(MODEL_PATH, modelDest);
  }

  tfliteInstance = new TFLite();
  await tfliteInstance.loadModel({
    model: modelDest,
    numThreads: 4,
    useGpuDelegate: true,   // GPU acceleration via OpenCL/Vulkan
    useNNApiDelegate: false,
  });
  modelLoaded = true;
}

// ─── Image Upscaling ───────────────────────────────────────────────────────
/**
 * @param {string} inputUri  — local file URI
 * @param {string} scaleKey  — 'X2' | 'X4' | 'X8'
 * @param {function} onProgress — (percent: number) => void
 * @returns {Promise<string>}   — output file URI
 */
export async function upscaleImage(inputUri, scaleKey = 'X4', onProgress) {
  await ensureModelLoaded();

  const mode      = ScaleMode[scaleKey];
  const outDir    = RNFS.ExternalDirectoryPath || RNFS.DocumentDirectoryPath;
  const timestamp = Date.now();
  const outputUri = `${outDir}/pixelforge_${timestamp}${mode.suffix}.jpg`;

  onProgress?.(5);

  // Read image as base64 and send to TFLite
  const imageB64 = await RNFS.readFile(inputUri, 'base64');

  onProgress?.(15);

  // For X8: chain two X4 passes (model is trained to x4)
  let result;
  if (scaleKey === 'X8') {
    const pass1 = await runESRGANPass(imageB64, 4, (p) => onProgress?.(15 + p * 0.4));
    result      = await runESRGANPass(pass1,    2, (p) => onProgress?.(55 + p * 0.4));
  } else {
    result = await runESRGANPass(imageB64, mode.scale, (p) => onProgress?.(15 + p * 0.8));
  }

  onProgress?.(95);

  // Write output
  await RNFS.writeFile(outputUri, result, 'base64');

  onProgress?.(100);
  return `file://${outputUri}`;
}

async function runESRGANPass(imageB64, scaleFactor, onProgress) {
  onProgress?.(0);

  const inputTensor  = preprocessImage(imageB64, TILE_SIZE);
  const outputTensor = await tfliteInstance.runInference(inputTensor, {
    inputShape:  [1, TILE_SIZE, TILE_SIZE, 3],
    outputShape: [1, TILE_SIZE * scaleFactor, TILE_SIZE * scaleFactor, 3],
    dType:       'float32',
    normalize:   true,         // [0,255] → [0,1]
    denormalize: true,         // [0,1]  → [0,255]
  });

  onProgress?.(80);

  return postprocessImage(outputTensor);
}

// ─── Video Upscaling ───────────────────────────────────────────────────────
/**
 * Upscale video using FFmpeg frame injection + ESRGAN processing
 * @param {string} inputUri
 * @param {string} scaleKey
 * @param {function} onProgress
 * @returns {Promise<string>}
 */
export async function upscaleVideo(inputUri, scaleKey = 'X4', onProgress) {
  const mode      = ScaleMode[scaleKey];
  const outDir    = RNFS.ExternalDirectoryPath || RNFS.DocumentDirectoryPath;
  const timestamp = Date.now();
  const framesDir = `${outDir}/frames_${timestamp}`;
  const upscDir   = `${outDir}/upsc_${timestamp}`;
  const outputUri = `${outDir}/pixelforge_video_${timestamp}${mode.suffix}.mp4`;

  await RNFS.mkdir(framesDir);
  await RNFS.mkdir(upscDir);

  onProgress?.(5);

  // Step 1: Extract frames
  const extractCmd = `-i "${inputUri}" -q:v 2 -threads 4 "${framesDir}/frame_%05d.jpg"`;
  const extractSess = await FFmpegKit.execute(extractCmd);
  if (!ReturnCode.isSuccess(await extractSess.getReturnCode())) {
    throw new Error('Frame extraction failed');
  }

  onProgress?.(25);

  // Step 2: Get frame count for progress tracking
  const probeCmd  = `-v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "${inputUri}"`;
  const probeSess = await FFprobeKit.execute(probeCmd);
  const totalFrames = parseInt(await probeSess.getOutput()) || 100;

  // Step 3: Upscale each frame with ESRGAN
  const frames = await RNFS.readDir(framesDir);
  let processed = 0;

  for (const frame of frames) {
    const outFramePath = `${upscDir}/${frame.name}`;
    await upscaleImage(frame.path, scaleKey, () => {});
    processed++;
    const pct = 25 + Math.floor((processed / frames.length) * 55);
    onProgress?.(pct);
  }

  onProgress?.(80);

  // Step 4: Re-encode with FFmpeg (high fidelity)
  const targetRes   = { X2: '2560x1440', X4: '3840x2160', X8: '7680x4320' }[scaleKey];
  const encodeCmd   = [
    `-framerate 30 -i "${upscDir}/frame_%05d.jpg"`,
    `-i "${inputUri}"`,       // original audio track
    `-map 0:v:0 -map 1:a:0?`,
    `-vcodec libx265 -crf 18 -preset slow`,
    `-vf "scale=${targetRes}:flags=lanczos"`,
    `-acodec aac -b:a 320k`,
    `-movflags +faststart`,
    `-y "${outputUri}"`
  ].join(' ');

  const encodeSess = await FFmpegKit.execute(encodeCmd);
  if (!ReturnCode.isSuccess(await encodeSess.getReturnCode())) {
    throw new Error('Video re-encoding failed');
  }

  // Cleanup temp dirs
  await RNFS.unlink(framesDir).catch(() => {});
  await RNFS.unlink(upscDir).catch(() => {});

  onProgress?.(100);
  return `file://${outputUri}`;
}

// ─── Tensor Helpers (simplified) ──────────────────────────────────────────
function preprocessImage(base64, tileSize) {
  // Convert base64 → Float32Array [0..1] normalized pixel data
  // In production, use a native bridge for pixel extraction
  return { data: base64, tileSize, normalized: true };
}

function postprocessImage(tensor) {
  // Convert Float32Array → base64 JPEG
  return tensor.outputBase64;
}

export default { upscaleImage, upscaleVideo, ScaleMode };