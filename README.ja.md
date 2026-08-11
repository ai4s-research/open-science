<div align="center">

[![Open Science Desktop — Local-first AI research workbench](./docs/assets/banner.webp)](https://github.com/ai4s-research/open-science)

# Open Science Desktop

**macOS、Windows & Linux 向けのローカルファースト、モデル非依存 AI 研究ワークベンチ。**

Formerly Open Science. Claude Science などの AI-for-science ワークベンチに対するオープンソースのデスクトップ代替です。Tauri、MCP、agent skills、再現可能な成果物を基盤に、エージェント、ノートブック、ファイル、図、レポート、実行記録、レビューを 1 つの監査可能なデスクトップワークフローにまとめます。

<p>
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <b>日本語</b> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.ko.md">한국어</a>
</p>

<p>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://doi.org/10.5281/zenodo.21351225"><img src="https://img.shields.io/badge/DOI-10.5281%2Fzenodo.21351225-1682D4" alt="DOI"></a>
  <a href="https://internscience.github.io/ResearchClawBench-Home/"><img src="https://img.shields.io/badge/%F0%9F%8F%86%20%231-ResearchClawBench-FFB300" alt="#1 on ResearchClawBench"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platforms">
  <img src="https://img.shields.io/badge/i18n-7%20languages-5B8DEF" alt="7 interface languages">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20React-24C8DB" alt="Built with Tauri + React">
  <img src="https://img.shields.io/badge/runtime-OpenCode-success" alt="OpenCode runtime">
  <a href="https://discord.gg/fWNMDKcd5P"><img src="https://img.shields.io/badge/Join-Discord-5865F2" alt="Join Discord"></a>
</p>

</div>

---

## ニュース

- **2026-08-01** — 🗂️ **プロジェクト・メモリ・全履歴。** セッションを名前付きプロジェクトにまとめ（既存リポジトリはコピーせず**その場で**インポート）、グローバルとプロジェクトの永続メモリを持たせ、過去のすべての会話を検索可能な履歴（アーカイブ／復元／エクスポート付き）から辿れます。 *(v0.3.1)*
- **2026-07-24** — 🪟 **分割ペインのタイリング。** セッションを並べて表示し、ペインをドラッグして再配置し、独立した「スクリーン」を複数保持でき、ペインごとに別のモデルを使えます。 *(v0.3.0)*
- **2026-07-21** — 🌐 **どこからでもアクセス——スマホからでも。** トークン認証ゲートウェイが*本物の*デスクトップ UI を CLI、LAN 上のブラウザ、あるいはスマホへ配信します（既定はループバック、LAN はオプトイン）。デスクで実行を開始し、完成した図とレポートをスマホで読めます。 *(v0.2.3)*
- **2026-07-21** — 🧭 **ブラウザ制御。** エージェントがあなた自身の Chrome を——プロファイルとログインを保ったまま——操作し、あなたと同じようにライブな Web を読み取ります。必要に応じて分離されたプライベートブラウザも使えます。 *(v0.2.3)*
- **2026-07-09** — 🎉 **ResearchClawBench 第 1 位。** Open Science Desktop は、自律型科学研究エージェント向けのエンドツーエンドベンチマーク [ResearchClawBench](https://internscience.github.io/ResearchClawBench-Home/) で、採点済みタスク平均スコア第 1 位です（Pass@1 リーダーボード）。

---

## 目次

- [✨ できること](#できること)
- [🎬 スクリーンショット](#スクリーンショット)
- [🧪 現在の機能](#現在の機能)
- [🔌 スキルとコネクタ](#スキルとコネクタ)
- [📦 インストール](#インストール)
- [🚀 ソースからビルド](#ソースからビルド)
- [🔒 安全性とプライバシー](#安全性とプライバシー)
- [🗂️ リポジトリ構成](#リポジトリ構成)
- [📌 状態](#状態)

## できること

**研究ループをまるごと回す**——広い方向性から完成論文まで:探索、文献調査、仮説、実験コード、分析、作図、執筆を、1 回の連続した監査可能なセッションで。

- **自律型リサーチエージェント**: バンドルされた `ai4s-agent` が専門スキルをエンドツーエンドで連結し(探索 → 調査 → 実験 → 執筆)、各ステップが単なるチャット返信ではなく、実在する検査可能な成果物をワークスペースに残します。
- **すべてが辿れる**: 図、表、レポート、ノートブック、実行出力は、それらを生成した正確なコード、入力、環境、モデル出力、会話へリンクします。
- **ローカルファースト、あなたのもの**: セッション、データ、来歴、ノートブック、実行記録はすべて手元のローカルフォルダに保存され、既定では外部に出ません。
- **モデル非依存ランタイム**: UI は `packages/sdk` 経由でバンドル済み OpenCode sidecar と通信します——好きなモデルを持ち込めます。プロバイダ、スキル、MCP サーバーは差し替え可能です。
- **設計から再現可能**: ローカル、SSH/Slurm、Modal、notebook-batch の実行を、散らばった端末ログではなく再現可能な run record として記録します。
- **どこからでも届く**: 組み込みのトークン認証ゲートウェイが*本物の*デスクトップ UI を LAN 上のブラウザやスマホへ配信します（トンネルを使えばどこからでも）——デスクで実行を開始し、昼休みにスマホから様子を確認できます。既定ではオフで、オプトインするまではループバック限定。API キーがマシンから出ることはありません。
- **あなた自身のブラウザを操作**: エージェントはあなた自身の Chrome を、プロファイルとログインを保ったまま制御し、あなたと同じようにライブな Web を読み取れます——あるいは、そうしたくないときは分離されたプライベートブラウザを使います。
- **拡張可能**: エージェントスキル、MCP サーバーとワンクリックの科学コネクタ、`/` コマンド、`!` shell モード、そしてモデル非依存の SDK。

## スクリーンショット

**1 つのプロンプトから公開品質の図へ。そしてすべての点が、それを生み出した正確なコードと入力へ辿れます。** ブラックボックスはありません:任意の成果物を開けば、その生成スクリプト、データファイル、そしてそれを生み出した会話が見られます。

![成果物インスペクタで、生成スクリプトと入力ファイルの隣に描画された種間アトラス図](./docs/assets/showcase-provenance.webp)

**文献から検証可能なレポートへ。** 複数のソースへ検索を広げ、PDF として描画される原稿を起草し、公開前に引用レビューでゲートします——DOI を解決し、出典のない数値や図/コードの不整合を指摘します。

![タンパク質言語モデルの文献調査を PDF 原稿にまとめ、引用レビューアがすべての DOI の解決を確認](./docs/assets/showcase-literature.webp)

**あなた自身の Chrome を操作。** エージェントはあなた自身のブラウザプロファイル——ログインも含めて——を通じてライブな Web を読み取り、見つけた内容を図とソート可能な CSV に変換します。

![open-science-browser でユーザー自身の Chrome を操作し、bioRxiv のプレプリントを収集してチャートと CSV にするエージェント](./docs/assets/showcase-browser.webp)

**どこからでも研究——スマホからでも。** 組み込みの認証ゲートウェイが*本物の*デスクトップ UI を LAN 上のブラウザ（またはトンネル）へ配信するので、デスクで実行を開始し、完成した図とレポートをスマホで読めます。

<table align="center">
  <tr>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-home.webp" width="240" alt="スマホのブラウザで動作するワークベンチ:スターター分析付きの新規セッション画面"><br><sub>新規セッション</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-run.webp" width="240" alt="スマホで表示した、完成した用量反応分析——スクリプト、結果、図、レポート"><br><sub>完成した分析</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-reproduce.webp" width="240" alt="スマホで表示した、ARI 対エポック図を伴う scVI ベンチマークの再現"><br><sub>再現したベンチマーク</sub></td>
  </tr>
</table>

<details>
<summary><b>その他のスクリーンショット</b></summary>

<br>

![固定された環境、実行ログ、来歴とともにリモート A100 上で scVI 統合ベンチマークを再現](./docs/assets/showcase-remote.webp)

![エージェントのカーネルを共有するライブ分析ノートブックの隣にある、8 アームの scVI ハイパーパラメータスイープ表](./docs/assets/showcase-experiment.webp)

</details>

## 現在の機能

**研究ループをスキルとして。** 1 つのメタスキルがパイプライン全体を実行し、各ステージは自己完結したスキルとして、実在する評価可能な成果物を生成します——OpenCode が対応する任意のモデルで動きます:

| スキル | 役割 | 主な成果物 |
| --- | --- | --- |
| `ai4s-agent` | 下の 4 スキルを順に実行 | 研究パッケージ一式 |
| `research-explorer` | 広い方向性を具体的なテーマへ収束 | `research_exploration.md`、`topic_matrix.md`、`literature_pre_survey.md` |
| `literature-survey` | 文献調査を執筆 | 6–20 頁 PDF、60+ の実引用、LaTeX ソース、分類図 |
| `experiment-suite` | 実験パッケージを構築 | 設計文書、実行可能コード、来歴付き `results.json`、図、レポート |
| `paper-writer` | 研究論文を執筆 | 8–14 頁 PDF、200+ 引用、4–8 図、表 |
| `mindmap-render` | マインドマップを描画 | `topic_matrix.md` から生成した画像 |
| `integrity-auditor` | 論文の整合性を監査 | 画像/数値/論理の指摘、4 段階の証拠グレーディング、`audit_report.md` |

これらは `ai4s-skills` パックとして、第一者のレビュースキルおよび下記の Office/ドキュメントスキルとともに提供されます。

### プラットフォーム

| 領域 | 現在の状態 |
| --- | --- |
| デスクトップ | Tauri 2 + React + TypeScript + Vite。macOS、Windows、Linux のビルド対象。 |
| ランタイム | アプリが自動起動するバンドル済み OpenCode sidecar。ユーザー自身の OpenCode 設定/データとは分離。 |
| プロジェクト | セッションをまとめる名前付きプロジェクト。既存フォルダをその場でインポート（コピーしない）、ワークスペース内の既存フォルダの取り込み、既存セッションのプロジェクトへの移動。 |
| セッション | 複数セッション、履歴、日時付きワークスペース、検索可能な履歴（アーカイブ／復元／エクスポート）、`@` ファイル参照と `#` 会話参照、`/` コマンド、`!` shell モード。 |
| レイアウト | N 分割のペインタイリング、ドラッグでの再ドック、独立した複数スクリーン、ペインごとのモデルと推論強度、スクリーン間のペインドラッグ。 |
| エージェントモード | `/plan`（計画してから実行）、`/goal`（目的と受入基準）、専用パネルでのサブエージェント状況、ランタイムの実サーバー状態を反映する停止。 |
| メモリ | グローバルとプロジェクトの 2 層メモリ（切替可能）、モデルのコンテキスト窓に近づくと自動でコンテキストを圧縮。 |
| リモート計算 | `~/.ssh/config` からマシンを登録し、疎通を確認し、ジョブの投入・追跡・キャンセルをアプリ内から実行。 |
| 外観 | Light / Warm / Dark の 3 テーマ（テーマ別アクセント）と UI ズーム。 |
| ファイル | グローバル/セッション内のファイルブラウズ、右クリック操作、外部アプリで開く、パスコピー、ローカルプレビューサーバー。 |
| リモートアクセス | 本物の UI を CLI、LAN 上の Web ブラウザ、またはスマホへ配信するトークン認証ゲートウェイ（既定はループバック、LAN はオプトイン）。読み取り専用/フルアクセスの各モード。トークンを埋め込んだリンクをコピーし、ワンタップで接続。API キーが通信路を渡ることはありません。 |
| ブラウザ制御 | エージェントがあなた自身の Chrome を——プロファイルとログイン状態を保ったまま——操作し、アクセシビリティツリーを通じてページを読み取ります。必要に応じて分離された/プライベートなブラウザも使えます。 |
| ノートブック | 実際の `.ipynb`、Python/R ノートブック作成、ローカルカーネル実行、バンドル `uv` による Jupyter 環境、JupyterLab 起動。 |
| 実行記録 | 追記型 run log、グローバル SQLite インデックス、検索/ファセット/ページング、出力リンク、ログ、再現プロンプト。 |
| 来歴 | `.openscience/provenance.jsonl` がファイル版を記録し、成果物を作成元の実行または編集へ結びます。 |
| ビューア | PDF、画像、動画、HTML、Markdown、コード、CSV/TSV とチャート、DOCX、XLSX、PPTX、分子、3D mesh、ゲノム、FITS、DOS/DOSCAR、EIGENVAL bands、qcode、異常マップ、phase。 |
| UI 言語 | English、简体中文、日本語、Español、Deutsch、Français、한국어。Portuguese (Brazil) と Arabic は登録済みですが、まだ選択可能ではありません。 |

## スキルとコネクタ

ビルド時に `ai4s-skills`、`anthropics/skills` の `docx`/`pdf`/`pptx`/`xlsx`、および `runtime/skills/core/` の第一者スキルを取得します。コアスキルには `traceability-review`、`stats-integrity`、`domain-check`、`large-file`、`publication-figures`、`remote-compute`、`modal-run` が含まれます。

ワンクリック科学 MCP コネクタ: 文献検索、Biomedical databases、Materials Project、FRED、Space weather、Open-Meteo、USGS water data。任意のローカル/リモート MCP サーバーも Settings から追加できます。

## インストール

[Releases](https://github.com/ai4s-research/open-science/releases/latest) から最新版をダウンロードしてください。

- **macOS**: `.dmg` / `.app`、Apple Silicon と Intel、macOS 13 Ventura 以降。
- **Windows**: NSIS `.exe` と `.msi`、Windows 10/11 x64。
- **Linux**: x86_64 Linux 向け `.deb` と `.rpm`。

macOS パッケージは Developer ID 署名・Notarization・staple 済みで、そのまま開けます（`xattr` の回避策は不要）。Windows と Linux のビルドはまだ署名されていません。

Windows では SmartScreen の **More info -> Run anyway** を選択します。

## ソースからビルド

```bash
git clone https://github.com/ai4s-research/open-science
cd open-science
pnpm install
bash scripts/dev/fetch-opencode.sh
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh
pnpm --filter @ai4s/desktop tauri dev
pnpm --filter @ai4s/desktop tauri build
```

チェック:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## 安全性とプライバシー

ワークスペース、元データ、会話履歴、来歴、ノートブック、実行記録は既定でローカルに残ります。コマンド実行、削除、依存関係インストール、リモート接続は人間の承認を通ります。認証情報はアプリ専用ランタイム設定に保存され、ワークスペース、来歴、git、エクスポート、グローバル OpenCode 設定には入りません。

## リポジトリ構成

| パス | 用途 |
| --- | --- |
| `apps/desktop/` | Tauri + React デスクトップアプリ。 |
| `packages/sdk/` | `OpenCodeClient`。UI が OpenCode を直接呼ばないための層。 |
| `packages/shared/` | 共有型とチャートパレット。 |
| `runtime/skills/core/` | 第一者科学スキル。 |
| `runtime/skills/external/` | ビルド時取得の外部スキル。 |
| `examples/` | 内蔵サンプルワークスペース。 |
| `scripts/dev/` | sidecar、`uv`、スキル取得、回帰プローブ。 |
| `docs/` | 製品、技術、operator、コネクタ、研究メモ。 |

## 状態

現在の実装ログは [`PROGRESS.md`](./PROGRESS.md) を参照してください。近い作業は Windows のコード署名、自動更新、Windows/Linux 検証の拡大、コネクタの堅牢化、再現性レビューの継続です。macOS リリースは署名・Notarization 済みです。議論には [Open Science Discord](https://discord.gg/fWNMDKcd5P) も使えます。

[MIT](./LICENSE). Open Science Desktop は beta の研究ツールです。出力は草稿として扱い、公開や意思決定の前に数字、引用、コード、結論を検証してください。

## 引用

研究で Open Science Desktop を使用した場合は、以下のように引用してください:

```bibtex
@software{open_science_desktop,
  author  = {{The Open Science Desktop Contributors}},
  title   = {Open Science Desktop: a local-first, model-agnostic AI research workbench},
  year    = {2026},
  version = {0.3.3},
  doi     = {10.5281/zenodo.21805331},
  url     = {https://github.com/ai4s-research/open-science},
  license = {MIT}
}
```

GitHub の **“Cite this repository”** ボタン([`CITATION.cff`](./CITATION.cff) から生成)でも APA / BibTeX 形式を取得できます。
