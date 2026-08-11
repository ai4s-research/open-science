<div align="center">

[![Open Science Desktop — Local-first AI research workbench](./docs/assets/banner.webp)](https://github.com/ai4s-research/open-science)

# Open Science Desktop

**macOS, Windows & Linux용 로컬 우선, 모델 독립 AI 연구 워크벤치.**

Formerly Open Science. Claude Science 및 유사한 AI-for-science 워크벤치의 오픈소스 데스크톱 대안으로, Tauri, MCP, agent skills, 재현 가능한 산출물을 기반으로 합니다. 에이전트, 노트북, 파일, 그림, 보고서, 실행 기록, 리뷰를 하나의 감사 가능한 데스크톱 워크플로로 연결합니다.

<p>
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.fr.md">Français</a> ·
  <b>한국어</b>
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

## 소식

- **2026-08-01** — 🗂️ **프로젝트, 메모리, 전체 히스토리.** 세션을 이름이 있는 프로젝트로 묶고(기존 저장소는 복사하지 않고 **그 자리에서** 가져옵니다), 에이전트에 전역·프로젝트 영속 메모리를 부여하며, 모든 과거 대화를 검색 가능한 히스토리에서 보관·복원·내보내기와 함께 찾을 수 있습니다. *(v0.3.1)*
- **2026-07-24** — 🪟 **분할 페인 타일링.** 세션을 나란히 배치하고, 페인을 드래그해 재배치하며, 독립적인 화면을 여러 개 유지하고, 페인마다 다른 모델을 사용할 수 있습니다. *(v0.3.0)*
- **2026-07-21** — 🌐 **어디서나 접속 — 심지어 휴대폰에서도.** 토큰 인증 게이트웨이가 *실제* 데스크톱 UI를 CLI, LAN 내 브라우저, 또는 휴대폰에 제공합니다(기본은 loopback, LAN은 선택적 활성화). 책상에서 실행을 시작하고 완성된 그림과 보고서를 휴대폰에서 확인하세요. *(v0.2.3)*
- **2026-07-21** — 🧭 **브라우저 제어.** 에이전트가 프로필과 로그인이 유지된 당신의 Chrome을 직접 조작해 당신이 보는 방식 그대로 실시간 웹을 읽거나, 필요할 때 격리된 비공개 브라우저를 사용할 수 있습니다. *(v0.2.3)*
- **2026-07-09** — 🎉 **ResearchClawBench 1위.** Open Science Desktop은 자율 과학 연구 에이전트를 위한 엔드투엔드 벤치마크 [ResearchClawBench](https://internscience.github.io/ResearchClawBench-Home/)에서 채점된 작업 평균 기준 1위를 기록했습니다(Pass@1 리더보드).

---

## 목차

- [✨ 무엇을 하나요](#무엇을-하나요)
- [🎬 스크린샷](#스크린샷)
- [🧪 현재 기능](#현재-기능)
- [🔌 스킬과 커넥터](#스킬과-커넥터)
- [📦 설치](#설치)
- [🚀 소스에서 빌드](#소스에서-빌드)
- [🔒 안전과 개인정보](#안전과-개인정보)
- [🗂️ 저장소 구조](#저장소-구조)
- [📌 상태](#상태)

## 무엇을 하나요

**연구 루프 전체를 돌립니다** — 넓은 방향에서 완성된 논문까지: 탐색, 문헌 조사, 가설, 실험 코드, 분석, 그림, 집필을 하나의 연속되고 감사 가능한 세션에서 진행합니다.

- **자율 연구 에이전트**: 번들된 `ai4s-agent`가 전문 스킬을 엔드투엔드로 연결하며(탐색 → 조사 → 실험 → 집필), 각 단계는 단순한 채팅 답변이 아니라 실제로 검사 가능한 산출물을 워크스페이스에 남깁니다.
- **모든 것이 역추적됩니다**: 그림, 표, 보고서, 노트북, 실행 출력이 이를 생성한 정확한 코드, 입력, 환경, 모델 출력, 대화로 연결됩니다.
- **로컬 우선, 당신의 것**: 세션, 데이터, provenance, 노트북, 실행 기록이 모두 로컬 폴더에 저장되며 기본적으로 외부로 나가지 않습니다.
- **모델 독립 런타임**: UI는 `packages/sdk`를 통해 번들·고정된 OpenCode sidecar와 통신합니다. 원하는 모델을 가져오세요; provider, skill, MCP 서버는 교체 가능합니다.
- **설계상 재현 가능**: 로컬, SSH/Slurm, Modal, notebook-batch 실행을 흩어진 터미널 출력이 아니라 재현 가능한 run record로 기록합니다.
- **어디서나 접속**: 내장된 토큰 인증 게이트웨이가 *실제* 데스크톱 UI를 LAN 내 브라우저나 휴대폰에 제공합니다(터널을 쓰면 어디서든) — 책상에서 실행을 시작하고 점심시간에 휴대폰으로 확인하세요. 기본은 꺼져 있고, 활성화하기 전까지는 loopback 전용이며, API 키는 기기를 벗어나지 않습니다.
- **당신의 브라우저를 직접 조작**: 에이전트가 프로필과 로그인이 유지된 실제 Chrome을 제어해 당신이 보는 방식 그대로 실시간 웹을 읽을 수 있으며 — 원치 않으면 격리된 비공개 브라우저를 사용합니다.
- **확장 가능**: 에이전트 스킬, MCP 서버와 원클릭 과학 커넥터, `/` 명령, `!` shell 모드, 그리고 모델 독립 SDK.

## 스크린샷

**하나의 프롬프트 -> 출판 수준의 그림, 그리고 모든 데이터 포인트는 그것을 만든 정확한 코드와 입력으로 추적됩니다.** 블랙박스가 없습니다: 아무 산출물이나 열어 그것을 생성한 스크립트, 데이터 파일, 그리고 그것을 만들어낸 대화를 확인하세요.

![산출물 검사기에서 생성 스크립트 및 입력 파일과 나란히 표시된 렌더링된 교차종 아틀라스 그림](./docs/assets/showcase-provenance.webp)

**문헌 -> 검증 가능한 보고서.** 여러 출처에 걸쳐 검색을 확장하고, PDF로 렌더링되는 원고를 작성한 뒤, 무엇이든 배포되기 전에 인용 검토를 통과하도록 강제합니다 — DOI가 해석되고, 출처 없는 수치와 그림/코드 불일치가 표시됩니다.

![단백질 언어 모델 문헌 조사를 PDF 원고로 컴파일하고, 인용 검토기가 모든 DOI가 해석됨을 확인하는 화면](./docs/assets/showcase-literature.webp)

**당신의 Chrome을 직접 조작.** 에이전트가 로그인을 포함한 실제 브라우저 프로필로 실시간 웹을 읽고, 찾은 내용을 그림과 정렬 가능한 CSV로 만듭니다.

![open-science-browser로 사용자의 Chrome을 조작해 bioRxiv 프리프린트를 차트와 CSV로 수집하는 에이전트](./docs/assets/showcase-browser.webp)

**어디서나, 심지어 휴대폰에서도 연구.** 내장된 인증 게이트웨이가 *실제* 데스크톱 UI를 LAN 내 브라우저(또는 터널)에 제공하므로, 책상에서 실행을 시작하고 완성된 그림과 보고서를 휴대폰에서 읽을 수 있습니다.

<table align="center">
  <tr>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-home.webp" width="240" alt="휴대폰 브라우저에서 본 워크벤치: 시작 분석이 있는 새 세션 화면"><br><sub>새 세션</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-run.webp" width="240" alt="휴대폰에서 본 완성된 용량-반응 분석 — 스크립트, 결과, 그림, 보고서"><br><sub>완성된 분석</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-reproduce.webp" width="240" alt="휴대폰에서 본 scVI 벤치마크 재현과 그 ARI-대-epoch 그림"><br><sub>재현된 벤치마크</sub></td>
  </tr>
</table>

<details>
<summary><b>추가 스크린샷</b></summary>

<br>

![고정된 환경, 실행 로그, provenance와 함께 원격 A100에서 scVI 통합 벤치마크 재현](./docs/assets/showcase-remote.webp)

![에이전트의 커널을 공유하는 라이브 분석 노트북과 나란히 표시된 8-arm scVI 하이퍼파라미터 스윕 표](./docs/assets/showcase-experiment.webp)

</details>

## 현재 기능

**연구 루프를 스킬로.** 하나의 메타 스킬이 전체 파이프라인을 실행하며, 각 단계는 실제로 평가 가능한 산출물을 만드는 자기완결형 스킬입니다 — OpenCode가 지원하는 어떤 모델에서도 실행됩니다:

| 스킬 | 역할 | 주요 산출물 |
| --- | --- | --- |
| `ai4s-agent` | 아래 네 스킬을 순서대로 실행 | 완전한 연구 패키지 |
| `research-explorer` | 넓은 방향을 구체적 주제로 좁히기 | `research_exploration.md`, `topic_matrix.md`, `literature_pre_survey.md` |
| `literature-survey` | 문헌 조사 작성 | 6–20쪽 PDF, 60+ 실제 인용, LaTeX 소스, 분류 체계 그림 |
| `experiment-suite` | 실험 패키지 구축 | 설계 문서, 실행 가능한 코드, provenance 포함 `results.json`, 그림, 보고서 |
| `paper-writer` | 연구 논문 작성 | 8–14쪽 PDF, 200+ 인용, 4–8개 그림, 표 |
| `mindmap-render` | 마인드맵 렌더링 | `topic_matrix.md`로 생성한 이미지 |
| `integrity-auditor` | 논문 무결성 감사 | 이미지/수치/논리 발견, 4단계 증거 등급, `audit_report.md` |

이들은 `ai4s-skills` 팩으로 제공되며, 자체 리뷰 스킬 및 아래의 Office/문서 스킬과 함께 번들됩니다.

### 플랫폼

| 영역 | 현재 상태 |
| --- | --- |
| 데스크톱 | Tauri 2 + React + TypeScript + Vite, macOS/Windows/Linux 빌드 대상. |
| 런타임 | 앱이 자동 시작하는 번들 OpenCode sidecar. 사용자의 OpenCode 설정/데이터와 격리됩니다. |
| 프로젝트 | 세션을 묶는 이름 있는 프로젝트 워크스페이스. 기존 폴더를 그 자리에서 가져오기(복사하지 않음), 워크스페이스 안에 이미 있는 폴더 편입, 기존 세션을 프로젝트로 이동. |
| 세션 | 다중 세션 채팅, 보관/복원/내보내기가 있는 검색 가능한 히스토리, 날짜별 워크스페이스 폴더, `@` 파일 및 `#` 대화 참조, `/` 명령, `!` shell 모드. |
| 레이아웃 | 드래그로 재배치하는 N분할 페인 타일링, 독립 화면, 페인별 모델과 추론 강도, 화면 간 페인 드래그. |
| 에이전트 모드 | 계획 후 실행을 위한 `/plan`, 목표와 수용 기준을 위한 `/goal`, 전용 패널의 서브에이전트 상태, 런타임의 실제 서버 상태를 반영하는 중지. |
| 메모리 | 전역과 프로젝트 두 계층 메모리(켜고 끌 수 있음), 그리고 모델 컨텍스트 창에 가까워지면 자동 컨텍스트 압축. |
| 원격 컴퓨팅 | `~/.ssh/config`에서 머신을 등록하고 점검하며, 앱에서 작업을 제출·추적·취소. |
| 외관 | 테마별 강조색이 있는 Light / Warm / Dark 3종 테마와 UI 확대/축소. |
| 파일 | 전역/세션 파일 탐색, 컨텍스트 메뉴, 외부 열기/표시, 경로 복사, 로컬 미리보기 서버. |
| 원격 접속 | 실제 UI를 CLI, LAN 웹 브라우저, 또는 휴대폰에 제공하는 토큰 인증 게이트웨이(기본은 loopback, LAN은 선택적 활성화); 읽기 전용/전체 접근 모드; 토큰이 포함된 링크를 복사해 한 번의 탭으로 연결. API 키는 네트워크를 통해 전송되지 않습니다. |
| 브라우저 제어 | 에이전트가 프로필과 로그인 상태가 보존된 당신의 Chrome을 조작해 접근성 트리로 페이지를 읽거나, 필요할 때 격리된/비공개 브라우저를 사용합니다. |
| 노트북 | 실제 `.ipynb`, Python/R 노트북 생성, 로컬 커널 실행, 번들 `uv` 기반 Jupyter 환경, JupyterLab 열기. |
| 실행 기록 | append-only run log, 전역 SQLite 인덱스, 검색/필터/페이지네이션, 로컬/원격 surface, 출력 링크, 로그, 재현 prompt. |
| Provenance | `.openscience/provenance.jsonl`이 파일 버전을 기록하고 산출물을 생성한 실행 또는 편집과 연결합니다. |
| 뷰어 | PDF, 이미지, 비디오, HTML, Markdown, 코드, CSV/TSV와 차트, DOCX, XLSX, PPTX, 분자, 3D mesh, genome, FITS, DOS/DOSCAR, EIGENVAL bands, qcode, anomaly map, phase 파일. |
| UI 언어 | English, 简体中文, 日本語, Español, Deutsch, Français, 한국어. Portuguese (Brazil)와 Arabic은 등록되어 있지만 아직 선택할 수 없습니다. |

## 스킬과 커넥터

빌드 시 `ai4s-skills`, `anthropics/skills`의 `docx`/`pdf`/`pptx`/`xlsx`, 그리고 `runtime/skills/core/`의 first-party 스킬을 가져옵니다: `traceability-review`, `stats-integrity`, `domain-check`, `large-file`, `publication-figures`, `remote-compute`, `modal-run`.

원클릭 과학 MCP 커넥터: literature search, biomedical databases, Materials Project, FRED, Space weather, Open-Meteo, USGS water data. Settings에서 로컬 또는 원격 MCP 서버를 직접 추가할 수도 있습니다.

## 설치

[Releases](https://github.com/ai4s-research/open-science/releases/latest)에서 최신 설치 파일을 받으세요.

- **macOS**: `.dmg` / `.app`, Apple Silicon 및 Intel, macOS 13 Ventura 이상.
- **Windows**: NSIS `.exe` 및 `.msi`, Windows 10/11 x64.
- **Linux**: x86_64용 `.deb` 및 `.rpm`.

macOS 패키지는 Developer ID 서명·공증·스테이플이 완료되어 그대로 열립니다. `xattr` 우회는 필요하지 않습니다. Windows와 Linux 빌드는 아직 서명되지 않았습니다.

Windows에서는 SmartScreen에서 **More info -> Run anyway**를 선택합니다.

## 소스에서 빌드

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

검사:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## 안전과 개인정보

워크스페이스 파일, 원본 데이터, 세션 히스토리, provenance, 노트북, run record는 기본적으로 로컬에 남습니다. 명령 실행, 파일 삭제, 의존성 설치, 원격 연결은 사용자 승인을 거칩니다. 자격 증명은 앱 전용 런타임 설정에 저장되며 워크스페이스, provenance, git, export, 전역 OpenCode 설정에는 들어가지 않습니다.

## 저장소 구조

| 경로 | 용도 |
| --- | --- |
| `apps/desktop/` | Tauri + React 데스크톱 앱. |
| `packages/sdk/` | UI가 OpenCode를 직접 호출하지 않도록 하는 `OpenCodeClient`. |
| `packages/shared/` | 공유 타입과 차트 팔레트. |
| `runtime/skills/core/` | First-party 과학 스킬. |
| `runtime/skills/external/` | 빌드 시 가져오는 외부 스킬. |
| `examples/` | 내장 예제 워크스페이스. |
| `scripts/dev/` | sidecar, `uv`, skill fetcher 및 집중 회귀 검사. |
| `docs/` | 제품, 기술, operator, connector, research notes. |

## 상태

가장 신뢰할 수 있는 구현 로그는 [`PROGRESS.md`](./PROGRESS.md)입니다. 가까운 작업은 Windows 코드 서명, 자동 업데이트, Windows/Linux 검증 확대, 커넥터 강화, 재현성 리뷰 지속입니다. macOS 릴리스는 이미 서명·공증되었습니다. 토론은 [Open Science Discord](https://discord.gg/fWNMDKcd5P)에서도 할 수 있습니다.

[MIT](./LICENSE). Open Science Desktop은 beta 연구 도구입니다. 출력은 초안으로 보고, 공개나 의사결정 전에 숫자, 인용, 코드, 결론을 검증하세요.

## 인용

연구에서 Open Science Desktop을 사용했다면 아래와 같이 인용해 주세요:

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

GitHub의 **“Cite this repository”** 버튼([`CITATION.cff`](./CITATION.cff) 기반)에서 APA/BibTeX 형식도 얻을 수 있습니다.
