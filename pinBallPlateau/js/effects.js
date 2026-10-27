import * as THREE from 'three';

const MAX_DEBRIS = 3000;
const MAX_RINGS = 48;
const MAX_POPUPS = 14;
const DEBRIS_G = 90; // 破片だけに効かせる見た目用の重力 [unit/s²]

/**
 * 建物破壊の演出：破片の飛散、地面を走る衝撃波、閃光、得点表示、画面の揺れ。
 * 強さは耐久（hp）で決まり、木造は控えめ、RC・SRC 造ほど派手になる。
 */
export class Effects {
  constructor(scene, container) {
    this.scene = scene;
    this.container = container;

    // 破片：InstancedMesh のプール
    this.debris = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.8 }),
      MAX_DEBRIS
    );
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.setColorAt(0, new THREE.Color());
    this.debris.frustumCulled = false;
    this.debris.castShadow = true;
    scene.add(this.debris);
    this.d = {
      pos: new Float32Array(MAX_DEBRIS * 3),
      vel: new Float32Array(MAX_DEBRIS * 3),
      axis: new Float32Array(MAX_DEBRIS * 3),
      spin: new Float32Array(MAX_DEBRIS),
      angle: new Float32Array(MAX_DEBRIS),
      size: new Float32Array(MAX_DEBRIS),
      life: new Float32Array(MAX_DEBRIS),
      floor: new Float32Array(MAX_DEBRIS),
    };
    this.cursor = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_DEBRIS; i++) this.debris.setMatrixAt(i, zero);

    // 衝撃波のリング
    const ringGeom = new THREE.RingGeometry(0.82, 1, 64);
    ringGeom.rotateX(-Math.PI / 2);
    this.rings = [];
    for (let i = 0; i < MAX_RINGS; i++) {
      const m = new THREE.Mesh(
        ringGeom,
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide })
      );
      m.visible = false;
      m.renderOrder = 2;
      scene.add(m);
      this.rings.push({ mesh: m, t: 1, dur: 1, r: 1 });
    }

    // 閃光：ライト数を変えるとシェーダーが作り直されるので1灯を使い回す
    this.flash = new THREE.PointLight(0xfff1d6, 0, 120, 1.6);
    scene.add(this.flash);

    this.popups = 0;
    this.shake = 0;
    this.shakeOffset = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  /**
   * info: { x, z, base, top, radius, color, hp, points }
   * 効果音を付けるときもここが入口になる（strength 0〜1）
   */
  destruction(info, camera) {
    const strength = THREE.MathUtils.clamp(Math.log2(info.hp + 1) / Math.log2(101), 0.15, 1);
    this.burst(info, strength);
    this.ring(info, strength);
    if (strength > 0.55) {
      this.flash.position.set(info.x, info.top + 4, info.z);
      this.flash.intensity = Math.max(this.flash.intensity, 600 * strength);
      this.shake = Math.min(this.shake + strength * 0.9, 2.2);
    }
    this.popup(info, camera, strength);
    return strength;
  }

  burst(info, strength) {
    const d = this.d;
    const n = Math.round(8 + 40 * strength);
    const base = new THREE.Color(info.color);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_DEBRIS;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * info.radius;
      const h = info.base + Math.random() * Math.max(info.top - info.base, 0.4);
      d.pos.set([info.x + Math.cos(a) * r, h, info.z + Math.sin(a) * r], i * 3);
      const out = 12 + Math.random() * 38 * strength;
      d.vel.set([Math.cos(a) * out, 18 + Math.random() * 55 * strength, Math.sin(a) * out], i * 3);
      this._v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      d.axis.set([this._v.x, this._v.y, this._v.z], i * 3);
      d.spin[i] = (Math.random() - 0.5) * 20;
      d.angle[i] = 0;
      d.size[i] = 0.25 + Math.random() * (0.4 + 0.9 * strength);
      d.life[i] = 1.0 + Math.random() * 0.9;
      d.floor[i] = info.base;
      // 半分は建物の色、残りは白っぽい粉塵
      this._c.copy(base).lerp(new THREE.Color(0xffffff), Math.random() < 0.5 ? 0.15 : 0.75);
      this.debris.setColorAt(i, this._c);
    }
    this.debris.instanceColor.needsUpdate = true;
  }

  ring(info, strength) {
    const slot = this.rings.find((r) => r.t >= r.dur);
    if (!slot) return;
    slot.t = 0;
    slot.dur = 0.45 + 0.5 * strength;
    slot.r = info.radius + 6 + 26 * strength;
    slot.mesh.position.set(info.x, info.base + 0.3, info.z);
    slot.mesh.material.color.set(strength > 0.55 ? 0xffe2a8 : 0xffffff);
    slot.mesh.visible = true;
  }

  popup(info, camera, strength) {
    if (this.popups >= MAX_POPUPS) return;
    const rect = this.container.getBoundingClientRect();
    this._v.set(info.x, info.top + 2, info.z).project(camera);
    if (this._v.z > 1) return;
    const el = document.createElement('div');
    el.className = 'popup';
    el.textContent = `+${info.points}`;
    el.style.left = `${((this._v.x + 1) / 2) * rect.width}px`;
    el.style.top = `${((1 - this._v.y) / 2) * rect.height}px`;
    el.style.fontSize = `${12 + 14 * strength}px`;
    el.style.color = `#${new THREE.Color(info.color).multiplyScalar(0.7).getHexString()}`;
    this.container.appendChild(el);
    this.popups++;
    el.addEventListener('animationend', () => { el.remove(); this.popups--; }, { once: true });
  }

  update(dt) {
    const d = this.d;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      if (d.life[i] <= 0) continue;
      d.life[i] -= dt;
      const p = i * 3;
      d.vel[p + 1] -= DEBRIS_G * dt;
      d.pos[p] += d.vel[p] * dt;
      d.pos[p + 1] += d.vel[p + 1] * dt;
      d.pos[p + 2] += d.vel[p + 2] * dt;
      if (d.pos[p + 1] < d.floor[i]) {
        d.pos[p + 1] = d.floor[i];
        d.vel[p + 1] *= -0.3;
        d.vel[p] *= 0.6;
        d.vel[p + 2] *= 0.6;
        d.spin[i] *= 0.6;
      }
      d.angle[i] += d.spin[i] * dt;
      const sc = d.life[i] > 0 ? d.size[i] * Math.min(1, d.life[i] / 0.35) : 0;
      this._v.set(d.axis[p], d.axis[p + 1], d.axis[p + 2]);
      this._q.setFromAxisAngle(this._v, d.angle[i]);
      this._m.compose(this._v.set(d.pos[p], d.pos[p + 1], d.pos[p + 2]), this._q, this._s.setScalar(sc));
      this.debris.setMatrixAt(i, this._m);
    }
    this.debris.instanceMatrix.needsUpdate = true;

    for (const r of this.rings) {
      if (r.t >= r.dur) continue;
      r.t += dt;
      const u = Math.min(r.t / r.dur, 1);
      const e = 1 - (1 - u) ** 3;
      r.mesh.scale.setScalar(0.2 + r.r * e);
      r.mesh.material.opacity = (1 - u) * 0.9;
      if (u >= 1) r.mesh.visible = false;
    }

    this.flash.intensity *= Math.exp(-dt * 10);
    this.shake *= Math.exp(-dt * 7);
  }

  // 描画の前後でカメラを揺らして戻す（視点モードの計算に影響させない）
  beginShake(camera) {
    const a = this.shake;
    this.shakeOffset.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
    camera.position.add(this.shakeOffset);
  }

  endShake(camera) {
    camera.position.sub(this.shakeOffset);
  }
}
