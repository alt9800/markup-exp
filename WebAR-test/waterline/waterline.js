// =====================================================================
// waterline.js — 水面認識 + 3D平面幾何 + 粒子のコア実装
//
// index.html (ライブカメラ) と test.html (静止画テストハーネス) の両方から
// 使う。映像ソースは video でも canvas でもよく、寸法はアクセサで受け取る。
//
//   画像処理 (2D): シード点からの領域成長で「どの画素が水か」のマスクを作る
//   幾何 (3D):     「水面は水平な平面で、カメラはその高さh(仮定)にある」
//                  という拘束のもと、水画素のレイと平面の交点を計算して
//                  スクリーン座標を3次元座標に逆投影する
//   演出:          粒子は水面上の3次元点から生成し、ワールド座標で上昇。
//                  毎フレーム、現在のカメラ姿勢で投影し直す
// =====================================================================
window.Waterline = (function () {
    const CONFIG = {
        PROC_WIDTH: 120,        // 画像処理の解像度 (幅)
        DETECT_FPS: 8,
        SEED_DEFAULT: { x: 0.5, y: 0.85 },  // ソース座標比のシード初期値
        MAX_REGION_RATIO: 0.75, // 領域がこれ以上に広がったら誤認識として棄却
        MIN_REGION_RATIO: 0.02,
        MIN_COL_RATIO: 0.25,
        EMA: 0.35,              // 水際ラインの時間平滑
        FOV_DEG: 60,            // 縦FOVの仮定
        MAX_DIST: 60,           // これより遠い交点は棄却 [m]
        SPAWN_PER_FRAME: 4,
        MAX_PARTICLES: 300,
        RISE_SPEED: [0.15, 0.5],  // 上昇速度 [m/s]
        LIFE: [1.5, 3.5],         // 寿命 [s]
        SIZE: [0.02, 0.05],       // 粒子の実サイズ [m]
    };

    // init() で受け取るもの
    let source = null;          // 映像ソース要素 (video または canvas)
    let getW = () => 0;         // ソースの幅/高さ
    let getH = () => 0;
    let layer = null, ctx = null;
    let toleranceInput = null, camHeightInput = null;
    let onStatus = () => {};

    const procCanvas = document.createElement('canvas');
    const procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d');

    let seed = { ...CONFIG.SEED_DEFAULT };
    let boundary = null;       // 水際ライン (画面座標の折れ線)
    let maskImage = null;      // 水面マスク (proc解像度)
    let waterPixels = [];      // 受理画素のインデックス
    let procSize = null;
    let particles = [];
    let lastTime = null;
    let running = false;

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

    // ---------------------------------------------------------------
    // 水面マスク: シード点からの領域成長 (2D)
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
        // 色味は保たれやすい (実写の池・運河の写真での観察に基づく)。
        // 特徴量: [Y(輝度), Cr(R-Y), Cb(B-Y)]、距離 = 0.35|dY| + 1.3(|dCr|+|dCb|)
        function features(o) {
            const r = src[o], g = src[o + 1], b = src[o + 2];
            const y = 0.299 * r + 0.587 * g + 0.114 * b;
            return [y, r - y, b - y];
        }
        function dist(f, c) {
            return 0.35 * Math.abs(f[0] - c[0])
                 + 1.3 * (Math.abs(f[1] - c[1]) + Math.abs(f[2] - c[2]));
        }

        // シード: ユーザーがタップした場合はその1点、既定では画面下部に
        // 複数ばら撒く (最下部が手すり・船べり等でも他のシードが生き残る)
        const seedPoints = seed.tapped
            ? [seed]
            : [0.15, 0.3, 0.5, 0.7, 0.85].flatMap(x => [
                  { x, y: 0.9 }, { x, y: 0.75 },
              ]);

        // 各シードの3x3平均をクラスタ中心にする (近すぎるクラスタは統合)
        const clusters = [];
        for (const sp of seedPoints) {
            const sx = Math.min(W - 1, Math.max(0, Math.round(sp.x * W)));
            const sy = Math.min(H - 1, Math.max(0, Math.round(sp.y * H)));
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
                clusters.push({ f, seeds: [sy * W + sx] });
            }
        }

        // マルチソースBFS: いずれかのクラスタに近い画素を連結領域として成長。
        // visited = 訪問済み (再enqueue防止)、mask = 受理した水面画素
        const thr = Number(toleranceInput.value) * 3;
        const visited = new Uint8Array(W * H);
        const mask = new Uint8Array(W * H);
        const queue = new Int32Array(W * H);
        let head = 0, tail = 0, accepted = 0;
        for (const cl of clusters) {
            for (const si of cl.seeds) {
                if (!visited[si]) { visited[si] = 1; queue[tail++] = si; }
            }
        }

        while (head < tail) {
            const i = queue[head++];
            const f = features(i * 4);
            let best = null, bestD = Infinity;
            for (const cl of clusters) {
                const d = dist(f, cl.f);
                if (d < bestD) { bestD = d; best = cl; }
            }
            if (bestD > thr) continue;
            mask[i] = 1;
            accepted++;
            // 受理画素で最寄りクラスタの中心を微更新 (緩やかな色変化に追従)
            best.f[0] += (f[0] - best.f[0]) * 0.002;
            best.f[1] += (f[1] - best.f[1]) * 0.002;
            best.f[2] += (f[2] - best.f[2]) * 0.002;

            const x = i % W, y = (i / W) | 0;
            if (x > 0 && !visited[i - 1]) { visited[i - 1] = 1; queue[tail++] = i - 1; }
            if (x < W - 1 && !visited[i + 1]) { visited[i + 1] = 1; queue[tail++] = i + 1; }
            if (y > 0 && !visited[i - W]) { visited[i - W] = 1; queue[tail++] = i - W; }
            if (y < H - 1 && !visited[i + W]) { visited[i + W] = 1; queue[tail++] = i + W; }
        }

        const ratio = accepted / (W * H);
        if (ratio > CONFIG.MAX_REGION_RATIO || ratio < CONFIG.MIN_REGION_RATIO) {
            boundary = null; maskImage = null; waterPixels = [];
            return false;
        }

        // 列ごとの最上端 → 水際ライン
        const tops = new Float32Array(W).fill(-1);
        let cols = 0;
        for (let x = 0; x < W; x++) {
            for (let y = 0; y < H; y++) {
                if (mask[y * W + x]) { tops[x] = y; cols++; break; }
            }
        }
        if (cols < W * CONFIG.MIN_COL_RATIO) {
            boundary = null; maskImage = null; waterPixels = [];
            return false;
        }

        // 水がない列は近傍から補間し、メディアン平滑 (幅5)
        let prev = -1;
        for (let x = 0; x < W; x++) {
            if (tops[x] >= 0) prev = tops[x];
            else if (prev >= 0) tops[x] = prev;
        }
        for (let x = W - 1, next = -1; x >= 0; x--) {
            if (tops[x] >= 0) next = tops[x];
            else if (next >= 0) tops[x] = next;
        }
        const smoothed = new Float32Array(W);
        for (let x = 0; x < W; x++) {
            const win = [];
            for (let k = -2; k <= 2; k++) {
                win.push(tops[Math.min(W - 1, Math.max(0, x + k))]);
            }
            win.sort((a, b) => a - b);
            smoothed[x] = win[2];
        }

        // 水際より下は水として穴を埋める。表示用マスクとスポーン画素リストを更新
        const img = maskCtx.createImageData(W, H);
        waterPixels = [];
        for (let x = 0; x < W; x++) {
            const top = Math.round(smoothed[x]);
            for (let y = top; y < H; y++) {
                const o = (y * W + x) * 4;
                img.data[o] = 120;
                img.data[o + 1] = 220;
                img.data[o + 2] = 255;
                img.data[o + 3] = 28;
                waterPixels.push(y * W + x);
            }
        }
        maskImage = img;

        // 水際ライン: ソース座標 → 画面座標
        const { scale, ox, oy } = coverTransform();
        const s = vw / W;
        const pts = [];
        for (let x = 0; x < W; x += 2) {
            pts.push({ x: x * s * scale + ox, y: smoothed[x] * s * scale + oy });
        }
        if (boundary && boundary.length === pts.length) {
            for (let i = 0; i < pts.length; i++) {
                boundary[i].y += (pts[i].y - boundary[i].y) * CONFIG.EMA;
                boundary[i].x = pts[i].x;
            }
        } else {
            boundary = pts;
        }
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
    // 粒子 (ワールド座標)
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

        // 認識した水面をうっすら着色
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

        // 水際ライン
        if (boundary) {
            ctx.beginPath();
            ctx.moveTo(boundary[0].x, boundary[0].y);
            for (const p of boundary) ctx.lineTo(p.x, p.y);
            ctx.strokeStyle = 'rgba(140, 235, 255, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // 粒子: ワールドで上昇 → 現在のカメラ姿勢で投影
        spawnParticles();
        const f = focalPx();
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.age += dt;
            if (p.age > p.life) { particles.splice(i, 1); continue; }
            p.pos[1] += p.vy * dt;
            p.pos[0] += Math.sin(p.age * 3 + p.phase) * p.sway * dt;

            const sp = worldToScreen(p.pos);
            if (!sp) continue;
            const r = p.size * f / sp.dist;
            if (r < 0.3) continue;

            const t = p.age / p.life;
            const alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(180, 240, 255, ${alpha * 0.8})`;
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
        seed = { x, y, tapped: true };
        boundary = null;
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
        seed = { ...CONFIG.SEED_DEFAULT };
        boundary = null;
        maskImage = null;
        waterPixels = [];
        particles = [];
    }

    return {
        CONFIG, init, reset, resize,
        setOrientation, setSeedFromScreen,
        // テスト・デバッグ用の内部状態アクセス
        get boundary() { return boundary; },
        get particles() { return particles; },
        get waterPixels() { return waterPixels; },
    };
})();
