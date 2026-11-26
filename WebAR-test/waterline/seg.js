// =====================================================================
// seg.js — 端末内セマンティックセグメンテーション (段0.7)
//
// transformers.js + SegFormer-B0 (ADE20K学習済み、waterクラスあり) で
// 現在のフレームから水面マスクを一発推定する。サーバーは使わない
// (モデル約15MBはHugging Face CDNから初回のみダウンロード)。
//
// 役割分担:
//   ML (このファイル): 「どの画素が水か」を意味論で一発判定する。
//                      推論は数百ms〜数秒かかるので毎フレームは回せない
//   色ベース追従 (waterline.js): MLマスクをシードと選別の事前知識として
//                      受け取り、毎フレームの追従は従来の領域成長で行う
//
// 色ベース手法の原理的な天井 (水面 = 環境の鏡像 + 吸収、色では定義
// しきれない) を、学習済みモデルの意味論で補うのが目的。
// =====================================================================
window.WaterSeg = (function () {
    const MODEL = 'Xenova/segformer-b0-finetuned-ade-512-512';
    const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';
    // ADE20K 150クラスのうち水に相当するもの (完全一致で判定。
    // 部分一致だと 'pool table' などを誤って拾う)
    const WATER_LABELS = new Set([
        'water', 'sea', 'river', 'lake', 'swimming pool', 'waterfall', 'fountain',
    ]);

    let segPipe = null;
    let loadPromise = null;
    let device = null;         // 実際に使われたバックエンド ('webgpu' | 'wasm')

    // 推論入力用 (長辺512程度に縮小して渡す)
    const inCanvas = document.createElement('canvas');
    const inCtx = inCanvas.getContext('2d', { willReadFrequently: true });

    // モデルの読み込み。二重呼び出しは同じPromiseを返す。
    // onProgress(text) で進捗をUIに流す
    function load(onProgress = () => {}) {
        if (loadPromise) return loadPromise;
        loadPromise = (async () => {
            const { pipeline } = await import(CDN);
            const progress_callback = p => {
                if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
                    onProgress(`モデルを取得中 ${Math.round(p.progress || 0)}%`);
                }
            };
            // WebGPUが使えれば使う (WASM比で数倍速い)。失敗したらWASM
            try {
                segPipe = await pipeline('image-segmentation', MODEL,
                    { device: 'webgpu', progress_callback });
                device = 'webgpu';
            } catch (e) {
                onProgress('WebGPU不可、WASMで読み込み中');
                segPipe = await pipeline('image-segmentation', MODEL,
                    { device: 'wasm', progress_callback });
                device = 'wasm';
            }
            return segPipe;
        })();
        loadPromise.catch(() => { loadPromise = null; });   // 失敗時は再試行可能に
        return loadPromise;
    }

    // 現在のフレームを推論し、水クラスの合成マスクを返す。
    // 戻り値: { data: Uint8Array(0/1), W, H, labels: [検出された水系ラベル] }
    // 水系クラスが見つからなければ null
    async function segment(source, sw, sh) {
        if (!segPipe) throw new Error('load() を先に呼ぶこと');
        const scale = Math.min(1, 512 / Math.max(sw, sh));
        const W = Math.max(8, Math.round(sw * scale));
        const H = Math.max(8, Math.round(sh * scale));
        inCanvas.width = W;
        inCanvas.height = H;
        inCtx.drawImage(source, 0, 0, W, H);

        // pipelineは URL / RawImage を受けるので data URL 経由で渡す
        const results = await segPipe(inCanvas.toDataURL('image/png'));

        const hits = results.filter(r => WATER_LABELS.has(r.label));
        if (hits.length === 0) return null;

        // 水系ラベルのマスクをORで合成。maskは入力と同サイズの1ch (0/255)
        const mw = hits[0].mask.width, mh = hits[0].mask.height;
        const data = new Uint8Array(mw * mh);
        for (const r of hits) {
            const m = r.mask.data;
            for (let i = 0; i < data.length; i++) {
                if (m[i] > 127) data[i] = 1;
            }
        }
        return { data, W: mw, H: mh, labels: hits.map(r => r.label) };
    }

    return {
        load, segment,
        get ready() { return segPipe !== null; },
        get device() { return device; },
    };
})();
