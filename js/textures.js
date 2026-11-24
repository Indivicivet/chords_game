import * as THREE from "three";

// Simple deterministic hash + 2D value noise for seamless/clean procedural textures
function hash2(x, y, seed = 1337) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function tileNoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smoothstep(x - xi);
  const yf = smoothstep(y - yi);
  const x0 = ((xi % period) + period) % period;
  const y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;

  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x1, y0, seed);
  const v01 = hash2(x0, y1, seed);
  const v11 = hash2(x1, y1, seed);

  const a = v00 + (v10 - v00) * xf;
  const b = v01 + (v11 - v01) * xf;
  return a + (b - a) * yf;
}

function fbmTile(u, v, baseFreq, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u * freq, v * freq, freq, seed + o * 97);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function heightFieldToNormalCanvas(height, size, strength) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const at = (x, y) => {
    const wx = ((x % size) + size) % size;
    const wy = ((y % size) + size) % size;
    return height[wy * size + wx];
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;

      const idx = (y * size + x) * 4;
      data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Generates carved travertine / limestone PBR textures.
 */
export function createStoneTextures() {
  const size = 512;
  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = size;
  albedoCanvas.height = size;
  const aCtx = albedoCanvas.getContext("2d");
  const aImg = aCtx.createImageData(size, size);

  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rCtx = roughCanvas.getContext("2d");
  const rImg = rCtx.createImageData(size, size);

  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      const broad = fbmTile(u, v, 6, 4, 11);
      const fine = fbmTile(u, v, 32, 3, 211);
      const grain = fbmTile(u, v, 96, 2, 503);

      // Subtle sedimentary limestone veining
      const veinWarp = fbmTile(u, v, 8, 3, 77) * 0.18;
      const vein = Math.sin((u * 2.0 + v * 1.0 + veinWarp) * Math.PI * 4.0) * 0.5 + 0.5;
      const veinMask = Math.pow(vein, 3.0) * 0.14;

      // Occasional tiny natural travertine pits
      const pitRaw = tileNoise(u * 48, v * 48, 48, 991);
      const pit = pitRaw > 0.88 ? (pitRaw - 0.88) / 0.12 : 0;

      const hVal = broad * 0.45 + fine * 0.35 + grain * 0.2 - pit * 0.48 - veinMask * 0.25;
      height[y * size + x] = hVal;

      // Warm sunlit carved limestone palette
      const tone = 0.78 + broad * 0.12 + fine * 0.06 - veinMask * 0.28 - pit * 0.16;
      const r = Math.min(255, Math.max(0, Math.round(tone * 238)));
      const g = Math.min(255, Math.max(0, Math.round(tone * 230)));
      const b = Math.min(255, Math.max(0, Math.round(tone * 214)));

      const idx = (y * size + x) * 4;
      aImg.data[idx] = r;
      aImg.data[idx + 1] = g;
      aImg.data[idx + 2] = b;
      aImg.data[idx + 3] = 255;

      const rough = Math.min(255, Math.max(110, Math.round((0.62 + (1 - fine) * 0.22 + pit * 0.16) * 255)));
      rImg.data[idx] = rough;
      rImg.data[idx + 1] = rough;
      rImg.data[idx + 2] = rough;
      rImg.data[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);
  const normalCanvas = heightFieldToNormalCanvas(height, size, 1.35);

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;

  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = 8;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.anisotropy = 8;

  return { map, normalMap, roughnessMap };
}

/**
 * Generates a braided/twisted 3-ply cord texture set for the game strings.
 */
export function createStringTextures() {
  const size = 256;
  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = size;
  albedoCanvas.height = size;
  const aCtx = albedoCanvas.getContext("2d");
  const aImg = aCtx.createImageData(size, size);

  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // 3-ply helical twist along u (length) and v (circumference)
      const phase = (u * 14.0 + v * 3.0) * Math.PI * 2;
      const ply = Math.abs(Math.sin(phase));
      const microFiber = Math.sin((u * 42.0 - v * 9.0) * Math.PI * 2) * 0.14;
      const noise = fbmTile(u, v, 16, 2, 404) * 0.12;
      const h = Math.pow(ply, 0.55) * 0.78 + microFiber + noise;
      height[y * size + x] = h;

      const shade = Math.min(255, Math.max(120, Math.round((0.72 + Math.pow(ply, 0.7) * 0.28 + noise * 0.3) * 255)));
      const idx = (y * size + x) * 4;
      aImg.data[idx] = shade;
      aImg.data[idx + 1] = shade;
      aImg.data[idx + 2] = shade;
      aImg.data[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  const normalCanvas = heightFieldToNormalCanvas(height, size, 3.6);

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(6, 1);

  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(6, 1);

  return { map, normalMap };
}

/**
 * Generates an equirectangular sunlit blue-sky + clouds + sun-disc environment texture.
 */
export function createSkyEquirectTexture(sunDir) {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  const data = img.data;

  const sDir = sunDir.clone().normalize();

  for (let py = 0; py < height; py++) {
    const v = py / height; // 0 = zenith (+Y), 0.5 = horizon, 1 = nadir (-Y)
    const phi = v * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let px = 0; px < width; px++) {
      const u = px / width;
      const theta = u * Math.PI * 2;
      const dx = sinPhi * Math.cos(theta);
      const dy = cosPhi;
      const dz = sinPhi * Math.sin(theta);

      let r, g, b;

      if (dy >= 0) {
        // Sky dome: rich cerulean zenith to bright horizon azure
        const hT = Math.pow(1 - dy, 2.2);
        r = 38 + hT * 145;
        g = 118 + hT * 105;
        b = 228 + hT * 26;

        // Soft drifting cumulus clouds in mid-upper sky
        if (dy > 0.04) {
          const cu = dx / (dy + 0.25);
          const cv = dz / (dy + 0.25);
          const n1 = fbmTile((cu * 0.18 + 10) % 1, (cv * 0.18 + 10) % 1, 8, 4, 303);
          const cloudMask = Math.max(0, (n1 - 0.52) / 0.28);
          const fade = Math.min(1, dy * 5.0) * (1 - Math.pow(dy, 3.0) * 0.35);
          const cAmt = Math.min(0.92, Math.pow(cloudMask, 1.35) * fade);
          // Sunlit white-warm cloud top
          r = r * (1 - cAmt) + 252 * cAmt;
          g = g * (1 - cAmt) + 252 * cAmt;
          b = b * (1 - cAmt) + 255 * cAmt;
        }

        // Sun glow & crisp bright solar disc
        const sunDot = Math.max(0, dx * sDir.x + dy * sDir.y + dz * sDir.z);
        const halo = Math.pow(sunDot, 16) * 0.38 + Math.pow(sunDot, 140) * 0.65;
        const disc = sunDot > 0.9988 ? 1.0 : 0.0;
        r = Math.min(255, r + (halo + disc) * 255);
        g = Math.min(255, g + (halo * 0.95 + disc) * 245);
        b = Math.min(255, b + (halo * 0.78 + disc) * 215);
      } else {
        // Bright sunlit azure mist / distant courtyard water horizon below y=0
        const gT = Math.min(1, -dy * 2.8);
        r = 183 * (1 - gT) + 128 * gT;
        g = 216 * (1 - gT) + 178 * gT;
        b = 246 * (1 - gT) + 225 * gT;
      }

      const idx = (py * width + px) * 4;
      data[idx] = Math.round(r);
      data[idx + 1] = Math.round(g);
      data[idx + 2] = Math.round(b);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
