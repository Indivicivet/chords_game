/**
 * Exact 2D geometric replication of chords_base.scad and planar graph construction
 * for the 8-vertex complete graph K_8 inside a circle of radius BOARD_R = 50.
 */

export const SCAD = {
  BOARD_R: 50,
  CIRC_EXTEND_RATIO: 0.0,
  BASE_EXTEND_RATIO: 0.001,
  GAP_W: 1.65,
  EDGE_W: 1.3,
  MINK_R: 0.8,
  BASE_H: 3.0,
  MID_RAISE: 1.5,
  EDGE_RAISE: 3.5,
};

const EPS = 1e-6;

export function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) * 0.5;
}

export function polygonCentroid(pts) {
  let cx = 0;
  let cy = 0;
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
    area2 += cross;
  }
  if (Math.abs(area2) < 1e-9) {
    const n = pts.length || 1;
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / n,
      y: pts.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  return { x: cx / (3 * area2), y: cy / (3 * area2) };
}

export function pointInConvexPolygon(pt, poly, margin = 0) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < EPS) continue;
    // Inward normal for CCW polygon is (-ey/len, ex/len)
    const dist = ((pt.x - a.x) * -ey + (pt.y - a.y) * ex) / len;
    if (dist < margin) return false;
  }
  return true;
}

/**
 * Clips a CCW convex polygon by half-plane: nx * x + ny * y >= d.
 */
function clipPolygonHalfPlane(poly, nx, ny, d) {
  if (poly.length === 0) return [];
  const out = [];
  const evalHP = (p) => nx * p.x + ny * p.y - d;

  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const dc = evalHP(cur);
    const dn = evalHP(nxt);
    const inC = dc >= -1e-9;
    const inN = dn >= -1e-9;

    if (inC && inN) {
      out.push(nxt);
    } else if (inC && !inN) {
      const t = dc / (dc - dn);
      out.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
    } else if (!inC && inN) {
      const t = dc / (dc - dn);
      out.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
      out.push(nxt);
    }
  }

  // Deduplicate tiny edges
  const cleaned = [];
  for (const p of out) {
    if (cleaned.length === 0 || dist2D(cleaned[cleaned.length - 1], p) > 1e-6) {
      cleaned.push(p);
    }
  }
  if (cleaned.length > 1 && dist2D(cleaned[0], cleaned[cleaned.length - 1]) < 1e-6) {
    cleaned.pop();
  }
  return cleaned.length >= 3 ? cleaned : [];
}

function cleanPolygon(pts, minDist = 0.025) {
  if (pts.length < 3) return [];
  const dedup = [];
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (dedup.length === 0 || dist2D(dedup[dedup.length - 1], p) > minDist) {
      dedup.push(p);
    }
  }
  while (dedup.length > 1 && dist2D(dedup[0], dedup[dedup.length - 1]) <= minDist) {
    dedup.pop();
  }
  return dedup.length >= 3 ? dedup : [];
}

/**
 * Insets a CCW convex polygon inward by `insetDist` on every edge,
 * then rounds corners with circular arcs of radius `roundR` (matching OpenSCAD minkowski).
 */
export function insetAndRoundConvexPolygon(poly, insetDist, roundR, arcSegs = 5) {
  const totalShrink = insetDist + roundR;
  let core = poly.map((p) => ({ ...p }));

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < EPS) continue;
    const nx = -dy / len;
    const ny = dx / len;
    const d = nx * a.x + ny * a.y + totalShrink;
    core = clipPolygonHalfPlane(core, nx, ny, d);
    if (core.length < 3) return [];
  }

  core = cleanPolygon(core, 0.02);
  if (core.length < 3) return [];
  if (roundR <= 1e-5) return core;

  // Offset core outward by roundR and insert circular arcs at vertices
  const result = [];
  const n = core.length;
  for (let i = 0; i < n; i++) {
    const prev = core[(i - 1 + n) % n];
    const cur = core[i];
    const nxt = core[(i + 1) % n];

    const e1x = cur.x - prev.x;
    const e1y = cur.y - prev.y;
    const l1 = Math.hypot(e1x, e1y);
    if (l1 < 1e-5) continue;
    const n1x = e1y / l1; // outward normal for CCW
    const n1y = -e1x / l1;

    const e2x = nxt.x - cur.x;
    const e2y = nxt.y - cur.y;
    const l2 = Math.hypot(e2x, e2y);
    if (l2 < 1e-5) continue;
    const n2x = e2y / l2;
    const n2y = -e2x / l2;

    const a1 = Math.atan2(n1y, n1x);
    let a2 = Math.atan2(n2y, n2x);
    while (a2 < a1) a2 += Math.PI * 2;
    if (a2 - a1 > Math.PI * 1.99) a2 -= Math.PI * 2;

    for (let s = 0; s <= arcSegs; s++) {
      const t = s / arcSegs;
      const ang = a1 + (a2 - a1) * t;
      result.push({
        x: cur.x + Math.cos(ang) * roundR,
        y: cur.y + Math.sin(ang) * roundR,
      });
    }
  }
  return cleanPolygon(result, 0.025);
}

/**
 * Generates one of the 8 outer solid border crescents matching top_plate().
 * Bounded by circle r = BOARD_R - MINK_R and the octagon edge chord inset by GAP_W/2 + MINK_R,
 * then expanded outward by MINK_R.
 */
function buildOuterBorderCrescent(edgeIndex) {
  const R = SCAD.BOARD_R;
  const mink = SCAD.MINK_R;
  const halfGap = SCAD.GAP_W * 0.5;
  const baseAngle = edgeIndex * (Math.PI / 4) + Math.PI / 8; // perpendicular bisecting angle
  const nx = Math.cos(baseAngle);
  const ny = Math.sin(baseAngle);
  const tx = -ny;
  const ty = nx;

  // Inner straight boundary of core (after subtracting GAP_W/2 + MINK_R from chord at d = R * cos(22.5))
  const dCore = R * Math.cos(Math.PI / 8) + halfGap + mink;
  const rCore = R - mink;
  if (dCore >= rCore) return [];

  const halfSpan = Math.sqrt(rCore * rCore - dCore * dCore);
  // Sample core shape: straight base + circular arc, then round corners / expand by mink
  const core = [];
  const arcSteps = 18;
  const angSpan = Math.atan2(halfSpan, dCore);
  for (let s = 0; s <= arcSteps; s++) {
    const a = baseAngle - angSpan + (2 * angSpan * s) / arcSteps;
    core.push({ x: Math.cos(a) * rCore, y: Math.sin(a) * rCore });
  }

  // Exact Minkowski sum with disk of radius mink on this convex lens:
  // Straight edge moves inward (toward center) by mink -> d = dCore - mink = R*cos(22.5) + halfGap.
  // Circular arc expands outward from rCore to rCore + mink = BOARD_R.
  // Corners at the two endpoints are rounded with radius mink!
  const c1 = { x: nx * dCore - tx * halfSpan, y: ny * dCore - ty * halfSpan };
  const c2 = { x: nx * dCore + tx * halfSpan, y: ny * dCore + ty * halfSpan };

  const poly = [];
  // Corner 1 arc: from straight-edge normal (-nx, -ny) to radial normal at c1
  const aStraight = Math.atan2(-ny, -nx);
  const aRad1 = Math.atan2(c1.y, c1.x);
  let startA = aStraight;
  let endA = aRad1;
  while (endA < startA) endA += Math.PI * 2;
  if (endA - startA > Math.PI) endA -= Math.PI * 2;
  for (let s = 0; s <= 5; s++) {
    const a = startA + ((endA - startA) * s) / 5;
    poly.push({ x: c1.x + Math.cos(a) * mink, y: c1.y + Math.sin(a) * mink });
  }

  // Outer circle arc at r = BOARD_R
  const aRad2 = Math.atan2(c2.y, c2.x);
  let arcStart = aRad1;
  let arcEnd = aRad2;
  while (arcEnd < arcStart) arcEnd += Math.PI * 2;
  for (let s = 1; s < arcSteps; s++) {
    const a = arcStart + ((arcEnd - arcStart) * s) / arcSteps;
    poly.push({ x: Math.cos(a) * R, y: Math.sin(a) * R });
  }

  // Corner 2 arc: from radial normal at c2 to straight-edge normal (-nx, -ny)
  let s2 = aRad2;
  let e2 = aStraight;
  while (e2 < s2) e2 += Math.PI * 2;
  if (e2 - s2 > Math.PI) e2 -= Math.PI * 2;
  for (let s = 0; s <= 5; s++) {
    const a = s2 + ((e2 - s2) * s) / 5;
    poly.push({ x: c2.x + Math.cos(a) * mink, y: c2.y + Math.sin(a) * mink });
  }

  return cleanPolygon(poly, 0.025);
}

/**
 * Line-line intersection for two chords.
 */
function intersectLines(nx1, ny1, d1, nx2, ny2, d2) {
  const det = nx1 * ny2 - ny1 * nx2;
  if (Math.abs(det) < 1e-8) return null;
  return {
    x: (d1 * ny2 - ny1 * d2) / det,
    y: (nx1 * d2 - d1 * nx2) / det,
  };
}

/**
 * Builds the complete board geometry, 28 chords, and exact planar face graph.
 */
export function buildBoardData() {
  const R = SCAD.BOARD_R;

  // 8 vertices on circle at 0, 45, 90, ... degrees (start at top = 90° for symmetric presentation)
  const vertices = [];
  for (let i = 0; i < 8; i++) {
    const angle = Math.PI / 2 - i * (Math.PI / 4); // clockwise from top: 0=N, 1=NE, 2=E, ...
    vertices.push({
      id: i,
      angle,
      x: Math.cos(angle) * R,
      y: Math.sin(angle) * R,
    });
  }

  // 28 chords for all pairs (i < j)
  const chords = [];
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const a = vertices[i];
      const b = vertices[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len;
      const ny = dx / len;
      const d = nx * a.x + ny * a.y;
      const stepDiff = Math.min(j - i, 8 - (j - i));
      chords.push({
        id: chords.length,
        vA: i,
        vB: j,
        pA: { x: a.x, y: a.y },
        pB: { x: b.x, y: b.y },
        nx,
        ny,
        d,
        length: len,
        isPerimeter: stepDiff === 1,
        intersections: [], // filled below: { otherChordId, x, y, t }
      });
    }
  }

  // Compute strict interior intersections between pairs of chords
  for (let i = 0; i < chords.length; i++) {
    for (let j = i + 1; j < chords.length; j++) {
      const c1 = chords[i];
      const c2 = chords[j];
      if (c1.vA === c2.vA || c1.vA === c2.vB || c1.vB === c2.vA || c1.vB === c2.vB) {
        continue;
      }
      const pt = intersectLines(c1.nx, c1.ny, c1.d, c2.nx, c2.ny, c2.d);
      if (!pt) continue;
      // Check strictly inside segment of both chords
      const t1 = ((pt.x - c1.pA.x) * (c1.pB.x - c1.pA.x) + (pt.y - c1.pA.y) * (c1.pB.y - c1.pA.y)) / (c1.length * c1.length);
      const t2 = ((pt.x - c2.pA.x) * (c2.pB.x - c2.pA.x) + (pt.y - c2.pA.y) * (c2.pB.y - c2.pA.y)) / (c2.length * c2.length);
      if (t1 > 1e-4 && t1 < 1 - 1e-4 && t2 > 1e-4 && t2 < 1 - 1e-4) {
        c1.intersections.push({ otherChordId: c2.id, x: pt.x, y: pt.y, t: t1 });
        c2.intersections.push({ otherChordId: c1.id, x: pt.x, y: pt.y, t: t2 });
      }
    }
  }

  // Start with the regular octagon (CCW!)
  let rawFaces = [
    Array.from({ length: 8 }, (_, k) => {
      const idx = (8 - k) % 8; // CCW order
      return { x: vertices[idx].x, y: vertices[idx].y };
    }),
  ];

  // Iteratively split convex polygons by all 20 interior chords
  for (const chord of chords) {
    if (chord.isPerimeter) continue;
    const nextFaces = [];
    for (const poly of rawFaces) {
      const pos = clipPolygonHalfPlane(poly, chord.nx, chord.ny, chord.d);
      const neg = clipPolygonHalfPlane(poly, -chord.nx, -chord.ny, -chord.d);
      if (pos.length >= 3 && polygonArea(pos) > 1e-3) nextFaces.push(pos);
      if (neg.length >= 3 && polygonArea(neg) > 1e-3) nextFaces.push(neg);
    }
    rawFaces = nextFaces;
  }

  // Build face objects with exact edge-to-chord mapping and rounded inner/outer polygons
  const faces = rawFaces.map((rawPoly, id) => {
    const outerPoly = insetAndRoundConvexPolygon(rawPoly, SCAD.GAP_W * 0.5, SCAD.MINK_R, 5);
    const innerPoly = insetAndRoundConvexPolygon(
      rawPoly,
      (SCAD.GAP_W + SCAD.EDGE_W) * 0.5,
      SCAD.MINK_R,
      5
    );
    const centroid = polygonCentroid(rawPoly);
    const area = polygonArea(rawPoly);

    // Map each edge of rawPoly to its supporting chord
    const edges = [];
    for (let i = 0; i < rawPoly.length; i++) {
      const a = rawPoly[i];
      const b = rawPoly[(i + 1) % rawPoly.length];
      const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
      const chordId = findSupportingChord(a, b, chords);
      edges.push({
        a,
        b,
        mid,
        chordId,
        neighborFaceId: null,
      });
    }

    return {
      id,
      rawPoly,
      outerPoly,
      innerPoly,
      centroid,
      area,
      edges,
    };
  });

  // Match shared edges between adjacent faces
  for (let i = 0; i < faces.length; i++) {
    for (const e1 of faces[i].edges) {
      if (e1.neighborFaceId !== null) continue;
      for (let j = i + 1; j < faces.length; j++) {
        let matched = false;
        for (const e2 of faces[j].edges) {
          if (e2.chordId !== e1.chordId) continue;
          if (dist2D(e1.mid, e2.mid) < 1e-3) {
            e1.neighborFaceId = j;
            e2.neighborFaceId = i;
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }
  }

  // 8 outer solid border crescents
  const borderCrescents = [];
  for (let i = 0; i < 8; i++) {
    const poly = buildOuterBorderCrescent(i);
    if (poly.length >= 3) borderCrescents.push(poly);
  }

  return {
    vertices,
    chords,
    faces,
    borderCrescents,
  };
}

function findSupportingChord(a, b, chords) {
  let bestId = -1;
  let bestErr = Infinity;
  for (const c of chords) {
    const ea = Math.abs(c.nx * a.x + c.ny * a.y - c.d);
    const eb = Math.abs(c.nx * b.x + c.ny * b.y - c.d);
    const err = ea + eb;
    if (err < bestErr) {
      bestErr = err;
      bestId = c.id;
    }
  }
  return bestId;
}
