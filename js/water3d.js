import * as THREE from "three";
import { SCAD, pointInConvexPolygon } from "./geometry.js";
import { toWorldXZ } from "./board3d.js";

const GRID_N = 256;
const BOARD_SPAN = SCAD.BOARD_R * 2; // 100
const WELL_FLOOR_Y = SCAD.BASE_H + SCAD.MID_RAISE; // 4.5
const WELL_FULL_Y = SCAD.BASE_H + SCAD.EDGE_RAISE - 0.26; // 6.24 (just below 6.5 rim)
const POUR_DURATION = 1.0;
const STAGGER_STEP = 0.085;

const WATER_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const WATER_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uWaveTex;
  uniform sampler2D uSkyTex;
  uniform vec3 uSunDir;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;
  uniform float uFillProgress;
  uniform float uTime;
  uniform float uGridSize;
  uniform float uBoardSpan;

  varying vec3 vWorldPos;

  float decodeH(vec2 texel) {
    vec2 clamped = clamp(texel, vec2(0.5), vec2(uGridSize - 0.5));
    vec4 s = texture2D(uWaveTex, clamped / uGridSize);
    float v16 = (s.r * 255.0 * 256.0 + s.g * 255.0) / 65535.0;
    return (v16 * 2.0 - 1.0);
  }

  float sampleHeightBilinear(vec2 worldXZ) {
    vec2 uv = (worldXZ + uBoardSpan * 0.5) / uBoardSpan;
    vec2 f = uv * uGridSize - 0.5;
    vec2 i0 = floor(f);
    vec2 fr = f - i0;
    float h00 = decodeH(i0 + vec2(0.5, 0.5));
    float h10 = decodeH(i0 + vec2(1.5, 0.5));
    float h01 = decodeH(i0 + vec2(0.5, 1.5));
    float h11 = decodeH(i0 + vec2(1.5, 1.5));
    return mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
  }

  vec3 sampleSky(vec3 dir) {
    vec3 d = normalize(dir);
    // Keep reflection mostly in sky hemisphere for crisp bright water look
    d.y = abs(d.y) * 0.85 + max(d.y, 0.0) * 0.15;
    float u = fract(atan(d.z, d.x) / 6.28318530718);
    float v = 1.0 - acos(clamp(d.y, -1.0, 1.0)) / 3.14159265359;
    return texture2D(uSkyTex, vec2(u, v)).rgb;
  }

  void main() {
    float eps = uBoardSpan / uGridSize;
    float hL = sampleHeightBilinear(vWorldPos.xz - vec2(eps, 0.0));
    float hR = sampleHeightBilinear(vWorldPos.xz + vec2(eps, 0.0));
    float hD = sampleHeightBilinear(vWorldPos.xz - vec2(0.0, eps));
    float hU = sampleHeightBilinear(vWorldPos.xz + vec2(0.0, eps));

    // Subtle capillary wind shimmer so water stays gracefully alive
    float cap1 = sin(vWorldPos.x * 1.9 + uTime * 2.3) * cos(vWorldPos.z * 2.1 - uTime * 1.8);
    float cap2 = sin((vWorldPos.x + vWorldPos.z) * 2.7 - uTime * 2.9);
    float dCapX = (cos(vWorldPos.x * 1.9 + uTime * 2.3) * cos(vWorldPos.z * 2.1 - uTime * 1.8) * 1.9
                 + cos((vWorldPos.x + vWorldPos.z) * 2.7 - uTime * 2.9) * 2.7) * 0.028;
    float dCapZ = (-sin(vWorldPos.x * 1.9 + uTime * 2.3) * sin(vWorldPos.z * 2.1 - uTime * 1.8) * 2.1
                 + cos((vWorldPos.x + vWorldPos.z) * 2.7 - uTime * 2.9) * 2.7) * 0.028;

    float waveGain = 2.6;
    float dx = (hR - hL) * waveGain + dCapX;
    float dz = (hU - hD) * waveGain + dCapZ;
    vec3 N = normalize(vec3(-dx, 1.0, -dz));

    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 R = reflect(-V, N);

    vec3 skyRefl = sampleSky(R);

    // Subtle stone caustic shimmer visible through shallower water
    float caustic = 0.5 + 0.5 * (cap1 * 0.6 + cap2 * 0.4);
    vec3 baseWater = mix(uShallowColor, uDeepColor, clamp(uFillProgress * 0.85, 0.0, 1.0));
    baseWater += uShallowColor * caustic * (1.0 - uFillProgress * 0.55) * 0.14;

    float fresnel = 0.08 + 0.88 * pow(1.0 - max(dot(N, V), 0.0), 3.6);
    vec3 color = mix(baseWater, skyRefl * mix(vec3(1.0), uShallowColor, 0.25), fresnel);

    // Crisp sun specular sparkles + broad glint
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);
    float ndoth = max(dot(N, H), 0.0);
    float specTight = pow(ndoth, 280.0) * 3.0;
    float specMid = pow(ndoth, 42.0) * 0.34;
    color += vec3(1.0, 0.97, 0.90) * (specTight + specMid);

    float alpha = mix(0.68, 0.90, clamp(uFillProgress, 0.0, 1.0));
    gl_FragColor = vec4(color, alpha);
  }
`;

function makeShapeFromPoly(pts) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i].x, pts[i].y);
  }
  shape.closePath();
  return shape;
}

export function createWaterSystem(board, skyEquirectTex, sunDir) {
  const root = new THREE.Group();
  const nFaces = board.faces.length;

  // 1. Pre-bake wellMask (GRID_N x GRID_N) and pixel lists per face
  const wellMask = new Int16Array(GRID_N * GRID_N).fill(-1);
  const wellPixels = Array.from({ length: nFaces }, () => []);

  // Precompute bounding boxes for quick point-in-well lookup
  const faceBoxes = board.faces.map((f) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of f.innerPoly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  });

  for (let gz = 0; gz < GRID_N; gz++) {
    const wz = ((gz + 0.5) / GRID_N - 0.5) * BOARD_SPAN;
    const by = -wz;
    for (let gx = 0; gx < GRID_N; gx++) {
      const wx = ((gx + 0.5) / GRID_N - 0.5) * BOARD_SPAN;
      const bx = wx;
      for (let fId = 0; fId < nFaces; fId++) {
        const bb = faceBoxes[fId];
        if (bx < bb.minX || bx > bb.maxX || by < bb.minY || by > bb.maxY) continue;
        if (pointInConvexPolygon({ x: bx, y: by }, board.faces[fId].innerPoly, -0.05)) {
          const idx = gz * GRID_N + gx;
          wellMask[idx] = fId;
          wellPixels[fId].push(idx);
          break;
        }
      }
    }
  }

  // Also locate nearest pixel for each well centroid (for splash injection)
  const faceCentroidGrid = board.faces.map((f) => {
    const w = toWorldXZ(f.centroid);
    const gx = Math.max(1, Math.min(GRID_N - 2, Math.floor(((w.x + BOARD_SPAN * 0.5) / BOARD_SPAN) * GRID_N)));
    const gz = Math.max(1, Math.min(GRID_N - 2, Math.floor(((w.z + BOARD_SPAN * 0.5) / BOARD_SPAN) * GRID_N)));
    return { gx, gz, idx: gz * GRID_N + gx };
  });

  // 2. Wave height buffers + RGBA8 16-bit encoded DataTexture
  const hCur = new Float32Array(GRID_N * GRID_N);
  const hPrev = new Float32Array(GRID_N * GRID_N);
  const hNext = new Float32Array(GRID_N * GRID_N);
  const texData = new Uint8Array(GRID_N * GRID_N * 4);

  const waveTex = new THREE.DataTexture(
    texData,
    GRID_N,
    GRID_N,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  waveTex.minFilter = THREE.NearestFilter;
  waveTex.magFilter = THREE.NearestFilter;
  waveTex.wrapS = THREE.ClampToEdgeWrapping;
  waveTex.wrapT = THREE.ClampToEdgeWrapping;
  waveTex.needsUpdate = true;

  // 3. Per-well water meshes & pouring streams + droplets
  const activeWells = new Map(); // faceId -> state
  const pourStreams = new Map(); // faceId -> mesh
  const droplets = [];

  const dropletGeo = new THREE.SphereGeometry(0.2, 8, 6);
  const streamGeo = new THREE.CylinderGeometry(0.14, 0.34, 1.0, 14, 1, false);
  // Shift cylinder so y=0 is bottom impact, y=1 is top spout
  streamGeo.translate(0, 0.5, 0);

  let simTime = 0;

  function createWellMesh(face, palette) {
    const shape = makeShapeFromPoly(face.innerPoly);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX_SHADER,
      fragmentShader: WATER_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: true,
      uniforms: {
        uWaveTex: { value: waveTex },
        uSkyTex: { value: skyEquirectTex },
        uSunDir: { value: sunDir.clone().normalize() },
        uShallowColor: { value: new THREE.Color(palette.waterShallow) },
        uDeepColor: { value: new THREE.Color(palette.waterDeep) },
        uFillProgress: { value: 0.0 },
        uTime: { value: 0.0 },
        uGridSize: { value: GRID_N },
        uBoardSpan: { value: BOARD_SPAN },
      },
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = WELL_FLOOR_Y + 0.04;
    mesh.visible = false;
    root.add(mesh);
    return mesh;
  }

  function createStreamMesh(face, palette) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: palette.waterShallow,
      emissive: palette.waterDeep,
      emissiveIntensity: 0.18,
      roughness: 0.05,
      metalness: 0.12,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      transparent: true,
      opacity: 0.84,
    });
    const mesh = new THREE.Mesh(streamGeo, mat);
    const wPos = toWorldXZ(face.centroid);
    mesh.position.set(wPos.x, WELL_FLOOR_Y, wPos.z);
    mesh.visible = false;
    root.add(mesh);
    return mesh;
  }

  function injectSplash(fId, strength, radiusCells = 2.5) {
    const c = faceCentroidGrid[fId];
    const rCeil = Math.ceil(radiusCells);
    for (let dz = -rCeil; dz <= rCeil; dz++) {
      const gz = c.gz + dz;
      if (gz < 1 || gz >= GRID_N - 1) continue;
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        const gx = c.gx + dx;
        if (gx < 1 || gx >= GRID_N - 1) continue;
        const idx = gz * GRID_N + gx;
        if (wellMask[idx] !== fId) continue;
        const d = Math.hypot(dx, dz);
        if (d <= radiusCells) {
          const w = 0.5 * (1 + Math.cos((Math.PI * d) / radiusCells));
          hCur[idx] = Math.max(-0.95, Math.min(0.95, hCur[idx] + strength * w));
        }
      }
    }
  }

  function spawnDroplet(fId, waterY, palette) {
    const face = board.faces[fId];
    const center = toWorldXZ(face.centroid);
    const ang = Math.random() * Math.PI * 2;
    const speedR = 1.2 + Math.random() * 2.4;
    const mat = new THREE.MeshBasicMaterial({
      color: palette.waterShallow,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.Mesh(dropletGeo, mat);
    mesh.position.set(
      center.x + Math.cos(ang) * 0.2,
      waterY + 0.15,
      center.z + Math.sin(ang) * 0.2
    );
    const s = 0.6 + Math.random() * 0.65;
    mesh.scale.setScalar(s);
    root.add(mesh);
    droplets.push({
      mesh,
      vx: Math.cos(ang) * speedR,
      vy: 3.8 + Math.random() * 3.8,
      vz: Math.sin(ang) * speedR,
      floorY: waterY,
      life: 0,
    });
  }

  function claimFaces(faceIds, palette, animate = true) {
    if (!faceIds || faceIds.length === 0) return;

    // Sort faces radially from their average center for an organic cascade stagger
    const avg = faceIds.reduce(
      (acc, id) => {
        acc.x += board.faces[id].centroid.x;
        acc.y += board.faces[id].centroid.y;
        return acc;
      },
      { x: 0, y: 0 }
    );
    avg.x /= faceIds.length;
    avg.y /= faceIds.length;

    const ordered = faceIds.slice().sort((a, b) => {
      const fa = board.faces[a].centroid;
      const fb = board.faces[b].centroid;
      return Math.hypot(fa.x - avg.x, fa.y - avg.y) - Math.hypot(fb.x - avg.x, fb.y - avg.y);
    });

    ordered.forEach((fId, idx) => {
      if (activeWells.has(fId)) return;
      const face = board.faces[fId];
      const mesh = createWellMesh(face, palette);
      const stream = animate ? createStreamMesh(face, palette) : null;
      if (stream) pourStreams.set(fId, stream);

      const startAt = animate ? simTime + idx * STAGGER_STEP : simTime - POUR_DURATION;
      activeWells.set(fId, {
        faceId: fId,
        palette,
        mesh,
        startAt,
        fillProgress: animate ? 0 : 1,
        pouringStarted: !animate,
        pouringFinished: !animate,
        dropletTimer: 0,
        ambientTimer: Math.random() * 1.5,
      });

      if (!animate) {
        mesh.visible = true;
        mesh.position.y = WELL_FULL_Y;
        mesh.material.uniforms.uFillProgress.value = 1.0;
        injectSplash(fId, 0.25, 2.5);
      }
    });
  }

  function clearAll() {
    for (const w of activeWells.values()) {
      root.remove(w.mesh);
      w.mesh.geometry.dispose();
      w.mesh.material.dispose();
    }
    activeWells.clear();

    for (const s of pourStreams.values()) {
      root.remove(s);
      s.material.dispose();
    }
    pourStreams.clear();

    for (const d of droplets) {
      root.remove(d.mesh);
      d.mesh.material.dispose();
    }
    droplets.length = 0;

    hCur.fill(0);
    hPrev.fill(0);
    hNext.fill(0);
    texData.fill(0);
    waveTex.needsUpdate = true;
  }

  function rebuildFromFaceOwners(faceOwners, paletteBySlot) {
    clearAll();
    const byOwner = new Map();
    for (let fId = 0; fId < faceOwners.length; fId++) {
      const owner = faceOwners[fId];
      if (owner === null) continue;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(fId);
    }
    for (const [slot, ids] of byOwner.entries()) {
      const pal = paletteBySlot.get(slot);
      if (pal) claimFaces(ids, pal, false);
    }
  }

  function hasActivePour() {
    for (const w of activeWells.values()) {
      if (!w.pouringFinished) return true;
    }
    return false;
  }

  function stepWavePhysics() {
    const c2 = 0.22; // wave speed squared (stable < 0.25)
    const damping = 0.9968; // super gentle damping so ripples linger very long

    for (const w of activeWells.values()) {
      if (!w.pouringStarted) continue;
      const pixels = wellPixels[w.faceId];
      const fId = w.faceId;
      for (let k = 0; k < pixels.length; k++) {
        const idx = pixels[k];
        const hc = hCur[idx];
        const hL = wellMask[idx - 1] === fId ? hCur[idx - 1] : hc;
        const hR = wellMask[idx + 1] === fId ? hCur[idx + 1] : hc;
        const hD = wellMask[idx - GRID_N] === fId ? hCur[idx - GRID_N] : hc;
        const hU = wellMask[idx + GRID_N] === fId ? hCur[idx + GRID_N] : hc;

        const lap = hL + hR + hD + hU - 4.0 * hc;
        let next = (2.0 * hc - hPrev[idx] + c2 * lap) * damping;
        if (next > 1.0) next = 1.0;
        else if (next < -1.0) next = -1.0;
        hNext[idx] = next;
      }
    }

    // Swap active pixels & pack 16-bit RGBA8 texture
    for (const w of activeWells.values()) {
      if (!w.pouringStarted) continue;
      const pixels = wellPixels[w.faceId];
      for (let k = 0; k < pixels.length; k++) {
        const idx = pixels[k];
        const prev = hCur[idx];
        const cur = hNext[idx];
        hPrev[idx] = prev;
        hCur[idx] = cur;

        const norm = Math.max(0, Math.min(1, cur * 0.5 + 0.5));
        const q = Math.round(norm * 65535);
        const tIdx = idx * 4;
        texData[tIdx] = (q >> 8) & 255;
        texData[tIdx + 1] = q & 255;
        texData[tIdx + 2] = 255;
        texData[tIdx + 3] = 255;
      }
    }
    waveTex.needsUpdate = true;
  }

  let physicsAccum = 0;

  function update(dt) {
    const clampedDt = Math.min(dt, 0.05);
    simTime += clampedDt;

    for (const w of activeWells.values()) {
      w.mesh.material.uniforms.uTime.value = simTime;

      if (simTime < w.startAt) continue;

      if (!w.pouringStarted) {
        w.pouringStarted = true;
        w.mesh.visible = true;
        injectSplash(w.faceId, 0.55, 3.0);
      }

      const elapsed = simTime - w.startAt;
      const rawT = Math.min(1, elapsed / POUR_DURATION);
      // Smooth ease-out volume rise
      const easeFill = 1 - Math.pow(1 - rawT, 1.75);
      w.fillProgress = easeFill;

      const waterY = WELL_FLOOR_Y + 0.05 + easeFill * (WELL_FULL_Y - WELL_FLOOR_Y - 0.05);
      w.mesh.position.y = waterY;
      w.mesh.material.uniforms.uFillProgress.value = easeFill;

      const stream = pourStreams.get(w.faceId);
      if (rawT < 1) {
        // Turbulent pouring impulses & splash droplets
        const pulse = Math.sin(simTime * 28.0 + w.faceId) * 0.22 + 0.14;
        injectSplash(w.faceId, pulse * clampedDt * 24.0, 2.4);

        w.dropletTimer += clampedDt;
        if (w.dropletTimer > 0.09) {
          w.dropletTimer = 0;
          spawnDroplet(w.faceId, waterY, w.palette);
        }

        if (stream) {
          stream.visible = true;
          const spoutTopY = 23.0;
          const headDrop = Math.min(1, elapsed / 0.14);
          const streamBottomY = spoutTopY * (1 - headDrop) + waterY * headDrop;
          const streamLen = Math.max(0.1, spoutTopY - streamBottomY);
          const pinch = rawT > 0.85 ? (1 - rawT) / 0.15 : 1.0;
          const wobble = 1.0 + Math.sin(simTime * 34.0 + w.faceId) * 0.12;
          stream.position.y = streamBottomY;
          stream.scale.set(pinch * wobble, streamLen, pinch * wobble);
        }
      } else {
        if (!w.pouringFinished) {
          w.pouringFinished = true;
          // Final settling ring pulse
          injectSplash(w.faceId, 0.45, 3.2);
          if (stream) {
            root.remove(stream);
            stream.material.dispose();
            pourStreams.delete(w.faceId);
          }
        }

        // Long-lived gentle ambient ripples so pools stay shimmeringly alive
        w.ambientTimer -= clampedDt;
        if (w.ambientTimer <= 0) {
          w.ambientTimer = 1.8 + Math.random() * 2.8;
          injectSplash(w.faceId, (Math.random() - 0.5) * 0.12, 2.2);
        }
      }
    }

    // Update splash droplets
    for (let i = droplets.length - 1; i >= 0; i--) {
      const d = droplets[i];
      d.life += clampedDt;
      d.vy -= 26.0 * clampedDt;
      d.mesh.position.x += d.vx * clampedDt;
      d.mesh.position.y += d.vy * clampedDt;
      d.mesh.position.z += d.vz * clampedDt;
      if (d.mesh.position.y <= d.floorY || d.life > 1.0) {
        root.remove(d.mesh);
        d.mesh.material.dispose();
        droplets.splice(i, 1);
      }
    }

    // Step 2D wave simulation at steady 60Hz rate (2 substeps per step)
    if (activeWells.size > 0) {
      physicsAccum += clampedDt;
      const stepDt = 1 / 60;
      let steps = 0;
      while (physicsAccum >= stepDt && steps < 3) {
        stepWavePhysics();
        stepWavePhysics();
        physicsAccum -= stepDt;
        steps++;
      }
    }
  }

  return {
    root,
    claimFaces,
    rebuildFromFaceOwners,
    clearAll,
    hasActivePour,
    update,
  };
}
