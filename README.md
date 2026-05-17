# polyhedra

オーディオに反応する 3D ビジュアライザ。中央の多面体が音のビートに合わせて 10 種類の幾何形態を遷移し、パーティクル・ショックウェーブ・グリッドが BLACK / WHITE / PINK の 3 モードを循環する。

[three.js](https://threejs.org/) + WebGL シェーダパイプライン（`EffectComposer` + `UnrealBloomPass`）で 3D シーンを描画し、2D キャンバスを HUD・スワイプ遷移・スネアフラッシュに重ねている。

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

Vite の開発サーバが起動する。`server.host = true` を有効にしているので、同一 LAN の他端末からもアクセスできる。

## ビルド

```bash
npm run build
npm run preview
```

`tsc` で型チェックしたうえで `vite build` が `dist/` に成果物を出力する。`preview` はビルド済みファイルをローカル配信する。

## 音声入力

画面右下のパネルから入力ソースを選択する。

- **mic** — マイク入力
- **file** — ローカル音声ファイル
- **tab audio** — タブのオーディオ（`getDisplayMedia` の音声トラックを利用）
- **stop** — 停止

ブラウザのオートプレイポリシーにより、最初のクリックで `AudioContext` を起動する必要がある。

## ファイル構成

```
.
├── index.html          # エントリ HTML（HUD パネル + キャンバス）
├── src/
│   └── polyhedra.ts    # 描画・解析ロジック一式
├── vite.config.ts
└── tsconfig.json
```
