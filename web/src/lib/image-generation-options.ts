export const IMAGE_ASPECT_RATIO_VALUES = ["1:1", "16:9", "4:3", "3:4", "9:16"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIO_VALUES)[number];

export const IMAGE_RESOLUTION_VALUES = ["1k", "2k", "4k"] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTION_VALUES)[number];

export const IMAGE_QUALITY_VALUES = ["auto", "low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITY_VALUES)[number];

const ASPECT_RATIOS: Record<ImageAspectRatio, readonly [number, number]> = {
  "1:1": [1, 1],
  "16:9": [16, 9],
  "4:3": [4, 3],
  "3:4": [3, 4],
  "9:16": [9, 16],
};

const RESOLUTION_BASE_SIZE: Record<ImageResolution, number> = {
  "1k": 1024,
  "2k": 2048,
  "4k": 3840,
};

function isOneOf<T extends readonly string[]>(value: unknown, options: T): value is T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

export function normalizeImageAspectRatio(value: unknown): ImageAspectRatio {
  return isOneOf(value, IMAGE_ASPECT_RATIO_VALUES) ? value : "1:1";
}

export function normalizeImageResolution(value: unknown): ImageResolution {
  return isOneOf(value, IMAGE_RESOLUTION_VALUES) ? value : "1k";
}

export function isImageResolutionAllowedForAspectRatio(resolution: ImageResolution, aspectRatio: ImageAspectRatio) {
  const normalizedResolution = normalizeImageResolution(resolution);
  const normalizedAspectRatio = normalizeImageAspectRatio(aspectRatio);
  return normalizedResolution !== "4k" || normalizedAspectRatio === "16:9" || normalizedAspectRatio === "9:16";
}

export function normalizeImageResolutionForAspectRatio(
  resolution: unknown,
  aspectRatio: unknown,
): ImageResolution {
  const normalizedResolution = normalizeImageResolution(resolution);
  const normalizedAspectRatio = normalizeImageAspectRatio(aspectRatio);
  return isImageResolutionAllowedForAspectRatio(normalizedResolution, normalizedAspectRatio)
    ? normalizedResolution
    : "2k";
}

export function normalizeImageQuality(value: unknown): ImageQuality {
  return isOneOf(value, IMAGE_QUALITY_VALUES) ? value : "auto";
}

export function resolveImageOutputSize(resolution: ImageResolution, aspectRatio: ImageAspectRatio) {
  const normalizedResolution = normalizeImageResolutionForAspectRatio(resolution, aspectRatio);
  const normalizedAspectRatio = normalizeImageAspectRatio(aspectRatio);
  const [ratioWidth, ratioHeight] = ASPECT_RATIOS[normalizedAspectRatio];
  const baseSize = RESOLUTION_BASE_SIZE[normalizedResolution];
  const largerRatio = Math.max(ratioWidth, ratioHeight);
  const smallerRatio = Math.min(ratioWidth, ratioHeight);
  const shortEdge = Math.round((baseSize / largerRatio) * smallerRatio);
  const width = ratioWidth >= ratioHeight ? baseSize : shortEdge;
  const height = ratioWidth >= ratioHeight ? shortEdge : baseSize;
  return `${width}x${height}`;
}

// 上游对话链路单张图片的面积上限（约 1.57MP，例如 16:9 ≈ 1672×941）。
// 不再让用户选择分辨率，直接按所选比例占满这个面积，得到允许范围内的最大分辨率。
const MAX_IMAGE_AREA = 1672 * 941;

export function maxImageOutputSizeForAspectRatio(aspectRatio: ImageAspectRatio) {
  const normalizedAspectRatio = normalizeImageAspectRatio(aspectRatio);
  const [ratioWidth, ratioHeight] = ASPECT_RATIOS[normalizedAspectRatio];
  const width = Math.round(Math.sqrt(MAX_IMAGE_AREA * (ratioWidth / ratioHeight)));
  const height = Math.round(Math.sqrt(MAX_IMAGE_AREA * (ratioHeight / ratioWidth)));
  return `${width}x${height}`;
}

export function formatImageOutputSize(size: string) {
  return size.replace("x", " x ");
}
