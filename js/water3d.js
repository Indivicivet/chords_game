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

  vec2 decodeSample(vec2 texel) {
    vec2 clamped = clamp(texel, vec2(0.5), vec2(uGridSize - 0.5));
    vec4 s = texture2D(uWaveTex, clamped / uGridSize);
    float v16 = (s.r * 255.0 * 256.0 + s.g * 255.0) / 65535.0;
    return vec2(v16 * 2.0 - 1.0, s.b);
  }

  float sampleHeightBilinear(vec2 worldXZ) {
    vec2 uv = (worldXZ + uBoardSpan * 0.5) / uBoardSpan;
    vec2 f = uv * uGridSize - 0.5;
    vec2 i0 = floor(f);
    vec2 fr = f - i0;

    vec2 s00 = decodeSample(i0 + vec2(0.5, 0.5));
    vec2 s10 = decodeSample(i0 + vec2(1.5, 0.5));
    vec2 s01 = decodeSample(i0 + vec2(0.5, 1.5));
    vec2 s11 = decodeSample(i0 + vec2(1.5, 1.5));

    float w00 = (1.0 - fr.x) * (1.0 - fr.y) * step(0.5, s00.y);
    float w10 = fr.x * (1.0 - fr.y) * step(0.5, s10.y);
    float w01 = (1.0 - fr.x) * fr.y * step(0.5, s01.y);
    float w11 = fr.x * fr.y * step(0.5, s11.y);

    float wSum = w00 + w10 + w01 + w11;
    if (wSum < 1e-4) return 0.0;
    return (s00.x * w00 + s10.x * w10 + s01.x * w01 + s11.x * w11) / wSum;
  }

  vec3 sampleSky(vec3 dir) {
    vec3 d = normalize(dir);
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

    // Smooth living ripples + gentle capillary surface shimmer
    float breeze = sin(vWorldPos.x * 0.65 + uTime * 1.9) * cos(vWorldPos.z * 0.72 - uTime * 1.5);
    float breeze2 = sin((vWorldPos.x - vWorldPos.z) * 0.95 + uTime * 2.3);
    float dBreezeX = (cos(vWorldPos.x * 0.65 + uTime * 1.9) * cos(vWorldPos.z * 0.72 - uTime * 1.5) * 0.65
                    + cos((vWorldPos.x - vWorldPos.z) * 0.95 + uTime * 2.3) * 0.95) * 0.026;
    float dBreezeZ = (-sin(vWorldPos.x * 0.65 + uTime * 1.9) * sin(vWorldPos.z * 0.72 - uTime * 1.5) * 0.72
                    - cos((vWorldPos.x - vWorldPos.z) * 0.95 + uTime * 2.3) * 0.95) * 0.026;

    float waveGain = 4.2;
    float dx = (hR - hL) * waveGain + dBreezeX;
    float dz = (hU - hD) * waveGain + dBreezeZ;
    vec3 N = normalize(vec3(-dx, 1.0, -dz));

    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 R = reflect(-V, N);

    vec3 skyRefl = sampleSky(R);
    // Keep sky reflection clean and mostly bright white/neutral so player water hue stays true to string color
    float skyLum = dot(skyRefl, vec3(0.299, 0.587, 0.114));
    vec3 whiteSkyRefl = mix(vec3(0.75 + skyLum * 0.25), skyRefl, 0.14);

    vec3 bodyColor = mix(uShallowColor, uDeepColor, clamp(uFillProgress * 0.55, 0.0, 1.0));
    bodyColor += uShallowColor * (0.5 + 0.5 * (breeze * 0.6 + breeze2 * 0.4)) * 0.08;

    float fresnel = 0.05 + 0.48 * pow(1.0 - max(dot(N, V), 0.0), 3.6);
    vec3 color = mix(bodyColor, whiteSkyRefl, fresnel);

    // Crisp sun specular sparkles + broad sheen on ripple crests
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);
    float ndoth = max(dot(N, H), 0.0);
    float specTight = pow(ndoth, 180.0) * 2.8;
    float specMid = pow(ndoth, 34.0) * 0.34;
    color += vec3(1.0, 0.99, 0.96) * (specTight + specMid);

    float alpha = mix(0.74, 0.92, clamp(uFillProgress, 0.0, 1.0));
    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const WATERFALL_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const WATERFALL_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uPourT;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  void main() {
    // vUv.x runs 0 (top spout) -> 1 (water impact) along TubeGeometry
    float tAlong = vUv.x;
    float flow = sin(tAlong * 26.0 - uTime * 16.0 + sin(vUv.y * 12.566) * 0.7) * 0.5 + 0.5;
    float streaks = sin(vUv.y * 18.849 + tAlong * 8.0 - uTime * 11.0) * 0.5 + 0.5;

    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);

    float fresnel = 0.2 + 0.75 * pow(1.0 - abs(dot(N, V)), 2.5);
    float spec = pow(max(dot(N, H), 0.0), 80.0) * 1.4;
    float foam = smoothstep(0.55, 0.98, flow * 0.65 + streaks * 0.45) * (0.28 + 0.45 * tAlong);

    vec3 base = mix(uShallowColor, uDeepColor, 0.35);
    vec3 color = mix(base, vec3(0.95, 0.98, 1.0), foam + fresnel * 0.32) + vec3(1.0) * spec;

    // Fade softly at top spout origin and pinch cleanly near end of pour
    float topFade = smoothstep(0.0, 0.26, tAlong);
    float endFade = 1.0 - smoothstep(0.84, 1.0, uPourT);
    float headReveal = smoothstep(0.0, 0.14, uPourT);
    float alpha = topFade * endFade * headReveal * (0.68 + 0.22 * foam);

    gl_FragColor = vec4(color, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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

function buildWaterfallGeometry() {
  // Graceful parabolic arc descending from (2.2, 8.2, 0.8) down to impact (0, 0, 0)
  const pts = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 = top spout, 1 = impact
    const x = 2.1 * Math.pow(1 - t, 1.45);
    const z = 0.7 * Math.pow(1 - t, 1.45);
    const y = 8.4 * (1 - t * t);
    pts.push(new THREE.Vector3(x, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, 20, 0.32, 12, false);

  // Taper radius: slim at top spout, wider/fanned waterfall ribbon toward impact
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const centerTmp = new THREE.Vector3();
  const vTmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, uv.getX(i)));
    curve.getPointAt(t, centerTmp);
    vTmp.fromBufferAttribute(pos, i).sub(centerTmp);
    const taper = 0.42 + 0.85 * t;
    // Slightly flatten cross-section into a cascading ribbon
    vTmp.x *= taper * 1.15;
    vTmp.z *= taper * 0.78;
    vTmp.y *= taper;
    vTmp.add(centerTmp);
    pos.setXYZ(i, vTmp.x, vTmp.y, vTmp.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function createWaterSystem(board, skyEquirectTex, sunDir) {
  const root = new THREE.Group();
  const nFaces = board.faces.length;

  // 1. Pre-bake wellMask (GRID_N x GRID_N) and pixel lists per face
  const wellMask = new Int16Array(GRID_N * GRID_N).fill(-1);
  const wellPixels = Array.from({ length: nFaces }, () => []);

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

  // Precompute 1-pixel 8-connected Neumann ghost ring per face so bilinear + central diff taps never hit cliffs
  const wellGhostCells = Array.from({ length: nFaces }, () => []);
  const seenGhost = new Map();
  for (let fId = 0; fId < nFaces; fId++) {
    seenGhost.clear();
    for (const idx of wellPixels[fId]) {
      const gx = idx % GRID_N;
      const gz = (idx - gx) / GRID_N;
      for (let dz = -1; dz <= 1; dz++) {
        const nz = gz + dz;
        if (nz < 0 || nz >= GRID_N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = gx + dx;
          if (nx < 0 || nx >= GRID_N) continue;
          const nb = nz * GRID_N + nx;
          if (wellMask[nb] === -1) {
            if (!seenGhost.has(nb)) {
              seenGhost.set(nb, []);
            }
            seenGhost.get(nb).push(idx);
          }
        }
      }
    }
    for (const [ghostIdx, interiorNbs] of seenGhost.entries()) {
      wellGhostCells[fId].push({ ghostIdx, interiorNbs });
    }
  }

  const faceCentroidGrid = board.faces.map((f) => {
    const w = toWorldXZ(f.centroid);
    const gx = Math.max(1, Math.min(GRID_N - 2, Math.floor(((w.x + BOARD_SPAN * 0.5) / BOARD_SPAN) * GRID_N)));
    const gz = Math.max(1, Math.min(GRID_N - 2, Math.floor(((w.z + BOARD_SPAN * 0.5) / BOARD_SPAN) * GRID_N)));
    return { gx, gz, idx: gz * GRID_N + gx };
  });

  // 2. Wave height buffers + RGBA8 16-bit encoded DataTexture initialized to neutral 0.0 (32768 -> 128, 0)
  const hCur = new Float32Array(GRID_N * GRID_N);
  const hPrev = new Float32Array(GRID_N * GRID_N);
  const hNext = new Float32Array(GRID_N * GRID_N);
  const texData = new Uint8Array(GRID_N * GRID_N * 4);

  function resetTexNeutral() {
    for (let i = 0; i < GRID_N * GRID_N; i++) {
      const tIdx = i * 4;
      texData[tIdx] = 128;
      texData[tIdx + 1] = 0;
      texData[tIdx + 2] = 0;
      texData[tIdx + 3] = 255;
    }
  }
  resetTexNeutral();

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

  // 3. Per-well water meshes, curved waterfall streams, splash rings, and droplets
  const activeWells = new Map();
  const pourStreams = new Map(); // faceId -> { streamMesh, foamRing }
  const droplets = [];

  const dropletGeo = new THREE.SphereGeometry(0.16, 8, 6);
  const waterfallGeo = buildWaterfallGeometry();
  const foamRingGeo = new THREE.RingGeometry(0.22, 0.62, 24);
  foamRingGeo.rotateX(-Math.PI / 2);

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

  function createPourFX(face, palette) {
    const wPos = toWorldXZ(face.centroid);

    const streamMat = new THREE.ShaderMaterial({
      vertexShader: WATERFALL_VERTEX_SHADER,
      fragmentShader: WATERFALL_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uShallowColor: { value: new THREE.Color(palette.waterShallow) },
        uDeepColor: { value: new THREE.Color(palette.waterDeep) },
        uSunDir: { value: sunDir.clone().normalize() },
        uTime: { value: 0 },
        uPourT: { value: 0 },
      },
    });
    const streamMesh = new THREE.Mesh(waterfallGeo, streamMat);
    // Orient waterfall arc slightly toward the board center for natural visual balance
    const yaw = Math.atan2(-wPos.x, -wPos.z) + 0.35;
    streamMesh.position.set(wPos.x, WELL_FLOOR_Y, wPos.z);
    streamMesh.rotation.y = yaw;
    streamMesh.visible = false;
    root.add(streamMesh);

    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });
    const foamRing = new THREE.Mesh(foamRingGeo, foamMat);
    foamRing.position.set(wPos.x, WELL_FLOOR_Y + 0.06, wPos.z);
    foamRing.visible = false;
    root.add(foamRing);

    return { streamMesh, foamRing };
  }

  function injectSplash(fId, strength, radiusCells = 2.6) {
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
          hCur[idx] = Math.max(-0.85, Math.min(0.85, hCur[idx] + strength * w));
        }
      }
    }
  }

  function spawnDroplet(fId, waterY, palette) {
    const face = board.faces[fId];
    const center = toWorldXZ(face.centroid);
    const ang = Math.random() * Math.PI * 2;
    const speedR = 0.9 + Math.random() * 1.8;
    const mat = new THREE.MeshBasicMaterial({
      color: palette.waterShallow,
      transparent: true,
      opacity: 0.78,
    });
    const mesh = new THREE.Mesh(dropletGeo, mat);
    mesh.position.set(
      center.x + Math.cos(ang) * 0.25,
      waterY + 0.12,
      center.z + Math.sin(ang) * 0.25
    );
    mesh.scale.setScalar(0.55 + Math.random() * 0.55);
    root.add(mesh);
    droplets.push({
      mesh,
      vx: Math.cos(ang) * speedR,
      vy: 2.8 + Math.random() * 2.6,
      vz: Math.sin(ang) * speedR,
      floorY: waterY,
      life: 0,
    });
  }

  function claimFaces(faceIds, palette, animate = true) {
    if (!faceIds || faceIds.length === 0) return;

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
      if (animate) {
        pourStreams.set(fId, createPourFX(face, palette));
      }

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
        ambientTimer: 1.0 + Math.random() * 2.5,
      });

      if (!animate) {
        mesh.visible = true;
        mesh.position.y = WELL_FULL_Y;
        mesh.material.uniforms.uFillProgress.value = 1.0;
        injectSplash(fId, 0.16, 2.8);
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

    for (const fx of pourStreams.values()) {
      root.remove(fx.streamMesh);
      fx.streamMesh.material.dispose();
      root.remove(fx.foamRing);
      fx.foamRing.material.dispose();
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
    resetTexNeutral();
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

  function packTexel(idx, heightVal) {
    const norm = Math.max(0, Math.min(1, heightVal * 0.5 + 0.5));
    const q = Math.round(norm * 65535);
    const tIdx = idx * 4;
    texData[tIdx] = (q >> 8) & 255;
    texData[tIdx + 1] = q & 255;
    texData[tIdx + 2] = 255;
    texData[tIdx + 3] = 255;
  }

  function stepWavePhysics() {
    const c2 = 0.22;
    const scalarDamping = 0.9978;
    // Light viscosity kills jagged 1-cell Nyquist ringing while keeping smooth waves lively
    const viscosity = 0.014;

    for (const w of activeWells.values()) {
      if (!w.pouringStarted) continue;
      const pixels = wellPixels[w.faceId];
      const fId = w.faceId;
      for (let k = 0; k < pixels.length; k++) {
        const idx = pixels[k];
        const hc = hCur[idx];
        const hp = hPrev[idx];
        const vc = hc - hp;

        const iL = idx - 1;
        const iR = idx + 1;
        const iD = idx - GRID_N;
        const iU = idx + GRID_N;

        const hL = wellMask[iL] === fId ? hCur[iL] : hc;
        const hR = wellMask[iR] === fId ? hCur[iR] : hc;
        const hD = wellMask[iD] === fId ? hCur[iD] : hc;
        const hU = wellMask[iU] === fId ? hCur[iU] : hc;

        const vL = wellMask[iL] === fId ? hCur[iL] - hPrev[iL] : vc;
        const vR = wellMask[iR] === fId ? hCur[iR] - hPrev[iR] : vc;
        const vD = wellMask[iD] === fId ? hCur[iD] - hPrev[iD] : vc;
        const vU = wellMask[iU] === fId ? hCur[iU] - hPrev[iU] : vc;

        const lapH = hL + hR + hD + hU - 4.0 * hc;
        const lapV = vL + vR + vD + vU - 4.0 * vc;

        let next = hc + (vc * scalarDamping + c2 * lapH + viscosity * lapV);
        if (next > 0.9) next = 0.9;
        else if (next < -0.9) next = -0.9;
        hNext[idx] = next;
      }
    }

    for (const w of activeWells.values()) {
      if (!w.pouringStarted) continue;
      const pixels = wellPixels[w.faceId];
      for (let k = 0; k < pixels.length; k++) {
        const idx = pixels[k];
        const cur = hNext[idx];
        hPrev[idx] = hCur[idx];
        hCur[idx] = cur;
        packTexel(idx, cur);
      }

      // Mirror boundary heights into 1-pixel Neumann ghost ring so bilinear taps have zero cliff
      const ghosts = wellGhostCells[w.faceId];
      for (let k = 0; k < ghosts.length; k++) {
        const g = ghosts[k];
        let sum = 0;
        for (let j = 0; j < g.interiorNbs.length; j++) {
          sum += hCur[g.interiorNbs[j]];
        }
        packTexel(g.ghostIdx, sum / g.interiorNbs.length);
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
        injectSplash(w.faceId, 0.55, 3.2);
      }

      const elapsed = simTime - w.startAt;
      const rawT = Math.min(1, elapsed / POUR_DURATION);
      const easeFill = 1 - Math.pow(1 - rawT, 1.75);
      w.fillProgress = easeFill;

      const waterY = WELL_FLOOR_Y + 0.05 + easeFill * (WELL_FULL_Y - WELL_FLOOR_Y - 0.05);
      w.mesh.position.y = waterY;
      w.mesh.material.uniforms.uFillProgress.value = easeFill;

      const fx = pourStreams.get(w.faceId);
      if (rawT < 1) {
        // Lively concentric splash waves during pour
        const pulse = Math.sin(simTime * 18.0 + w.faceId) * 0.24 + 0.14;
        injectSplash(w.faceId, pulse * clampedDt * 22.0, 3.0);

        w.dropletTimer += clampedDt;
        if (w.dropletTimer > 0.11) {
          w.dropletTimer = 0;
          spawnDroplet(w.faceId, waterY, w.palette);
        }

        if (fx) {
          fx.streamMesh.visible = true;
          fx.streamMesh.position.y = waterY;
          fx.streamMesh.material.uniforms.uTime.value = simTime;
          fx.streamMesh.material.uniforms.uPourT.value = rawT;

          fx.foamRing.visible = true;
          fx.foamRing.position.y = waterY + 0.03;
          const ringScale = 0.8 + ((simTime * 2.2 + w.faceId * 0.3) % 1.0) * 1.4;
          fx.foamRing.scale.setScalar(ringScale);
          fx.foamRing.material.opacity = (1 - Math.abs(ringScale - 1.5) * 0.65) * 0.48 * (1 - rawT * 0.4);
        }
      } else {
        if (!w.pouringFinished) {
          w.pouringFinished = true;
          injectSplash(w.faceId, 0.45, 3.5);
          if (fx) {
            root.remove(fx.streamMesh);
            fx.streamMesh.material.dispose();
            root.remove(fx.foamRing);
            fx.foamRing.material.dispose();
            pourStreams.delete(w.faceId);
          }
        }

        // Gentle ongoing ripple rings so filled pools visibly shimmer & move
        w.ambientTimer -= clampedDt;
        if (w.ambientTimer <= 0) {
          w.ambientTimer = 1.2 + Math.random() * 1.6;
          injectSplash(w.faceId, (Math.random() > 0.5 ? 1 : -1) * (0.08 + Math.random() * 0.06), 3.0);
        }
      }
    }

    for (let i = droplets.length - 1; i >= 0; i--) {
      const d = droplets[i];
      d.life += clampedDt;
      d.vy -= 24.0 * clampedDt;
      d.mesh.position.x += d.vx * clampedDt;
      d.mesh.position.y += d.vy * clampedDt;
      d.mesh.position.z += d.vz * clampedDt;
      if (d.mesh.position.y <= d.floorY || d.life > 0.9) {
        root.remove(d.mesh);
        d.mesh.material.dispose();
        droplets.splice(i, 1);
      }
    }

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
