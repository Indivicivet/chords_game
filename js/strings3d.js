import * as THREE from "three";
import { SCAD } from "./geometry.js";
import { toWorldXZ } from "./board3d.js";
import { createStringTextures } from "./textures.js";

const STRING_RADIUS = 0.54;
const GROOVE_Y = SCAD.BASE_H + 1.82; // 4.82 inside the 3.0..6.5 channel
const PEG_ANCHOR_Y = SCAD.BASE_H + 2.45; // 5.45 wrapped on peg shaft
const ARCH_HALF_WIDTH = 3.6;
const PEG_BLEND_LEN = 5.2;

export function createStrings3D(board) {
  const root = new THREE.Group();
  const textures = createStringTextures();

  // Map chordId -> { group, yAtT(t), placedAt, animT }
  const placedMap = new Map();
  const activeAnims = [];

  // Reusable ghost preview mesh
  const previewGroup = new THREE.Group();
  previewGroup.visible = false;
  root.add(previewGroup);

  let previewMesh = null;
  let lastPreviewKey = "";

  function makeStringMaterial(colorHex, isGhost = false, isValid = true) {
    if (isGhost) {
      return new THREE.MeshStandardMaterial({
        color: isValid ? colorHex : 0xff3b3b,
        emissive: isValid ? colorHex : 0xaa1111,
        emissiveIntensity: isValid ? 0.35 : 0.45,
        roughness: 0.5,
        transparent: true,
        opacity: isValid ? 0.62 : 0.45,
        depthWrite: false,
      });
    }
    return new THREE.MeshStandardMaterial({
      color: colorHex,
      map: textures.map,
      normalMap: textures.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughness: 0.64,
      metalness: 0.04,
    });
  }

  function computeHeightProfile(chord) {
    // Check all already-placed chords that intersect this chord
    const bumps = [];
    for (const inter of chord.intersections) {
      const other = placedMap.get(inter.otherChordId);
      if (!other) continue;
      // Find t on `other` chord
      const otherChord = board.chords[inter.otherChordId];
      const otherInter = otherChord.intersections.find((x) => x.otherChordId === chord.id);
      const otherY = otherInter ? other.evalY(otherInter.t) : GROOVE_Y;
      const targetY = otherY + STRING_RADIUS * 1.92;
      bumps.push({
        s: inter.t * chord.length,
        extra: Math.max(0, targetY - GROOVE_Y),
      });
    }

    // Keep string centered along the exact chord line (radius BOARD_R) across all stone grooves,
    // blending onto the inward-set anchor pegs only inside the open hub clearing near each vertex.
    const cA = toWorldXZ(chord.pA);
    const cB = toWorldXZ(chord.pB);
    const rPeg = SCAD.BOARD_R - 1.35;
    const wA = toWorldXZ({
      x: Math.cos(board.vertices[chord.vA].angle) * rPeg,
      y: Math.sin(board.vertices[chord.vA].angle) * rPeg,
    });
    const wB = toWorldXZ({
      x: Math.cos(board.vertices[chord.vB].angle) * rPeg,
      y: Math.sin(board.vertices[chord.vB].angle) * rPeg,
    });
    const spanLen = chord.length;

    function evalY(t) {
      const s = t * spanLen;
      const endDist = Math.min(s, spanLen - s);
      const pegBlend =
        endDist < PEG_BLEND_LEN ? 0.5 * (1 + Math.cos((Math.PI * endDist) / PEG_BLEND_LEN)) : 0;
      const y = GROOVE_Y + pegBlend * (PEG_ANCHOR_Y - GROOVE_Y);

      let maxBump = 0;
      for (const b of bumps) {
        const d = Math.abs(s - b.s);
        if (d < ARCH_HALF_WIDTH) {
          const w = 0.5 * (1 + Math.cos((Math.PI * d) / ARCH_HALF_WIDTH));
          const lift = b.extra * w;
          if (lift > maxBump) maxBump = lift;
        }
      }
      return y + maxBump;
    }

    const sampleCount = Math.max(24, Math.round(spanLen * 0.75));
    const points = [];
    for (let i = 0; i <= sampleCount; i++) {
      const t = i / sampleCount;
      const s = t * spanLen;
      const blendA = s < PEG_BLEND_LEN ? 0.5 * (1 + Math.cos((Math.PI * s) / PEG_BLEND_LEN)) : 0;
      const rem = spanLen - s;
      const blendB = rem < PEG_BLEND_LEN ? 0.5 * (1 + Math.cos((Math.PI * rem) / PEG_BLEND_LEN)) : 0;
      const x = cA.x + (cB.x - cA.x) * t + blendA * (wA.x - cA.x) + blendB * (wB.x - cB.x);
      const z = cA.z + (cB.z - cA.z) * t + blendA * (wA.z - cA.z) + blendB * (wB.z - cB.z);
      points.push(new THREE.Vector3(x, evalY(t), z));
    }

    return {
      curve: new THREE.CatmullRomCurve3(points),
      evalY,
      wA,
      wB,
      spanLen,
    };
  }

  function addString(chordId, colorHex, animate = true) {
    if (placedMap.has(chordId)) return;
    const chord = board.chords[chordId];
    const profile = computeHeightProfile(chord);

    const group = new THREE.Group();
    const mat = makeStringMaterial(colorHex, false, true);

    const segs = Math.max(28, Math.round(profile.spanLen * 0.85));
    const tubeGeo = new THREE.TubeGeometry(profile.curve, segs, STRING_RADIUS, 10, false);
    // Scale UV u along tube length for consistent twist pitch
    const uv = tubeGeo.attributes.uv;
    const uScale = profile.spanLen / 6.0;
    for (let i = 0; i < uv.count; i++) {
      uv.setX(i, uv.getX(i) * uScale);
    }
    uv.needsUpdate = true;

    const tubeMesh = new THREE.Mesh(tubeGeo, mat);
    tubeMesh.castShadow = true;
    tubeMesh.receiveShadow = true;
    group.add(tubeMesh);

    // Small knot/wrap rings around each anchor peg
    const knotGeo = new THREE.TorusGeometry(0.76, 0.24, 8, 18);
    for (const endPos of [profile.wA, profile.wB]) {
      const knot = new THREE.Mesh(knotGeo, mat);
      knot.rotation.x = Math.PI / 2;
      knot.position.set(endPos.x, PEG_ANCHOR_Y + (placedMap.size % 3) * 0.14 - 0.14, endPos.z);
      knot.castShadow = true;
      group.add(knot);
    }

    root.add(group);

    const entry = {
      chordId,
      group,
      evalY: profile.evalY,
      animProgress: animate ? 0 : 1,
    };
    placedMap.set(chordId, entry);

    if (animate) {
      group.scale.set(1, 0.2, 1);
      group.position.y = 2.4;
      activeAnims.push(entry);
    }
  }

  function showPreview(chordId, colorHex, isValid) {
    if (chordId === null || chordId === undefined) {
      previewGroup.visible = false;
      return;
    }
    const key = `${chordId}:${colorHex}:${isValid}:${placedMap.size}`;
    if (key !== lastPreviewKey) {
      lastPreviewKey = key;
      if (previewMesh) {
        previewGroup.remove(previewMesh);
        previewMesh.geometry.dispose();
        previewMesh.material.dispose();
      }
      const chord = board.chords[chordId];
      const profile = computeHeightProfile(chord);
      const geo = new THREE.TubeGeometry(
        profile.curve,
        Math.max(20, Math.round(profile.spanLen * 0.5)),
        STRING_RADIUS * 0.85,
        8,
        false
      );
      const mat = makeStringMaterial(colorHex, true, isValid);
      previewMesh = new THREE.Mesh(geo, mat);
      previewMesh.position.y = 0.22;
      previewGroup.add(previewMesh);
    }
    previewGroup.visible = true;
  }

  function hidePreview() {
    previewGroup.visible = false;
  }

  function rebuildFromOrder(placementOrder, paletteBySlot) {
    clearAll();
    for (const item of placementOrder) {
      const pal = paletteBySlot.get(item.playerSlot);
      if (pal) {
        addString(item.chordId, pal.stringColor, false);
      }
    }
  }

  function clearAll() {
    for (const entry of placedMap.values()) {
      root.remove(entry.group);
      entry.group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }
    placedMap.clear();
    activeAnims.length = 0;
    lastPreviewKey = "";
    hidePreview();
  }

  function update(dt) {
    for (let i = activeAnims.length - 1; i >= 0; i--) {
      const e = activeAnims[i];
      e.animProgress = Math.min(1, e.animProgress + dt / 0.24);
      const t = e.animProgress;
      // Crisp snap down into groove with tiny taut rebound
      const ease = 1 - Math.pow(1 - t, 3);
      const bounce = Math.sin(t * Math.PI * 2) * (1 - t) * 0.28;
      e.group.position.y = (1 - ease) * 2.2 + bounce;
      e.group.scale.y = 0.35 + 0.65 * ease;
      if (t >= 1) {
        e.group.position.y = 0;
        e.group.scale.set(1, 1, 1);
        activeAnims.splice(i, 1);
      }
    }
  }

  return {
    root,
    addString,
    showPreview,
    hidePreview,
    rebuildFromOrder,
    clearAll,
    update,
  };
}
