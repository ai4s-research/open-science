<div align="center">

[![Open Science Desktop — Local-first AI research workbench](./docs/assets/banner.webp)](https://github.com/ai4s-research/open-science)

# Open Science Desktop

**Local-first, modellunabhängige KI-Forschungs-Workbench für macOS, Windows & Linux.**

Formerly Open Science. Eine quelloffene Desktop-Alternative zu Claude Science und ähnlichen AI-for-science-Workbenches, gebaut mit Tauri, MCP, agent skills und reproduzierbaren Artefakten. Agenten, Notebooks, Dateien, Abbildungen, Berichte, Läufe und Reviews werden zu einem auditierbaren Desktop-Workflow verbunden.

<p>
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.es.md">Español</a> ·
  <b>Deutsch</b> ·
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

## Neuigkeiten

- **2026-08-01** — 🗂️ **Projekte, Memory und vollständiger Verlauf.** Sitzungen in benannten Projekten gruppieren (ein bestehendes Repository wird *an seinem Ort* importiert, nicht kopiert), dem Agenten globales und projektbezogenes Memory geben und jede frühere Unterhaltung über einen durchsuchbaren Verlauf mit Archivieren, Wiederherstellen und Export erreichen. *(v0.3.1)*
- **2026-07-24** — 🪟 **Geteilte Panes.** Sitzungen nebeneinander anordnen, Panes per Drag neu andocken, mehrere unabhängige Screens behalten und in jedem Pane ein anderes Modell fahren. *(v0.3.0)*
- **2026-07-21** — 🌐 **Von überall zugreifen — sogar vom Handy.** Ein token-authentifiziertes Gateway liefert die *echte* Desktop-UI an eine CLI, einen Browser in deinem LAN oder dein Handy (standardmäßig nur Loopback; LAN ist optional aktivierbar). Starte einen Lauf am Schreibtisch und lies die fertige Abbildung und den Bericht auf deinem Handy. *(v0.2.3)*
- **2026-07-21** — 🧭 **Browser-Steuerung.** Der Agent kann deinen eigenen Chrome steuern — mit Profil und Logins intakt —, um das aktuelle Web so zu lesen wie du, oder bei Bedarf einen isolierten privaten Browser. *(v0.2.3)*
- **2026-07-09** — 🎉 **Platz 1 auf ResearchClawBench.** Open Science Desktop belegt nach Durchschnitt der bewerteten Aufgaben Platz 1 auf [ResearchClawBench](https://internscience.github.io/ResearchClawBench-Home/), einem End-to-End-Benchmark für autonome wissenschaftliche Forschungsagenten (Pass@1-Leaderboard).

---

## Inhalt

- [✨ Was es leistet](#was-es-leistet)
- [🎬 Screenshots](#screenshots)
- [🧪 Aktuelle Funktionen](#aktuelle-funktionen)
- [🔌 Skills und Konnektoren](#skills-und-konnektoren)
- [📦 Installation](#installation)
- [🚀 Aus dem Quellcode bauen](#aus-dem-quellcode-bauen)
- [🔒 Sicherheit und Datenschutz](#sicherheit-und-datenschutz)
- [🗂️ Repository-Struktur](#repository-struktur)
- [📌 Status](#status)

## Was es leistet

**Durchläuft die gesamte Forschungsschleife** — von einer groben Richtung bis zum fertigen Paper: Exploration, Literaturüberblick, Hypothese, Experiment-Code, Analyse, Abbildungen und Ausarbeitung, in einer durchgängigen, auditierbaren Sitzung.

- **Autonome Forschungs-Agenten**: Der gebündelte `ai4s-agent` verkettet Spezial-Skills Ende zu Ende (Explore → Survey → Experiment → Write), und jeder Schritt legt ein echtes, prüfbares Artefakt in deinen Workspace, nicht nur eine Chat-Antwort.
- **Alles ist rückverfolgbar**: Abbildungen, Tabellen, Berichte, Notebooks und Lauf-Ausgaben verweisen auf den exakten Code, die Inputs, die Umgebung, die Modellausgabe und das Gespräch, die sie erzeugt haben.
- **Local-first und deins**: Sitzungen, Daten, Provenance, Notebooks und Run Records liegen in lokalen Ordnern auf deinem Gerät. Standardmäßig verlässt nichts das Gerät.
- **Modellunabhängige Laufzeit**: Die UI spricht über `packages/sdk` mit einem gebündelten, gepinnten OpenCode-Sidecar. Bring dein eigenes Modell mit; Provider, Skills und MCP-Server bleiben austauschbar.
- **Reproduzierbar von Grund auf**: Lokale, SSH/Slurm-, Modal- und Notebook-Batch-Läufe werden als reproduzierbare Run Records erfasst, nicht als loser Terminal-Output.
- **Von überall erreichbar**: Ein eingebautes, token-authentifiziertes Gateway liefert die *echte* Desktop-UI an einen Browser in deinem LAN oder auf deinem Handy (oder, mit einem Tunnel, von überall) — starte einen Lauf am Schreibtisch und schau in der Mittagspause vom Handy aus nach. Standardmäßig aus; nur Loopback, bis du es aktivierst, und API-Keys verlassen niemals das Gerät.
- **Steuert deinen eigenen Browser**: Der Agent kann deinen echten Chrome steuern — mit deinem Profil und deinen Logins intakt —, um das aktuelle Web so zu lesen wie du — oder einen isolierten privaten Browser, wenn dir das lieber ist.
- **Erweiterbar**: Agent-Skills, MCP-Server und Ein-Klick-Wissenschaftskonnektoren, `/`-Befehle, `!`-Shell-Modus und ein modellunabhängiges SDK.

## Screenshots

**Ein Prompt -> eine publikationsreife Abbildung, und jeder Punkt lässt sich auf genau den Code und die Eingaben zurückführen, die ihn erzeugt haben.** Keine Black Boxes: Öffne ein beliebiges Artefakt, um sein erzeugendes Skript, seine Datendateien und die Konversation zu sehen, die es hervorgebracht hat.

![Eine gerenderte artenübergreifende Atlas-Abbildung neben ihrem erzeugenden Skript und den Eingabedateien im Artefakt-Inspektor](./docs/assets/showcase-provenance.webp)

**Literatur -> ein überprüfbarer Bericht.** Fächere die Suche über mehrere Quellen auf, verfasse ein als PDF gerendertes Manuskript und stelle es unter einen Zitations-Review — DOIs aufgelöst, unbelegte Zahlen und Inkonsistenzen zwischen Abbildungen und Code markiert —, bevor irgendetwas ausgeliefert wird.

![Eine Literaturrecherche zu Protein-Sprachmodellen, zusammengestellt zu einem PDF-Manuskript, mit einem Zitations-Reviewer, der bestätigt, dass jede DOI auflöst](./docs/assets/showcase-literature.webp)

**Steuert deinen eigenen Chrome.** Der Agent liest das aktuelle Web über dein echtes Browser-Profil — Logins inklusive — und macht daraus eine Abbildung und eine sortierbare CSV.

![Der Agent steuert den eigenen Chrome des Nutzers per Browser-Steuerung, um bioRxiv-Preprints in ein Diagramm und eine CSV zu überführen](./docs/assets/showcase-browser.webp)

**Forschen von überall — sogar vom Handy.** Ein eingebautes, authentifiziertes Gateway liefert die *echte* Desktop-UI an einen Browser in deinem LAN (oder über einen Tunnel), sodass du einen Lauf am Schreibtisch starten und die fertige Abbildung und den Bericht auf deinem Handy lesen kannst.

<table align="center">
  <tr>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-home.webp" width="240" alt="Die Workbench in einem Handy-Browser: der Neue-Sitzung-Bildschirm mit Starter-Analysen"><br><sub>Neue Sitzung</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-run.webp" width="240" alt="Eine fertige Dosis-Wirkungs-Analyse — Skript, Ergebnisse, Abbildung und Bericht — auf einem Handy"><br><sub>Eine fertige Analyse</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-reproduce.webp" width="240" alt="Reproduktion eines scVI-Benchmarks mit seiner ARI-über-Epochen-Abbildung, betrachtet auf einem Handy"><br><sub>Ein reproduzierter Benchmark</sub></td>
  </tr>
</table>

<details>
<summary><b>Weitere Screenshots</b></summary>

<br>

![Reproduktion eines scVI-Integrations-Benchmarks auf einer entfernten A100 mit gepinnter Umgebung, Ausführungslog und Provenance](./docs/assets/showcase-remote.webp)

![Eine Tabelle mit einem 8-armigen scVI-Hyperparameter-Sweep neben einem live Analyse-Notebook, das sich den Kernel des Agents teilt](./docs/assets/showcase-experiment.webp)

</details>

## Aktuelle Funktionen

**Die Forschungsschleife als Skills.** Ein Meta-Skill durchläuft die gesamte Pipeline; jede Stufe ist ein eigenständiger Skill, der ein echtes, bewertbares Artefakt erzeugt — lauffähig auf jedem von OpenCode unterstützten Modell:

| Skill | Rolle | Hauptausgabe |
| --- | --- | --- |
| `ai4s-agent` | Führt die vier Skills unten der Reihe nach aus | Das komplette Forschungspaket |
| `research-explorer` | Eine grobe Richtung zu konkreten Themen verdichten | `research_exploration.md`, `topic_matrix.md`, `literature_pre_survey.md` |
| `literature-survey` | Einen Literaturüberblick schreiben | 6–20 S. PDF, 60+ echte Zitate, LaTeX-Quelle, Taxonomie-Abbildungen |
| `experiment-suite` | Ein Experiment-Paket bauen | Design-Dokument, lauffähiger Code, `results.json` mit Provenance, Abbildungen, Bericht |
| `paper-writer` | Ein Forschungspaper schreiben | 8–14 S. PDF, 200+ Zitate, 4–8 Abbildungen, Tabellen |
| `mindmap-render` | Eine Mindmap rendern | Aus einer `topic_matrix.md` generiertes Bild |
| `integrity-auditor` | Die Integrität eines Papers prüfen | Bild-/numerische/logische Befunde, 4-stufige Evidenzbewertung, `audit_report.md` |

Diese sind im `ai4s-skills`-Pack enthalten, neben den First-Party-Review-Skills und den Office-/Dokument-Skills weiter unten.

### Plattform

| Bereich | Aktueller Stand |
| --- | --- |
| Desktop | Tauri 2 + React + TypeScript + Vite, mit Build-Zielen für macOS, Windows und Linux. |
| Runtime | Gebündeltes OpenCode-Sidecar, von der App gestartet und von der OpenCode-Konfiguration des Nutzers isoliert. |
| Projekte | Benannte Projekt-Workspaces, die ihre Sitzungen gruppieren; einen bestehenden Ordner an seinem Ort importieren (nie kopiert) oder einen bereits im Workspace liegenden übernehmen; bestehende Sitzungen in ein Projekt verschieben. |
| Sitzungen | Multi-Session-Chat, durchsuchbarer Verlauf mit Archivieren/Wiederherstellen/Export, datierte Workspace-Ordner, `@`-Datei- und `#`-Unterhaltungsverweise, `/`-Befehle und `!`-Shell-Modus. |
| Layout | N-fach geteilte Panes mit Drag-to-Dock, unabhängige Screens, Modell und Reasoning-Aufwand pro Pane, Pane-Drag über Screens hinweg. |
| Agentenmodi | `/plan` für Planen-dann-Ausführen, `/goal` für Ziel und Abnahmekriterien, Subagenten-Status in eigenem Panel, Stop spiegelt den echten Serverzustand der Runtime. |
| Memory | Globale und projektbezogene Memory-Schichten, abschaltbar, plus automatische Kontext-Kompaktierung nahe am Kontextfenster des Modells. |
| Remote-Rechnen | Maschinen aus `~/.ssh/config` registrieren, prüfen und Jobs aus der App einreichen, verfolgen oder abbrechen. |
| Erscheinungsbild | Themes Light, Warm und Dark mit eigenen Akzentfarben und UI-Zoom. |
| Dateien | Globale und sitzungsbezogene Dateiansicht, Kontextmenü, extern öffnen/anzeigen, Pfad kopieren, lokaler Preview-Server. |
| Fernzugriff | Token-authentifiziertes Gateway, das die echte UI an eine CLI, einen Web-Browser im LAN oder dein Handy liefert (standardmäßig nur Loopback, LAN optional aktivierbar); Modi für Nur-Lesen bzw. Vollzugriff; kopiere einen Link mit eingebettetem Token, um dich mit einem Tipp zu verbinden. API-Keys gehen niemals über die Leitung. |
| Browser-Steuerung | Der Agent steuert deinen eigenen Chrome — mit erhaltenem Profil und Login-Zustand —, liest Seiten über den Accessibility-Baum, oder bei Bedarf einen isolierten/privaten Browser. |
| Notebooks | Echte `.ipynb`-Dateien, Python/R-Notebook-Erstellung, lokaler Kernel, Jupyter-Umgebung über gebündeltes `uv`, JupyterLab öffnen. |
| Läufe | Append-only Run Logs, globaler SQLite-Index, Suche/Facetten/Paginierung, lokale und entfernte Oberflächen, Output-Links, Logs und Reproduce-Prompts. |
| Provenance | `.openscience/provenance.jsonl` zeichnet Dateiversionen auf und verbindet Artefakte mit dem erzeugenden Lauf oder Edit. |
| Viewer | PDF, Bild, Video, HTML, Markdown, Code, CSV/TSV mit Charts, DOCX, XLSX, PPTX, Moleküle, 3D Mesh, Genom, FITS, DOS/DOSCAR, EIGENVAL bands, qcode, Anomaly Maps und Phase-Dateien. |
| UI-Sprachen | English, 简体中文, 日本語, Español, Deutsch, Français und 한국어. Portuguese (Brazil) und Arabic sind registriert, aber noch nicht auswählbar. |

## Skills und Konnektoren

Beim Build werden `ai4s-skills`, die `docx`/`pdf`/`pptx`/`xlsx`-Skills aus `anthropics/skills` und First-Party-Skills aus `runtime/skills/core/` geholt: `traceability-review`, `stats-integrity`, `domain-check`, `large-file`, `publication-figures`, `remote-compute` und `modal-run`.

Ein-Klick-MCP-Konnektoren: Literatursuche, biomedizinische Datenbanken, Materials Project, FRED, Space weather, Open-Meteo und USGS water data. Beliebige lokale oder entfernte MCP-Server können in Settings ergänzt werden.

## Installation

Lade den neuesten Installer von [Releases](https://github.com/ai4s-research/open-science/releases/latest).

- **macOS**: `.dmg` / `.app`, Apple Silicon und Intel, macOS 13 Ventura oder neuer.
- **Windows**: NSIS `.exe` und `.msi`, Windows 10/11 x64.
- **Linux**: `.deb` und `.rpm` für x86_64.

Die macOS-Pakete sind Developer-ID-signiert, notarisiert und gestapelt und öffnen sich normal — kein `xattr`-Workaround nötig. Windows- und Linux-Builds sind noch nicht signiert.

Unter Windows in SmartScreen **More info -> Run anyway** wählen.

## Aus dem Quellcode bauen

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

Checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Sicherheit und Datenschutz

Workspace-Dateien, Rohdaten, Sitzungsverlauf, Provenance, Notebooks und Run Records bleiben standardmäßig lokal. Befehlsausführung, Dateilöschung, Dependency-Installation und Remote-Verbindungen laufen über menschliche Genehmigung. Zugangsdaten werden in app-privater Runtime-Konfiguration gespeichert, nicht im Workspace, in Provenance, git, Exporten oder globaler OpenCode-Konfiguration.

## Repository-Struktur

| Pfad | Zweck |
| --- | --- |
| `apps/desktop/` | Tauri + React Desktop-App. |
| `packages/sdk/` | `OpenCodeClient`, damit die UI OpenCode nicht direkt aufruft. |
| `packages/shared/` | Gemeinsame Typen und Chart-Palette. |
| `runtime/skills/core/` | First-Party-Wissenschafts-Skills. |
| `runtime/skills/external/` | Beim Build geholte externe Skills. |
| `examples/` | Mitgelieferte Beispiel-Workspaces. |
| `scripts/dev/` | Fetcher für Sidecar, `uv`, Skills und fokussierte Regressionstests. |
| `docs/` | Produkt-, Technik-, Operator-, Konnektor- und Forschungsnotizen. |

## Status

Das verlässlichste Implementierungslog ist [`PROGRESS.md`](./PROGRESS.md). Nahe Arbeiten: Windows-Code-Signierung, Auto-Update, breitere Windows/Linux-Verifikation, robustere Konnektoren und weitere Reproduzierbarkeits-Reviews. macOS-Releases sind bereits signiert und notarisiert. Für Diskussionen gibt es den [Open Science Discord](https://discord.gg/fWNMDKcd5P).

[MIT](./LICENSE). Open Science Desktop ist Beta-Forschungstooling. Ausgaben sind Entwürfe: Zahlen, Zitate, Code und Schlussfolgerungen vor Veröffentlichung oder Entscheidung prüfen.

## Zitation

Wenn Sie Open Science Desktop in Ihrer Forschung verwenden, zitieren Sie es bitte wie folgt:

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

GitHubs **„Cite this repository“**-Button (aus [`CITATION.cff`](./CITATION.cff) generiert) liefert dieselbe Referenz als APA und BibTeX.
