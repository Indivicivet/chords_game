import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildBoardData } from "./geometry.js";
import {
  PLAYER_PALETTES,
  applyMove,
  computeScores,
  createGameState,
  getChordValidity,
  getCurrentPlayer,
  simulateClaim,
  undoLastMove,
} from "./game.js";
import { chooseAIMove } from "./ai.js";
import { createSkyEquirectTexture } from "./textures.js";
import { createBoard3D } from "./board3d.js";
import { createStrings3D } from "./strings3d.js";
import { createWaterSystem } from "./water3d.js";
import { createAudio } from "./audio.js";

// --- Scene Setup ---
const container = document.getElementById("canvas-container");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.5, 600);
const DEFAULT_CAM_POS = new THREE.Vector3(0, 82, 86);
const DEFAULT_TARGET = new THREE.Vector3(0, 2.5, -2);
camera.position.copy(DEFAULT_CAM_POS);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(DEFAULT_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minDistance = 42;
controls.maxDistance = 175;
controls.minPolarAngle = 0.04;
controls.maxPolarAngle = Math.PI * 0.46;
controls.update();

// Sunlit blue-sky lighting & skybox
const sunDir = new THREE.Vector3(0.56, 0.72, 0.41).normalize();
const skyTex = createSkyEquirectTexture(sunDir);
scene.background = skyTex;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(skyTex).texture;
scene.environmentIntensity = 0.78;
pmrem.dispose();

const hemiLight = new THREE.HemisphereLight(0xaad8ff, 0x8d7e67, 0.72);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff6e5, 2.35);
sunLight.position.copy(sunDir).multiplyScalar(120);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 20;
sunLight.shadow.camera.far = 260;
sunLight.shadow.camera.left = -64;
sunLight.shadow.camera.right = 64;
sunLight.shadow.camera.top = 64;
sunLight.shadow.camera.bottom = -64;
sunLight.shadow.bias = -0.0004;
scene.add(sunLight);

const rimFill = new THREE.DirectionalLight(0xcbe8ff, 0.42);
rimFill.position.set(-70, 45, -60);
scene.add(rimFill);

// --- Build Board, Strings, Water, Audio ---
const board = buildBoardData();
const board3d = createBoard3D(board);
scene.add(board3d.root);

const strings3d = createStrings3D(board);
scene.add(strings3d.root);

const water3d = createWaterSystem(board, skyTex, sunDir);
scene.add(water3d.root);

const audio = createAudio();

// --- Game & UI State ---
const DEFAULT_SEATS = [
  { type: "human" },
  { type: "ai-tactical" },
  { type: "none" },
  { type: "none" },
];

let seatConfigs = DEFAULT_SEATS.map((s) => ({ ...s }));
let gameState = createGameState(board, seatConfigs);

let selectedVertex = null;
let hoveredVertex = null;
let hoveredChord = null;
let aiDelayTimer = 0;
let camTween = null;

// --- DOM References ---
const turnDot = document.getElementById("turn-dot");
const turnText = document.getElementById("turn-text");
const scoresBar = document.getElementById("scores-bar");
const statusBar = document.getElementById("status-bar");
const btnUndo = document.getElementById("btn-undo");
const btnCamera = document.getElementById("btn-camera");
const btnMute = document.getElementById("btn-mute");
const btnRules = document.getElementById("btn-rules");
const btnNewGame = document.getElementById("btn-new-game");

const setupModal = document.getElementById("setup-modal");
const seatListEl = document.getElementById("seat-list");
const btnStartGame = document.getElementById("btn-start-game");

const rulesModal = document.getElementById("rules-modal");
const btnCloseRules = document.getElementById("btn-close-rules");

const gameoverModal = document.getElementById("gameover-modal");
const winnerTitle = document.getElementById("winner-title");
const winnerSubtitle = document.getElementById("winner-subtitle");
const finalStandings = document.getElementById("final-standings");
const btnInspectBoard = document.getElementById("btn-inspect-board");
const btnPlayAgain = document.getElementById("btn-play-again");

// --- Setup Modal UI ---
function renderSetupSeats() {
  seatListEl.innerHTML = "";
  PLAYER_PALETTES.forEach((pal, idx) => {
    const row = document.createElement("div");
    row.className = "seat-row";

    const label = document.createElement("div");
    label.className = "seat-label";
    label.innerHTML = `<span class="color-dot" style="background:${pal.hex};color:${pal.hex}"></span><span>Player ${idx + 1} — ${pal.name}</span>`;

    const select = document.createElement("select");
    select.className = "seat-select";
    const options = [
      { value: "human", label: "Human" },
      { value: "ai-tactical", label: "Bot (Tactical)" },
      { value: "ai-casual", label: "Bot (Casual)" },
    ];
    if (idx >= 2) {
      options.push({ value: "none", label: "None" });
    }
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (seatConfigs[idx].type === opt.value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener("change", () => {
      seatConfigs[idx].type = select.value;
    });

    row.appendChild(label);
    row.appendChild(select);
    seatListEl.appendChild(row);
  });
}

function getPaletteMap() {
  const map = new Map();
  for (const p of gameState.players) map.set(p.slot, p.palette);
  return map;
}

function startNewGame() {
  gameState = createGameState(board, seatConfigs);
  selectedVertex = null;
  hoveredVertex = null;
  hoveredChord = null;
  aiDelayTimer = 0.4;
  strings3d.clearAll();
  water3d.clearAll();
  board3d.setWellHighlights([], "#ffffff");
  clearPegHighlights();
  gameoverModal.classList.add("hidden");
  setupModal.classList.add("hidden");
  updateHUD();
  setStatus("Click two edge pegs or a chord groove • Drag to orbit, scroll to zoom");
}

function setStatus(text, isWarn = false) {
  statusBar.textContent = text;
  statusBar.classList.toggle("warn", isWarn);
}

function updateHUD() {
  const cur = getCurrentPlayer(gameState);
  const scores = computeScores(gameState);

  if (gameState.gameOver) {
    turnDot.style.background = "#f4c430";
    turnDot.style.color = "#f4c430";
    turnText.textContent = "Game Complete";
  } else {
    turnDot.style.background = cur.palette.hex;
    turnDot.style.color = cur.palette.hex;
    turnText.textContent =
      cur.type === "human" ? `${cur.palette.name}'s Turn` : `${cur.label} thinking...`;
  }

  // Keep player order stable in score pills
  const scoreBySlot = new Map(scores.map((s) => [s.player.slot, s.segments]));
  scoresBar.innerHTML = "";
  for (const p of gameState.players) {
    const pill = document.createElement("div");
    const isActive = !gameState.gameOver && cur.slot === p.slot;
    pill.className = `score-pill${isActive ? " active" : ""}`;
    if (isActive) {
      pill.style.borderColor = p.palette.hex;
      pill.style.boxShadow = `0 0 12px ${p.palette.hex}55, 0 6px 20px rgba(0,0,0,0.25)`;
    }
    pill.innerHTML = `
      <span class="color-dot" style="background:${p.palette.hex};color:${p.palette.hex}"></span>
      <span>${p.label}</span>
      <span class="score-count">${scoreBySlot.get(p.slot) || 0}</span>
    `;
    scoresBar.appendChild(pill);
  }

  btnUndo.disabled = gameState.history.length === 0;
}

function showGameOverModal() {
  const scores = computeScores(gameState);
  const topSegs = scores[0].segments;
  const topArea = scores[0].area;
  const tiedTop = scores.filter((s) => s.segments === topSegs);

  if (tiedTop.length === 1) {
    winnerTitle.textContent = `${tiedTop[0].player.label} Wins!`;
    winnerSubtitle.textContent = `Claimed ${topSegs} stone well${topSegs === 1 ? "" : "s"}.`;
  } else {
    const names = tiedTop.map((t) => t.player.label).join(" & ");
    winnerTitle.textContent = `Tie: ${names}`;
    winnerSubtitle.textContent = `Both claimed ${topSegs} stone wells (sorted by total area).`;
  }

  finalStandings.innerHTML = "";
  scores.forEach((s, i) => {
    const row = document.createElement("div");
    const isWin = s.segments === topSegs && (tiedTop.length === 1 || Math.abs(s.area - topArea) < 0.01);
    row.className = `standing-row${isWin && i === 0 ? " winner" : ""}`;
    row.innerHTML = `
      <div class="seat-label">
        <span class="color-dot" style="background:${s.player.palette.hex};color:${s.player.palette.hex}"></span>
        <span>${s.player.label}</span>
      </div>
      <div style="text-align:right">
        <div><strong>${s.segments}</strong> wells</div>
        <div class="standing-meta">${s.area.toFixed(0)} area</div>
      </div>
    `;
    finalStandings.appendChild(row);
  });

  gameoverModal.classList.remove("hidden");
  audio.playVictory();
}

function clearPegHighlights() {
  for (let i = 0; i < 8; i++) {
    board3d.setPegHighlight(i, "none", "#ffffff");
  }
}

function refreshInteractivePreviews() {
  clearPegHighlights();
  strings3d.hidePreview();
  board3d.setWellHighlights([], "#ffffff");

  if (gameState.gameOver) return;
  const cur = getCurrentPlayer(gameState);
  if (cur.type !== "human") return;

  if (selectedVertex !== null) {
    board3d.setPegHighlight(selectedVertex, "selected", cur.palette.hex);
  }

  let targetChordId = null;
  if (selectedVertex !== null && hoveredVertex !== null && hoveredVertex !== selectedVertex) {
    targetChordId = findChordId(selectedVertex, hoveredVertex);
    board3d.setPegHighlight(hoveredVertex, "hover", cur.palette.hex);
  } else if (selectedVertex === null && hoveredChord !== null) {
    targetChordId = hoveredChord;
  } else if (hoveredVertex !== null && selectedVertex === null) {
    board3d.setPegHighlight(hoveredVertex, "hover", cur.palette.hex);
  }

  if (targetChordId !== null) {
    const check = getChordValidity(gameState, targetChordId, cur.slot);
    strings3d.showPreview(targetChordId, cur.palette.stringColor, check.valid);
    if (check.valid) {
      const wouldClaim = simulateClaim(
        board,
        gameState.chordOwners,
        gameState.faceOwners,
        targetChordId,
        cur.slot
      );
      board3d.setWellHighlights(wouldClaim, cur.palette.hex);
      if (wouldClaim.length > 0) {
        setStatus(`Place string to claim ${wouldClaim.length} section${wouldClaim.length > 1 ? "s" : ""}`);
      } else {
        setStatus("Click to place string");
      }
    } else {
      setStatus(`Blocked: ${check.reason}`, true);
    }
  } else if (selectedVertex !== null) {
    setStatus("Select a second edge peg to complete chord (click same peg to cancel)");
  } else {
    setStatus("Click two edge pegs or a chord groove • Drag to orbit, scroll to zoom");
  }
}

function findChordId(v1, v2) {
  const a = Math.min(v1, v2);
  const b = Math.max(v1, v2);
  const c = board.chords.find((ch) => ch.vA === a && ch.vB === b);
  return c ? c.id : null;
}

function executeChordMove(chordId) {
  const cur = getCurrentPlayer(gameState);
  const check = getChordValidity(gameState, chordId, cur.slot);
  if (!check.valid) {
    audio.playBlocked();
    setStatus(`Blocked: ${check.reason}`, true);
    return false;
  }

  const result = applyMove(gameState, chordId);
  if (!result) return false;

  const pal = PLAYER_PALETTES[result.playerSlot];
  strings3d.addString(chordId, pal.stringColor, true);
  audio.playPluck(board.chords[chordId].length);

  if (result.claimedFaces.length > 0) {
    water3d.claimFaces(result.claimedFaces, pal, true);
    audio.playPour(result.claimedFaces.length);
  }

  selectedVertex = null;
  hoveredChord = null;
  aiDelayTimer = 0.35;

  updateHUD();
  refreshInteractivePreviews();

  if (result.passes.length > 0 && !result.gameOver) {
    const names = result.passes.map((p) => p.label).join(", ");
    setStatus(`${names} had no legal move and passed`);
  } else if (result.claimedFaces.length > 0) {
    setStatus(`${cur.label} claimed ${result.claimedFaces.length} section${result.claimedFaces.length > 1 ? "s" : ""}!`);
  }

  if (result.gameOver) {
    setTimeout(() => {
      if (gameState.gameOver) showGameOverModal();
    }, 1150);
  }

  return true;
}

// --- Raycasting & Input ---
const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let downPos = null;

function updatePointerNDC(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickBoardTarget(ev) {
  updatePointerNDC(ev);
  raycaster.setFromCamera(pointerNDC, camera);

  const pegHits = raycaster.intersectObjects(board3d.pegHitTargets, false);
  if (pegHits.length > 0) {
    return { kind: "peg", id: pegHits[0].object.userData.vertexId };
  }

  // Only allow direct chord-groove hover when not mid-peg-selection
  if (selectedVertex === null) {
    const chordHits = raycaster.intersectObjects(board3d.chordHitTargets, false);
    if (chordHits.length > 0) {
      return { kind: "chord", id: chordHits[0].object.userData.chordId };
    }
  }
  return null;
}

renderer.domElement.addEventListener("pointerdown", (ev) => {
  downPos = { x: ev.clientX, y: ev.clientY };
});

renderer.domElement.addEventListener("pointermove", (ev) => {
  if (gameState.gameOver || getCurrentPlayer(gameState).type !== "human") {
    renderer.domElement.style.cursor = "grab";
    return;
  }

  const hit = pickBoardTarget(ev);
  if (!hit) {
    hoveredVertex = null;
    hoveredChord = null;
    renderer.domElement.style.cursor = "grab";
  } else if (hit.kind === "peg") {
    hoveredVertex = hit.id;
    hoveredChord = null;
    renderer.domElement.style.cursor = "pointer";
  } else {
    hoveredVertex = null;
    hoveredChord = hit.id;
    renderer.domElement.style.cursor = "pointer";
  }
  refreshInteractivePreviews();
});

renderer.domElement.addEventListener("pointerup", (ev) => {
  if (!downPos) return;
  const moveDist = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
  downPos = null;
  if (moveDist > 6 || ev.button !== 0) return;

  if (gameState.gameOver) return;
  const cur = getCurrentPlayer(gameState);
  if (cur.type !== "human") return;

  const hit = pickBoardTarget(ev);
  if (!hit) {
    if (selectedVertex !== null) {
      selectedVertex = null;
      refreshInteractivePreviews();
    }
    return;
  }

  if (hit.kind === "peg") {
    if (selectedVertex === null) {
      selectedVertex = hit.id;
      refreshInteractivePreviews();
    } else if (selectedVertex === hit.id) {
      selectedVertex = null;
      refreshInteractivePreviews();
    } else {
      const chordId = findChordId(selectedVertex, hit.id);
      if (chordId !== null) {
        executeChordMove(chordId);
      }
    }
  } else if (hit.kind === "chord") {
    executeChordMove(hit.id);
  }
});

// --- HUD Buttons ---
btnUndo.addEventListener("click", () => {
  if (gameState.history.length === 0) return;
  const hasHuman = gameState.players.some((p) => p.type === "human");
  let didUndo = false;
  if (hasHuman) {
    while (gameState.history.length > 0) {
      didUndo = undoLastMove(gameState);
      if (getCurrentPlayer(gameState).type === "human") break;
    }
  } else {
    didUndo = undoLastMove(gameState);
  }
  if (!didUndo) return;

  const palMap = getPaletteMap();
  strings3d.rebuildFromOrder(gameState.placementOrder, palMap);
  water3d.rebuildFromFaceOwners(gameState.faceOwners, palMap);
  selectedVertex = null;
  gameoverModal.classList.add("hidden");
  updateHUD();
  refreshInteractivePreviews();
  setStatus("Undid last move");
});

btnCamera.addEventListener("click", () => {
  camTween = {
    t: 0,
    startPos: camera.position.clone(),
    startTarget: controls.target.clone(),
  };
});

btnMute.addEventListener("click", () => {
  const next = !audio.isMuted();
  audio.setMuted(next);
  btnMute.textContent = next ? "Sound Off" : "Sound On";
});

btnRules.addEventListener("click", () => rulesModal.classList.remove("hidden"));
btnCloseRules.addEventListener("click", () => rulesModal.classList.add("hidden"));
btnNewGame.addEventListener("click", () => {
  renderSetupSeats();
  setupModal.classList.remove("hidden");
});
btnStartGame.addEventListener("click", startNewGame);
btnInspectBoard.addEventListener("click", () => gameoverModal.classList.add("hidden"));
btnPlayAgain.addEventListener("click", () => {
  renderSetupSeats();
  gameoverModal.classList.add("hidden");
  setupModal.classList.remove("hidden");
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Animation & AI Loop ---
renderSetupSeats();
updateHUD();

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (camTween) {
    camTween.t = Math.min(1, camTween.t + dt * 2.6);
    const e = 1 - Math.pow(1 - camTween.t, 3);
    camera.position.lerpVectors(camTween.startPos, DEFAULT_CAM_POS, e);
    controls.target.lerpVectors(camTween.startTarget, DEFAULT_TARGET, e);
    if (camTween.t >= 1) camTween = null;
  }

  controls.update();
  strings3d.update(dt);
  water3d.update(dt);

  // AI plays as soon as all pouring water volume has finished entering the wells
  if (!gameState.gameOver && setupModal.classList.contains("hidden")) {
    const cur = getCurrentPlayer(gameState);
    if (cur.type !== "human") {
      if (water3d.hasActivePour()) {
        // Wait for pouring water volume to finish before AI plays
        aiDelayTimer = 0.25;
      } else {
        aiDelayTimer -= dt;
        if (aiDelayTimer <= 0) {
          const choice = chooseAIMove(gameState, cur);
          if (choice !== null) {
            executeChordMove(choice);
          }
        }
      }
    }
  }

  renderer.render(scene, camera);
}

animate();
