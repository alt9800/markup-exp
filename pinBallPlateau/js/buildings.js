import * as THREE from 'three';

// 構造種別（i-UR コードリスト BuildingDetailAttribute_buildingStructureType）ごとの挙動。
// 色は得点（耐久）の低い順に淡→濃。不明は灰色
// hp は「衝突時のボールの法線方向速度 [unit/s]」の累計と、接触時間（圧力）で減る。
// keep は破壊して突き抜けたときに残る速度の割合。
// 棟の間隔が 1 unit 前後と密なので、重力だけで再加速した衝突速度（20 unit/s 程度）で
// 木造〜鉄骨造が壊れる水準にしてある。これより硬くすると市街地でほぼ止まる
export const STRUCTURES = {
  601: { name: '木造・土蔵造', color: 0xe6def0, restitution: 0.1, hp: 4, keep: 0.995 },
  611: { name: '不明', color: 0xd9d9dc, restitution: 0.3, hp: 6, keep: 0.99 },
  605: { name: '軽量鉄骨造', color: 0xd2c6e6, restitution: 0.3, hp: 10, keep: 0.99 },
  606: { name: 'レンガ・CB・石造', color: 0xbcaad9, restitution: 0.35, hp: 20, keep: 0.98 },
  604: { name: '鉄骨造', color: 0x9f8bc8, restitution: 0.5, hp: 35, keep: 0.97 },
  610: { name: '非木造', color: 0x9f8bc8, restitution: 0.5, hp: 35, keep: 0.97 },
  603: { name: '鉄筋コンクリート造', color: 0x7a63ad, restitution: 0.55, hp: 60, keep: 0.95 },
  602: { name: '鉄骨鉄筋コンクリート造', color: 0x553c8c, restitution: 0.6, hp: 100, keep: 0.92 },
};
const structOf = (code) => STRUCTURES[code] ?? STRUCTURES[611];

// 2D 凸包（x, z 交互の Float32Array で返す）
function hull2d(fp) {
  const pts = [];
  for (let v = 0; v < fp.length; v += 2) pts.push([fp[v], fp[v + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let k = pts.length - 1; k >= 0; k--) {
    const q = pts[k];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  return Float32Array.from(h.flat());
}

const MIN_IMPACT = 4; // これ未満の接触（転がりながら触れる程度）はダメージなし
const CELL = 16;      // 有効化判定用の格子 [unit]

/**
 * PLATEAU LOD1 の外形を押し出した建物群。
 * 描画は1つの結合メッシュ、当たり判定は建物ごとの凸包で、高さは max(実高さ, colliderMinH)。
 */
export class Buildings {
  constructor(RAPIER, world, scene, data, opts) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.opts = opts; // { body, unitM, offsetM: {x, z}, heightAt, colliderMinH, exclude(x, z) }
    // 地形と同じ固定ボディに載せる。別ボディだと静止物どうしの接触ペアが棟数分でき、毎ステップ走査される
    this.body = opts.body;
    this.byHandle = new Map();

    const { unitM, offsetM } = opts;
    const n = data.count;
    this.structure = Int16Array.from(data.structure);
    this.usage = Int16Array.from(data.usage);
    this.height = new Float32Array(n);
    this.footprints = new Array(n);
    this.hulls = new Array(n); // 当たり判定と接触判定に使う凸包
    this.center = new Float32Array(n * 2);
    this.hp = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.colliders = new Array(n).fill(null);
    this.radius = new Float32Array(n);
    this.base = new Float32Array(n);
    this.effects = [];
    this.effectMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, transparent: true });
    this.enabled = new Uint8Array(n);
    this.active = [];

    let k = 0;
    for (let i = 0; i < n; i++) {
      const m = data.nverts[i];
      const fp = new Float32Array(m * 2);
      let cx = 0, cz = 0;
      for (let v = 0; v < m; v++) {
        fp[v * 2] = (data.xz_dm[k++] / 10 + offsetM.x) / unitM;
        fp[v * 2 + 1] = (data.xz_dm[k++] / 10 + offsetM.z) / unitM;
        cx += fp[v * 2];
        cz += fp[v * 2 + 1];
      }
      this.footprints[i] = fp;
      this.hulls[i] = hull2d(fp);
      this.center[i * 2] = cx / m;
      this.center[i * 2 + 1] = cz / m;
      this.height[i] = data.height_dm[i] / 10 / unitM;
      let rad = 0;
      for (let v = 0; v < m; v++) {
        rad = Math.max(rad, Math.hypot(fp[v * 2] - cx / m, fp[v * 2 + 1] - cz / m));
      }
      this.radius[i] = rad;
      this.hp[i] = structOf(this.structure[i]).hp;
      this.alive[i] = opts.exclude(cx / m, cz / m) ? 0 : 1;
    }
    this.initialAlive = this.alive.slice();

    // 建物の中心で引く格子索引
    this.cells = new Map();
    for (let i = 0; i < n; i++) {
      const key = this.cellKey(Math.floor(this.center[i * 2] / CELL), Math.floor(this.center[i * 2 + 1] / CELL));
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(i);
    }
    this.maxRadius = this.radius.reduce((a, b) => Math.max(a, b), 0);

    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  // 地形に合わせて描画と当たり判定を作り直す（誇張率の変更時にも呼ぶ）
  rebuild() {
    const { heightAt, colliderMinH } = this.opts;
    const RAPIER = this.RAPIER;
    for (let i = 0; i < this.colliders.length; i++) {
      if (this.colliders[i]) this.world.removeCollider(this.colliders[i], false);
      this.colliders[i] = null;
    }
    this.byHandle.clear();
    this.enabled.fill(0);
    this.active = [];

    // 頂点数を先に数える：壁 6m、屋根 3(m-2)
    let total = 0;
    for (let i = 0; i < this.footprints.length; i++) {
      const m = this.footprints[i].length / 2;
      total += 6 * m + 3 * (m - 2);
    }
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const col = new Uint8Array(total * 3);
    this.range = new Uint32Array(this.footprints.length * 2);
    const c = new THREE.Color();
    let p = 0;

    const put = (x, y, z, nx, ny, nz, r, g, b) => {
      pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
      nor[p * 3] = nx; nor[p * 3 + 1] = ny; nor[p * 3 + 2] = nz;
      col[p * 3] = r; col[p * 3 + 1] = g; col[p * 3 + 2] = b;
      p++;
    };

    for (let i = 0; i < this.footprints.length; i++) {
      const fp = this.footprints[i];
      const m = fp.length / 2;
      const start = p;

      let base = Infinity;
      for (let v = 0; v < m; v++) base = Math.min(base, heightAt(fp[v * 2], fp[v * 2 + 1]));
      base = Math.min(base, heightAt(this.center[i * 2], this.center[i * 2 + 1])) - 0.05;
      const top = base + this.height[i];
      this.base[i] = base;

      c.setHex(structOf(this.structure[i]).color);
      const wr = Math.round(c.r * 255), wg = Math.round(c.g * 255), wb = Math.round(c.b * 255);
      const rr = Math.min(255, wr + 28), rg = Math.min(255, wg + 28), rb = Math.min(255, wb + 28);

      // 向きをそろえる（x 東・z 南で符号付き面積が正）
      let area = 0;
      for (let v = 0; v < m; v++) {
        const w = (v + 1) % m;
        area += fp[v * 2] * fp[w * 2 + 1] - fp[w * 2] * fp[v * 2 + 1];
      }
      const idx = (v) => (area >= 0 ? v : m - 1 - v);

      for (let v = 0; v < m; v++) {
        const a = idx(v), b = idx((v + 1) % m);
        const x0 = fp[a * 2], z0 = fp[a * 2 + 1], x1 = fp[b * 2], z1 = fp[b * 2 + 1];
        const dx = x1 - x0, dz = z1 - z0;
        const len = Math.hypot(dx, dz) || 1;
        const nx = dz / len, nz = -dx / len;
        put(x0, base, z0, nx, 0, nz, wr, wg, wb);
        put(x1, top, z1, nx, 0, nz, wr, wg, wb);
        put(x1, base, z1, nx, 0, nz, wr, wg, wb);
        put(x0, base, z0, nx, 0, nz, wr, wg, wb);
        put(x0, top, z0, nx, 0, nz, wr, wg, wb);
        put(x1, top, z1, nx, 0, nz, wr, wg, wb);
      }
      const contour = [];
      for (let v = 0; v < m; v++) contour.push(new THREE.Vector2(fp[v * 2], fp[v * 2 + 1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (let t = 0; t < m - 2; t++) {
        const tri = tris[t];
        if (!tri) { put(0, 0, 0, 0, 1, 0, 0, 0, 0); put(0, 0, 0, 0, 1, 0, 0, 0, 0); put(0, 0, 0, 0, 1, 0, 0, 0, 0); continue; }
        let [a, b, d] = tri;
        const ny = (fp[b * 2 + 1] - fp[a * 2 + 1]) * (fp[d * 2] - fp[a * 2]) - (fp[b * 2] - fp[a * 2]) * (fp[d * 2 + 1] - fp[a * 2 + 1]);
        if (ny < 0) [b, d] = [d, b];
        for (const v of [a, b, d]) put(fp[v * 2], top, fp[v * 2 + 1], 0, 1, 0, rr, rg, rb);
      }
      this.range[i * 2] = start;
      this.range[i * 2 + 1] = p - start;

      if (!this.alive[i]) {
        pos.fill(0, start * 3, p * 3);
        continue;
      }

      // 当たり判定：外形の凸包を、最低でも colliderMinH の高さまで押し出す
      const hull = this.hulls[i];
      const hm = hull.length / 2;
      const hullTop = base + Math.max(this.height[i], colliderMinH);
      const verts = new Float32Array(hm * 6);
      for (let v = 0; v < hm; v++) {
        verts.set([hull[v * 2], base - 1, hull[v * 2 + 1], hull[v * 2], hullTop, hull[v * 2 + 1]], v * 6);
      }
      const desc = RAPIER.ColliderDesc.convexHull(verts);
      if (!desc) continue;
      // 当たり判定はボールの近くだけ有効にする（updateActive）。
      // 2万棟以上を常時有効にすると、CCD と広域判定で1ステップ 10 ms 以上かかる
      desc.setEnabled(false);
      const s = structOf(this.structure[i]);
      const collider = this.world.createCollider(desc.setRestitution(s.restitution).setFriction(0.2), this.body);
      this.colliders[i] = collider;
      this.byHandle.set(collider.handle, i);
    }

    const g = this.mesh.geometry;
    g.dispose();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    this.mesh.geometry = geom;
  }

  cellKey(cx, cz) {
    return cx * 65536 + cz;
  }

  // 建物の表示と当たり判定をまとめて切り替える（地形だけを見る検証用）
  setVisible(visible) {
    this.hidden = !visible;
    this.mesh.visible = visible;
    if (!visible) {
      for (const i of this.active) {
        if (this.colliders[i]) this.colliders[i].setEnabled(false);
        this.enabled[i] = 0;
      }
      this.active = [];
    }
  }

  // (x, z) から radius 以内に外形がかかる建物だけ当たり判定を有効にする
  updateActive(x, z, radius) {
    if (this.hidden) return;
    const reach = radius + this.maxRadius;
    const c0x = Math.floor((x - reach) / CELL), c1x = Math.floor((x + reach) / CELL);
    const c0z = Math.floor((z - reach) / CELL), c1z = Math.floor((z + reach) / CELL);
    const next = [];
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cz = c0z; cz <= c1z; cz++) {
        const list = this.cells.get(this.cellKey(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (!this.colliders[i]) continue;
          const dx = this.center[i * 2] - x, dz = this.center[i * 2 + 1] - z;
          const r = radius + this.radius[i];
          if (dx * dx + dz * dz < r * r) next.push(i);
        }
      }
    }
    for (const i of next) this.enabled[i] |= 2;
    for (const i of this.active) {
      if (!(this.enabled[i] & 2) && this.colliders[i]) {
        this.colliders[i].setEnabled(false);
        this.enabled[i] = 0;
      }
    }
    for (const i of next) {
      if (!(this.enabled[i] & 1)) this.colliders[i].setEnabled(true);
      this.enabled[i] = 1;
    }
    this.active = next;
  }

  indexOfHandle(handle) {
    return this.byHandle.get(handle);
  }

  // ボール中心から外形への水平方向の単位ベクトル（最近点方向）と距離
  nearest(i, bx, bz) {
    const fp = this.hulls[i];
    const m = fp.length / 2;
    let best = Infinity, px = 0, pz = 0;
    for (let v = 0; v < m; v++) {
      const w = (v + 1) % m;
      const ax = fp[v * 2], az = fp[v * 2 + 1], ex = fp[w * 2] - ax, ez = fp[w * 2 + 1] - az;
      const t = THREE.MathUtils.clamp(((bx - ax) * ex + (bz - az) * ez) / (ex * ex + ez * ez || 1), 0, 1);
      const qx = ax + ex * t, qz = az + ez * t;
      const d = (qx - bx) ** 2 + (qz - bz) ** 2;
      if (d < best) { best = d; px = qx; pz = qz; }
    }
    let dx = px - bx, dz = pz - bz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      dx = this.center[i * 2] - bx; dz = this.center[i * 2 + 1] - bz;
      const l2 = Math.hypot(dx, dz) || 1;
      return [dx / l2, dz / l2, 0];
    }
    return [dx / len, dz / len, len];
  }

  /**
   * 接触している建物の耐久を時間で減らす。傾きで押し付けられて止まる地点をなくすため。
   * 戻り値は加算する得点
   */
  pressure(ballPos, ballR, dps, dt) {
    let points = 0;
    for (const i of this.active) {
      if (!this.alive[i]) continue;
      const [, , d] = this.nearest(i, ballPos.x, ballPos.z);
      if (d > ballR + 0.3) continue;
      this.hp[i] -= dps * dt;
      if (this.hp[i] <= 0) {
        points += Math.round(structOf(this.structure[i]).hp * 10);
        this.destroy(i);
      }
    }
    return points;
  }

  /**
   * 衝突1回分の処理。prevVel は衝突直前のボール速度。
   * 戻り値：null（影響なし）または { destroyed, keep, points }
   */
  hit(i, ballPos, prevVel) {
    if (!this.alive[i]) return null;
    const [nx, nz] = this.nearest(i, ballPos.x, ballPos.z);
    const impact = prevVel.x * nx + prevVel.z * nz;
    if (impact < MIN_IMPACT) return null;
    const s = structOf(this.structure[i]);
    this.hp[i] -= impact;
    if (this.hp[i] > 0) return { destroyed: false };
    this.destroy(i);
    return { destroyed: true, keep: s.keep, points: Math.round(s.hp * 10) };
  }

  destroy(i) {
    this.alive[i] = 0;
    const collider = this.colliders[i];
    if (collider) {
      this.byHandle.delete(collider.handle);
      this.world.removeCollider(collider, false);
      this.colliders[i] = null;
      this.enabled[i] = 0;
    }
    this.active = this.active.filter((k) => k !== i);
    const attr = this.mesh.geometry.attributes.position;
    const start = this.range[i * 2], count = this.range[i * 2 + 1];
    this.spawnEffect(i, start, count);
    const st = structOf(this.structure[i]);
    this.onDestroy?.({
      x: this.center[i * 2], z: this.center[i * 2 + 1], base: this.base[i],
      top: this.base[i] + this.height[i], radius: this.radius[i],
      color: st.color, hp: st.hp, points: st.hp * 10, structure: this.structure[i],
    });
    attr.array.fill(0, start * 3, (start + count) * 3);
    attr.addUpdateRange(start * 3, count * 3);
    attr.needsUpdate = true;
  }

  // 破壊の演出：結合メッシュから該当範囲を切り出し、白く光ってから沈みつつ消える
  spawnEffect(i, start, count) {
    if (this.effects.length >= 160) return; // 一度に大量に壊れたときは省略
    const g = this.mesh.geometry;
    const cx = this.center[i * 2], cz = this.center[i * 2 + 1], by = this.base[i];
    const pos = g.attributes.position.array.slice(start * 3, (start + count) * 3);
    for (let k = 0; k < count; k++) {
      pos[k * 3] -= cx; pos[k * 3 + 1] -= by; pos[k * 3 + 2] -= cz;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(g.attributes.normal.array.slice(start * 3, (start + count) * 3), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(g.attributes.color.array.slice(start * 3, (start + count) * 3), 3, true));
    const mat = this.effectMat.clone();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, by, cz);
    mesh.frustumCulled = false;
    this.mesh.parent.add(mesh);
    this.effects.push({ mesh, t: 0 });
  }

  updateEffects(dt) {
    const DURATION = 0.5;
    for (let k = this.effects.length - 1; k >= 0; k--) {
      const e = this.effects[k];
      e.t += dt;
      const u = Math.min(e.t / DURATION, 1);
      const flash = Math.max(0, 1 - u * 5);
      e.mesh.material.emissive.setScalar(flash * 0.8);
      e.mesh.material.opacity = 1 - u * u;
      e.mesh.scale.set(1 + u * 0.25, Math.max(0.02, 1 - u), 1 + u * 0.25);
      if (u >= 1) {
        e.mesh.removeFromParent();
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        this.effects.splice(k, 1);
      }
    }
  }

  // 破壊状態を初期化
  restore() {
    this.alive.set(this.initialAlive);
    for (let i = 0; i < this.hp.length; i++) this.hp[i] = structOf(this.structure[i]).hp;
    this.rebuild();
  }

  stats() {
    const out = {};
    for (let i = 0; i < this.structure.length; i++) {
      if (!this.initialAlive[i]) continue;
      const code = STRUCTURES[this.structure[i]] ? this.structure[i] : 611;
      const o = (out[code] ??= { total: 0, alive: 0 });
      o.total++;
      if (this.alive[i]) o.alive++;
    }
    return out;
  }
}
