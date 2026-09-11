/**
 * AutoCAD Color Index (ACI) & Hex / RGB Color Mapping Library
 * Pure functional implementation without DOM dependencies.
 */

export const ACI_BYBLOCK = 0;
export const ACI_BYLAYER = 256;

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Standard ACI Palette lookup table (index 0..256).
 * 0: BYBLOCK (#FFFFFF default)
 * 1..9: Standard basic colors
 * 10..249: 24 Hues x 5 Lightness x 2 Saturation levels
 * 250..255: Grayscale levels
 * 256: BYLAYER (#FFFFFF default)
 */
function buildAciPalette(): RgbColor[] {
  const palette: RgbColor[] = new Array(257);

  // ACI 0: BYBLOCK
  palette[0] = { r: 255, g: 255, b: 255 };

  // ACI 1..9 Basic Colors
  palette[1] = { r: 255, g: 0, b: 0 };       // Red
  palette[2] = { r: 255, g: 255, b: 0 };     // Yellow
  palette[3] = { r: 0, g: 255, b: 0 };       // Green
  palette[4] = { r: 0, g: 255, b: 255 };     // Cyan
  palette[5] = { r: 0, g: 0, b: 255 };       // Blue
  palette[6] = { r: 255, g: 0, b: 255 };     // Magenta
  palette[7] = { r: 255, g: 255, b: 255 };   // White / Black
  palette[8] = { r: 128, g: 128, b: 128 };   // Dark Gray
  palette[9] = { r: 192, g: 192, b: 192 };   // Light Gray

  // ACI 10..249: 24 Hue wheels x 5 Lightness levels x 2 Saturations
  const intensities = [1.0, 0.8, 0.6, 0.4, 0.2];

  for (let h = 0; h < 24; h++) {
    // Determine base RGB for 24 hues at full intensity & saturation
    let baseR = 0;
    let baseG = 0;
    let baseB = 0;

    if (h >= 0 && h <= 3) {
      baseR = 255;
      baseG = Math.round(255 * (h / 4));
      baseB = 0;
    } else if (h >= 4 && h <= 7) {
      baseR = Math.round(255 * ((8 - h) / 4));
      baseG = 255;
      baseB = 0;
    } else if (h >= 8 && h <= 11) {
      baseR = 0;
      baseG = 255;
      baseB = Math.round(255 * ((h - 8) / 4));
    } else if (h >= 12 && h <= 15) {
      baseR = 0;
      baseG = Math.round(255 * ((16 - h) / 4));
      baseB = 255;
    } else if (h >= 16 && h <= 19) {
      baseR = Math.round(255 * ((h - 16) / 4));
      baseG = 0;
      baseB = 255;
    } else {
      baseR = 255;
      baseG = 0;
      baseB = Math.round(255 * ((24 - h) / 4));
    }

    for (let lvl = 0; lvl < 5; lvl++) {
      const k = intensities[lvl];

      // Even index: Full Saturation
      const evenIndex = 10 + h * 10 + lvl * 2;
      palette[evenIndex] = {
        r: Math.round(baseR * k),
        g: Math.round(baseG * k),
        b: Math.round(baseB * k),
      };

      // Odd index: 50% Saturation
      const oddIndex = evenIndex + 1;
      palette[oddIndex] = {
        r: Math.round(baseR * k * 0.5 + 255 * k * 0.5),
        g: Math.round(baseG * k * 0.5 + 255 * k * 0.5),
        b: Math.round(baseB * k * 0.5 + 255 * k * 0.5),
      };
    }
  }

  // ACI 250..255: Grayscale
  palette[250] = { r: 51, g: 51, b: 51 };
  palette[251] = { r: 91, g: 91, b: 91 };
  palette[252] = { r: 132, g: 132, b: 132 };
  palette[253] = { r: 173, g: 173, b: 173 };
  palette[254] = { r: 214, g: 214, b: 214 };
  palette[255] = { r: 255, g: 255, b: 255 };

  // ACI 256: BYLAYER
  palette[256] = { r: 255, g: 255, b: 255 };

  return palette;
}

const ACI_PALETTE: RgbColor[] = buildAciPalette();

/**
 * Parses a Hex color string (#RGB or #RRGGBB, with or without #) into an RgbColor object.
 * Returns null if the hex string is invalid.
 */
export function parseHexToRgb(hex: string): RgbColor | null {
  if (!hex || typeof hex !== 'string') {
    return null;
  }

  let clean = hex.trim();
  if (clean.startsWith('#')) {
    clean = clean.slice(1);
  }

  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);

    if (isNaN(r) || isNaN(g) || isNaN(b)) {
      return null;
    }
    return { r, g, b };
  }

  if (clean.length === 6) {
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);

    if (isNaN(r) || isNaN(g) || isNaN(b)) {
      return null;
    }
    return { r, g, b };
  }

  return null;
}

/**
 * Converts an RgbColor object into a 6-character uppercase Hex string (#RRGGBB).
 */
export function rgbToHex(rgb: RgbColor): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(rgb.r).toString(16).padStart(2, '0').toUpperCase();
  const g = clamp(rgb.g).toString(16).padStart(2, '0').toUpperCase();
  const b = clamp(rgb.b).toString(16).padStart(2, '0').toUpperCase();

  return `#${r}${g}${b}`;
}

/**
 * Converts an AutoCAD Color Index (ACI) to an RGB color object.
 * Falls back to #FFFFFF ({r:255, g:255, b:255}) for 0 (BYBLOCK), 256 (BYLAYER), or out-of-bounds indices.
 */
export function aciToRgb(aci: number): RgbColor {
  if (typeof aci !== 'number' || isNaN(aci) || aci < 0 || aci > 256) {
    return { r: 255, g: 255, b: 255 };
  }

  const index = Math.round(aci);
  return ACI_PALETTE[index] || { r: 255, g: 255, b: 255 };
}

/**
 * Converts an AutoCAD Color Index (ACI) to a 6-character uppercase Hex string (#RRGGBB).
 * Returns '#FFFFFF' for 0 (BYBLOCK), 256 (BYLAYER), or out-of-bounds indices.
 */
export function aciToHex(aci: number): string {
  return rgbToHex(aciToRgb(aci));
}

/**
 * Converts RGB values (0..255) to the closest matching ACI index (1..255)
 * using Euclidean color distance in RGB space.
 */
export function rgbToAci(r: number, g: number, b: number): number {
  const clampR = Math.max(0, Math.min(255, Math.round(r)));
  const clampG = Math.max(0, Math.min(255, Math.round(g)));
  const clampB = Math.max(0, Math.min(255, Math.round(b)));

  let minDistanceSq = Infinity;
  let closestAci = 7; // Fallback default to white/black (ACI 7)

  for (let i = 1; i <= 255; i++) {
    const target = ACI_PALETTE[i];
    const dr = clampR - target.r;
    const dg = clampG - target.g;
    const db = clampB - target.b;
    const distSq = dr * dr + dg * dg + db * db;

    if (distSq < minDistanceSq) {
      minDistanceSq = distSq;
      closestAci = i;
      if (distSq === 0) {
        break; // Exact match found
      }
    }
  }

  return closestAci;
}

/**
 * Converts a Hex color string (or ACI number string) to the closest ACI index (1..255).
 * Falls back to ACI 7 (#FFFFFF) if hex is invalid or empty.
 */
export function hexToAci(hex: string): number {
  if (!hex || typeof hex !== 'string') {
    return 7;
  }

  const rgb = parseHexToRgb(hex);
  if (rgb) {
    return rgbToAci(rgb.r, rgb.g, rgb.b);
  }

  // Check if hex is a direct numeric string (e.g., "1", "256")
  const num = Number(hex.trim());
  if (!isNaN(num) && num >= 0 && num <= 256) {
    const rounded = Math.round(num);
    if (rounded === 0 || rounded === 256) {
      return 7;
    }
    return rounded;
  }

  return 7;
}

/**
 * Translates CADLayer color property to Group Code 62 value.
 * Defaults to ACI 7 if invalid or empty.
 */
export function getLayerAci(layerColor?: string): number {
  if (!layerColor || typeof layerColor !== 'string') {
    return 7;
  }

  const clean = layerColor.trim().toLowerCase();
  if (clean === 'bylayer' || clean === '256') {
    return ACI_BYLAYER;
  }
  if (clean === 'byblock' || clean === '0') {
    return ACI_BYBLOCK;
  }

  return hexToAci(layerColor);
}

/**
 * Translates entity color or layer color fallback to ACI integer.
 * Returns 256 (ByLayer) if entity color is omitted, 'bylayer', or if isByLayer flag is true.
 */
export function getEntityAci(entityColor?: string, isByLayer?: boolean | string): number {
  if (isByLayer === true) {
    return ACI_BYLAYER;
  }

  if (!entityColor || typeof entityColor !== 'string') {
    return ACI_BYLAYER;
  }

  const clean = entityColor.trim().toLowerCase();
  if (clean === 'bylayer' || clean === '256') {
    return ACI_BYLAYER;
  }
  if (clean === 'byblock' || clean === '0') {
    return ACI_BYBLOCK;
  }

  return hexToAci(entityColor);
}
