<div align="center">

[![Open Science Desktop — 本地优先 AI 科研桌面工作台](./docs/assets/banner.webp)](https://github.com/ai4s-research/open-science)

# Open Science Desktop

**本地优先、模型无关的 macOS、Windows & Linux AI 科研桌面工作台。**

原名 Open Science。它是 Claude Science 及同类 AI-for-science 工作台的开源桌面替代：
基于 Tauri、MCP、agent skills 和可复现工件构建。它把智能体、笔记本、文件、图表、
报告、运行记录和审查连接成一条可审计的桌面工作流。

<p>
  <a href="./README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="./README.ja.md">日本語</a> ·
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
  <a href="http://makeapullrequest.com"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <a href="https://linux.do"><img src="https://img.shields.io/badge/Join-linux.do-orange" alt="linux.do"></a>
</p>

</div>

---

## 最新动态

- **2026-08-18** — 🖥️ **无屏也能跑，终端命令随包附带。** `osd server` 在没有显示器的机器上启动整套工作台——工作区、智能体运行时，以及*同一套* Web UI；`osd session send … --wait` 让脚本或另一个智能体来驱动它。`osd` 现在装在桌面安装包里，首次启动自动进入 PATH；服务器上用压缩包，什么都不用装。模型、密钥、审批都能在终端配置（`osd model`、`osd auth`、`osd approval`）。
- **2026-08-13** — 🔌 **双向支持 Agent Client Protocol。** 在本应用里直接驱动 Codex、Gemini CLI、Claude Code 等任意 ACP 智能体——沿用它自己的模型、历史，以及你在本应用配置的 MCP 连接器；反过来，也可以从 Zed、JetBrains、Neovim 里驱动 Open Science。 *(v0.4.0)*
- **2026-08-01** — 🗂️ **项目、记忆与完整历史。** 会话可以归入命名项目（**就地**导入已有仓库，不做复制），智能体获得持久的全局记忆与项目记忆，全部历史对话都能在可搜索的历史视图中找到，并支持归档、恢复与导出。 *(v0.3.1)*
- **2026-07-24** — 🪟 **分屏平铺。** 会话可以并排平铺、拖拽分栏重新停靠、保留多个互不干扰的「屏幕」，每个分栏还能用不同的模型。 *(v0.3.0)*
- **2026-07-21** — 🌐 **随时随地访问——连手机都行。** 一个基于令牌认证的网关，把*真正的*桌面 UI 提供给命令行、局域网中的浏览器或你的手机（默认仅回环地址；局域网需手动开启）。在电脑前发起一次运行，然后在手机上查看完成的图表和报告。 *(v0.2.3)*
- **2026-07-21** — 🧭 **浏览器控制。** 智能体可以驱动你自己的 Chrome——保留配置文件和登录状态——像你一样浏览实时网页，也可以按需使用隔离的隐私浏览器。 *(v0.2.3)*
- **2026-07-09** — 🎉 **ResearchClawBench 排名第 1。** Open Science Desktop 在面向自主科研智能体的端到端基准 [ResearchClawBench](https://internscience.github.io/ResearchClawBench-Home/) 上，按已评分任务平均分排名第 1（Pass@1 榜单）。

---

## 目录

- [✨ 它能做什么](#它能做什么)
- [🎬 效果演示](#效果演示)
- [🧪 当前能力](#当前能力)
- [🔌 技能与连接器](#技能与连接器)
- [📦 安装](#安装)
- [🖥️ 无头与命令行(`osd`)](#无头与命令行osd)
- [🚀 从源码构建](#从源码构建)
- [🔒 安全与隐私](#安全与隐私)
- [🗂️ 仓库结构](#仓库结构)
- [📌 状态](#状态)
- [🤝 参与贡献](#参与贡献)
- [📖 引用](#引用)
- [⚖️ 许可证](#许可证)

## 它能做什么

**跑完整个科研闭环**——从一个宽泛的方向到一篇成稿论文：探索、文献综述、假设、实验代码、分析、绘图、写作，全部在一次连续、可审计的会话里完成。

- **自主科研智能体**：内置的 `ai4s-agent` 端到端串起各专项技能(探索 → 综述 → 实验 → 写作)，每一步都把一个真实、可检查的工件落到你的工作区里,而不只是一条聊天回复。
- **一切都可回溯**：图、表、报告、笔记本和运行输出都连回生成它们的确切代码、输入、环境、模型输出和对话。
- **本地优先，数据归你**：会话、数据、溯源、笔记本和运行记录都在本机的本地文件夹里,默认不外流。
- **模型无关运行时**：UI 通过 `packages/sdk` 调用内置固定版本的 OpenCode sidecar——自带模型即可;模型提供方、技能和 MCP 服务器保持可插拔。
- **天然可复现**：本地、SSH/Slurm、Modal 和 notebook-batch 运行都被记录为可复现的 run record,而不是散落的终端输出。
- **随时随地访问**：内置的、基于令牌认证的网关把*真正的*桌面 UI 提供给局域网里的浏览器或手机(有隧道时更可从任何地方访问)——在电脑前发起一次运行,午饭时用手机查看进度。默认关闭;开启前仅限回环地址,且 API key 永不离开本机。
- **驱动你自己的浏览器**：智能体可以控制你真实的 Chrome,保留你的配置文件和登录状态,像你一样浏览实时网页——你也可以选择一个隔离的隐私浏览器。
- **先规划再动手**：`/plan` 在动任何文件之前先给出执行计划,`/goal` 则先确定目标、约束与验收标准,再让智能体朝它推进。
- **为长期项目而建**:命名项目把相关会话归到一处,两层持久记忆(全局与项目级)在会话之间承载要紧的信息,长对话在接近模型上下文窗口时自动压缩。
- **同时推进多条线**:分栏并排平铺、多个互不干扰的「屏幕」,每个分栏可用各自的模型。
- **可扩展**:智能体技能、MCP 服务器与一键科学连接器、`/` 命令、`!` shell 模式,以及一个模型无关的 SDK。

## 效果演示

**一句提示 -> 一张可发表级别的图，图上每个点都能回溯到生成它的确切代码和输入。** 没有黑盒：打开任意工件，就能看到生成它的脚本、它的数据文件，以及产出它的对话。

![工件检查器中，一张跨物种图谱图与其生成脚本和输入文件并列展示](./docs/assets/showcase-provenance.webp)

**文献 -> 可验证报告。** 把检索扇出到多个来源，起草一篇渲染成 PDF 的稿件，并在发布前用引用评审把关——DOI 逐一解析，无出处的数值以及图表/代码不一致都会被标记出来。

![一篇蛋白质语言模型的文献综述被汇编成 PDF 稿件，引用评审确认每个 DOI 都可解析](./docs/assets/showcase-literature.webp)

**驱动你自己的 Chrome。** 智能体通过你真实的浏览器配置文件——连同登录状态——读取实时网页，再把找到的内容变成一张图和一份可排序的 CSV。

![智能体通过 open-science-browser 驱动用户自己的 Chrome，把 bioRxiv 预印本采集成图表和 CSV](./docs/assets/showcase-browser.webp)

**随时随地做研究——连手机都行。** 内置的认证网关把*真正的*桌面 UI 提供给局域网里的浏览器(或通过隧道),这样你就能在电脑前发起一次运行,再在手机上查看完成的图表和报告。

<table align="center">
  <tr>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-home.webp" width="240" alt="在手机浏览器中运行的工作台：带有起步分析的新建会话界面"><br><sub>新建会话</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-run.webp" width="240" alt="在手机上查看一份完成的剂量-响应分析——脚本、结果、图表与报告"><br><sub>一份完成的分析</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-reproduce.webp" width="240" alt="在手机上查看正在复现的 scVI 基准，以及它的 ARI-vs-epoch 图"><br><sub>一份复现的基准</sub></td>
  </tr>
</table>

<details>
<summary><b>更多截图</b></summary>

<br>

![在远程 A100 上以固定环境复现 scVI 整合基准，附带执行日志和溯源](./docs/assets/showcase-remote.webp)

![一张 8 组的 scVI 超参数扫描表格，与共享智能体内核的实时分析笔记本并列](./docs/assets/showcase-experiment.webp)

</details>

## 当前能力

**把科研闭环做成技能。** 一个元技能跑完整条流水线;每个阶段都是一个自足的技能,产出真实、可评审的工件——在 OpenCode 支持的任意模型上都能跑:

| 技能 | 职责 | 主要产出 |
| --- | --- | --- |
| `ai4s-agent` | 按顺序运行下面四个技能 | 完整的研究包 |
| `research-explorer` | 把宽泛方向收敛成具体课题 | `research_exploration.md`、`topic_matrix.md`、`literature_pre_survey.md` |
| `literature-survey` | 撰写文献综述 | 6–20 页 PDF、60+ 条真实引用、LaTeX 源码、分类学图 |
| `experiment-suite` | 构建实验包 | 设计文档、可运行代码、带溯源的 `results.json`、图、报告 |
| `paper-writer` | 撰写研究论文 | 8–14 页 PDF、200+ 引用、4–8 张图、表格 |
| `mindmap-render` | 渲染思维导图 | 由 `topic_matrix.md` 生成的图片 |
| `integrity-auditor` | 审计论文完整性 | 图像/数值/逻辑问题、四级证据分级、`audit_report.md` |

这些技能随 `ai4s-skills` 技能包一起提供,与第一方审查技能以及下方的 Office/文档技能并列。

### 平台

| 范围 | 当前状态 |
| --- | --- |
| 桌面外壳 | Tauri 2 + React + TypeScript + Vite，主打 macOS 和 Windows 桌面构建，同时提供 Linux 包。 |
| 运行时 | 内置 OpenCode sidecar，由应用自动启动，并与用户自己的 OpenCode 配置/数据隔离。 |
| 项目 | 命名的项目工作区,把相关会话归到一处;可就地导入已有文件夹(绝不复制),或纳管工作区内已存在的文件夹;已有会话也能移动到项目中。 |
| 会话 | 多会话聊天与历史、按时间创建的工作区文件夹、可搜索的历史(含归档/恢复/导出)、`@` 引用文件与 `#` 引用历史会话、`/` 命令和 `!` shell 模式。 |
| 布局 | N 元分屏平铺,支持拖拽停靠、多个独立「屏幕」、每个分栏各自的模型与推理强度,以及跨屏幕拖拽分栏。 |
| 智能体模式 | `/plan` 先规划后执行,`/goal` 设定目标与验收标准,子代理状态实时显示在独立面板,「停止」反映运行时真实的服务端状态。 |
| 记忆 | 全局与项目两层记忆,可开关;长对话接近模型窗口时自动压缩上下文。 |
| 远程计算 | 从 `~/.ssh/config` 登记计算机、探测可用性,并在应用内提交、跟踪或取消作业。 |
| 外观 | Light / Warm / Dark 三套主题(各有自己的强调色)与界面缩放。 |
| 文件 | 全局和会话内文件浏览、右键菜单、系统打开/定位、复制路径、本地预览服务。 |
| 无头与命令行 | `osd server` 以无窗口方式运行工作台——同样的工作区、同样的运行时、同样的 Web UI，全部来自一个自包含目录；`osd` 则从终端驱动它（或驱动正在运行的桌面应用）：会话、项目、运行记录、文件、审批，支持 `--wait` 与 `--json`。 |
| 远程访问 | 基于令牌认证的网关，把真正的 UI 提供给命令行、局域网 Web 浏览器或你的手机(默认仅回环地址，局域网需手动开启);支持只读与完全访问两种模式;可复制一条内嵌令牌的链接，一键连接。API key 永不经过网络传输。 |
| 编辑器互通（ACP） | 双向支持 Agent Client Protocol：既可以把任意 ACP 智能体（Codex、Gemini CLI、Claude Code 等）作为运行时接到常规界面背后，沿用它自己的模型与推理档位选择、历史回放，以及本应用的 MCP 连接器；也可以让外部编辑器（Zed、JetBrains、Neovim 等）驱动 Open Science，复用网关令牌。 |
| 浏览器控制 | 智能体驱动你自己的 Chrome——保留配置文件和登录状态——通过无障碍树读取页面，也可按需使用隔离的隐私浏览器。 |
| 笔记本 | 真实 `.ipynb` 文件、Python/R 笔记本创建、本地内核运行、内置 `uv` 管理 Jupyter 环境，以及打开 JupyterLab。 |
| 运行记录 | 追加式 run log、全局 SQLite 索引、搜索/筛选/分页、本地与远程 surface、输出链接、日志和复现提示。 |
| 溯源 | `.openscience/provenance.jsonl` 记录文件版本，并把产物连回创建它的运行或编辑。 |
| 审查 | 内置 traceability、stats-integrity、domain-check、large-file、publication-figure、remote-compute、Modal run 等第一方技能。 |
| 查看器 | PDF、图片、视频、HTML、Markdown、代码、CSV/TSV 表格与图表、DOCX、XLSX、PPTX、分子、3D mesh、基因组轨道、FITS、DOS/DOSCAR、EIGENVAL bands、qcode、异常图和 phase 文件。 |
| 模型 | OpenCode 提供方目录、OAuth/API key 连接、自定义 OpenAI-compatible endpoint，以及 OpenCode 支持的本地/云模型选项。 |
| 界面语言 | English、简体中文、日本語、Español、Deutsch、Français、한국어。Portuguese (Brazil) 和 Arabic 已注册，但还不可选。 |

## 技能与连接器

构建和发布时会拉取内置技能，避免把第三方技能包直接提交到 git 历史：

- `ai4s-research/ai4s-skills` 技能包。
- Apache-2.0 `anthropics/skills` 仓库中的 Office/文档技能：`docx`、`pdf`、`pptx`、`xlsx`。
- `runtime/skills/core/` 中的第一方技能：`traceability-review`、`stats-integrity`、`domain-check`、`large-file`、`publication-figures`、`remote-compute`、`modal-run`。

当前一键科学 MCP 连接器包括：

- 文献检索：arXiv、PubMed、Crossref、Semantic Scholar、bioRxiv/medRxiv。
- 生物医学数据库：PubMed、ClinicalTrials.gov、MyVariant/ClinVar。
- Materials Project。
- FRED 经济数据。
- Space weather。
- Open-Meteo 天气与气候。
- USGS water data。

你也可以在 Settings 中添加任意本地或远程 MCP 服务器。参见
[`docs/CONNECT_YOUR_TOOLS.md`](./docs/CONNECT_YOUR_TOOLS.md)。

中立定位对比见
[`Open Science Desktop vs OpenScience`](./docs/open-science-desktop-vs-openscience.md)。

## 安装

从 [Releases 页面](https://github.com/ai4s-research/open-science/releases/latest) 下载最新安装包。

- **macOS**：`.dmg` / `.app`，Apple Silicon 和 Intel，要求 macOS 13 Ventura 或更高。
- **Windows**：NSIS `.exe`，Windows 10/11 x64 —— 按用户安装，无需管理员权限。另发 `.msi` 供机构批量部署；两种格式请择一使用，不要混装。
- **Linux**：x86_64 Linux 的 `.deb` 和 `.rpm`。

macOS 安装包已使用 Developer ID 签名、公证并 staple，可直接打开，无需 `xattr` 之类的绕过操作。Windows 与 Linux 构建尚未签名。

**Windows**：如果出现 SmartScreen，选择 **更多信息 -> 仍要运行**。

**Linux**：

```bash
sudo apt install ./Open.Science_*.deb
# 或
sudo rpm -i Open.Science-*.rpm
```

## 无头与命令行(`osd`)

科研机器通常没有屏幕。`osd` 就是没有屏幕的同一套工作台：同样的工作区布局、同样的智能体运行时、同样的项目、同样的 Web UI——只是通过 HTTP 提供，而不是画在窗口里。

**在服务器上，用压缩包。** Releases 里的 `osd-<version>-<target>` 解压即跑，什么都不用装——已在一个不加任何软件包的空白 Ubuntu 容器里验证过。

```bash
# 配置这台机器（服务还没启动时也能配）
./osd auth set anthropic --key sk-…       # 只留在本机，绝不上网络
./osd model set anthropic/claude-opus-4-5 # 之后每一轮的默认模型
./osd server --lan                        # 打印访问地址和令牌
```

密钥也可以完全不落盘：智能体运行时继承本进程的环境变量，所以 `ANTHROPIC_API_KEY=sk-… ./osd server` 根本不需要 `auth set`。自建或代理的端点写在同一条命令里（`--base-url https://my-gateway.internal/v1`）；`osd auth ls` 只打印提供商名字——任何地方都不会打印密钥。改了密钥需要重启服务，CLI 会主动提示，而不是让你自己猜。

打开打印出来的地址，浏览器里就是真正的桌面 UI，手机也一样。也可以从终端驱动它——本机、SSH 过去，或者从你的笔记本：

```bash
osd project new "Reef survey"
id=$(osd session new --project "Reef survey")
osd session send "$id" "Fit the 2015–2024 bleaching trend and write report.md" \
    --model anthropic/claude-sonnet-4-5 --wait
osd fs ls figures/
osd fs get report.md --output ./report.md
```

Windows 上同样的命令在 PowerShell 里可用，只是 shell 语法不同：

```powershell
$id = osd session new --project "Reef survey"
osd session send $id "Fit the 2015-2024 bleaching trend and write report.md" --wait
```

**在你自己的机器上，它已经装好了。** 桌面安装包里带着 `osd`，应用首次启动时会把它放到你的 PATH 上，所以新开一个终端就能用，不需要任何设置。它只写一个小的包装脚本（`~/.local/bin/osd`，或者当终端本来就搜索 `~/bin` 时放那里）——绝不是符号链接，因为 `osd` 要在自己真实可执行文件的旁边找运行时。如果那个目录不在 PATH 上，应用会把它加进你的登录 profile，并在「设置 → 远程访问」里说明改了哪个文件。你 shell 上的其他东西一概不动。

`--wait` 在这一轮真正跑完时才返回，而不是在被接受时；如果这一轮什么都没答，它会明确报错。`--json` 输出接口原样的响应，供脚本解析。

### 用哪个模型，谁来批准

`osd model` 显示当前默认模型，`osd model ls` 列出运行时**真正能服务**的模型（也就是这台机器有凭据的那些提供商，当前那个带星号），`osd model set <provider/model>` 修改它——走网关，所以对远程服务器同样有效。任何单轮都可以用 `osd session send --model … --agent … --effort …` 覆盖。

审批规则依然生效：智能体在执行命令、删除文件、安装依赖或访问网络前会询问。没有窗口时，`--wait` 会说明**在等什么**，并给出两条回答路径——终端里 `osd permission ls` / `osd permission allow <id>`，或者它打印的那个网关地址（带令牌，所以笔记本或手机上的浏览器可以直接批准）。

无人值守的机器可以显式放弃审批：

```bash
osd approval            # 现在哪些动作需要询问
osd approval set full   # 一律不问：命令、删除、装依赖、访问网络
```

`full` 是一个明确的选择，不是默认值：智能体仍被限制在工作区内，但不会再为你暂停。`osd approval set approve` 把所有规则放回去。

### 作为系统服务运行

`osd server` 就是一个普通的前台进程，systemd 直接跑它即可。下面这份 unit 已在 Ubuntu 上完整跑过——启用、重启、崩溃、停止：

```ini
# /etc/systemd/system/osd.service
[Unit]
Description=Open Science Desktop (headless)
After=network-online.target

[Service]
Type=simple
User=ubuntu
Environment=HOME=/home/ubuntu
ExecStart=/opt/osd/osd server --port 4788
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now osd`，打印出的地址和令牌会进 `journalctl -u osd`。用 unit 也是最干净的跑法：systemd 停止时会收走整个 cgroup，所以无论服务怎么死，智能体运行时都不会活得比它久。

不指定 `--gateway` 时，`osd` 会连上本机已经在跑的网关——包括桌面应用自己的那个——所以只要应用开着，`osd session ls` 直接就能用。否则用 `osd login --gateway <url> --token <token>` 指向任意一台。

没有桌面时*不具备*的能力：本地 Jupyter 内核、系统文件对话框、系统文件管理器——Web UI 会直接隐藏它们，而不是给出一个注定失败的按钮。另有两点值得知道：**溯源记录与运行记录是由桌面客户端写入的**，所以无头服务端仍会用 git 快照保留工作区的文件历史，但不会追加 `provenance.jsonl` 和运行索引。

## 从源码构建

前置依赖：

- Node.js >= 20
- pnpm 9
- Rust 工具链
- Tauri 在当前系统需要的 macOS、Windows 或 Linux 依赖

```bash
git clone https://github.com/ai4s-research/open-science
cd open-science
pnpm install

bash scripts/dev/fetch-opencode.sh
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh

# osd 终端客户端也一起打包；它是我们自己的代码，所以是构建而非下载。
bash scripts/dev/build-osd-sidecar.sh $(rustc -vV | sed -n 's/host: //p')

pnpm --filter @ai4s/desktop tauri dev
pnpm --filter @ai4s/desktop tauri build
```

常用检查：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## 安全与隐私

- 工作区文件、原始数据、会话历史、溯源、笔记本和运行记录默认保留在本机。
- 命令执行、删除文件、安装依赖和远程连接在桌面应用中走人工批准流程。
- 提供方凭据写入应用私有运行时配置，不进入工作区、溯源、git、导出或用户全局 OpenCode 配置。
- Settings 中有大白话数据流说明，说明哪些内容可能发给所选模型提供方。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `apps/desktop/` | Tauri + React 桌面应用。 |
| `packages/sdk/` | `OpenCodeClient`，避免 UI 直接调用 OpenCode。 |
| `packages/shared/` | 共享领域类型和图表色板。 |
| `packages/ui/` | 共享 UI 包。 |
| `runtime/skills/core/` | 第一方科学技能。 |
| `runtime/skills/external/` | 构建时拉取的外部技能。 |
| `runtime/harness/` | 运行时 harness 知识与 operator 上下文。 |
| `runtime/mcp/` | MCP 运行时说明和配置。 |
| `examples/` | 内置示例工作区。 |
| `crates/osd-core/` | 服务端内核——工作区、sidecar、网关。不依赖 Tauri，因而可无头运行。 |
| `crates/osd-cli/` | `osd`：无头服务端及其客户端。 |
| `scripts/dev/` | sidecar、`uv`、技能拉取器和聚焦回归探针。 |
| `docs/` | 产品、技术、operator、连接器和研究笔记。 |

## 状态

项目是正在积极开发的桌面 MVP。最可靠的当前实现日志是 [`PROGRESS.md`](./PROGRESS.md)。
产品和架构说明位于 [`docs/PRD.md`](./docs/PRD.md) 和
[`docs/TECHNICAL_DESIGN.md`](./docs/TECHNICAL_DESIGN.md)，但这些文档同时包含目标设计和历史状态说明。

近期工作集中在 Windows 代码签名、自动更新、更广的 Windows/Linux 验证、连接器加固，以及继续强化可复现性审查。macOS 发布版已完成签名与公证。

## 参与贡献

欢迎 Issue 和 PR。请保持改动最小且可验证，遵循 [`AGENTS.md`](./AGENTS.md)，并在提交 PR 前运行检查。讨论和交流可以加入
[Open Science Discord](https://discord.gg/fWNMDKcd5P)，也可以在 [linux.do](https://linux.do) 社区参与。

## 引用

如果 Open Science Desktop 对你的研究有帮助,请如下引用:

```bibtex
@software{open_science_desktop,
  author  = {{The Open Science Desktop Contributors}},
  title   = {Open Science Desktop: a local-first, model-agnostic AI research workbench},
  year    = {2026},
  version = {0.5.2},
  doi     = {10.5281/zenodo.22004919},
  url     = {https://github.com/ai4s-research/open-science},
  license = {MIT}
}
```

仓库页顶部的 **"Cite this repository"** 按钮(由 [`CITATION.cff`](./CITATION.cff) 生成)提供 APA 与 BibTeX 两种格式。

## 许可证

[MIT](./LICENSE)。随附的第三方技能和连接器保留各自许可证。

> Open Science Desktop 仍是 beta 阶段科研工具。产出应视为草稿：发表或决策前请核对数字、引用、代码和结论。
