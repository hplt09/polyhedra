# polyhedra

オーディオに反応する 3D ビジュアライザ。中央の多面体が音のビートに合わせて 10 種類の幾何形態を遷移し、パーティクル・ショックウェーブ・グリッドが BLACK / WHITE / PINK の 3 モードを循環する。

公開先: <https://polyhedra-gold.vercel.app/>

[three.js](https://threejs.org/) + WebGL シェーダパイプライン（`EffectComposer` + `UnrealBloomPass` + 自前の chromatic / vignette ShaderPass）で 3D シーンを描画し、2D キャンバスを HUD・スワイプ遷移・スネアフラッシュに重ねている。

## 必要環境

- Node.js 18 以上
- npm

## セットアップ

```bash
npm install
```

## 開発サーバ

```bash
npm run dev
```

Vite の開発サーバが起動する。`server.host = true` を有効にしているので、同一 LAN の他端末（スマホ）からもアクセスできる。

## ビルド / プレビュー

```bash
npm run build
npm run preview
```

`tsc` で型チェックしたうえで `vite build` が `dist/` に成果物を出力する。`preview` はビルド済みファイルをローカル配信する。

## デプロイ

Vercel と GitHub リポジトリを連携している。`main` への push で自動的にビルド・デプロイされる。Framework Preset は **Vite** を自動検出。追加の設定ファイルは無し。

## 音声入力

初回はスプラッシュ画面が表示され、タップすると操作を開始できる（ブラウザのオートプレイポリシー対策）。画面下部のパネルから入力ソースを選ぶ:

- **mic** — マイク入力。スマホで周囲の音楽を拾う用途向け。モバイルでは 1.8x のプリゲインがかかる
- **tab audio** — `getDisplayMedia` で別タブの音声を取り込む。PC Chrome 系専用（モバイルでは非表示）
- **stop** — 停止。`MediaStreamTrack` を明示的に止めるので、ブラウザの録音インジケータも消える

無音時はキャンバスをタップすると形状とカラーモードが手動で切り替わる（パネル内のクリックは無視される）。

## スマホ向け最適化

`window.innerWidth < 768` をモバイル判定として、以下を切り替える:

- DPR 上限 1.5（PC は 2）、`MAX_PARTICLES` 500（PC は 800）
- `KICK_IMPULSE` / `BOUNCE_*` を強めに調整し、弱い入力でもバウンスが見える
- 多面体の基準サイズを `min(W,H) * 0.14`（PC は 0.085）に拡大
- `tab audio` ボタンを非表示、タップターゲットを拡大、`100dvh` + safe-area 対応

## ファイル構成

```
.
├── index.html          # エントリ HTML（スプラッシュ・HUD パネル・キャンバス）
├── public/
│   └── favicon.svg     # 三角形ファビコン
├── src/
│   └── polyhedra.ts    # 描画・解析・入力ロジック一式
├── vite.config.ts
└── tsconfig.json
```
