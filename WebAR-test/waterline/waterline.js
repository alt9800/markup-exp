// =====================================================================
// waterline.js — 水面認識 + 3D平面幾何 + 粒子のコア実装
//
// index.html (ライブカメラ) と test.html (静止画テストハーネス) の両方から
// 使う。映像ソースは video でも canvas でもよく、寸法はアクセサで受け取る。
//
// 設計 (v6):
//   認識 (2D): シード群からの領域成長で「水面ポリゴン」のマスクを作り、
//              その輪郭を毎フレーム描画し続ける (ワイヤーフレーム式 —
//              毎フレーム画像から取り直すので対象からずれない)。
//              かつての「水際ラインより下は全部水」という仮定は廃止。
//              運河の楔形の水面や、手前に土手がある川では成り立たないため
//   幾何 (3D): 「水面は水平な平面で、カメラは高さh(仮定)にある」の拘束で
//              マスク内の画素を平面上の3次元座標に逆投影する
//   演出:      泡は水面ポリゴン内の3次元点から生成し、ワールドで上昇。
//              泡の真下の「足元」が水面ポリゴン内にあるか + 水面からの
//              高さ上限で可視判定する (擬似オクルージョン)。
//              岸や船の上に泡が出る「ハリボテ感」をここで抑える
// =====================================================================
window.Waterline = (function () {
    const CONFIG = {
        PROC_WIDTH: 120,        // 画像処理の解像度 (幅)
        DETECT_FPS: 8,
        MIN_REGION_RATIO: 0.02, // 地平線より下に占める最小面積比
        FOV_DEG: 60,            // 縦FOVの仮定
        MAX_DIST: 60,           // これより遠い平面交点は棄却 [m]
        SPAWN_PER_FRAME: 4,
        MAX_PARTICLES: 300,
        RISE_SPEED: [0.1, 0.35],  // 泡の上昇速度 [m/s]
        RISE_LIMIT: 0.8,          // 水面からこの高さで消える [m]
        LIFE: [1.5, 3.5],         // 寿命 [s]
        SIZE: [0.02, 0.05],       // 泡の実サイズ [m]
        COMPANION_DIST: 25,     // 最良クラスタとこの色距離以内の同輩も採用
    };

    // init() で受け取るもの
    let source = null;
    let getW = () => 0;
    let getH = () => 0;
    let layer = null, ctx = null;
    let toleranceInput = null, camHeightInput = null;
    let onStatus = () => {};

    const procCanvas = document.createElement('canvas');
    const procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d');

    let seed = null;           // タップ指定時のみ {x, y} (ソース座標比)
    let maskGrid = null;       // 水面マスク (proc解像度, Uint8Array)
    let contour = null;        // マスク輪郭画素のインデックス配列
    let maskImage = null;      // 表示用の着色マスク
    let waterPixels = [];      // マスク画素のインデックス (泡のスポーン元)
    let procSize = null;
    let particles = [];
    let lastTime = null;
    let running = false;
    let debug = {};            // 直近の検出の内部統計 (チューニング用)

    // ---------------------------------------------------------------
    // 姿勢: DeviceOrientation → クォータニオン (W3C仕様の Z-X'-Y'' 順)
    // ワールド座標系は X=東, Y=上, Z=南。カメラは原点固定 (3DoF)。
    // ---------------------------------------------------------------
    let deviceQuat = [1, 0, 0, 0];   // [w, x, y, z]
    const DEG = Math.PI / 180;

    function setOrientation(alpha, beta, gamma) {
        if (alpha === null || beta === null) return;
        const _z = alpha * DEG / 2, _x = beta * DEG / 2, _y = (gamma || 0) * DEG / 2;
        const cX = Math.cos(_x), cY = Math.cos(_y), cZ = Math.cos(_z);
        const sX = Math.sin(_x), sY = Math.sin(_y), sZ = Math.sin(_z);
        deviceQuat = [
            cX * cY * cZ - sX * sY * sZ,
            sX * cY * cZ - cX * sY * sZ,
            cX * sY * cZ + sX * cY * sZ,
            cX * cY * sZ + sX * sY * cZ,
        ];
    }

    function quatRotate(q, v) {
        const [w, x, y, z] = q;
        const [vx, vy, vz] = v;
        const tx = 2 * (y * vz - z * vy);
        const ty = 2 * (z * vx - x * vz);
        const tz = 2 * (x * vy - y * vx);
        return [
            vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx),
        ];
    }
    const quatConj = q => [q[0], -q[1], -q[2], -q[3]];

    // デバイス座標 (X右, Y上, Z手前 / 背面カメラは-Z向き) ⇔ ワールド座標
    function deviceToWorld(v) {
        const e = quatRotate(deviceQuat, v);   // → 地球座標 (E, N, U)
        return [e[0], e[2], -e[1]];            // → (東, 上, 南)
    }
    function worldToDevice(v) {
        const e = [v[0], -v[2], v[1]];
        return quatRotate(quatConj(deviceQuat), e);
    }

    function focalPx() {
        return (innerHeight / 2) / Math.tan(CONFIG.FOV_DEG * DEG / 2);
    }

    // 画面座標 → 水平面 (y = -カメラ高さ) 上のワールド座標。交点がなければ null
    function screenToPlane(sx, sy) {
        const f = focalPx();
        const d = [(sx - innerWidth / 2) / f, -(sy - innerHeight / 2) / f, -1];
        const dw = deviceToWorld(d);
        const h = Number(camHeightInput.value);
        if (dw[1] >= -0.01) return null;
        const t = -h / dw[1];
        if (t <= 0 || t * Math.hypot(dw[0], dw[2]) > CONFIG.MAX_DIST) return null;
        return [dw[0] * t, -h, dw[2] * t];
    }

    // ワールド座標 → 画面座標と距離。カメラの後ろなら null
    function worldToScreen(p) {
        const d = worldToDevice(p);
        if (d[2] > -0.1) return null;
        const f = focalPx();
        const inv = 1 / -d[2];
        return {
            x: innerWidth / 2 + d[0] * f * inv,
            y: innerHeight / 2 - d[1] * f * inv,
            dist: -d[2],
        };
    }

    // object-fit: cover と同じソース座標⇔画面座標の変換パラメータ
    function coverTransform() {
        const vw = getW(), vh = getH();
        const scale = Math.max(innerWidth / vw, innerHeight / vh);
        return {
            scale,
            ox: (innerWidth - vw * scale) / 2,
            oy: (innerHeight - vh * scale) / 2,
        };
    }

    // 画面座標が水面マスクの中か (泡の可視判定に使う)
    function maskAtScreen(sx, sy) {
        if (!maskGrid || !procSize) return false;
        const { W, H } = procSize;
        const { scale, ox, oy } = coverTransform();
        const s = getW() / W;
        const px = Math.floor((sx - ox) / scale / s);
        const py = Math.floor((sy - oy) / scale / s);
        return px >= 0 && px < W && py >= 0 && py < H && maskGrid[py * W + px] === 1;
    }

    // ---------------------------------------------------------------
    // 水面認識: シード群からの領域成長 + クラスタ選別 + 輪郭抽出
    // ---------------------------------------------------------------
    function detectWater() {
        const vw = getW(), vh = getH();
        if (!vw) return false;
        const W = CONFIG.PROC_WIDTH;
        const H = Math.round(W * vh / vw);
        procSize = { W, H };
        procCanvas.width = W;
        procCanvas.height = H;
        procCtx.drawImage(source, 0, 0, W, H);
        const src = procCtx.getImageData(0, 0, W, H).data;

        // 色の比較は「輝度に鈍く、色味に敏感」にする。
        // 水面は空の反射 (明) と影・藻 (暗) で輝度が大きく割れる一方、
        // 色味は保たれやすい。特徴量: [Y, Cr(R-Y), Cb(B-Y)]
        function features(o) {
            const r = src[o], g = src[o + 1], b = src[o + 2];
            const y = 0.299 * r + 0.587 * g + 0.114 * b;
            return [y, r - y, b - y];
        }
        function dist(f, c) {
            return 0.25 * Math.abs(f[0] - c[0])
                 + 1.6 * (Math.abs(f[1] - c[1]) + Math.abs(f[2] - c[2]));
        }

        // テクスチャ判定用の輝度勾配。水面は滑らか、植生・護岸・船は高テクスチャ
        const luma = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) {
            const o = i * 4;
            luma[i] = 0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2];
        }
        const grad = new Float32Array(W * H);
        for (let y = 1; y < H - 1; y++) {
            for (let x = 1; x < W - 1; x++) {
                const i = y * W + x;
                grad[i] = Math.abs(luma[i + 1] - luma[i - 1])
                        + Math.abs(luma[i + W] - luma[i - W]);
            }
        }

        // 幾何制約: 地平線より上は水ではありえない。
        // 現在のカメラ姿勢で水平面が見える最上端の行を求め、BFSをそこに制限する
        const ct = coverTransform();
        let horizonRow = 0;
        for (let y = 0; y < H; y++) {
            const screenY = y * (vw / W) * ct.scale + ct.oy;
            if (screenToPlane(innerWidth / 2, screenY)) { horizonRow = y; break; }
            horizonRow = y + 1;
        }

        // シード: タップ指定時はその1点。既定では画面の中〜下部に格子状に
        // ばら撒く (手前が土手で水面が画面中段にある構図にも届くように)
        const seedPoints = seed
            ? [seed]
            : [0.15, 0.3, 0.5, 0.7, 0.85].flatMap(x =>
                  [0.5, 0.65, 0.8, 0.9].map(y => ({ x, y })));

        // 各シードの3x3平均をクラスタ中心にする (近い色のクラスタは統合)
        const clusters = [];
        for (const sp of seedPoints) {
            const sx = Math.min(W - 1, Math.max(0, Math.round(sp.x * W)));
            const sy = Math.min(H - 1, Math.max(0, Math.round(sp.y * H)));
            if (sy < horizonRow) continue;
            let f = [0, 0, 0], c = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = sx + dx, y = sy + dy;
                    if (x < 0 || x >= W || y < 0 || y >= H) continue;
                    const ff = features((y * W + x) * 4);
                    f[0] += ff[0]; f[1] += ff[1]; f[2] += ff[2]; c++;
                }
            }
            f = f.map(v => v / c);
            const near = clusters.find(cl => dist(f, cl.f) < 20);
            if (near) {
                near.seeds.push(sy * W + sx);
            } else {
                clusters.push({ f, f0: f.slice(), seeds: [sy * W + sx] });
            }
        }
        if (clusters.length === 0) {
            debug = { reason: 'no seeds below horizon' };
            maskGrid = null; contour = null; maskImage = null; waterPixels = [];
            return false;
        }

        // マルチソースBFS: 受理画素に最寄りクラスタのラベルを付ける
        const thr = Number(toleranceInput.value) * 3;
        const visited = new Uint8Array(W * H);
        const labels = new Int8Array(W * H).fill(-1);
        const queue = new Int32Array(W * H);
        let head = 0, tail = 0;
        for (const cl of clusters) {
            for (const si of cl.seeds) {
                if (!visited[si]) { visited[si] = 1; queue[tail++] = si; }
            }
        }

        const counts = new Array(clusters.length).fill(0);
        const gradSums = new Array(clusters.length).fill(0);
        const colMin = new Array(clusters.length).fill(Infinity);
        const colMax = new Array(clusters.length).fill(-1);

        while (head < tail) {
            const i = queue[head++];
            if (((i / W) | 0) < horizonRow) continue;   // 地平線より上は水ではない
            const f = features(i * 4);
            let best = -1, bestD = Infinity;
            for (let k = 0; k < clusters.length; k++) {
                const d = dist(f, clusters[k].f);
                if (d < bestD) { bestD = d; best = k; }
            }
            if (bestD > thr) continue;
            labels[i] = best;
            counts[best]++;
            gradSums[best] += grad[i];
            const x = i % W, y = (i / W) | 0;
            if (x < colMin[best]) colMin[best] = x;
            if (x > colMax[best]) colMax[best] = x;
            // 受理画素で最寄りクラスタの中心を微更新。初期中心から離れた画素では
            // 更新しない (平均が岸の色まで歩いてしまう事故の防止)
            const cl2 = clusters[best];
            if (dist(f, cl2.f0) < 25) {
                cl2.f[0] += (f[0] - cl2.f[0]) * 0.002;
                cl2.f[1] += (f[1] - cl2.f[1]) * 0.002;
                cl2.f[2] += (f[2] - cl2.f[2]) * 0.002;
            }

            if (x > 0 && !visited[i - 1]) { visited[i - 1] = 1; queue[tail++] = i - 1; }
            if (x < W - 1 && !visited[i + 1]) { visited[i + 1] = 1; queue[tail++] = i + 1; }
            if (y > 0 && !visited[i - W]) { visited[i - W] = 1; queue[tail++] = i - W; }
            if (y < H - 1 && !visited[i + W]) { visited[i + W] = 1; queue[tail++] = i + W; }
        }

        // クラスタ選別: 「広くて滑らか」を水面らしさとして最良クラスタを選び、
        // それと色の近い同輩 (明暗で割れた同じ水面) も併せて採用する。
        // サイズや接地では判定しない — 楔形の運河や手前が土手の川があるため
        const total = W * (H - horizonRow) || 1;
        const textures = clusters.map((cl, k) =>
            counts[k] > 0 ? gradSums[k] / counts[k] : Infinity);
        const scores = clusters.map((cl, k) => {
            if (counts[k] < total * 0.01) return -1;
            const span = colMax[k] - colMin[k] + 1;
            return span * counts[k] / (textures[k] + 3);
        });
        let bestK = -1;
        for (let k = 0; k < clusters.length; k++) {
            if (scores[k] > (bestK < 0 ? -1 : scores[bestK])) bestK = k;
        }
        if (bestK < 0) {
            debug = { reason: 'no viable cluster' };
            maskGrid = null; contour = null; maskImage = null; waterPixels = [];
            return false;
        }
        const keep = clusters.map((cl, k) =>
            scores[k] > 0 &&
            (k === bestK || dist(cl.f, clusters[bestK].f) < CONFIG.COMPANION_DIST));

        // マスク・輪郭・スポーン画素・表示用画像を作る
        const mask = new Uint8Array(W * H);
        let accepted = 0;
        for (let i = 0; i < W * H; i++) {
            if (labels[i] >= 0 && keep[labels[i]]) { mask[i] = 1; accepted++; }
        }

        debug = {
            clusters: clusters.map((cl, k) => ({
                f: cl.f.map(v => +v.toFixed(1)),
                count: counts[k],
                texture: +textures[k].toFixed(1),
                score: +scores[k].toFixed(0),
                kept: keep[k],
            })),
            horizonRow,
            ratio: +(accepted / total).toFixed(3),
            reason: null,
        };
        if (accepted < total * CONFIG.MIN_REGION_RATIO) {
            debug.reason = 'region too small';
            maskGrid = null; contour = null; maskImage = null; waterPixels = [];
            return false;
        }

        const newContour = [];
        waterPixels = [];
        const img = maskCtx.createImageData(W, H);
        for (let i = 0; i < W * H; i++) {
            if (!mask[i]) continue;
            waterPixels.push(i);
            const o = i * 4;
            img.data[o] = 120; img.data[o + 1] = 220; img.data[o + 2] = 255;
            img.data[o + 3] = 26;
            const x = i % W, y = (i / W) | 0;
            if (x === 0 || x === W - 1 || y === 0 || y === H - 1 ||
                !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) {
                newContour.push(i);
            }
        }
        maskGrid = mask;
        contour = newContour;
        maskImage = img;
        return true;
    }

    function detectLoop() {
        if (!running) return;
        if (detectWater()) {
            onStatus('水面を認識中 (ずれるときは水面をタップ)');
        } else {
            onStatus('水面が見つかりません。画面に映った水面をタップしてください');
        }
        setTimeout(detectLoop, 1000 / CONFIG.DETECT_FPS);
    }

    // ---------------------------------------------------------------
    // 泡 (ワールド座標)
    // ---------------------------------------------------------------
    function spawnParticles() {
        if (waterPixels.length === 0 || !procSize) return;
        const { W } = procSize;
        const { scale, ox, oy } = coverTransform();
        const s = getW() / W;

        for (let n = 0; n < CONFIG.SPAWN_PER_FRAME; n++) {
            if (particles.length >= CONFIG.MAX_PARTICLES) break;
            const i = waterPixels[(Math.random() * waterPixels.length) | 0];
            const px = (i % W + Math.random()) * s * scale + ox;
            const py = (((i / W) | 0) + Math.random()) * s * scale + oy;
            const p = screenToPlane(px, py);
            if (!p) continue;
            particles.push({
                pos: p,
                vy: CONFIG.RISE_SPEED[0] + Math.random() * (CONFIG.RISE_SPEED[1] - CONFIG.RISE_SPEED[0]),
                sway: (Math.random() - 0.5) * 0.15,
                phase: Math.random() * Math.PI * 2,
                life: CONFIG.LIFE[0] + Math.random() * (CONFIG.LIFE[1] - CONFIG.LIFE[0]),
                age: 0,
                size: CONFIG.SIZE[0] + Math.random() * (CONFIG.SIZE[1] - CONFIG.SIZE[0]),
            });
        }
    }

    function render(time) {
        if (!running) return;
        const dt = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, 0.05);
        lastTime = time;

        const dpr = devicePixelRatio;
        ctx.clearRect(0, 0, layer.width, layer.height);
        ctx.save();
        ctx.scale(dpr, dpr);

        // 認識した水面ポリゴンをうっすら着色
        if (maskImage && procSize) {
            const { W, H } = procSize;
            maskCanvas.width = W;
            maskCanvas.height = H;
            maskCtx.putImageData(maskImage, 0, 0);
            const vw = getW(), vh = getH();
            const { scale, ox, oy } = coverTransform();
            ctx.drawImage(maskCanvas, ox, oy, vw * scale, vh * scale);
        }

        ctx.globalCompositeOperation = 'lighter';

        // 水面ポリゴンの輪郭を毎フレーム描く (ワイヤーフレーム式)
        if (contour && procSize) {
            const { W } = procSize;
            const { scale, ox, oy } = coverTransform();
            const s = getW() / W;
            const r = Math.max(1.2, s * scale * 0.55);
            ctx.fillStyle = 'rgba(140, 235, 255, 0.5)';
            for (const i of contour) {
                const x = (i % W + 0.5) * s * scale + ox;
                const y = (((i / W) | 0) + 0.5) * s * scale + oy;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // 泡: ワールドで上昇 → 現在の姿勢で投影。
        // 可視条件 = 足元 (真下の水面上の点) が水面ポリゴン内にあること。
        // 岸・船・空の上に泡が出るのを防ぎ、水面の形に沿った奥行きが出る
        spawnParticles();
        const f = focalPx();
        const camH = Number(camHeightInput.value);
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.age += dt;
            const height = p.pos[1] + camH;   // 水面からの高さ
            if (p.age > p.life || height > CONFIG.RISE_LIMIT) {
                particles.splice(i, 1);
                continue;
            }
            p.pos[1] += p.vy * dt;
            p.pos[0] += Math.sin(p.age * 3 + p.phase) * p.sway * dt;

            const sp = worldToScreen(p.pos);
            if (!sp) continue;
            const foot = worldToScreen([p.pos[0], -camH, p.pos[2]]);
            if (!foot || !maskAtScreen(foot.x, foot.y)) continue;

            const r = p.size * f / sp.dist;
            if (r < 0.3) continue;

            const t = p.age / p.life;
            let alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
            alpha *= 1 - Math.max(0, height / CONFIG.RISE_LIMIT - 0.6) / 0.4;  // 上限付近でフェード
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(180, 240, 255, ${Math.max(0, alpha) * 0.8})`;
            ctx.fill();
        }

        ctx.restore();
        requestAnimationFrame(render);
    }

    // ---------------------------------------------------------------
    // 公開API
    // ---------------------------------------------------------------
    function resize() {
        layer.width = innerWidth * devicePixelRatio;
        layer.height = innerHeight * devicePixelRatio;
    }

    // 画面座標でシードを指定 (タップ)
    function setSeedFromScreen(sx, sy) {
        const { scale, ox, oy } = coverTransform();
        const x = (sx - ox) / scale / getW();
        const y = (sy - oy) / scale / getH();
        if (x < 0 || x > 1 || y < 0 || y > 1) return false;
        seed = { x, y };
        particles = [];
        return true;
    }

    function init(opts) {
        source = opts.source;
        getW = opts.getW;
        getH = opts.getH;
        layer = opts.layer;
        ctx = layer.getContext('2d');
        toleranceInput = opts.toleranceInput;
        camHeightInput = opts.camHeightInput;
        onStatus = opts.onStatus || (() => {});

        window.addEventListener('resize', resize);
        resize();
        running = true;
        detectLoop();
        requestAnimationFrame(render);
    }

    function reset() {
        seed = null;
        maskGrid = null;
        contour = null;
        maskImage = null;
        waterPixels = [];
        particles = [];
    }

    return {
        CONFIG, init, reset, resize,
        setOrientation, setSeedFromScreen,
        // テスト・デバッグ用の内部状態アクセス
        get contour() { return contour; },
        get particles() { return particles; },
        get waterPixels() { return waterPixels; },
        get debug() { return debug; },
    };
})();
