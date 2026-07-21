import type { Config } from '@imgly/background-removal';

type BackgroundRemovalModel = 'isnet_fp16' | 'isnet' | 'isnet_quint8';

const MAX_WORKING_SIZE = 2048;
const MIN_ALPHA_TO_KEEP = 22;
const CONNECTED_ALPHA_THRESHOLD = 34;
const PORTABLE_BACKGROUND_REMOVAL_MODULE = 'https://esm.sh/@imgly/background-removal@1.7.0?bundle';

let backgroundRemovalModulePromise: Promise<typeof import('@imgly/background-removal')> | null = null;

const loadBackgroundRemovalModule = () => {
  if (!backgroundRemovalModulePromise) {
    backgroundRemovalModulePromise = import.meta.env.MODE === 'portable'
      ? import(/* @vite-ignore */ PORTABLE_BACKGROUND_REMOVAL_MODULE)
      : import('@imgly/background-removal');
  }
  return backgroundRemovalModulePromise;
};

async function sourceToBlob(imageSource: string | Blob): Promise<Blob> {
  if (imageSource instanceof Blob) return imageSource;

  const response = await fetch(imageSource);
  if (!response.ok) {
    throw new Error(`图片读取失败: ${response.status}`);
  }
  return response.blob();
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('图片导出失败'));
      }
    }, 'image/png', 1);
  });
}

async function normalizeImageSource(imageSource: string | Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const blob = await sourceToBlob(imageSource);
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_WORKING_SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    bitmap.close();
    throw new Error('浏览器无法创建图片处理画布');
  }

  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return {
    blob: await canvasToBlob(canvas),
    width,
    height
  };
}

async function runBackgroundRemoval(
  imageSource: Blob,
  model: BackgroundRemovalModel,
  onProgress?: (progress: number) => void,
  progressStart = 12,
  progressEnd = 86
): Promise<Blob> {
  const { removeBackground } = await loadBackgroundRemovalModule();
  const config: Config = {
    model,
    device: 'cpu',
    output: {
      format: 'image/png',
      quality: 1
    },
    progress: (_key, current, total) => {
      if (!onProgress || total <= 0) return;
      const ratio = current / total;
      onProgress(Math.round(progressStart + ratio * (progressEnd - progressStart)));
    }
  };

  return removeBackground(imageSource, config);
}

function getAlpha(data: Uint8ClampedArray, index: number) {
  return data[index * 4 + 3];
}

function setAlpha(data: Uint8ClampedArray, index: number, alpha: number) {
  data[index * 4 + 3] = alpha;
}

function cleanSubjectAlpha(imageData: ImageData) {
  const { width, height, data } = imageData;
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);
  const keep = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  const components: Array<{ area: number; minX: number; maxX: number; minY: number; maxY: number; centerScore: number; pixels: number[] }> = [];
  const centerX = width / 2;
  const centerY = height / 2;
  const centerRadius = Math.min(width, height) * 0.34;

  for (let start = 0; start < totalPixels; start += 1) {
    if (visited[start] || getAlpha(data, start) < CONNECTED_ALPHA_THRESHOLD) continue;

    let head = 0;
    let tail = 0;
    let area = 0;
    let centerHits = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    const pixels: number[] = [];

    visited[start] = 1;
    queue[tail] = start;
    tail += 1;

    while (head < tail) {
      const index = queue[head];
      head += 1;
      pixels.push(index);
      area += 1;

      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy < centerRadius * centerRadius) centerHits += 1;

      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1
      ];

      for (const next of neighbors) {
        if (next < 0 || visited[next] || getAlpha(data, next) < CONNECTED_ALPHA_THRESHOLD) continue;
        visited[next] = 1;
        queue[tail] = next;
        tail += 1;
      }
    }

    components.push({
      area,
      minX,
      maxX,
      minY,
      maxY,
      centerScore: centerHits / Math.max(1, area),
      pixels
    });
  }

  if (components.length === 0) return;

  components.sort((a, b) => b.area - a.area);
  const largestArea = components[0].area;
  const minArea = Math.max(32, Math.round(totalPixels * 0.00045));

  for (const component of components) {
    const touchesCenter = component.centerScore > 0.015;
    const largeEnough = component.area >= Math.max(minArea, largestArea * 0.035);
    const isPrimary = component === components[0];

    if (isPrimary || largeEnough || touchesCenter) {
      for (const pixel of component.pixels) keep[pixel] = 1;
    }
  }

  const originalAlpha = new Uint8ClampedArray(totalPixels);
  for (let i = 0; i < totalPixels; i += 1) {
    originalAlpha[i] = getAlpha(data, i);
  }

  for (let index = 0; index < totalPixels; index += 1) {
    if (!keep[index] && originalAlpha[index] < 180) {
      setAlpha(data, index, 0);
    }
  }

  const expandedAlpha = new Uint8ClampedArray(totalPixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let maxAlpha = getAlpha(data, index);

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          maxAlpha = Math.max(maxAlpha, getAlpha(data, ny * width + nx) - 28);
        }
      }

      expandedAlpha[index] = Math.max(getAlpha(data, index), maxAlpha);
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let sum = 0;
      let count = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          sum += expandedAlpha[ny * width + nx];
          count += 1;
        }
      }

      const softened = Math.round(sum / count);
      const original = getAlpha(data, index);
      const alpha = original <= MIN_ALPHA_TO_KEEP ? 0 : Math.max(original, softened);
      setAlpha(data, index, alpha);
    }
  }
}

async function refineForegroundBlob(foregroundBlob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(foregroundBlob);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    bitmap.close();
    throw new Error('浏览器无法创建结果处理画布');
  }

  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  cleanSubjectAlpha(imageData);
  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas);
}

export async function removeImageBackground(
  imageSource: string | Blob,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  onProgress?.(4);
  const normalized = await normalizeImageSource(imageSource);

  onProgress?.(10);

  let result: Blob;
  try {
    result = await runBackgroundRemoval(normalized.blob, 'isnet_fp16', onProgress, 12, 82);
  } catch (error) {
    console.warn('High quality background removal failed, falling back to compact model.', error);
    onProgress?.(18);
    result = await runBackgroundRemoval(normalized.blob, 'isnet_quint8', onProgress, 18, 82);
  }

  onProgress?.(88);
  const refined = await refineForegroundBlob(result);
  onProgress?.(100);
  return refined;
}
