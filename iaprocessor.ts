/**
 * IAProcessor.ts
 * Gestion de l'Upscaling IA (Real-ESRGAN) pour Images et Vidéos.
 * Compatible Android & iOS.
 */

import { TFLite } from 'react-native-tflite';
import RNFS from 'react-native-fs';
import { Platform } from 'native';

// ─────────────────────────────────────────────────────────────────────────────
// 1. TYPES & INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

export interface ScaleModeEntry {
  label: string;
  scale: number;
  suffix: string;
}

export interface ScaleModeMap {
  X2: ScaleModeEntry;
  X4: ScaleModeEntry;
  X8: ScaleModeEntry;
}

export type ScaleKey = keyof ScaleModeMap;

export interface UpscaleResult {
  uri: string;
  scaleKey: ScaleKey;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_PATH = 'real_esrgan_x4_tiny.tflite';
const TILE_SIZE = 128;

export const ScaleMode: ScaleModeMap = {
  X2: { label: '2K', scale: 2, suffix: '_2K' },
  X4: { label: '4K', scale: 4, suffix: '_4K' },
  X8: { label: '8K', scale: 8, suffix: '_8K' },
};

// État interne pour le modèle (Singleton)
let modelLoaded = false;
let tfliteInstance: TFLite | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// 3. GESTION DU MODÈLE TFLITE
// ─────────────────────────────────────────────────────────────────────────────

async function ensureModelLoaded(): Promise<void> {
  if (modelLoaded && tfliteInstance) return;

  const modelDest = `${RNFS.DocumentDirectoryPath}/${MODEL_PATH}`;

  try {
    const exists = await RNFS.exists(modelDest);
    if (!exists) {
      if (Platform.OS === 'android') {
        await RNFS.copyFileAssets(MODEL_PATH, modelDest);
      } else {
        await RNFS.copyFile(`${RNFS.MainBundlePath}/${MODEL_PATH}`, modelDest);
      }
    }

    tfliteInstance = new TFLite();
    await tfliteInstance.loadModel({
      model: modelDest,
      numThreads: 4,
      useGpuDelegate: true,
    });

    modelLoaded = true;
  } catch (error) {
    modelLoaded = false;
    tfliteInstance = null;
    throw new Error(`[IAProcessor] Erreur chargement modèle: ${(error as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. UPSCALE IMAGE
// ─────────────────────────────────────────────────────────────────────────────

export async function upscaleImage(
  inputUri: string,
  scaleKey: ScaleKey = 'X4',
  onProgress?: (p: number) => void
): Promise<UpscaleResult> {
  
  if (!inputUri) throw new Error('[IAProcessor] URI manquante');
  await ensureModelLoaded();

  const mode = ScaleMode[scaleKey];
  const timestamp = Date.now();
  const outputUri = `${RNFS.CachesDirectoryPath}/pf_img_${timestamp}${mode.suffix}.jpg`;

  try {
    onProgress?.(5);
    const cleanPath = inputUri.replace('file://', '');
    const imageB64 = await RNFS.readFile(cleanPath, 'base64');
    onProgress?.(15);

    let resultB64: string;
    if (scaleKey === 'X8') {
      const pass1 = await runESRGANPass(imageB64, 4);
      onProgress?.(50);
      resultB64 = await runESRGANPass(pass1, 2);
    } else {
      resultB64 = await runESRGANPass(imageB64, mode.scale);
    }

    onProgress?.(90);
    await RNFS.writeFile(outputUri, resultB64, 'base64');
    onProgress?.(100);

    return { uri: `file://${outputUri}`, scaleKey, timestamp };
  } catch (error) {
    await safeUnlink(outputUri);
    throw new Error(`[IAProcessor] Upscale Image failed: ${(error as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UPSCALE VIDÉO
// ─────────────────────────────────────────────────────────────────────────────

export async function upscaleVideo(
  inputUri: string,
  scaleKey: ScaleKey = 'X4',
  onProgress?: (p: number) => void
): Promise<UpscaleResult> {

  if (!inputUri) throw new Error('[IAProcessor] URI manquante');

  // Import dynamique de FFmpeg pour éviter les crashs au démarrage
  let FFmpegKit, FFprobeKit, ReturnCode;
  try {
    const ffmpeg = await import('ffmpeg-kit-react-native');
    FFmpegKit = ffmpeg.FFmpegKit;
    FFprobeKit = ffmpeg.FFprobeKit;
    ReturnCode = ffmpeg.ReturnCode;
  } catch (e) {
    throw new Error('[IAProcessor] FFmpeg non installé');
  }

  await ensureModelLoaded();

  const mode = ScaleMode[scaleKey];
  const timestamp = Date.now();
  const cacheDir = RNFS.CachesDirectoryPath;
  const framesDir = `${cacheDir}/pf_frames_${timestamp}`;
  const scaledDir = `${cacheDir}/pf_scaled_${timestamp}`;
  const outputUri = `${cacheDir}/pf_vid_${timestamp}${mode.suffix}.mp4`;

  try {
    onProgress?.(2);
    await RNFS.mkdir(framesDir);
    await RNFS.mkdir(scaledDir);

    const cleanInput = inputUri.replace('file://', '');

    // Step 1: Extraire les frames
    onProgress?.(5);
    const extractSession = await FFmpegKit.execute(`-i "${cleanInput}" "${framesDir}/f_%04d.png"`);
    if (!ReturnCode.isSuccess(await extractSession.getReturnCode())) {
      throw new Error('Extraction frames failed');
    }

    // Step 2: Upscaler chaque frame
    const frames = (await RNFS.readDir(framesDir)).filter(f => f.name.endsWith('.png'));
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const b64In = await RNFS.readFile(frame.path, 'base64');
      
      let b64Out: string;
      if (scaleKey === 'X8') {
        const p1 = await runESRGANPass(b64In, 4);
        b64Out = await runESRGANPass(p1, 2);
      } else {
        b64Out = await runESRGANPass(b64In, mode.scale);
      }

      await RNFS.writeFile(`${scaledDir}/${frame.name}`, b64Out, 'base64');
      onProgress?.(10 + Math.round((i / frames.length) * 75));
    }

    // Step 3: Recomposer la vidéo
    onProgress?.(90);
    const fps = await detectFPS(FFprobeKit, cleanInput);
    const composeSession = await FFmpegKit.execute(
      `-framerate ${fps} -i "${scaledDir}/f_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 "${outputUri}"`
    );

    if (!ReturnCode.isSuccess(await composeSession.getReturnCode())) {
      throw new Error('Composition failed');
    }

    onProgress?.(100);
    return { uri: `file://${outputUri}`, scaleKey, timestamp };

  } catch (error) {
    throw new Error(`[IAProcessor] Upscale Video failed: ${(error as Error).message}`);
  } finally {
    await safeUnlink(framesDir);
    await safeUnlink(scaledDir);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. HELPERS PRIVÉS
// ─────────────────────────────────────────────────────────────────────────────

async function runESRGANPass(imageB64: string, scale: number): Promise<string> {
  if (!tfliteInstance) throw new Error('Modèle non chargé');
  
  const output = await tfliteInstance.runInference(imageB64, {
    inputShape: [1, TILE_SIZE, TILE_SIZE, 3],
    outputShape: [1, TILE_SIZE * scale, TILE_SIZE * scale, 3],
    dType: 'float32',
    normalize: true,
    denormalize: true,
  });

  return extractB64(output);
}

function extractB64(res: any): string {
  if (typeof res === 'string') return res;
  if (res && res.outputBase64) return res.outputBase64;
  if (res && res.base64) return res.base64;
  throw new Error('Format TFLite invalide');
}

async function detectFPS(FFprobeKit: any, path: string): Promise<string> {
  try {
    const session = await FFprobeKit.execute(`-v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${path}"`);
    const out = await session.getOutput();
    const match = out?.match(/(\d+)\/(\d+)/);
    if (match) return (parseInt(match[1]) / parseInt(match[2])).toFixed(3);
  } catch {}
  return '30';
}

async function safeUnlink(path: string) {
  try {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT FINAL
// ─────────────────────────────────────────────────────────────────────────────

export default {
  upscaleImage,
  upscaleVideo,
  ScaleMode,
};
