'use strict';

/**
 * Builds the heatmap ramp from a single base colour.
 *
 * Age is a magnitude, so the ramp keeps ONE hue and varies lightness — a
 * hot-to-cold rainbow would imply categories that aren't there. The base colour
 * only supplies the hue and roughly how saturated to be; the steps are derived.
 */

const DEFAULT_COLOUR = '#3FB950';

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** Accepts #rgb or #rrggbb, with or without the hash. Returns null if unusable. */
function hexToHsl(hex) {
  if (typeof hex !== 'string') return null;

  let value = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;

  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;

  return { h: (h * 60 + 360) % 360, s: clamp(s, 0, 1), l };
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  const m = l - c / 2;
  return (
    '#' +
    rgb
      .map((channel) => {
        const byte = Math.round(clamp(channel + m, 0, 1) * 255);
        return byte.toString(16).padStart(2, '0');
      })
      .join('')
      .toUpperCase()
  );
}

/**
 * Steps from "changed just now" to "untouched for ages".
 *
 * Light and dark are not mirror images of each other. On a pale surface the
 * newest step is the darkest and the ramp lightens away to nothing; on a dark
 * surface the newest is the brightest and the ramp dims. Flipping one to make
 * the other gives you steps that vanish into the background.
 */
function buildRamp(baseColour, options = {}) {
  const { dark = true, steps = 8 } = options;

  const hsl = hexToHsl(baseColour) || hexToHsl(DEFAULT_COLOUR);
  const saturation = clamp(hsl.s, 0.35, 0.9);

  const startL = dark ? 0.62 : 0.34;
  const endL = dark ? 0.16 : 0.94;
  const endS = clamp(saturation * 0.55, 0.15, 0.9);

  return Array.from({ length: steps }, (unused, index) => {
    const t = steps === 1 ? 0 : index / (steps - 1);
    return hslToHex(hsl.h, saturation + (endS - saturation) * t, startL + (endL - startL) * t);
  });
}

module.exports = { DEFAULT_COLOUR, hexToHsl, hslToHex, buildRamp };
