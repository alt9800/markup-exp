# webxr — WebXR immersive-ar でドアを認識し、枠とボールを表示するデモ

サーバー処理なし・完全クライアントサイドの WebXR (immersive-ar) デモ。
`slide-old/webxr-window-ar` の後継で、こちらは **サーバーに深度を送らず、ブラウザ標準APIだけ** で完結する。

## 体験の流れ

1. 「AR開始」→ カメラ許可
2. ドアや壁など **縦の平面** にカメラを向ける
   - **plane-detection が使える端末**: 「高さ1.6m以上 × 幅0.55〜1.4m」のドアらしい縦平面を **自動認識** して枠を配置(誤検出防止に連続20フレームの安定検出で確定)
   - **フォールバック**: hit-test のレティクルが縦面で緑になり、ワイヤーフレームのプレビューが出るので **タップで配置**
3. シアンに光る枠が3秒脈動し、開口部が暗転
4. ボールが溢れ出し、床 (`local-floor` の y=0) でバウンドして転がる

## 動作環境

- **Android Chrome (ARCore対応端末)** — `immersive-ar` + `hit-test` 必須、`plane-detection` / `dom-overlay` はオプション
- iOS Safari は WebXR AR 非対応 (2026年7月現在) → 非対応端末では起動画面にその旨を表示
- HTTPS 必須 (secure context)

## ローカル検証

```bash
python3 ../serve.py     # https://<LAN IP>:8443/webxr/ をAndroid Chromeで開く
```

もしくは GitHub Pages / Netlify に `index.html` を置くだけで動く(静的1ファイル)。

## 技術的なポイント(スライドのネタ)

- **「認識」の中身**: ARCore が SLAM で作る平面情報を `plane-detection` API で受け取り、寸法でドアらしさを判定しているだけ。ML でも VPS でもない。それでも「そこにドアが生えた」体験になるのは、**WebXR のトラッキングが 6DoF で、配置後のオブジェクトが空間に張り付く** から。AR.js の GPS モードで得られなかった「ビタビタ感」の最小構成がこれ。
- **hit-test の姿勢**: hit result / plane pose の **+Y軸が面の法線**。`normal.y` がほぼ0なら縦面(壁・ドア)と判定できる。
- **床は `local-floor`**: 参照空間を `local-floor` にすると y=0 が床になるので、物理(バウンド・転がり)が座標変換なしで書ける。
- **物理は自前の20行**: 重力 + 床反発 + 摩擦 + 速度に応じた転がり回転。この規模なら物理エンジン不要。
- **オクルージョンはやっていない**: `depth-sensing` を optionalFeatures に足し、深度テクスチャをシェーダーに渡せば「ドアの手前を人が横切ると隠れる」まで行ける(発展課題)。

## ファイル構成

```
webxr/
├── index.html   # 全部入り (three.js は importmap + unpkg)
├── serve.py     # 自己署名HTTPSサーバー (証明書自動生成)
└── README.md
```
