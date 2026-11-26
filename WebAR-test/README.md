# WebAR ベンチマーク / WebAR 벤치마크 / WebAR Benchmark

「カメラ映像に何かを重ねる」を、アプローチ別に比較するためのデモ集。
すべて静的ファイルのみ・サーバーサイドなし・商用SDKなし・事前マッピングなし。

A set of demos comparing different approaches to overlaying content on a camera feed.
Static files only. No server side, no commercial SDK, no pre-mapping.

---

## 日本語

### どういうスライドのテーマから来ているか

出発点は、FOSS4Gでの発表テーマ「位置情報 × WebAR」での失敗経験である。
生駒市で「移設された鳥居を、昔あった位置にAR表示する」市民活動を実装した際、
AR.js の location-based モード (`gps-camera`) に VPS のような出力 —
カメラに映った場所にオブジェクトが貼り付く挙動 — を期待して実装を重ねてしまった。
実際の gps-camera は GPS とコンパスだけで位置合わせをしており、カメラ映像を
一切見ていないため、数mの誤差は仕様であって、貼り付く表現は原理的に出ない。

この経験から、ロケーションベースWebARの精度を
「何を位置合わせの根拠にするか」の階段として整理した:

| 段 | 根拠 | 手法 |
|---|---|---|
| 0 | ユーザーの立ち位置 (QRコード等) | カメラAPI + 幾何 |
| 1 | 端末のSLAM (6DoF) | WebXR |
| 2 | SLAM + 初期方位合わせ | WebXR + Geolocation |
| 3 | 事前マップとの照合 | VPS (Immersal / 8th Wall 等) |

このベンチマークが検証するのはスライドの中心的な主張:
**商用SDKにも事前マッピングにも頼らず、ブラウザ標準APIと素朴な推論だけで、
どこまで「その場所にある」表現に近づけるか(できればマークアップで)。**

### 単純なマークアップ・素朴な推論でどう叶えているか

共通の構造は3行で書ける:
`getUserMedia` の `<video>` を背景に敷き、透過させたキャンバスを重ね、
どこに何を描くかだけを自分で決める。位置合わせの根拠はすべて自分のコードにある。

| デモ | 認識 | 幾何 (スケールの根拠) | 対応 |
|---|---|---|---|
| [door/](door/) ドア認識 | Sobel縦エッジのペア + 上辺の横エッジ (約26行) | 「ドアの実寸は高さ2m」の仮定から距離を逆算 | iPhone / Android |
| [wireframe/](wireframe/) ワイヤーフレーム | 毎フレームのSobelエッジ検出 | なし (画面空間) | iPhone / Android |
| [waterline/](waterline/) 水辺のライン認識 | シード群からの領域成長で水面ポリゴンを抽出 | 「カメラは水面から高さ1.5m」の仮定で平面に逆投影 | iPhone / Android |
| [webxr/](webxr/) WebXR immersive-ar | plane-detection でドア寸法の縦平面 | OSのSLAM (仮定不要) | Android Chrome |

個別のポイント:

- **door** — ドア枠は A-Frame のマークアップ (`<a-box>` 3本) をHTMLに宣言するだけ。
  検出した矩形と実寸仮定から距離を求め、検出時のカメラ姿勢でワールド座標に
  焼き付けて、以後はジャイロ (3DoF) で追従する
- **wireframe** — 3D復元もトラッキングもしない「画面空間エフェクト」。
  毎フレーム画像から計算し直すので、定義上、対象からずれない
- **waterline** — 水面を2Dのマスク (どの画素が水か) と3Dの面 (水平面のどこか) の
  両方で扱う。泡は水面上の3次元点から生成し、泡の真下の「足元」が水面ポリゴン内に
  あるものだけ描画する (擬似オクルージョン)。地平線より上を幾何で除外し、
  色味・テクスチャでアスファルトや植生のクラスタを落とす
- **webxr** — 比較用。同じ体験を6DoFで実装すると何が変わるか (置いたものが
  空間に貼り付く・回り込める) を、他の3つと並べて確認するために置いている

単眼カメラでは絶対スケールが原理的に決まらないため、各デモは何らかの実寸仮定
(ドアの高さ・カメラの高さ・QRの立ち位置) でそれを補っている。この仮定を
スライダーとしてユーザーに露出するのが、このベンチマーク全体の設計方針である。

### 実行

静的ホスティング (GitHub Pages等) に置くだけで動く。カメラ利用のため
localhost 以外では HTTPS が必要。ローカル検証は `python3 serve.py` (自己署名HTTPS)。

---

## 한국어

### 어떤 발표 주제에서 출발했는가

출발점은 FOSS4G 발표 주제 "위치정보 × WebAR"에서의 실패 경험이다.
이코마시에서 "이전된 도리이(鳥居)를 원래 있던 위치에 AR로 표시하는" 시민 활동을
구현할 때, AR.js의 location-based 모드(`gps-camera`)에 VPS 같은 출력 —
카메라에 비친 장소에 오브젝트가 붙는 동작 — 을 기대하고 구현을 거듭했다.
실제 gps-camera는 GPS와 나침반만으로 위치를 맞추며 카메라 영상을 전혀 보지
않기 때문에, 수 미터의 오차는 사양이며 "붙는" 표현은 원리적으로 불가능하다.

이 경험을 바탕으로 위치 기반 WebAR의 정밀도를
"무엇을 위치 정합의 근거로 삼는가"의 단계로 정리했다:

| 단계 | 근거 | 기법 |
|---|---|---|
| 0 | 사용자의 위치 (QR코드 등) | 카메라 API + 기하 |
| 1 | 단말의 SLAM (6DoF) | WebXR |
| 2 | SLAM + 초기 방위 정렬 | WebXR + Geolocation |
| 3 | 사전 맵과의 매칭 | VPS (Immersal / 8th Wall 등) |

이 벤치마크가 검증하는 것은 발표의 핵심 주장이다:
**상용 SDK나 사전 매핑에 의존하지 않고, 브라우저 표준 API와 소박한 추론만으로
"그 장소에 있다"는 표현에 어디까지 다가갈 수 있는가 (가능하면 마크업으로).**

### 단순한 마크업과 소박한 추론으로 어떻게 구현했는가

공통 구조는 세 줄로 요약된다:
`getUserMedia`의 `<video>`를 배경에 깔고, 투명한 캔버스를 겹치고,
어디에 무엇을 그릴지만 직접 결정한다. 위치 정합의 근거가 모두 자신의 코드에 있다.

| 데모 | 인식 | 기하 (스케일의 근거) | 지원 |
|---|---|---|---|
| [door/](door/) 문 인식 | Sobel 세로 에지 쌍 + 상단 가로 에지 (약 26줄) | "문의 실제 높이는 2m"라는 가정에서 거리를 역산 | iPhone / Android |
| [wireframe/](wireframe/) 와이어프레임 | 매 프레임 Sobel 에지 검출 | 없음 (화면 공간) | iPhone / Android |
| [waterline/](waterline/) 수면 인식 | 시드 기반 영역 성장으로 수면 폴리곤 추출 | "카메라는 수면에서 1.5m 높이"라는 가정으로 평면에 역투영 | iPhone / Android |
| [webxr/](webxr/) WebXR immersive-ar | plane-detection으로 문 크기의 수직 평면 | OS의 SLAM (가정 불필요) | Android Chrome |

- **door** — 문틀은 A-Frame 마크업(`<a-box>` 3개)을 HTML에 선언할 뿐이다.
  검출된 사각형과 실제 크기 가정으로 거리를 구하고, 검출 시점의 카메라 자세로
  월드 좌표에 고정한 뒤 자이로(3DoF)로 추종한다
- **wireframe** — 3D 복원도 트래킹도 하지 않는 "화면 공간 이펙트".
  매 프레임 이미지에서 다시 계산하므로 정의상 대상에서 어긋나지 않는다
- **waterline** — 수면을 2D 마스크(어느 픽셀이 물인가)와 3D 평면(수평면의 어디인가)
  양쪽으로 다룬다. 거품은 수면 위 3차원 점에서 생성하며, 거품 바로 아래의 "발밑"이
  수면 폴리곤 안에 있는 것만 그린다 (의사 오클루전). 지평선 위는 기하로 제외하고,
  색상·텍스처로 아스팔트나 식생 클러스터를 걸러낸다
- **webxr** — 비교용. 같은 체험을 6DoF로 구현하면 무엇이 달라지는지
  (배치한 것이 공간에 고정되고, 돌아서 볼 수 있음) 를 나란히 확인하기 위한 것

단안 카메라로는 절대 스케일이 원리적으로 정해지지 않으므로, 각 데모는 어떤
실측 가정(문의 높이, 카메라 높이, QR의 위치)으로 이를 보완한다. 이 가정을
슬라이더로 사용자에게 노출하는 것이 이 벤치마크 전체의 설계 방침이다.

### 실행

정적 호스팅(GitHub Pages 등)에 올리기만 하면 동작한다. 카메라 사용을 위해
localhost 이외에서는 HTTPS가 필요하다. 로컬 검증은 `python3 serve.py` (자체 서명 HTTPS).

---

## English

### The slide theme behind this

The starting point is a failure story from a FOSS4G talk on "geolocation × WebAR".
While building a civic project in Ikoma City — showing a relocated torii gate at its
original location in AR — I kept iterating on AR.js's location-based mode
(`gps-camera`), expecting VPS-like output: an object that sticks to the place seen
through the camera. In reality, gps-camera aligns content using only GPS and the
compass and never looks at the camera image, so errors of several meters are by
design, and "sticking" is fundamentally out of reach.

That experience led to organizing the accuracy of location-based WebAR as a ladder
of "what grounds the alignment":

| Step | Grounding | Technique |
|---|---|---|
| 0 | The user's standing position (QR code, etc.) | Camera API + geometry |
| 1 | On-device SLAM (6DoF) | WebXR |
| 2 | SLAM + initial heading alignment | WebXR + Geolocation |
| 3 | Matching against a pre-built map | VPS (Immersal / 8th Wall, etc.) |

This benchmark tests the talk's central claim:
**without commercial SDKs or pre-mapping, how close can browser-standard APIs and
naive inference get to "it is there" — preferably in plain markup?**

### How plain markup and naive inference get there

The shared structure fits in three lines: lay a `getUserMedia` `<video>` as the
background, overlay a transparent canvas, and decide yourself what to draw where.
Every piece of the alignment lives in your own code.

| Demo | Recognition | Geometry (source of scale) | Runs on |
|---|---|---|---|
| [door/](door/) Door | Pair of Sobel vertical edges + top horizontal edge (~26 lines) | Distance back-solved from "a door is 2 m tall" | iPhone / Android |
| [wireframe/](wireframe/) Wireframe | Per-frame Sobel edge detection | None (screen space) | iPhone / Android |
| [waterline/](waterline/) Water surface | Seeded region growing extracts a water polygon | Back-projection onto a horizontal plane, assuming the camera is 1.5 m above it | iPhone / Android |
| [webxr/](webxr/) WebXR immersive-ar | plane-detection finds a door-sized vertical plane | OS SLAM (no assumptions needed) | Android Chrome |

- **door** — The frame is declared in A-Frame markup (three `<a-box>` elements).
  Distance comes from the detected rectangle plus the real-size assumption; the
  object is baked into world coordinates at detection time and then tracked with
  the gyroscope (3DoF)
- **wireframe** — A pure screen-space effect with no 3D reconstruction and no
  tracking. Because everything is recomputed from the image every frame, it cannot
  drift from its target by definition
- **waterline** — Treats the water surface both as a 2D mask (which pixels are
  water) and a 3D plane (where on the horizontal plane). Bubbles spawn at 3D points
  on the surface and are drawn only when their "footprint" — the point directly
  below on the plane — falls inside the water polygon (pseudo-occlusion). Geometry
  excludes everything above the horizon; chroma and texture cues reject asphalt and
  vegetation clusters
- **webxr** — The comparison piece: the same experience built on 6DoF, showing what
  changes (placed objects stick to space and can be walked around) side by side
  with the other three

A monocular camera cannot determine absolute scale, so each demo compensates with a
real-world assumption — door height, camera height, or the user's QR-anchored
standing position. Exposing those assumptions as sliders, instead of hiding them,
is the design policy of the whole benchmark.

### Running

Works on any static hosting (e.g. GitHub Pages). HTTPS is required for camera
access anywhere other than localhost. For local testing, `python3 serve.py` spins
up a self-signed HTTPS server.
