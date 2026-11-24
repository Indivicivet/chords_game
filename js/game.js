/**
 * Core rules engine for Chords Game.
 */

export const PLAYER_PALETTES = [
  {
    id: 0,
    name: "Purple",
    hex: "#8b3dff",
    uiBg: "rgba(139, 61, 255, 0.22)",
    stringColor: 0x9247ff,
    waterShallow: 0xc296ff,
    waterDeep: 0x7628eb,
  },
  {
    id: 1,
    name: "Yellow",
    hex: "#f5c52b",
    uiBg: "rgba(245, 197, 43, 0.22)",
    stringColor: 0xf4c430,
    waterShallow: 0xfff38a,
    waterDeep: 0xeab618,
  },
  {
    id: 2,
    name: "Sky Blue",
    hex: "#38bdf8",
    uiBg: "rgba(56, 189, 248, 0.22)",
    stringColor: 0x38bdf8,
    waterShallow: 0x9be7ff,
    waterDeep: 0x22a6e8,
  },
  {
    id: 3,
    name: "Coral Red",
    hex: "#e84a5f",
    uiBg: "rgba(232, 74, 95, 0.22)",
    stringColor: 0xe84a5f,
    waterShallow: 0xff9aa7,
    waterDeep: 0xd9364d,
  },
];

export function createGameState(board, seatConfigs) {
  const activePlayers = [];
  for (let i = 0; i < seatConfigs.length; i++) {
    const cfg = seatConfigs[i];
    if (cfg.type !== "none") {
      activePlayers.push({
        slot: i,
        name: PLAYER_PALETTES[i].name,
        type: cfg.type, // 'human' | 'ai-tactical' | 'ai-casual'
        palette: PLAYER_PALETTES[i],
        label: cfg.type === "human" ? PLAYER_PALETTES[i].name : `${PLAYER_PALETTES[i].name} (Bot)`,
      });
    }
  }

  return {
    board,
    players: activePlayers,
    chordOwners: new Array(board.chords.length).fill(null), // slot index or null
    faceOwners: new Array(board.faces.length).fill(null), // slot index or null
    placementOrder: [], // [{ chordId, playerSlot, claimedFaces }]
    currentTurnIdx: 0,
    consecutivePasses: 0,
    gameOver: false,
    autoEndedNoScoringMoves: false,
    lastEventText: "",
    history: [],
  };
}

export function getCurrentPlayer(state) {
  return state.players[state.currentTurnIdx];
}

export function getChordValidity(state, chordId, playerSlot) {
  if (state.gameOver) {
    return { valid: false, reason: "Game is over" };
  }
  if (state.chordOwners[chordId] !== null) {
    return { valid: false, reason: "Chord already has a string" };
  }

  const faces = state.board.faces;
  for (let fId = 0; fId < faces.length; fId++) {
    const owner = state.faceOwners[fId];
    if (owner === null || owner === playerSlot) continue;
    for (const edge of faces[fId].edges) {
      if (edge.chordId !== chordId || edge.neighborFaceId === null) continue;
      if (state.faceOwners[edge.neighborFaceId] === owner) {
        return { valid: false, reason: "Cannot cross an opponent's claimed area" };
      }
    }
  }

  return { valid: true, reason: "" };
}

export function getLegalChords(state, playerSlot) {
  const legal = [];
  for (let cId = 0; cId < state.board.chords.length; cId++) {
    if (getChordValidity(state, cId, playerSlot).valid) {
      legal.push(cId);
    }
  }
  return legal;
}

/**
 * Finds all unclaimed faces currently enclosed by `playerSlot` strings in `nextChords`
 * with no opponent strings or opponent-claimed faces inside.
 */
function findClaimableFaces(board, nextChords, faceOwners, playerSlot) {
  const nFaces = board.faces.length;

  // 1. Flood-fill from outside the octagon across edges lacking playerSlot's string
  const outside = new Uint8Array(nFaces);
  const queue = [];

  for (let fId = 0; fId < nFaces; fId++) {
    const face = board.faces[fId];
    for (const edge of face.edges) {
      if (edge.neighborFaceId === null && nextChords[edge.chordId] !== playerSlot) {
        if (!outside[fId]) {
          outside[fId] = 1;
          queue.push(fId);
        }
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const edge of board.faces[cur].edges) {
      if (edge.neighborFaceId === null) continue;
      if (nextChords[edge.chordId] === playerSlot) continue;
      if (!outside[edge.neighborFaceId]) {
        outside[edge.neighborFaceId] = 1;
        queue.push(edge.neighborFaceId);
      }
    }
  }

  // 2. Group enclosed faces into connected components across non-playerSlot edges
  const visited = new Uint8Array(nFaces);
  const newlyClaimed = [];

  for (let fId = 0; fId < nFaces; fId++) {
    if (outside[fId] || visited[fId]) continue;

    const comp = [];
    const compQueue = [fId];
    visited[fId] = 1;
    let cHead = 0;
    let blockedByOpponent = false;

    while (cHead < compQueue.length) {
      const cur = compQueue[cHead++];
      comp.push(cur);

      const curOwner = faceOwners[cur];
      if (curOwner !== null && curOwner !== playerSlot) {
        blockedByOpponent = true;
      }

      for (const edge of board.faces[cur].edges) {
        if (edge.neighborFaceId === null) continue;
        const cOwner = nextChords[edge.chordId];
        if (cOwner === playerSlot) continue; // player's hull wall

        if (!outside[edge.neighborFaceId]) {
          // Internal edge inside enclosed region
          if (cOwner !== null && cOwner !== playerSlot) {
            blockedByOpponent = true;
          }
          if (!visited[edge.neighborFaceId]) {
            visited[edge.neighborFaceId] = 1;
            compQueue.push(edge.neighborFaceId);
          }
        }
      }
    }

    if (!blockedByOpponent) {
      for (const id of comp) {
        if (faceOwners[id] === null) {
          newlyClaimed.push(id);
        }
      }
    }
  }

  return newlyClaimed;
}

/**
 * Pure simulation of which unclaimed faces become claimed if `playerSlot` places `chordId`.
 */
export function simulateClaim(board, chordOwners, faceOwners, chordId, playerSlot) {
  const nextChords = chordOwners.slice();
  nextChords[chordId] = playerSlot;
  return findClaimableFaces(board, nextChords, faceOwners, playerSlot);
}

/**
 * Returns true if `playerSlot` could still possibly enclose and score at least one
 * unclaimed face using any subset of its currently legal chords.
 */
export function canPlayerScore(state, playerSlot) {
  const maxChords = state.chordOwners.slice();
  let hasLegal = false;
  for (let cId = 0; cId < state.board.chords.length; cId++) {
    if (getChordValidity(state, cId, playerSlot).valid) {
      maxChords[cId] = playerSlot;
      hasLegal = true;
    }
  }
  if (!hasLegal) return false;
  return findClaimableFaces(state.board, maxChords, state.faceOwners, playerSlot).length > 0;
}

export function canAnyPlayerScore(state) {
  return state.players.some((p) => canPlayerScore(state, p.slot));
}

function snapshotState(state) {
  return {
    chordOwners: state.chordOwners.slice(),
    faceOwners: state.faceOwners.slice(),
    placementOrder: state.placementOrder.map((p) => ({
      ...p,
      claimedFaces: p.claimedFaces.slice(),
    })),
    currentTurnIdx: state.currentTurnIdx,
    consecutivePasses: state.consecutivePasses,
    gameOver: state.gameOver,
    autoEndedNoScoringMoves: state.autoEndedNoScoringMoves,
    lastEventText: state.lastEventText,
  };
}

export function applyMove(state, chordId) {
  const player = getCurrentPlayer(state);
  const check = getChordValidity(state, chordId, player.slot);
  if (!check.valid) return null;

  state.history.push(snapshotState(state));

  const claimed = simulateClaim(
    state.board,
    state.chordOwners,
    state.faceOwners,
    chordId,
    player.slot
  );

  state.chordOwners[chordId] = player.slot;
  for (const fId of claimed) {
    state.faceOwners[fId] = player.slot;
  }
  state.placementOrder.push({
    chordId,
    playerSlot: player.slot,
    claimedFaces: claimed,
  });

  state.consecutivePasses = 0;
  state.lastEventText =
    claimed.length > 0
      ? `${player.label} claimed ${claimed.length} section${claimed.length > 1 ? "s" : ""}`
      : `${player.label} placed a string`;

  if (!canAnyPlayerScore(state)) {
    state.gameOver = true;
    state.autoEndedNoScoringMoves = true;
    state.lastEventText = "No scoring moves remain for any player";
    return {
      playerSlot: player.slot,
      chordId,
      claimedFaces: claimed,
      passes: [],
      autoEnded: true,
      gameOver: true,
    };
  }

  const passInfo = advanceTurnAndCheckPasses(state);

  return {
    playerSlot: player.slot,
    chordId,
    claimedFaces: claimed,
    passes: passInfo.passes,
    autoEnded: false,
    gameOver: state.gameOver,
  };
}

function advanceTurnAndCheckPasses(state) {
  const nPlayers = state.players.length;
  const passes = [];

  for (let step = 0; step < nPlayers; step++) {
    state.currentTurnIdx = (state.currentTurnIdx + 1) % nPlayers;
    const nextPlayer = state.players[state.currentTurnIdx];
    const legal = getLegalChords(state, nextPlayer.slot);
    if (legal.length > 0) {
      state.consecutivePasses = 0;
      return { passes };
    }
    passes.push(nextPlayer);
    state.consecutivePasses += 1;
    if (state.consecutivePasses >= nPlayers) {
      state.gameOver = true;
      return { passes };
    }
  }

  state.gameOver = true;
  return { passes };
}

export function undoLastMove(state) {
  if (state.history.length === 0) return false;
  const prev = state.history.pop();
  state.chordOwners = prev.chordOwners;
  state.faceOwners = prev.faceOwners;
  state.placementOrder = prev.placementOrder;
  state.currentTurnIdx = prev.currentTurnIdx;
  state.consecutivePasses = prev.consecutivePasses;
  state.gameOver = prev.gameOver;
  state.autoEndedNoScoringMoves = prev.autoEndedNoScoringMoves;
  state.lastEventText = "Undid last move";
  return true;
}

export function computeScores(state) {
  const counts = new Map();
  const areas = new Map();
  for (const p of state.players) {
    counts.set(p.slot, 0);
    areas.set(p.slot, 0);
  }
  for (let fId = 0; fId < state.faceOwners.length; fId++) {
    const owner = state.faceOwners[fId];
    if (owner !== null && counts.has(owner)) {
      counts.set(owner, counts.get(owner) + 1);
      areas.set(owner, areas.get(owner) + state.board.faces[fId].area);
    }
  }
  return state.players
    .map((p) => ({
      player: p,
      segments: counts.get(p.slot) || 0,
      area: areas.get(p.slot) || 0,
    }))
    .sort((a, b) => b.segments - a.segments || b.area - a.area);
}
