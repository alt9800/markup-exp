# Kamogawa Pinball

鴨川（出町〜四条）の地形と建物を盤面にしたピンボールです。
標高は国土地理院の標高タイル、建物は PLATEAU の建築物モデル（LOD1）を使っています。

## 構成

```
index.html        ページ本体（CSS を含む）
js/               スクリプト（ES Modules）
Audio/            BGM
data/
  stages/         ステージ設定（範囲・縮尺・投入地点）
  {stage}.buildings.json   建物の外形・高さ・構造種別
```

- 静的ファイルだけで動きます。https で配信してください（GitHub Pages など）。
- three.js と Rapier は jsDelivr から、標高タイルと背景地図は地理院タイルから実行時に読み込みます。
- ディレクトリごと既存サイトの任意の場所に置けます。パスはすべて index.html からの相対です。
- ローカルで確認する場合は、このディレクトリで `npx http-server` などを起動してください（file:// では動きません）。

## 操作

- フリッパー：画面の左半分・右半分をタッチ、または ← →
- 台を揺らす：ボタン、または ↑
- 視点：二本指または右ドラッグで回転、ピンチまたはホイールで拡大。「視点を戻す」で初期位置へ

## クレジット

- 標高：国土地理院 標高タイル（DEM5A・DEM10B）
- 背景地図：国土地理院 地理院タイル（淡色地図）
- 建物：国土交通省 PLATEAU 京都市 建築物モデル（LOD1）
- BGM：miyako ni kakeru © takatobi002（https://x.com/takatobi002）
- 物理ロジック参考：Friedrich_buryu
- ライブラリ：three.js、Rapier

BGM の著作権は takatobi002 に帰属します。
