import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { Flipper } from './flipper.js';
import { loadElevationGrid, loadBasemap, mPerDegLon, M_PER_DEG_LAT } from './terrain.js';
import { Buildings, STRUCTURES } from './buildings.js';
import { Effects } from './effects.js';
import { Sound } from './audio.js';

await RAPIER.init();

// ページ（ゲーム / ビューア / 公開用のプレイ版）ごとに置く要素が違うので、
// 無い要素への書き込みは使い捨ての要素で受け流す
const $ = (id) => document.getElementById(id) ?? document.createElement('div');

// ---- ステージ ----------------------------------------------------------------
// stages/<id>.json に範囲・縮尺・投入地点・初期値・建物データを置く。?stage=<id> で切り替え
// ステージ JSON の置き場所は <body data-stages="..."> で変えられる（公開版は data/stages/）
const STAGES_BASE = document.body.dataset.stages ?? 'stages/';
const stageIndex = await fetch(`${STAGES_BASE}index.json`).then((r) => r.json());
const stageId = new URLSearchParams(location.search).get('stage') ?? stageIndex.default;
const STAGE = await fetch(`${STAGES_BASE}${encodeURIComponent(stageId)}.json`).then((r) => r.json());

// 盤面は北が奥、南（下流）が手前のフリッパー側。南端から 25 unit 北にフリッパーが来る
const BBOX = STAGE.bbox;
const UNIT_M = STAGE.unitM;   // 1 unit が何 m か。縮尺はここだけで決まる
const SPACING_M = UNIT_M;     // 標高格子の間隔 = 1 unit
const BALL_R = 2.5;           // unit。実寸の直径は 5 × UNIT_M
const K = BALL_R / 0.27;      // フリッパー試作（ボール半径 0.27）からの拡大率
const SPAWN = STAGE.spawn;
// viewer.html では地形と建物を眺めるだけ（盤面の平坦化・フリッパー・ボールなし）
const VIEWER = document.body.dataset.mode === 'viewer';
// play.html（公開用）：視点は固定。二本指・右ドラッグで動かせて、ボタンで元に戻す
const PLAY = document.body.dataset.mode === 'play';

const params = {
  tiltDeg: 4,
  exaggeration: 10,
  smoothM: 30,          // 地形の平滑化半径。ボールより細かい凹凸（川面の欠測補間跡など）を均す
  ...STAGE.defaults,
  gravity: Math.round(185 * K),
  flipperSpeed: 30,
};

{
  document.title = `${STAGE.name} / ${VIEWER ? '地形ビューア' : 'Kamogawa Pinball'}`;
  const select = $('stage-select');
  select.innerHTML = stageIndex.stages
    .map((st) => `<option value="${st.id}"${st.id === STAGE.id ? ' selected' : ''}>${st.name}</option>`)
    .join('');
  select.addEventListener('change', () => {
    location.search = `?stage=${encodeURIComponent(select.value)}`;
  });
  const launch = document.getElementById('launch');
  if (launch) launch.textContent = `ボール投入（${SPAWN.name}）`;
  $('data-range').innerHTML =
    `北緯 ${BBOX.south.toFixed(4)}〜${BBOX.north.toFixed(4)}<br>東経 ${BBOX.west.toFixed(4)}〜${BBOX.east.toFixed(4)}`;
  $('data-grid').textContent =
    `${UNIT_M} m（1 unit = ${UNIT_M} m、ボール直径 ${BALL_R * 2 * UNIT_M} m）`;
}

// ---- UI 要素 -----------------------------------------------------------------
const stage = document.getElementById('stage');
const canvas = document.getElementById('view');
const statusEl = document.getElementById('status');
const setStatus = (t) => {
  statusEl.textContent = t;
  statusEl.hidden = !t;
};

// ---- データ読み込み -----------------------------------------------------------
setStatus('標高タイルを読み込み中');
const [grid, basemap, buildingData] = await Promise.all([
  loadElevationGrid(BBOX, SPACING_M, (d, n) => setStatus(`標高タイルを読み込み中 ${d}/${n}`)),
  loadBasemap(BBOX),
  // tools/build_buildings.py または tools/clip_buildings.py で生成
  STAGE.buildings
    ? fetch(STAGE.buildings).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    : null,
]);
setStatus('');

const W = grid.widthM / UNIT_M;
const L = grid.lengthM / UNIT_M;
const { cols, rows, ncols, nrows } = grid;
const baseM = grid.heights.reduce((m, v) => Math.min(m, v), Infinity);

const toLocal = (lon, lat) => ({
  x: ((lon - grid.lonC) * mPerDegLon(grid.latC)) / UNIT_M,
  z: ((grid.latC - lat) * M_PER_DEG_LAT) / UNIT_M,
});

// 盤面の配置（南端にフリッパー）
const FL = {
  pivotX: 3.25 + 15.7 * Math.cos(Math.PI / 6),
  pivotZ: L / 2 - 25,
  apronStart: L / 2 - 62,  // ここから南を平坦化
  apronFull: L / 2 - 42,
};

// 南北の平均勾配（平坦化しない範囲、生の標高 [m] で）
function meanRowHeight(z) {
  const i = Math.round((z / L + 0.5) * nrows);
  let s = 0;
  for (let j = 0; j < cols; j++) s += grid.heights[i * cols + j];
  return s / cols;
}
const zN = -L / 2 + 10, zS = FL.apronStart;
const realSlope = (meanRowHeight(zN) - meanRowHeight(zS)) / ((zS - zN) * UNIT_M);

// 誇張率から盤面高さ [unit] を作る（行優先 rows × cols）
const smooth = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
let H = new Float32Array(cols * rows);
let apronY = 0;

// 分離型ボックスブラーを2回（ガウシアン近似）。端は端の値で延長
function blurGrid(src, radius) {
  if (radius < 1) return src.slice();
  let a = src.slice(), b = new Float32Array(src.length);
  const pass = (from, to, horizontal) => {
    const n = horizontal ? cols : rows, m = horizontal ? rows : cols;
    for (let o = 0; o < m; o++) {
      const idx = (t) => (horizontal ? o * cols + t : t * cols + o);
      let sum = 0;
      for (let t = -radius; t <= radius; t++) sum += from[idx(THREE.MathUtils.clamp(t, 0, n - 1))];
      for (let t = 0; t < n; t++) {
        to[idx(t)] = sum / (radius * 2 + 1);
        sum += from[idx(Math.min(t + radius + 1, n - 1))] - from[idx(Math.max(t - radius, 0))];
      }
    }
  };
  for (let it = 0; it < 2; it++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}
let smoothed = null, smoothedFor = -1;

function computeHeights(exag) {
  if (smoothedFor !== params.smoothM) {
    smoothed = blurGrid(grid.heights, Math.round(params.smoothM / SPACING_M));
    smoothedFor = params.smoothM;
  }
  const h = new Float32Array(cols * rows);
  for (let k = 0; k < h.length; k++) h[k] = ((smoothed[k] - baseM) / UNIT_M) * exag;
  // フリッパー周りの台座の高さ：平坦化完了行の中央付近の平均
  const iFull = Math.round((FL.apronFull / L + 0.5) * nrows);
  let s = 0, n = 0;
  for (let j = 0; j < cols; j++) {
    const x = -W / 2 + (j / ncols) * W;
    if (Math.abs(x) < FL.pivotX + 10) { s += h[iFull * cols + j]; n++; }
  }
  apronY = s / n;
  for (let i = 0; i < rows; i++) {
    const z = -L / 2 + (i / nrows) * L;
    const t = VIEWER ? 0 : smooth(FL.apronStart, FL.apronFull, z);
    if (t === 0) continue;
    for (let j = 0; j < cols; j++) {
      const k = i * cols + j;
      h[k] = h[k] * (1 - t) + apronY * t;
    }
  }
  return h;
}

function heightAt(x, z) {
  const fj = THREE.MathUtils.clamp((x / W + 0.5) * ncols, 0, ncols);
  const fi = THREE.MathUtils.clamp((z / L + 0.5) * nrows, 0, nrows);
  const j0 = Math.min(Math.floor(fj), ncols - 1), i0 = Math.min(Math.floor(fi), nrows - 1);
  const tx = fj - j0, tz = fi - i0;
  const a = H[i0 * cols + j0], b = H[i0 * cols + j0 + 1];
  const c = H[(i0 + 1) * cols + j0], d = H[(i0 + 1) * cols + j0 + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

// ---- 描画 --------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf7f8f9);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa1a8, 1.4));
// 陰影図の慣例に合わせて北西から照らす
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-120, 260, -160);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 10, far: 900 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);

// 地形メッシュ
const terrainGeom = new THREE.BufferGeometry();
{
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  for (let i = 0; i < rows; i++) {
    const lat = BBOX.north - (i / nrows) * (BBOX.north - BBOX.south);
    for (let j = 0; j < cols; j++) {
      const lon = BBOX.west + (j / ncols) * (BBOX.east - BBOX.west);
      const k = i * cols + j;
      pos[k * 3] = -W / 2 + (j / ncols) * W;
      pos[k * 3 + 2] = -L / 2 + (i / nrows) * L;
      const [u, v] = basemap.uvOf(lon, lat);
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
    }
  }
  const index = new Uint32Array(ncols * nrows * 6);
  let p = 0;
  for (let i = 0; i < nrows; i++) {
    for (let j = 0; j < ncols; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      index.set([a, c, b, b, c, d], p);
      p += 6;
    }
  }
  terrainGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  terrainGeom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  terrainGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols * rows * 3), 3));
  terrainGeom.setAttribute('elev', new THREE.BufferAttribute(new Float32Array(cols * rows), 1));
  terrainGeom.setIndex(new THREE.BufferAttribute(index, 1));
}
const mapTex = new THREE.CanvasTexture(basemap.canvas);
mapTex.colorSpace = THREE.SRGBColorSpace;
mapTex.flipY = false;
mapTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

// 段彩（標高 [m] を範囲内の最小〜最大で正規化）と水域
const RAMP = [
  [0.0, 0xe3edd5], [0.3, 0xcfe2c0], [0.55, 0xe5e0b4], [0.8, 0xe2c99c], [1.0, 0xd2b08c],
].map(([t, c]) => [t, new THREE.Color(c)]);
const WATER = new THREE.Color(0xa9cbe3);
function rampColor(t, out) {
  t = THREE.MathUtils.clamp(t, 0, 1);
  for (let k = 1; k < RAMP.length; k++) {
    if (t <= RAMP[k][0]) {
      const [t0, c0] = RAMP[k - 1], [t1, c1] = RAMP[k];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(RAMP[RAMP.length - 1][1]);
}

const terrainUniforms = { uContour: { value: 5 }, uContourOn: { value: 1 } };
const terrainMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true });
// 等高線：標高を頂点属性で渡し、fwidth で画面上の線幅を一定にする。5 本ごとに太く
terrainMat.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, terrainUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float elev;\nvarying float vElev;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = elev;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vElev;\nuniform float uContour;\nuniform float uContourOn;')
    .replace('#include <color_fragment>', `#include <color_fragment>
      float ce = vElev / uContour;
      float cw = max(fwidth(ce), 1e-4);
      float minor = 1.0 - smoothstep(0.0, 1.0, abs(fract(ce - 0.5) - 0.5) / cw);
      float ce5 = ce / 5.0;
      float major = 1.0 - smoothstep(0.0, 1.6, abs(fract(ce5 - 0.5) - 0.5) / max(fwidth(ce5), 1e-4));
      float line = max(minor * 0.55, major);
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6, line * uContourOn);`);
};
const terrainMesh = new THREE.Mesh(terrainGeom, terrainMat);

// 地表の表示：段彩 / 地図 / 重ね（地図に段彩を乗算）
let surfaceMode = 'tint';
function applySurfaceMode() {
  terrainMat.map = surfaceMode === 'tint' ? null : mapTex;
  terrainMat.vertexColors = surfaceMode !== 'map';
  terrainMat.needsUpdate = true;
  for (const b of document.querySelectorAll('[data-surface]')) {
    b.setAttribute('aria-pressed', String(b.dataset.surface === surfaceMode));
  }
}
for (const b of document.querySelectorAll('[data-surface]')) {
  b.addEventListener('click', () => { surfaceMode = b.dataset.surface; applySurfaceMode(); });
}
$('contour').addEventListener('change', (e) => {
  terrainUniforms.uContourOn.value = e.target.checked ? 1 : 0;
});
applySurfaceMode();
terrainMesh.receiveShadow = true;
scene.add(terrainMesh);

// ---- 物理 --------------------------------------------------------------------
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
world.integrationParameters.numSolverIterations = 8;
world.lengthUnit = BALL_R;
const STEP_HZ = 480;
world.timestep = 1 / STEP_HZ;

function applyGravity() {
  const t = THREE.MathUtils.degToRad(params.tiltDeg);
  world.gravity = { x: 0, y: -params.gravity * Math.cos(t), z: params.gravity * Math.sin(t) };
}
applyGravity();

const terrainBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
let terrainCollider = null;
let wallBody = null;
const wallGroup = new THREE.Group();
scene.add(wallGroup);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x56606b, roughness: 0.6 });
const guideMat = new THREE.MeshStandardMaterial({ color: 0x7b8591, roughness: 0.6 });
const WALL_H = 9, WALL_T = 1.4;

// 地形に沿って区切った壁。各区間は区間内の最低点の少し下から最高点 + WALL_H まで
function terrainWall(x1, z1, x2, z2, mat = wallMat) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const n = Math.max(1, Math.ceil(len / 12));
  const yaw = -Math.atan2(z2 - z1, x2 - x1);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  for (let s = 0; s < n; s++) {
    const a = s / n, b = (s + 1) / n;
    const ax = x1 + (x2 - x1) * a, az = z1 + (z2 - z1) * a;
    const bx = x1 + (x2 - x1) * b, bz = z1 + (z2 - z1) * b;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k <= 4; k++) {
      const y = heightAt(ax + ((bx - ax) * k) / 4, az + ((bz - az) * k) / 4);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    const y0 = lo - 3, y1 = hi + WALL_H;
    const seg = len / n + WALL_T;
    const cx = (ax + bx) / 2, cz = (az + bz) / 2, cy = (y0 + y1) / 2;
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(seg / 2, (y1 - y0) / 2, WALL_T / 2)
        .setTranslation(cx, cy, cz)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setRestitution(0.5).setFriction(0.1),
      wallBody
    );
    const m = new THREE.Mesh(new THREE.BoxGeometry(seg, y1 - y0, WALL_T), mat);
    m.position.set(cx, cy, cz);
    m.quaternion.copy(q);
    m.castShadow = true;
    m.receiveShadow = true;
    wallGroup.add(m);
  }
}

function buildWalls() {
  if (wallBody) world.removeRigidBody(wallBody);
  for (const m of wallGroup.children) m.geometry.dispose();
  wallGroup.clear();
  wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  const w = W / 2, l = L / 2;
  terrainWall(-w, -l, w, -l);
  terrainWall(-w, -l, -w, l);
  terrainWall(w, -l, w, l);
  terrainWall(-w, l, w, l);
  // インレーンのガイドとドレイン脇
  const px = FL.pivotX, pz = FL.pivotZ;
  const gx = px + 0.32 * K, gz = pz - 0.18 * K;
  terrainWall(-w, pz - 46, -gx, gz, guideMat);
  terrainWall(w, pz - 46, gx, gz, guideMat);
  terrainWall(-gx, gz, -px - 0.6 * K, l, guideMat);
  terrainWall(gx, gz, px + 0.6 * K, l, guideMat);
}

function rebuildTerrain() {
  H = computeHeights(params.exaggeration);

  // Rapier の heightfield は列優先。row が z、col が x に対応
  const hf = new Float32Array(cols * rows);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) hf[i + j * rows] = H[i * cols + j];
  if (terrainCollider) world.removeCollider(terrainCollider, false);
  terrainCollider = world.createCollider(
    RAPIER.ColliderDesc.heightfield(nrows, ncols, hf, { x: W, y: 1, z: L })
      .setFriction(0.2).setRestitution(0.1),
    terrainBody
  );

  const pos = terrainGeom.attributes.position;
  for (let k = 0; k < H.length; k++) pos.array[k * 3 + 1] = H[k];
  pos.needsUpdate = true;
  terrainGeom.computeVertexNormals();
  terrainGeom.computeBoundingSphere();

  // 表示用の標高 [m]（平坦化後の面に合わせる）と段彩
  const elev = terrainGeom.attributes.elev, color = terrainGeom.attributes.color;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < H.length; k++) {
    const m = (H[k] / params.exaggeration) * UNIT_M + baseM;
    elev.array[k] = m;
    lo = Math.min(lo, m); hi = Math.max(hi, m);
  }
  const c = new THREE.Color();
  for (let k = 0; k < H.length; k++) {
    if (grid.source[k] !== 0) c.copy(WATER); // DEM5A の欠測域 = 主に水面
    else rampColor((elev.array[k] - lo) / (hi - lo), c);
    color.array.set([c.r, c.g, c.b], k * 3);
  }
  elev.needsUpdate = true;
  color.needsUpdate = true;
  $('elev-min').textContent = `${lo.toFixed(0)} m`;
  $('elev-max').textContent = `${hi.toFixed(0)} m`;

  buildWalls();
  flippers?.left.setBaseY(apronY);
  flippers?.right.setBaseY(apronY);
  buildings?.rebuild();

  if (ballBody) {
    const p = ballBody.translation();
    const floor = heightAt(p.x, p.z) + BALL_R + 0.2;
    if (p.y < floor) ballBody.setTranslation({ x: p.x, y: floor, z: p.z }, true);
  }
  updateSlopeReadout();
}

let flippers = null;
let ballBody = null;
let buildings = null;
rebuildTerrain();

const flipperOpts = {
  length: 1.7 * K, r0: 0.25 * K, r1: 0.12 * K, height: 0.5 * K,
};
flippers = {
  left: new Flipper(RAPIER, world, scene, {
    ...flipperOpts, side: 'left', pivot: { x: -FL.pivotX, y: apronY, z: FL.pivotZ },
  }),
  right: new Flipper(RAPIER, world, scene, {
    ...flipperOpts, side: 'right', pivot: { x: FL.pivotX, y: apronY, z: FL.pivotZ },
  }),
};
for (const f of Object.values(flippers)) {
  f.speed = params.flipperSpeed;
  f.mesh.visible = !VIEWER;
}
wallGroup.visible = !VIEWER;

// ボール
ballBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, -100, 0)
    .setCcdEnabled(true)
    .setCanSleep(false)
    .setLinearDamping(0.05)
    .setAngularDamping(0.2)
);
const ballCollider = world.createCollider(
  RAPIER.ColliderDesc.ball(BALL_R).setDensity(1).setFriction(0.2).setRestitution(0.35)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
  ballBody
);
const ballMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 40, 20),
  new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.7, roughness: 0.25 })
);
ballMesh.castShadow = true;
scene.add(ballMesh);

const spawnPos = toLocal(SPAWN.lon, SPAWN.lat);

// 建物。フリッパー周りと投入地点の近くは除く
if (buildingData) {
  const o = toLocal(buildingData.origin[0], buildingData.origin[1]);
  buildings = new Buildings(RAPIER, world, scene, buildingData, {
    body: terrainBody,
    unitM: UNIT_M,
    offsetM: { x: o.x * UNIT_M, z: o.z * UNIT_M },
    heightAt: (x, z) => heightAt(x, z),
    colliderMinH: BALL_R * 2,
    exclude: VIEWER
      ? () => false
      : (x, z) => z > FL.apronStart - 4 || Math.hypot(x - spawnPos.x, z - spawnPos.z) < 10,
  });
  buildings.rebuild();
  buildings.onDestroy = (info) => sound?.destruction(effects.destruction(info, camera));
  $('bldg-source').textContent = buildingData.source;
} else {
  $('bldg-source').textContent = '建物データなし（tools/build_buildings.py --stage で生成）';
}
const effects = new Effects(scene, stage);

// 音（ゲームのみ）。自動再生制限のため、最初の操作で鳴り始める
const sound = VIEWER ? null : new Sound({ bgmUrl: document.body.dataset.bgm ?? 'audio/miyako-ni-kakeru.mp3' });
if (sound) {
  const unlock = () => sound.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  // 消音はチェックボックス（ゲーム版）か、aria-pressed で切り替える円ボタン（公開版）
  const mute = $('mute');
  if (mute.tagName === 'BUTTON') {
    mute.addEventListener('click', () => {
      const on = mute.getAttribute('aria-pressed') !== 'true';
      mute.setAttribute('aria-pressed', String(on));
      mute.setAttribute('aria-label', on ? '消音を解除' : '消音');
      sound.setMuted(on);
    });
  } else {
    mute.addEventListener('change', () => sound.setMuted(mute.checked));
  }
  for (const [id, set] of [['vol-bgm', (v) => sound.setBgmVolume(v)], ['vol-se', (v) => sound.setSeVolume(v)]]) {
    const input = document.getElementById(id);
    if (!input) continue;
    const out = document.querySelector(`output[for="${id}"]`);
    const apply = () => { set(Number(input.value) / 100); out.textContent = `${input.value}%`; };
    input.addEventListener('input', apply);
    apply();
  }
}
const showBuildings = document.getElementById('show-buildings');
showBuildings?.addEventListener('change', () => {
  buildings?.setVisible(showBuildings.checked);
  statsDirty = true;
});
// 初期状態はチェックボックスに合わせる（ビューアは建物なしで始める）。無いページでは表示
buildings?.setVisible(showBuildings ? showBuildings.checked : true);

let inPlay = false;
function spawnBall() {
  if (VIEWER) return;
  const y = heightAt(spawnPos.x, spawnPos.z) + BALL_R + 0.5;
  ballBody.setTranslation({ x: spawnPos.x, y, z: spawnPos.z }, true);
  ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  inPlay = true;
  drainTimer = -1;
  buildings?.updateActive(spawnPos.x, spawnPos.z, ACTIVE_RADIUS);
}

// ---- 勾配の表示 --------------------------------------------------------------
function updateSlopeReadout() {
  const deg = (r) => THREE.MathUtils.radToDeg(Math.atan(r)).toFixed(2);
  const t = Math.tan(THREE.MathUtils.degToRad(params.tiltDeg));
  $('slope-real').textContent =
    `${(realSlope * 1000).toFixed(1)}‰（${deg(realSlope)}°）`;
  $('slope-exag').textContent = `${deg(realSlope * params.exaggeration)}°`;
  $('slope-total').textContent = `${deg(realSlope * params.exaggeration + t)}°`;
}
{
  let c5 = 0, c10 = 0, cf = 0;
  for (const s of grid.source) s === 0 ? c5++ : s === 1 ? c10++ : cf++;
  const pct = (v) => `${((v / grid.source.length) * 100).toFixed(1)}%`;
  $('dem-source').textContent =
    `DEM5A ${pct(c5)} / DEM10B ${pct(c10)} / 補間 ${pct(cf)}`;
}
updateSlopeReadout();

// ---- カメラ ------------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(32, 1, 1, 3000);
let viewMode = 'overview';
const follow = { pos: new THREE.Vector3(), target: new THREE.Vector3(), init: false };
const controls = new OrbitControls(camera, canvas);
controls.enabled = PLAY;
let cameraTouched = false; // プレイ版で利用者が視点を動かしたか
if (PLAY) {
  // 左クリック・一本指はフリッパーに使うので、カメラは右ドラッグ・ホイール・二本指だけ
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.addEventListener('start', () => { cameraTouched = true; });
}
controls.enableDamping = true;
controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
controls.minDistance = 20;
controls.maxDistance = 1500;

function fitCamera() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (viewMode === 'follow' || viewMode === 'free') return;
  // プレイ版：動かした視点は画面サイズが変わっても保つ（スマホのアドレスバーの伸縮など）
  if (PLAY && cameraTouched) return;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const spanX = W + 10, spanZ = L + 10;
  if (viewMode === 'top') {
    const d = Math.max(spanZ / 2 / tanHalf, spanX / 2 / (tanHalf * camera.aspect));
    camera.position.set(0, d + apronY, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, apronY, 0);
  } else {
    const elev = THREE.MathUtils.degToRad(58);
    const d = Math.max(spanZ * 0.92 / 2 / tanHalf, spanX * 1.22 / 2 / (tanHalf * camera.aspect)) * 1.04;
    const target = new THREE.Vector3(0, apronY * 0.5, 6);
    camera.up.set(0, 1, 0);
    camera.position.set(target.x, target.y + Math.sin(elev) * d, target.z + Math.cos(elev) * d);
    camera.lookAt(target);
    controls.target.copy(target);
  }
}
new ResizeObserver(fitCamera).observe(stage);

function updateFollowCamera(dt) {
  const p = ballBody.translation();
  const target = new THREE.Vector3(p.x, p.y, Math.min(p.z, FL.pivotZ - 20));
  const want = target.clone().add(new THREE.Vector3(0, 70, 85));
  const a = follow.init ? 1 - Math.exp(-dt * 4) : 1;
  follow.target.lerp(target, a);
  follow.pos.lerp(want, a);
  follow.init = true;
  camera.up.set(0, 1, 0);
  camera.position.copy(follow.pos);
  camera.lookAt(follow.target);
}

function setViewMode(mode) {
  // 自由視点は直前の視点から始める。注視点はボール（投入前は盤面中央）
  if (mode === 'free') {
    const p = inPlay ? ballBody.translation() : { x: 0, y: apronY * 0.5, z: 6 };
    controls.target.set(p.x, p.y, p.z);
    camera.up.set(0, 1, 0);
  }
  viewMode = mode;
  controls.enabled = mode === 'free';
  pointers.clear();
  refreshPointerFlippers();
  follow.init = false;
  for (const b of document.querySelectorAll('[data-view]')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === mode));
  }
  fitCamera();
}
for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => setViewMode(b.dataset.view));
}

// ---- 入力 --------------------------------------------------------------------
const keyMap = {
  ArrowLeft: 'left', KeyZ: 'left', ShiftLeft: 'left',
  ArrowRight: 'right', Slash: 'right', ShiftRight: 'right',
};
const views = ['overview', 'top', 'follow', 'free'];
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const side = keyMap[e.code];
  if (side) { flippers[side].pressed = true; e.preventDefault(); }
  if (e.code === 'Space') { if (!inPlay) spawnBall(); e.preventDefault(); }
  if (e.code === 'KeyR') spawnBall();
  if (e.code === 'ArrowUp' || e.code === 'KeyX') { nudge(); e.preventDefault(); }
  if (e.code === 'KeyV') setViewMode(views[(views.indexOf(viewMode) + 1) % views.length]);
});
window.addEventListener('keyup', (e) => {
  const side = keyMap[e.code];
  if (side) flippers[side].pressed = false;
});
window.addEventListener('blur', () => {
  flippers.left.pressed = flippers.right.pressed = false;
});

const pointers = new Map();
function refreshPointerFlippers() {
  const sides = new Set(pointers.values());
  flippers.left.pressed = sides.has('left');
  flippers.right.pressed = sides.has('right');
}
// 二本指の操作中（カメラ）はフリッパーを受け付けない
const touches = new Set();
let gesture = false;
canvas.addEventListener('pointerdown', (e) => {
  if (viewMode === 'free') return; // 自由視点ではドラッグをカメラ操作に使う
  if (e.pointerType === 'mouse' && e.button !== 0) return; // 右・中ボタンはカメラ
  if (e.pointerType === 'touch') {
    touches.add(e.pointerId);
    if (PLAY && touches.size >= 2) {
      gesture = true;
      pointers.clear();
      refreshPointerFlippers();
    }
    if (gesture) return;
  }
  const r = canvas.getBoundingClientRect();
  pointers.set(e.pointerId, e.clientX - r.left < r.width / 2 ? 'left' : 'right');
  canvas.setPointerCapture(e.pointerId);
  refreshPointerFlippers();
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, (e) => {
    touches.delete(e.pointerId);
    if (touches.size === 0) gesture = false;
    pointers.delete(e.pointerId);
    refreshPointerFlippers();
  });
}
document.getElementById('launch')?.addEventListener('click', spawnBall);
document.getElementById('nudge')?.addEventListener('click', nudge);
document.getElementById('reset-view')?.addEventListener('click', () => {
  cameraTouched = false;
  fitCamera();
});

// 台を揺らす（ナッジ）。ボールを接している建物から離れる向きへ小突き、画面も揺らす。
// 何にも接していなければ左右どちらかへ小突く。
// 傾きによる加速が約 190 unit/s² あるので、小突きだけでは 0.2 秒ほどで打ち消される。
// そのため揺れでボールに接している建物にも耐久ダメージを与え、抜け道を作る
const NUDGE_SPEED = 70;     // unit/s。フリッパーの打球（300〜400）より十分弱い
const NUDGE_DAMAGE = 40;    // 接している建物への耐久ダメージ（RC 造 60 の 2/3）
const NUDGE_COOLDOWN = 0.5; // s
let lastNudge = -Infinity;
function nudge() {
  if (!inPlay) return;
  const now = performance.now() / 1000;
  if (now - lastNudge < NUDGE_COOLDOWN) return;
  lastNudge = now;
  const v = ballBody.linvel();
  const p = ballBody.translation();
  let ax = 0, az = 0;
  if (buildings) {
    for (const i of buildings.active) {
      if (!buildings.alive[i]) continue;
      const [nx, nz, d] = buildings.nearest(i, p.x, p.z);
      if (d < BALL_R + 1.2) { ax -= nx; az -= nz; }
    }
  }
  let len = Math.hypot(ax, az);
  if (len < 1e-3) { ax = Math.random() < 0.5 ? -1 : 1; az = -0.3; len = Math.hypot(ax, az); }
  // 少しばらつかせて、同じ所で同じ向きに跳ね返り続けないようにする
  const jitter = (Math.random() - 0.5) * 0.6;
  const dx = ax / len + jitter * (-az / len), dz = az / len + jitter * (ax / len);
  ballBody.setLinvel({ x: v.x + dx * NUDGE_SPEED, y: v.y + 6, z: v.z + dz * NUDGE_SPEED }, true);
  effects.shake = Math.min(effects.shake + 1.2, 2.2);
  if (buildings) {
    // pressure() は dps × dt を与えるので、dt = 1 で一度に NUDGE_DAMAGE を与える
    const pts = buildings.pressure(ballBody.translation(), BALL_R + 1.2, NUDGE_DAMAGE, 1);
    if (pts) { score += pts; statsDirty = true; }
  }
}

// パラメータ
function bindRange(id, key, fmt, { onInput, onCommit } = {}) {
  const input = document.getElementById(id);
  if (!input) return;
  const out = document.querySelector(`output[for="${id}"]`);
  input.value = params[key];
  const show = () => { out.textContent = fmt(Number(input.value)); };
  input.addEventListener('input', () => {
    show();
    if (onInput) { params[key] = Number(input.value); onInput(); }
  });
  input.addEventListener('change', () => {
    params[key] = Number(input.value);
    onCommit?.();
  });
  show();
}
bindRange('p-tilt', 'tiltDeg', (v) => `${v.toFixed(1)}°`, {
  onInput: () => { applyGravity(); updateSlopeReadout(); },
});
bindRange('p-exag', 'exaggeration', (v) => `×${v}`, { onCommit: rebuildTerrain });
bindRange('p-smooth', 'smoothM', (v) => `${v} m`, { onCommit: rebuildTerrain });
bindRange('p-gravity', 'gravity', (v) => v.toFixed(0), { onInput: applyGravity });
bindRange('p-fspeed', 'flipperSpeed', (v) => `${v.toFixed(0)} rad/s`, {
  onInput: () => { flippers.left.speed = flippers.right.speed = params.flipperSpeed; },
});

// ---- ループ ------------------------------------------------------------------
let balls = 3;
let drainTimer = -1;
const hud = {
  balls: document.getElementById('balls'),
  speed: document.getElementById('speed'),
  place: document.getElementById('place'),
  score: document.getElementById('score'),
};

const eventQueue = new RAPIER.EventQueue(true);
let score = 0;
const pendingHits = [];

// world.step() は毎回 queryPipeline.update()（レイキャスト用の索引の再構築）も行い、
// コライダー数に比例して重い。実行中はレイキャストを使わないので物理パイプラインだけ進める
function stepWorld() {
  world.physicsPipeline.step(
    world.gravity, world.integrationParameters, world.islands, world.broadPhase, world.narrowPhase,
    world.bodies, world.colliders, world.impulseJoints, world.multibodyJoints, world.ccdSolver,
    eventQueue, undefined
  );
}

const ACTIVE_RADIUS = 30;   // 当たり判定を有効にする範囲 [unit]
const PRESSURE_DPS = 600;   // 接触し続けたときの耐久の減り [hp/s]。SRC 造（100）で約 0.17 秒
let stepCount = 0;

function physicsStep(dt) {
  flippers.left.step(dt);
  flippers.right.step(dt);
  if (buildings && inPlay && stepCount++ % 8 === 0) {
    const p = ballBody.translation();
    buildings.updateActive(p.x, p.z, ACTIVE_RADIUS);
    const pts = buildings.pressure(p, BALL_R, PRESSURE_DPS, dt * 8);
    if (pts) { score += pts; statsDirty = true; }
  }
  const prevVel = ballBody.linvel();
  stepWorld();
  if (!buildings) return;
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const other = h1 === ballCollider.handle ? h2 : h2 === ballCollider.handle ? h1 : null;
    const i = other == null ? undefined : buildings.indexOfHandle(other);
    if (i !== undefined) pendingHits.push(i);
  });
  // コライダーの削除はイベントの走査が終わってから
  while (pendingHits.length) {
    const r = buildings.hit(pendingHits.pop(), ballBody.translation(), prevVel);
    if (r?.destroyed) {
      // 壊れた建物では跳ね返らず、減速して突き抜ける
      ballBody.setLinvel({ x: prevVel.x * r.keep, y: prevVel.y, z: prevVel.z * r.keep }, true);
      score += r.points;
      statsDirty = true;
    }
  }
}

// 構造種別ごとの凡例と残数
let statsDirty = true;
const legendBody = $('legend');
function renderLegend() {
  if (!buildings || !legendBody) return;
  const st = buildings.stats();
  legendBody.innerHTML = Object.entries(STRUCTURES)
    .filter(([code]) => st[code])
    .sort((a, b) => a[1].hp - b[1].hp)
    .map(([code, s]) => {
      const c = `#${s.color.toString(16).padStart(6, '0')}`;
      const { total, alive } = st[code];
      return `<tr><th><span class="swatch" style="background:${c}"></span>${s.name}</th>` +
        `<td>${(total - alive).toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')}</td>` +
        `<td>${s.restitution.toFixed(2)}</td><td>${s.hp}</td><td>${s.hp * 10}</td></tr>`;
    })
    .join('');
  statsDirty = false;
}
document.getElementById('restore')?.addEventListener('click', () => {
  buildings?.restore();
  score = 0;
  statsDirty = true;
});

let last = performance.now();
let acc = 0;
function frame(now) {
  const elapsed = Math.min((now - last) / 1000, 0.1);
  last = now;
  const dt = 1 / STEP_HZ;
  acc += elapsed;
  let n = 0;
  while (acc >= dt && n < 64) { physicsStep(dt); acc -= dt; n++; }
  if (n === 64) acc = 0;

  const p = ballBody.translation();
  if (inPlay) {
    if (drainTimer < 0 && p.z > FL.pivotZ + 1.2 * K && Math.abs(p.x) < FL.pivotX + 0.6 * K) drainTimer = 0.8;
    if (Math.abs(p.x) > W / 2 + 5 || Math.abs(p.z) > L / 2 + 5 || p.y < -50) drainTimer = 0;
    if (drainTimer >= 0) {
      drainTimer -= elapsed;
      if (drainTimer < 0) {
        balls = balls <= 1 ? 3 : balls - 1;
        inPlay = false;
        ballBody.setTranslation({ x: 0, y: -100, z: 0 }, true);
        ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
  } else {
    ballBody.setTranslation({ x: 0, y: -100, z: 0 }, true);
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  ballMesh.visible = inPlay;
  ballMesh.position.set(p.x, p.y, p.z);
  const r = ballBody.rotation();
  ballMesh.quaternion.set(r.x, r.y, r.z, r.w);
  flippers.left.sync();
  flippers.right.sync();
  if (viewMode === 'follow') updateFollowCamera(elapsed);
  if (viewMode === 'free' || PLAY) controls.update();
  buildings?.updateEffects(elapsed);
  effects.update(elapsed);
  sound?.update();

  const v = ballBody.linvel();
  if (!VIEWER) {
  hud.balls.textContent = balls;
  hud.score.textContent = score.toLocaleString('ja-JP');
  if (statsDirty) renderLegend();
  hud.speed.textContent = inPlay ? (Math.hypot(v.x, v.z) * UNIT_M).toFixed(0) : '-';
  if (inPlay) {
    const lat = grid.latC - (p.z * UNIT_M) / M_PER_DEG_LAT;
    const lon = grid.lonC + (p.x * UNIT_M) / mPerDegLon(grid.latC);
    hud.place.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  } else {
    hud.place.textContent = PLAY ? '「ボール投入」で開始' : 'Space で投入';
  }
  }

  effects.beginShake(camera);
  renderer.render(scene, camera);
  effects.endShake(camera);
  requestAnimationFrame(frame);
}
fitCamera();
if (VIEWER) {
  // 盤面中央を注視して自動回転
  setViewMode('free');
  controls.target.set(0, apronY * 0.5, 0);
  const d = Math.max(W, L) * 1.25;
  camera.position.set(d * 0.5, d * 0.5, d * 0.7);
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  $('auto-rotate').addEventListener('change', (e) => {
    controls.autoRotate = e.target.checked;
  });
  $('exag-1').addEventListener('click', () => {
    const input = document.getElementById('p-exag');
    input.value = 1;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  });
}
requestAnimationFrame(frame);

// コンソールからの調整・検証用
window.pinball = { THREE, renderer, scene, camera, controls, nudge, sound, effects, buildings, world, ballBody, flippers, params, spawnBall, physicsStep, heightAt, grid, FL, W, L, terrainCollider: () => terrainCollider, RAPIER };
