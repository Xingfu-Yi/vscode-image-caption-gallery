export interface Dimensions {
  width: number;
  height: number;
}

export function previewDimensions(width: number, height: number, resolution: number): Dimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('Invalid image dimensions.');
  }
  if (!Number.isSafeInteger(resolution) || resolution < 0) {
    throw new Error('Preview resolution must be a non-negative integer.');
  }
  if (resolution === 0 || width * height <= resolution ** 2) {
    return { width, height };
  }
  const scale = resolution / Math.sqrt(width * height);
  let nextWidth = Math.max(1, Math.floor(width * scale));
  let nextHeight = Math.max(1, Math.floor(height * scale));
  // A sub-pixel short edge must round up to one pixel, without exceeding the budget.
  if (nextWidth * nextHeight > resolution ** 2) {
    if (nextWidth > nextHeight) {
      nextWidth = Math.max(1, Math.floor(resolution ** 2 / nextHeight));
    } else {
      nextHeight = Math.max(1, Math.floor(resolution ** 2 / nextWidth));
    }
  }
  return { width: nextWidth, height: nextHeight };
}
