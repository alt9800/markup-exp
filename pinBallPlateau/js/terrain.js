// 地理院の標高タイル（PNG）を読み込み、盤面座標の格子に再標本化する
// https://maps.gsi.go.jp/development/demtile.html

const DEM_LAYERS = [
  { name: 'DEM5A', url: 'https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png', z: 15 },
  { name: 'DEM10B', url: 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png', z: 14 },
];
const BASEMAP = { url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', z: 16 };

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// 経緯度 → ズーム z のグローバルピクセル座標
function lonLatToPixel(lon, lat, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) return null; // 範囲外のタイルは 404
  return createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function tileRange(bbox, z) {
  const a = lonLatToPixel(bbox.west, bbox.north, z);
  const b = lonLatToPixel(bbox.east, bbox.south, z);
  return {
    x0: Math.floor(a.x / 256), x1: Math.floor(b.x / 256),
    y0: Math.floor(a.y / 256), y1: Math.floor(b.y / 256),
  };
}

function tileList(r) {
  const list = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) list.push({ x, y });
  return list;
}

// 1レイヤー分のタイルを読み、ピクセル単位で標高を引ける関数を返す
async function loadDemLayer(layer, bbox, onTile) {
  const range = tileRange(bbox, layer.z);
  const tiles = tileList(range);
  const ctx = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
  const grids = new Map();
  await mapLimit(tiles, 6, async (t) => {
    const url = layer.url.replace('{z}', layer.z).replace('{x}', t.x).replace('{y}', t.y);
    const img = await fetchImage(url).catch(() => null);
    if (img) {
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const h = new Float32Array(256 * 256);
      for (let i = 0; i < h.length; i++) {
        const v = px[i * 4] * 65536 + px[i * 4 + 1] * 256 + px[i * 4 + 2];
        h[i] = v === 8388608 || px[i * 4 + 3] === 0 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
      }
      grids.set(`${t.x}/${t.y}`, h);
    }
    onTile?.();
  });

  const pixel = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const g = grids.get(`${tx}/${ty}`);
    if (!g) return NaN;
    return g[(gy - ty * 256) * 256 + (gx - tx * 256)];
  };

  // 双一次補間。近傍4点に欠測があれば有効な点だけで平均する
  return (lon, lat) => {
    const p = lonLatToPixel(lon, lat, layer.z);
    const fx = p.x - 0.5, fy = p.y - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    let sum = 0, wsum = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const v = pixel(x0 + dx, y0 + dy);
      if (!Number.isNaN(v)) { sum += v * w; wsum += w; }
    }
    return wsum > 0.25 ? sum / wsum : NaN;
  };
}

// 欠測（水面など）を周囲の値で埋める
function fillHoles(h, cols, rows) {
  for (let pass = 0; pass < 200; pass++) {
    let remaining = 0;
    const next = h.slice();
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const k = i * cols + j;
        if (!Number.isNaN(h[k])) continue;
        let s = 0, n = 0;
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= rows || jj >= cols) continue;
          const v = h[ii * cols + jj];
          if (!Number.isNaN(v)) { s += v; n++; }
        }
        if (n) next[k] = s / n;
        else remaining++;
      }
    }
    h.set(next);
    if (!remaining) return;
  }
}

/**
 * bbox を spacing [m] 間隔の格子に再標本化し、標高 [m] を返す。
 * 格子は北西隅を (row 0, col 0) とし、row は南向き、col は東向き。
 */
export async function loadElevationGrid(bbox, spacing, onProgress) {
  const latC = (bbox.north + bbox.south) / 2;
  const lonC = (bbox.west + bbox.east) / 2;
  const widthM = (bbox.east - bbox.west) * mPerDegLon(latC);
  const lengthM = (bbox.north - bbox.south) * M_PER_DEG_LAT;
  const ncols = Math.round(widthM / spacing);
  const nrows = Math.round(lengthM / spacing);
  const cols = ncols + 1, rows = nrows + 1;

  const total = DEM_LAYERS.reduce((s, l) => s + tileList(tileRange(bbox, l.z)).length, 0);
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  const samplers = await Promise.all(DEM_LAYERS.map((l) => loadDemLayer(l, bbox, tick)));

  const heights = new Float32Array(cols * rows);
  const source = new Uint8Array(cols * rows); // 0: DEM5A, 1: DEM10B, 2: 補間
  for (let i = 0; i < rows; i++) {
    const lat = bbox.north - (i / nrows) * (bbox.north - bbox.south);
    for (let j = 0; j < cols; j++) {
      const lon = bbox.west + (j / ncols) * (bbox.east - bbox.west);
      let v = NaN, s = 2;
      for (let l = 0; l < samplers.length && Number.isNaN(v); l++) {
        v = samplers[l](lon, lat);
        s = l;
      }
      heights[i * cols + j] = v;
      source[i * cols + j] = Number.isNaN(v) ? 2 : s;
    }
  }
  fillHoles(heights, cols, rows);

  return { heights, source, ncols, nrows, cols, rows, widthM, lengthM, latC, lonC, bbox };
}

// 背景地図（淡色地図）を1枚のキャンバスに合成し、格子点の UV を計算する関数と一緒に返す
export async function loadBasemap(bbox) {
  const z = BASEMAP.z;
  const r = tileRange(bbox, z);
  const tiles = tileList(r);
  const canvas = document.createElement('canvas');
  canvas.width = (r.x1 - r.x0 + 1) * 256;
  canvas.height = (r.y1 - r.y0 + 1) * 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2f2f0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await mapLimit(tiles, 8, async (t) => {
    const url = BASEMAP.url.replace('{z}', z).replace('{x}', t.x).replace('{y}', t.y);
    const img = await fetchImage(url).catch(() => null);
    if (img) ctx.drawImage(img, (t.x - r.x0) * 256, (t.y - r.y0) * 256);
  });
  const uvOf = (lon, lat) => {
    const p = lonLatToPixel(lon, lat, z);
    return [(p.x - r.x0 * 256) / canvas.width, (p.y - r.y0 * 256) / canvas.height];
  };
  return { canvas, uvOf };
}

export { mPerDegLon, M_PER_DEG_LAT };
