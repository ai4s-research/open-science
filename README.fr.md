<div align="center">

[![Open Science Desktop — Local-first AI research workbench](./docs/assets/banner.webp)](https://github.com/ai4s-research/open-science)

# Open Science Desktop

**Atelier de recherche IA local-first et agnostique au modèle pour macOS, Windows & Linux.**

Formerly Open Science. Une alternative desktop open source à Claude Science et aux workbenches AI-for-science similaires, construite avec Tauri, MCP, agent skills et des artefacts reproductibles. Elle relie agents, notebooks, fichiers, figures, rapports, exécutions et revue dans un flux desktop auditable.

<p>
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <b>Français</b> ·
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

## Actualités

- **2026-08-13** — 🔌 **Parle l'Agent Client Protocol, dans les deux sens.** Pilotez Codex, Gemini CLI, Claude Code ou tout autre agent ACP depuis cette application — avec ses propres modèles, son historique et vos connecteurs MCP — ou pilotez Open Science depuis Zed, JetBrains ou Neovim. *(v0.4.0)*
- **2026-08-01** — 🗂️ **Projets, mémoire et historique complet.** Regroupez les sessions dans des projets nommés (un dépôt existant est importé *sur place*, sans copie), donnez à l'agent une mémoire persistante globale et par projet, et retrouvez chaque conversation passée dans un historique cherchable avec archivage, restauration et export. *(v0.3.1)*
- **2026-07-24** — 🪟 **Panneaux divisés.** Disposez les sessions côte à côte, faites glisser les panneaux pour les réancrer, gardez plusieurs écrans indépendants et utilisez un modèle différent par panneau. *(v0.3.0)*
- **2026-07-21** — 🌐 **Accès depuis n'importe où — même votre téléphone.** Une passerelle authentifiée par jeton sert l'*vraie* UI desktop à une CLI, à un navigateur sur votre réseau local ou à votre téléphone (loopback par défaut ; le LAN est opt-in). Lancez une exécution à votre bureau et lisez la figure et le rapport terminés sur votre téléphone. *(v0.2.3)*
- **2026-07-21** — 🧭 **Contrôle du navigateur.** L'agent peut piloter votre propre Chrome — profil et sessions intacts — pour lire le web en direct comme vous le faites, ou un navigateur privé isolé à la demande. *(v0.2.3)*
- **2026-07-09** — 🎉 **N° 1 sur ResearchClawBench.** Open Science Desktop est n° 1 au score moyen des tâches évaluées sur [ResearchClawBench](https://internscience.github.io/ResearchClawBench-Home/), un benchmark de bout en bout pour agents autonomes de recherche scientifique (classement Pass@1).

---

## Sommaire

- [✨ Ce que fait Open Science](#ce-que-fait-open-science)
- [🎬 Captures](#captures)
- [🧪 Fonctionnalités actuelles](#fonctionnalités-actuelles)
- [🔌 Skills et connecteurs](#skills-et-connecteurs)
- [📦 Installation](#installation)
- [🚀 Construire depuis le code source](#construire-depuis-le-code-source)
- [🔒 Sécurité et confidentialité](#sécurité-et-confidentialité)
- [🗂️ Structure du dépôt](#structure-du-dépôt)
- [📌 État](#état)

## Ce que fait Open Science

**Déroule toute la boucle de recherche** — d'une direction large à un article terminé : exploration, revue de littérature, hypothèse, code d'expérience, analyse, figures et rédaction, en une seule session continue et auditable.

- **Agents de recherche autonomes** : le `ai4s-agent` intégré enchaîne des skills spécialisés de bout en bout (explorer → revue → expérience → rédaction), et chaque étape dépose un artefact réel et inspectable dans votre workspace, pas seulement une réponse de chat.
- **Tout est traçable** : figures, tables, rapports, notebooks et sorties d'exécution renvoient au code, aux entrées, à l'environnement, à la sortie du modèle et à la conversation exacts qui les ont produits.
- **Local-first et à vous** : sessions, données, provenance, notebooks et run records vivent dans des dossiers locaux sur votre machine. Rien ne sort par défaut.
- **Runtime agnostique au modèle** : l'UI passe par `packages/sdk` vers un sidecar OpenCode épinglé et intégré. Apportez votre propre modèle ; fournisseurs, skills et serveurs MCP restent remplaçables.
- **Reproductible par conception** : les exécutions locales, SSH/Slurm, Modal et notebook-batch sont enregistrées comme run records reproductibles, pas comme sortie de terminal éparse.
- **Accessible depuis n'importe où** : une passerelle intégrée et authentifiée par jeton sert l'*vraie* UI desktop à un navigateur sur votre réseau local ou votre téléphone (ou, via un tunnel, depuis n'importe où) — lancez une exécution à votre bureau et suivez-la depuis votre téléphone pendant le déjeuner. Désactivée par défaut ; loopback uniquement tant que vous n'y consentez pas, et les clés API ne quittent jamais la machine.
- **Pilote votre propre navigateur** : l'agent peut contrôler votre vrai Chrome, avec votre profil et vos sessions intacts, pour lire le web en direct comme vous le faites — ou un navigateur privé isolé quand vous préférez qu'il s'en abstienne.
- **Extensible** : skills d'agent, serveurs MCP et connecteurs scientifiques en un clic, commandes `/`, mode shell `!` et un SDK agnostique au modèle.

## Captures

**Un prompt → une figure de qualité publication, et chaque point renvoie au code et aux entrées exacts qui l'ont produit.** Pas de boîtes noires : ouvrez n'importe quel artefact pour voir le script qui l'a généré, ses fichiers de données et la conversation qui l'a produit.

![Une figure d'atlas inter-espèces rendue, à côté de son script générateur et de ses fichiers d'entrée dans l'inspecteur d'artefacts](./docs/assets/showcase-provenance.webp)

**La littérature → un rapport vérifiable.** Déployez la recherche sur plusieurs sources, rédigez un manuscrit rendu en PDF, et soumettez-le à une revue des citations — DOIs résolus, chiffres sans source et incohérences figure/code signalés — avant toute publication.

![Une revue de littérature sur les modèles de langage des protéines compilée en un manuscrit PDF, avec un vérificateur de citations confirmant que chaque DOI se résout](./docs/assets/showcase-literature.webp)

**Pilote votre propre Chrome.** L'agent lit le web en direct via votre profil de navigateur réel — sessions comprises — puis transforme ce qu'il trouve en une figure et un CSV triable.

![L'agent pilotant le propre Chrome de l'utilisateur via le contrôle du navigateur pour collecter des préprints bioRxiv dans un graphique et un CSV](./docs/assets/showcase-browser.webp)

**Faire de la recherche depuis n'importe où — même votre téléphone.** Une passerelle intégrée et authentifiée sert l'*vraie* UI desktop à un navigateur sur votre réseau local (ou via un tunnel), pour que vous puissiez lancer une exécution à votre bureau et lire la figure et le rapport terminés sur votre téléphone.

<table align="center">
  <tr>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-home.webp" width="240" alt="L'atelier dans un navigateur mobile : l'écran de nouvelle session avec des analyses de démarrage"><br><sub>Nouvelle session</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-run.webp" width="240" alt="Une analyse dose-réponse terminée — script, résultats, figure et rapport — sur un téléphone"><br><sub>Une analyse terminée</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-reproduce.webp" width="240" alt="Reproduction d'un benchmark scVI, avec sa figure ARI-vs-époque, vue sur un téléphone"><br><sub>Un benchmark reproduit</sub></td>
  </tr>
</table>

<details>
<summary><b>Autres captures</b></summary>

<br>

![Reproduction d'un benchmark d'intégration scVI sur un A100 distant avec un environnement épinglé, un journal d'exécution et la provenance](./docs/assets/showcase-remote.webp)

![Un tableau de balayage d'hyperparamètres scVI à 8 branches à côté d'un notebook d'analyse en direct partageant le kernel de l'agent](./docs/assets/showcase-experiment.webp)

</details>

## Fonctionnalités actuelles

**La boucle de recherche, sous forme de skills.** Un méta-skill déroule tout le pipeline ; chaque étape est un skill autonome qui produit un artefact réel et évaluable — exécutable sur n'importe quel modèle pris en charge par OpenCode :

| Skill | Rôle | Sortie principale |
| --- | --- | --- |
| `ai4s-agent` | Exécute les quatre skills ci-dessous, dans l'ordre | Le package de recherche complet |
| `research-explorer` | Transformer une direction large en sujets concrets | `research_exploration.md`, `topic_matrix.md`, `literature_pre_survey.md` |
| `literature-survey` | Rédiger une revue de littérature | PDF de 6–20 p, 60+ citations réelles, source LaTeX, figures de taxonomie |
| `experiment-suite` | Construire un package d'expérience | Document de conception, code exécutable, `results.json` avec provenance, figures, rapport |
| `paper-writer` | Rédiger un article de recherche | PDF de 8–14 p, 200+ citations, 4–8 figures, tables |
| `mindmap-render` | Rendre une carte mentale | Image générée à partir d'un `topic_matrix.md` |
| `integrity-auditor` | Auditer l'intégrité d'un article | Constats image/numériques/logiques, évaluation en 4 niveaux, `audit_report.md` |

Ils sont fournis dans le pack `ai4s-skills`, aux côtés des skills de revue maison et des skills Office/documents ci-dessous.

### Plateforme

| Domaine | État actuel |
| --- | --- |
| Desktop | Tauri 2 + React + TypeScript + Vite, avec cibles macOS, Windows et Linux. |
| Runtime | Sidecar OpenCode inclus, démarré par l'app et isolé de la configuration/données OpenCode de l'utilisateur. |
| Projets | Workspaces de projet nommés qui regroupent leurs sessions ; importez un dossier existant sur place (jamais copié) ou adoptez-en un déjà présent dans le workspace ; déplacez une session existante dans un projet. |
| Sessions | Chat multi-session, historique cherchable avec archivage/restauration/export, dossiers datés, références `@` aux fichiers et `#` aux conversations, commandes `/` et mode shell `!`. |
| Disposition | Pavage de panneaux n-aire avec glisser-déposer pour réancrer, écrans indépendants, modèle et effort de raisonnement par panneau, glissement de panneaux entre écrans. |
| Modes de l'agent | `/plan` pour planifier puis exécuter, `/goal` pour l'objectif et les critères d'acceptation, statut des sous-agents dans son propre panneau, et Stop qui reflète l'état réel du serveur. |
| Mémoire | Couches de mémoire globale et par projet, activables, plus compactage automatique du contexte à l'approche de la fenêtre du modèle. |
| Calcul distant | Enregistrez des machines depuis votre `~/.ssh/config`, testez-les et soumettez, suivez ou annulez des tâches depuis l'app. |
| Apparence | Thèmes Light, Warm et Dark avec leurs accents, et zoom de l'interface. |
| Fichiers | Navigation globale et par session, menu contextuel, ouvrir/révéler, copier le chemin, serveur local de preview. |
| Accès distant | Passerelle authentifiée par jeton qui sert la vraie UI à une CLI, à un navigateur web du réseau local ou à votre téléphone (loopback par défaut, LAN opt-in) ; modes lecture seule ou accès complet ; copiez un lien avec le jeton intégré pour vous connecter en un tap. Les clés API ne transitent jamais par le réseau. |
| Interopérabilité éditeur (ACP) | Parle l'Agent Client Protocol dans les deux sens : n'importe quel agent ACP (Codex, Gemini CLI, Claude Code, …) tourne comme runtime derrière l'UI habituelle, avec ses propres sélecteurs de modèle et d'effort de raisonnement, la relecture de l'historique et les connecteurs MCP de cette application ; ou un éditeur externe (Zed, JetBrains, Neovim, …) pilote Open Science en réutilisant le jeton de la passerelle. |
| Contrôle du navigateur | L'agent pilote votre propre Chrome — profil et état de connexion préservés — en lisant les pages via l'arbre d'accessibilité, ou un navigateur isolé/privé à la demande. |
| Notebooks | Fichiers `.ipynb` réels, création Python/R, kernel local, environnement Jupyter géré via `uv`, action Open JupyterLab. |
| Exécutions | Run logs append-only, index SQLite global, recherche/facettes/pagination, surfaces locales/distantes, liens de sorties, logs et prompts de reproduction. |
| Provenance | `.openscience/provenance.jsonl` enregistre les versions de fichiers et relie les artefacts à l'exécution ou l'édition qui les a créés. |
| Visionneuses | PDF, image, vidéo, HTML, Markdown, code, CSV/TSV avec graphiques, DOCX, XLSX, PPTX, molécules, 3D mesh, génome, FITS, DOS/DOSCAR, EIGENVAL bands, qcode, cartes d'anomalies et fichiers phase. |
| Langues de l'UI | English, 简体中文, 日本語, Español, Deutsch, Français et 한국어. Portuguese (Brazil) et Arabic sont enregistrés mais pas encore sélectionnables. |

## Skills et connecteurs

Au build, le projet récupère `ai4s-skills`, les skills `docx`/`pdf`/`pptx`/`xlsx` de `anthropics/skills`, et les skills internes de `runtime/skills/core/` : `traceability-review`, `stats-integrity`, `domain-check`, `large-file`, `publication-figures`, `remote-compute` et `modal-run`.

Connecteurs MCP scientifiques en un clic : recherche bibliographique, bases biomédicales, Materials Project, FRED, Space weather, Open-Meteo et USGS water data. Tout serveur MCP local ou distant peut aussi être ajouté depuis Settings.

## Installation

Téléchargez la dernière version depuis [Releases](https://github.com/ai4s-research/open-science/releases/latest).

- **macOS** : `.dmg` / `.app`, Apple Silicon et Intel, macOS 13 Ventura ou plus récent.
- **Windows** : `.exe` NSIS, Windows 10/11 x64 — installation par utilisateur, sans droits administrateur. Un `.msi` est aussi publié pour les déploiements gérés par la DSI ; choisissez un format et conservez-le.
- **Linux** : `.deb` et `.rpm` pour x86_64.

Les paquets macOS sont signés avec un Developer ID, notarisés et agrafés : ils s'ouvrent normalement, sans passer par `xattr`. Les builds Windows et Linux ne sont pas encore signés.

Sous Windows, choisissez **More info -> Run anyway** dans SmartScreen.

## Construire depuis le code source

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

Vérifications :

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Sécurité et confidentialité

Les fichiers du workspace, données brutes, historique, provenance, notebooks et run records restent locaux par défaut. Exécution de commandes, suppression de fichiers, installation de dépendances et connexions distantes passent par une approbation humaine. Les identifiants sont stockés dans la configuration privée de l'app, pas dans le workspace, la provenance, git, les exports ni la configuration OpenCode globale.

## Structure du dépôt

| Chemin | Rôle |
| --- | --- |
| `apps/desktop/` | App desktop Tauri + React. |
| `packages/sdk/` | `OpenCodeClient`, couche qui évite les appels directs UI -> OpenCode. |
| `packages/shared/` | Types partagés et palette de graphiques. |
| `runtime/skills/core/` | Skills scientifiques internes. |
| `runtime/skills/external/` | Skills externes récupérés au build. |
| `examples/` | Workspaces d'exemple inclus. |
| `scripts/dev/` | Fetchers sidecar, `uv`, skills et tests ciblés. |
| `docs/` | Notes produit, technique, operator, connecteurs et recherche. |

## État

Le journal d'implémentation le plus fiable est [`PROGRESS.md`](./PROGRESS.md). Les prochains travaux portent sur la signature de code Windows, l'auto-update, une vérification Windows/Linux plus large, le durcissement des connecteurs et la revue de reproductibilité. Les releases macOS sont déjà signées et notarisées. Pour discuter du projet, rejoignez le [Discord Open Science](https://discord.gg/fWNMDKcd5P).

[MIT](./LICENSE). Open Science Desktop est un outil de recherche beta : traitez les sorties comme des brouillons et vérifiez nombres, citations, code et conclusions avant publication ou décision.

## Citation

Si vous utilisez Open Science Desktop dans vos recherches, merci de le citer ainsi :

```bibtex
@software{open_science_desktop,
  author  = {{The Open Science Desktop Contributors}},
  title   = {Open Science Desktop: a local-first, model-agnostic AI research workbench},
  year    = {2026},
  version = {0.4.2},
  doi     = {10.5281/zenodo.21967622},
  url     = {https://github.com/ai4s-research/open-science},
  license = {MIT}
}
```

Le bouton **« Cite this repository »** de GitHub (généré depuis [`CITATION.cff`](./CITATION.cff)) fournit la même référence en APA et BibTeX.
