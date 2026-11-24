import { getChordValidity, getLegalChords, simulateClaim } from "./game.js";

/**
 * Selects a chordId for an AI-controlled player.
 * mode: 'ai-tactical' | 'ai-casual'
 */
export function chooseAIMove(state, player) {
  const legal = getLegalChords(state, player.slot);
  if (legal.length === 0) return null;

  if (player.type === "ai-casual") {
    return chooseCasualMove(state, player.slot, legal);
  }
  return chooseTacticalMove(state, player.slot, legal);
}

function chooseCasualMove(state, playerSlot, legal) {
  const claims = [];
  for (const cId of legal) {
    const gained = simulateClaim(
      state.board,
      state.chordOwners,
      state.faceOwners,
      cId,
      playerSlot
    );
    if (gained.length > 0) {
      claims.push({ cId, count: gained.length });
    }
  }
  if (claims.length > 0 && Math.random() < 0.85) {
    claims.sort((a, b) => b.count - a.count);
    return claims[0].cId;
  }
  return legal[Math.floor(Math.random() * legal.length)];
}

function chooseTacticalMove(state, playerSlot, legal) {
  const board = state.board;
  const opponents = state.players.filter((p) => p.slot !== playerSlot);

  let bestScore = -Infinity;
  let bestMoves = [];

  for (const cId of legal) {
    const gained = simulateClaim(
      board,
      state.chordOwners,
      state.faceOwners,
      cId,
      playerSlot
    );
    const gainedArea = gained.reduce((s, fId) => s + board.faces[fId].area, 0);

    let score = gained.length * 16 + gainedArea * 0.06;

    // Simulate post-move board to measure opponent 1-move threats and block value
    const nextChords = state.chordOwners.slice();
    nextChords[cId] = playerSlot;
    const nextFaces = state.faceOwners.slice();
    for (const fId of gained) nextFaces[fId] = playerSlot;

    let maxOppGain = 0;
    for (const opp of opponents) {
      const oppStateMock = {
        board,
        chordOwners: nextChords,
        faceOwners: nextFaces,
        gameOver: false,
      };
      for (let oc = 0; oc < board.chords.length; oc++) {
        if (!getChordValidity(oppStateMock, oc, opp.slot).valid) continue;
        const oppGained = simulateClaim(board, nextChords, nextFaces, oc, opp.slot);
        if (oppGained.length > maxOppGain) {
          maxOppGain = oppGained.length;
        }
      }
    }

    score -= maxOppGain * 9.5;

    // Bonus for building triangles/polygons with our own existing strings
    const chord = board.chords[cId];
    let sharedVertexOwnStrings = 0;
    for (let other = 0; other < board.chords.length; other++) {
      if (state.chordOwners[other] !== playerSlot) continue;
      const oc = board.chords[other];
      if (
        oc.vA === chord.vA ||
        oc.vA === chord.vB ||
        oc.vB === chord.vA ||
        oc.vB === chord.vB
      ) {
        sharedVertexOwnStrings++;
      }
    }
    score += sharedVertexOwnStrings * 1.1;

    // Slight preference for longer interior chords early (more potential intersections/blocks)
    if (!chord.isPerimeter) {
      score += chord.intersections.length * 0.18;
    }

    // Small random tie-breaker so games vary naturally
    score += Math.random() * 0.25;

    if (score > bestScore + 1e-6) {
      bestScore = score;
      bestMoves = [cId];
    } else if (Math.abs(score - bestScore) <= 1e-6) {
      bestMoves.push(cId);
    }
  }

  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}
