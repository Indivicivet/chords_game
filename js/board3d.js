import * as THREE from "three";
import { SCAD } from "./geometry.js";
import { createStoneTextures } from "./textures.js";

export function toWorldXZ(p) {
  return { x: p.x, z: -p.y };
}

function makeShapeFromPoly(pts) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i].x, pts[i].y);
  }
  shape.closePath();
  return shape;
}

function makePathReversed(pts) {
  const path = new THREE.Path();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = pts.length - 1; i >= 1; i--) {
    path.lineTo(pts[i].x, pts[i].y);
  }
  path.closePath();
  return path;
}

function hasFinitePositions(geo) {
  const arr = geo.attributes.position.array;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

function buildFlatPrismFallback(shape, depth) {
  const extracted = shape.extractPoints(1);
  const contour = extracted.shape;
  const holes = extracted.holes;
  if (contour.length > 1 && contour[0].distanceTo(contour[contour.length - 1]) < 1e-6) {
    contour.pop();
  }
  for (const h of holes) {
    if (h.length > 1 && h[0].distanceTo(h[h.length - 1]) < 1e-6) h.pop();
  }

  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const allPts = contour.concat(...holes);
  const positions = [];
  const uvs = [];

  const pushTri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    uvs.push(0, 0, 1, 0, 0, 1);
  };

  // Top & bottom caps
  for (const [i0, i1, i2] of tris) {
    const a = allPts[i0], b = allPts[i1], c = allPts[i2];
    pushTri(a.x, a.y, depth, b.x, b.y, depth, c.x, c.y, depth);
    pushTri(a.x, a.y, 0, c.x, c.y, 0, b.x, b.y, 0);
  }

  // Side walls for outer contour and holes
  const addRingWalls = (ring) => {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      pushTri(p.x, p.y, 0, q.x, q.y, 0, q.x, q.y, depth);
      pushTri(p.x, p.y, 0, q.x, q.y, depth, p.x, p.y, depth);
    }
  };
  addRingWalls(contour);
  for (const h of holes) addRingWalls(h);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

function buildExtrudedStone(shape, opts) {
  const geo = new THREE.ExtrudeGeometry(shape, opts);
  if (hasFinitePositions(geo)) return geo;
  geo.dispose();
  const fallback = new THREE.ExtrudeGeometry(shape, { ...opts, bevelEnabled: false });
  if (hasFinitePositions(fallback)) return fallback;
  fallback.dispose();
  return buildFlatPrismFallback(shape, opts.depth || 1);
}

/**
 * Normalizes ExtrudeGeometry UVs into consistent world-scale coordinates so stone grain
 * never stretches across top caps vs vertical side walls.
 */
function normalizeStoneUVs(geometry, scale = 0.04) {
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nz = Math.abs(norm.getZ(i));
    if (nz > 0.5) {
      uv.setXY(i, (x + 50) * scale, (y + 50) * scale);
    } else {
      const nx = Math.abs(norm.getX(i));
      const horiz = nx > 0.5 ? y : x;
      uv.setXY(i, (horiz + 50) * scale, z * scale * 1.4);
    }
  }
  uv.needsUpdate = true;
}

export function createBoard3D(board) {
  const root = new THREE.Group();
  const textures = createStoneTextures();

  const stoneMat = new THREE.MeshStandardMaterial({
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughnessMap: textures.roughnessMap,
    roughness: 0.78,
    metalness: 0.04,
    color: 0xf7f2e8,
  });

  // Slightly darker stone inside deep groove channels for natural ambient occlusion feel
  const grooveStoneMat = new THREE.MeshStandardMaterial({
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: textures.roughnessMap,
    roughness: 0.9,
    metalness: 0.03,
    color: 0xc2b7a4,
  });

  // Crisp stepped stone plinth framing the circular board
  const plinthGeo = new THREE.CylinderGeometry(52.4, 54.0, 2.8, 100);
  const plinthMat = new THREE.MeshStandardMaterial({
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.85,
    metalness: 0.04,
    color: 0x9b9282,
  });
  const plinth = new THREE.Mesh(plinthGeo, plinthMat);
  plinth.position.y = -1.4;
  plinth.receiveShadow = true;
  root.add(plinth);

  // Base disc matching SCAD: r = BOARD_R * (1 + BASE_EXTEND_RATIO) = 50.05, height = BASE_H = 3
  const baseRadius = SCAD.BOARD_R * (1 + SCAD.CIRC_EXTEND_RATIO + SCAD.BASE_EXTEND_RATIO);
  const baseGeo = new THREE.CylinderGeometry(baseRadius, baseRadius + 0.35, SCAD.BASE_H, 100);
  const baseMesh = new THREE.Mesh(baseGeo, grooveStoneMat);
  baseMesh.position.y = SCAD.BASE_H * 0.5;
  baseMesh.castShadow = true;
  baseMesh.receiveShadow = true;
  root.add(baseMesh);

  // Subtle carved chamfer ring around outer edge of base
  const rimBevelGeo = new THREE.TorusGeometry(baseRadius - 0.12, 0.16, 8, 100);
  const rimBevel = new THREE.Mesh(rimBevelGeo, stoneMat);
  rimBevel.rotation.x = Math.PI / 2;
  rimBevel.position.y = SCAD.BASE_H;
  rimBevel.receiveShadow = true;
  root.add(rimBevel);

  // Plate group transformed from 2D SCAD (x, y, z_up) to Three.js (x, y_up, -z)
  const plateGroup = new THREE.Group();
  plateGroup.rotation.x = -Math.PI / 2;
  plateGroup.position.y = SCAD.BASE_H - 0.001;
  root.add(plateGroup);

  // 8 outer solid border crescents
  for (const crescent of board.borderCrescents) {
    const shape = makeShapeFromPoly(crescent);
    const geo = buildExtrudedStone(shape, {
      depth: SCAD.EDGE_RAISE,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.08,
      bevelThickness: 0.1,
    });
    normalizeStoneUVs(geo);
    const mesh = new THREE.Mesh(geo, stoneMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    plateGroup.add(mesh);
  }

  // 80 interior walled wells + subtle hover highlight bottoms
  const wellHighlightMeshes = [];
  const wellHighlightMats = [];

  for (const face of board.faces) {
    // 1. Sunken well floor (depth = MID_RAISE = 1.5)
    const floorShape = makeShapeFromPoly(face.outerPoly);
    const floorGeo = buildExtrudedStone(floorShape, {
      depth: SCAD.MID_RAISE,
      bevelEnabled: false,
    });
    normalizeStoneUVs(floorGeo);
    const floorMesh = new THREE.Mesh(floorGeo, stoneMat);
    floorMesh.castShadow = false;
    floorMesh.receiveShadow = true;
    plateGroup.add(floorMesh);

    // 2. Raised rim wall around the well (depth = EDGE_RAISE = 3.5)
    const wallShape = makeShapeFromPoly(face.outerPoly);
    wallShape.holes.push(makePathReversed(face.innerPoly));
    const wallGeo = buildExtrudedStone(wallShape, {
      depth: SCAD.EDGE_RAISE,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.075,
      bevelThickness: 0.09,
    });
    normalizeStoneUVs(wallGeo);
    const wallMesh = new THREE.Mesh(wallGeo, stoneMat);
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    plateGroup.add(wallMesh);

    // 3. Subtle claim-preview highlight mesh resting on bottom of well
    const hlShape = makeShapeFromPoly(face.innerPoly);
    const hlGeo = new THREE.ShapeGeometry(hlShape);
    const hlMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });
    const hlMesh = new THREE.Mesh(hlGeo, hlMat);
    hlMesh.position.z = SCAD.MID_RAISE + 0.03;
    plateGroup.add(hlMesh);
    wellHighlightMeshes.push(hlMesh);
    wellHighlightMats.push(hlMat);
  }

  // 8 Vertex Anchor Pegs + Interactive Hit Targets
  const pegMeshes = [];
  const pegHitTargets = [];
  const pegBaseGeo = new THREE.CylinderGeometry(1.15, 1.4, 2.2, 20);
  const pegShaftGeo = new THREE.CylinderGeometry(0.58, 0.72, 2.2, 20);
  const pegCapGeo = new THREE.SphereGeometry(0.68, 16, 12);
  const pegRingGeo = new THREE.TorusGeometry(0.95, 0.14, 10, 24);
  const pegHitGeo = new THREE.SphereGeometry(3.2, 12, 10);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });

  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xc9a35e,
    roughness: 0.34,
    metalness: 0.78,
  });

  const pegBaseMat = new THREE.MeshStandardMaterial({
    map: textures.map,
    normalMap: textures.normalMap,
    roughness: 0.72,
    metalness: 0.08,
    color: 0xb7aa95,
  });

  for (const v of board.vertices) {
    // Sit neatly right at the hub convergence inside radius 50
    const rPeg = SCAD.BOARD_R - 1.35;
    const px = Math.cos(v.angle) * rPeg;
    const pz = -Math.sin(v.angle) * rPeg;

    const pegGroup = new THREE.Group();
    pegGroup.position.set(px, SCAD.BASE_H, pz);

    const collar = new THREE.Mesh(pegBaseGeo, pegBaseMat);
    collar.position.y = 1.1;
    collar.castShadow = true;
    collar.receiveShadow = true;
    pegGroup.add(collar);

    const shaft = new THREE.Mesh(pegShaftGeo, brassMat.clone());
    shaft.position.y = 2.65;
    shaft.castShadow = true;
    pegGroup.add(shaft);

    const cap = new THREE.Mesh(pegCapGeo, shaft.material);
    cap.position.y = 3.75;
    cap.castShadow = true;
    pegGroup.add(cap);

    const selRing = new THREE.Mesh(
      pegRingGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
    );
    selRing.rotation.x = Math.PI / 2;
    selRing.position.y = 3.85;
    pegGroup.add(selRing);

    const hitMesh = new THREE.Mesh(pegHitGeo, hitMat);
    hitMesh.position.y = 2.6;
    hitMesh.userData = { vertexId: v.id };
    pegGroup.add(hitMesh);

    root.add(pegGroup);
    pegMeshes.push({ group: pegGroup, shaft, cap, selRing, worldPos: new THREE.Vector3(px, SCAD.BASE_H + 2.6, pz) });
    pegHitTargets.push(hitMesh);
  }

  // Invisible chord hit colliders for direct hover/click on chord grooves
  const chordHitTargets = [];
  for (const c of board.chords) {
    const a = toWorldXZ(c.pA);
    const b = toWorldXZ(c.pB);
    const midX = (a.x + b.x) * 0.5;
    const midZ = (a.z + b.z) * 0.5;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);

    const colliderGeo = new THREE.BoxGeometry(2.35, 3.0, Math.max(4, len - 5.0));
    const collider = new THREE.Mesh(colliderGeo, hitMat);
    collider.position.set(midX, SCAD.BASE_H + 1.8, midZ);
    collider.rotation.y = yaw;
    collider.userData = { chordId: c.id };
    root.add(collider);
    chordHitTargets.push(collider);
  }

  function setPegHighlight(vertexId, stateMode, colorHex) {
    const peg = pegMeshes[vertexId];
    if (!peg) return;
    if (stateMode === "selected") {
      peg.selRing.material.color.set(colorHex);
      peg.selRing.material.opacity = 0.95;
      peg.shaft.material.emissive.set(colorHex);
      peg.shaft.material.emissiveIntensity = 0.45;
      peg.group.scale.setScalar(1.08);
    } else if (stateMode === "hover") {
      peg.selRing.material.color.set(colorHex);
      peg.selRing.material.opacity = 0.55;
      peg.shaft.material.emissive.set(colorHex);
      peg.shaft.material.emissiveIntensity = 0.22;
      peg.group.scale.setScalar(1.04);
    } else {
      peg.selRing.material.opacity = 0;
      peg.shaft.material.emissive.setHex(0x000000);
      peg.shaft.material.emissiveIntensity = 0;
      peg.group.scale.setScalar(1.0);
    }
  }

  function setWellHighlights(faceIds, colorHex) {
    const idSet = new Set(faceIds);
    for (let i = 0; i < wellHighlightMats.length; i++) {
      if (idSet.has(i)) {
        wellHighlightMats[i].color.set(colorHex);
        wellHighlightMats[i].opacity = 0.28;
      } else {
        wellHighlightMats[i].opacity = 0.0;
      }
    }
  }

  return {
    root,
    pegHitTargets,
    chordHitTargets,
    pegMeshes,
    setPegHighlight,
    setWellHighlights,
  };
}
