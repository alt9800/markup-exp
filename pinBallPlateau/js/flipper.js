import * as THREE from 'three';

// 2D凸包（Andrew's monotone chain）。点は [x, z]
function convexHull2D(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// 根元半径 r0、先端半径 r1、長さ len のテーパー付きカプセル外形（ローカル座標、+x 方向に伸びる）
function flipperOutline(len, r0, r1, dir) {
  const pts = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * r0, Math.sin(a) * r0]);
    pts.push([dir * len + Math.cos(a) * r1, Math.sin(a) * r1]);
  }
  return convexHull2D(pts);
}

/**
 * Y軸（盤面法線）まわりに回転するキネマティックなフリッパー。
 * side: 'left' は +x 方向、'right' は -x 方向に伸びる。
 * 角度は「水平から盤面下側（手前）へ何度下がっているか」で指定する。
 */
export class Flipper {
  constructor(RAPIER, world, scene, opts) {
    const {
      side, pivot, length = 1.7, r0 = 0.25, r1 = 0.12, height = 0.5,
      restDeg = 30, upDeg = -28, color = 0x2b4a6f,
    } = opts;
    this.RAPIER = RAPIER;
    this.side = side;
    this.dir = side === 'left' ? 1 : -1;
    this.restAngle = THREE.MathUtils.degToRad(restDeg);
    this.upAngle = THREE.MathUtils.degToRad(upDeg);
    this.angle = this.restAngle;
    this.pressed = false;
    this.speed = 30; // rad/s
    this.length = length;

    const outline = flipperOutline(length, r0, r1, this.dir);

    // 物理：外形を上下に押し出した凸包
    const verts = new Float32Array(outline.length * 6);
    outline.forEach(([x, z], i) => {
      verts.set([x, 0.02, z, x, height, z], i * 6);
    });
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pivot.x, pivot.y ?? 0, pivot.z)
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.convexHull(verts).setRestitution(0.3).setFriction(0.4),
      this.body
    );

    // 描画：同じ外形を ExtrudeGeometry に
    const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geom.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 })
    );
    this.mesh.castShadow = true;
    this.mesh.position.set(pivot.x, pivot.y ?? 0, pivot.z);
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(r0 * 0.32, r0 * 0.32, height * 1.04, 16),
      new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.8, roughness: 0.3 })
    );
    pin.position.y = height / 2;
    this.mesh.add(pin);
    scene.add(this.mesh);

    this._q = new THREE.Quaternion();
    this._axis = new THREE.Vector3(0, 1, 0);
    this.applyRotation(true);
  }

  // left: 回転角 θ で +x が (cosθ, 0, -sinθ) へ。下がり角 a に対し θ = -a
  // right: -x が (-cosθ, 0, sinθ) へ。θ = a
  rotationFor(angle) {
    return this.dir === 1 ? -angle : angle;
  }

  applyRotation(immediate = false) {
    this._q.setFromAxisAngle(this._axis, this.rotationFor(this.angle));
    const q = { x: this._q.x, y: this._q.y, z: this._q.z, w: this._q.w };
    if (immediate) this.body.setRotation(q, true);
    else this.body.setNextKinematicRotation(q);
  }

  // 物理ステップごとに呼ぶ
  step(dt) {
    const target = this.pressed ? this.upAngle : this.restAngle;
    const maxDelta = this.speed * dt;
    const d = target - this.angle;
    this.angle += Math.abs(d) <= maxDelta ? d : Math.sign(d) * maxDelta;
    this.applyRotation();
  }

  // 描画フレームごとに呼ぶ
  sync() {
    const r = this.body.rotation();
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }

  // 地形の高さが変わったときに台座の高さを合わせる
  setBaseY(y) {
    const t = this.body.translation();
    this.body.setTranslation({ x: t.x, y, z: t.z }, true);
    this.mesh.position.y = y;
  }

  setRestitution(v) {
    this.collider.setRestitution(v);
  }
}
