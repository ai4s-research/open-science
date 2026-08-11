<div align="center">

[![Open Science Desktop — Local-first AI research workbench](./docs/assets/banner.webp)](https://github.com/ai4s-research/open-science)

# Open Science Desktop

**Banco de trabajo de investigación con IA, local-first y agnóstico al modelo, para macOS, Windows & Linux.**

Formerly Open Science. Una alternativa desktop open source a Claude Science y workbenches AI-for-science similares, construida con Tauri, MCP, agent skills y artefactos reproducibles. Conecta agentes, notebooks, archivos, figuras, informes, ejecuciones y revisión en un flujo de escritorio auditable.

<p>
  <a href="./README.md">English</a> ·
  <a href="./README.zh.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <b>Español</b> ·
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

## Novedades

- **2026-08-01** — 🗂️ **Proyectos, memoria e historial completo.** Agrupa sesiones en proyectos con nombre (un repositorio existente se importa *en su sitio*, sin copiarlo), da al agente memoria persistente global y por proyecto, y alcanza cualquier conversación pasada desde un historial buscable con archivar, restaurar y exportar. *(v0.3.1)*
- **2026-07-24** — 🪟 **Paneles divididos.** Coloca sesiones en mosaico, arrastra paneles para reacomodarlos, mantén varias pantallas independientes y usa un modelo distinto en cada panel. *(v0.3.0)*
- **2026-07-21** — 🌐 **Acceso desde cualquier lugar — incluso desde tu teléfono.** Un gateway autenticado por token sirve la UI de escritorio *real* a una CLI, un navegador en tu LAN o tu teléfono (loopback por defecto; la LAN es opcional). Inicia una ejecución en tu escritorio y lee la figura y el informe terminados desde tu teléfono. *(v0.2.3)*
- **2026-07-21** — 🧭 **Control del navegador.** El agente puede manejar tu propio Chrome — con tu perfil y sesiones intactos — para leer la web en vivo como lo harías tú, o un navegador privado aislado cuando lo necesites. *(v0.2.3)*
- **2026-07-09** — 🎉 **#1 en ResearchClawBench.** Open Science Desktop ocupa el puesto #1 por promedio de tareas puntuadas en [ResearchClawBench](https://internscience.github.io/ResearchClawBench-Home/), un benchmark end-to-end para agentes autónomos de investigación científica (leaderboard Pass@1).

---

## Índice

- [✨ Qué hace](#qué-hace)
- [🎬 Capturas](#capturas)
- [🧪 Capacidades actuales](#capacidades-actuales)
- [🔌 Skills y conectores](#skills-y-conectores)
- [📦 Instalación](#instalación)
- [🚀 Compilar desde el código](#compilar-desde-el-código)
- [🔒 Seguridad y privacidad](#seguridad-y-privacidad)
- [🗂️ Estructura del repositorio](#estructura-del-repositorio)
- [📌 Estado](#estado)

## Qué hace

**Ejecuta todo el ciclo de investigación** — de una dirección amplia a un artículo terminado: exploración, revisión bibliográfica, hipótesis, código de experimentos, análisis, figuras y redacción, en una sola sesión continua y auditable.

- **Agentes de investigación autónomos**: el `ai4s-agent` incluido encadena skills especializadas de principio a fin (explorar → revisar → experimentar → escribir), y cada paso deja un artefacto real e inspeccionable en tu workspace, no solo una respuesta de chat.
- **Todo es trazable**: figuras, tablas, informes, notebooks y salidas de ejecución enlazan con el código, las entradas, el entorno, la salida del modelo y la conversación exactos que los produjeron.
- **Local-first y tuyo**: sesiones, datos, procedencia, notebooks y registros de ejecución viven en carpetas locales de tu máquina. Nada sale por defecto.
- **Runtime agnóstico al modelo**: la UI habla mediante `packages/sdk` con un sidecar OpenCode fijado y empaquetado. Trae tu propio modelo; proveedores, skills y servidores MCP siguen siendo intercambiables.
- **Reproducible por diseño**: las ejecuciones locales, SSH/Slurm, Modal y notebook-batch se registran como run records reproducibles, no como salida suelta de terminal.
- **Accesible desde cualquier lugar**: un gateway integrado y autenticado por token sirve la UI de escritorio *real* a un navegador en tu LAN o teléfono (o, con un túnel, desde cualquier lugar) — arranca una ejecución en tu escritorio y revísala desde tu teléfono durante el almuerzo. Desactivado por defecto; solo loopback hasta que lo actives, y las API keys nunca salen de la máquina.
- **Maneja tu propio navegador**: el agente puede controlar tu Chrome real, con tu perfil y sesiones intactos, para leer la web en vivo como lo harías tú — o un navegador privado aislado cuando prefieras que no.
- **Extensible**: skills de agente, servidores MCP y conectores científicos de un clic, comandos `/`, modo shell `!` y un SDK agnóstico al modelo.

## Capturas

**Un prompt -> una figura con calidad de publicación, y cada punto se remonta al código y las entradas exactas que la generaron.** Sin cajas negras: abre cualquier artefacto para ver su script generador, sus archivos de datos y la conversación que lo produjo.

![Una figura de atlas entre especies renderizada junto a su script generador y sus archivos de entrada en el inspector de artefactos](./docs/assets/showcase-provenance.webp)

**Bibliografía -> un informe verificable.** Despliega la búsqueda por múltiples fuentes, redacta un manuscrito renderizado como PDF y somételo a una revisión de citas —DOIs resueltos, cifras sin fuente e inconsistencias entre figuras y código señaladas— antes de que nada salga.

![Un estudio bibliográfico sobre modelos de lenguaje de proteínas compilado en un manuscrito PDF, con un revisor de citas confirmando que cada DOI resuelve](./docs/assets/showcase-literature.webp)

**Maneja tu propio Chrome.** El agente lee la web en vivo a través de tu perfil de navegador real —con todas tus sesiones— y luego convierte lo que encuentra en una figura y un CSV ordenable.

![El agente manejando el propio Chrome del usuario mediante control del navegador para recopilar preprints de bioRxiv en un gráfico y un CSV](./docs/assets/showcase-browser.webp)

**Investiga desde cualquier lugar — incluso desde tu teléfono.** Un gateway autenticado integrado sirve la UI de escritorio *real* a un navegador en tu LAN (o un túnel), de modo que puedes iniciar una ejecución en tu escritorio y leer la figura y el informe terminados desde tu teléfono.

<table align="center">
  <tr>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-home.webp" width="240" alt="El banco de trabajo en el navegador de un teléfono: la pantalla de nueva sesión con análisis de inicio"><br><sub>Nueva sesión</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-run.webp" width="240" alt="Un análisis dosis-respuesta terminado —script, resultados, figura e informe— en un teléfono"><br><sub>Un análisis terminado</sub></td>
    <td align="center" width="33%"><img src="./docs/assets/showcase-mobile-reproduce.webp" width="240" alt="Reproduciendo un benchmark de scVI, con su figura de ARI frente a épocas, visto en un teléfono"><br><sub>Un benchmark reproducido</sub></td>
  </tr>
</table>

<details>
<summary><b>Más capturas</b></summary>

<br>

![Reproduciendo un benchmark de integración de scVI en una A100 remota con un entorno fijado, registro de ejecución y procedencia](./docs/assets/showcase-remote.webp)

![Una tabla de barrido de hiperparámetros de scVI con 8 configuraciones junto a un notebook de análisis en vivo que comparte el kernel del agente](./docs/assets/showcase-experiment.webp)

</details>

## Capacidades actuales

**El ciclo de investigación, como skills.** Un meta-skill ejecuta toda la tubería; cada etapa es un skill autónomo que produce un artefacto real y evaluable — ejecutable en cualquier modelo que soporte OpenCode:

| Skill | Rol | Salida principal |
| --- | --- | --- |
| `ai4s-agent` | Ejecuta los cuatro skills siguientes, en orden | El paquete de investigación completo |
| `research-explorer` | Convertir una dirección amplia en temas concretos | `research_exploration.md`, `topic_matrix.md`, `literature_pre_survey.md` |
| `literature-survey` | Escribir una revisión bibliográfica | PDF de 6–20 pp, 60+ citas reales, fuente LaTeX, figuras de taxonomía |
| `experiment-suite` | Construir un paquete de experimentos | Documento de diseño, código ejecutable, `results.json` con procedencia, figuras, informe |
| `paper-writer` | Escribir un artículo de investigación | PDF de 8–14 pp, 200+ citas, 4–8 figuras, tablas |
| `mindmap-render` | Renderizar un mapa mental | Imagen generada a partir de un `topic_matrix.md` |
| `integrity-auditor` | Auditar la integridad de un artículo | Hallazgos de imagen/numéricos/lógicos, evidencia en 4 niveles, `audit_report.md` |

Vienen en el pack `ai4s-skills`, junto a las skills de revisión propias y las skills de Office/documentos de abajo.

### Plataforma

| Área | Estado actual |
| --- | --- |
| Escritorio | Tauri 2 + React + TypeScript + Vite, con objetivos de build para macOS, Windows y Linux. |
| Runtime | Sidecar OpenCode incluido, iniciado por la app y aislado de la configuración/datos OpenCode del usuario. |
| Proyectos | Workspaces de proyecto con nombre que agrupan sus sesiones; importa una carpeta existente en su sitio (nunca se copia) o adopta una que ya esté en el workspace; mueve una sesión existente a un proyecto. |
| Sesiones | Chat multi-sesión, historial buscable con archivar/restaurar/exportar, carpetas fechadas, referencias `@` a archivos y `#` a conversaciones, comandos `/` y modo shell `!`. |
| Disposición | Mosaico de paneles n-ario con arrastrar para reacomodar, pantallas independientes, modelo y esfuerzo de razonamiento por panel, y arrastre de paneles entre pantallas. |
| Modos del agente | `/plan` para planificar y luego ejecutar, `/goal` para objetivo y criterios de aceptación, estado de subagentes en su propio panel, y Detener que refleja el estado real del servidor. |
| Memoria | Capas de memoria global y por proyecto, conmutables, más compactación automática del contexto al acercarse a la ventana del modelo. |
| Cómputo remoto | Registra máquinas desde tu `~/.ssh/config`, compruébalas y envía, sigue o cancela trabajos desde la app. |
| Apariencia | Temas Light, Warm y Dark con acentos propios, y zoom de la interfaz. |
| Archivos | Navegación global y por sesión, menú contextual, abrir/revelar en el sistema, copiar ruta y servidor local de previsualización. |
| Acceso remoto | Gateway autenticado por token que sirve la UI real a una CLI, un navegador web en la LAN o tu teléfono (loopback por defecto, LAN opcional); modos de solo lectura frente a acceso completo; copia un enlace con el token incrustado para conectarte con un toque. Las API keys nunca cruzan la red. |
| Control del navegador | El agente maneja tu propio Chrome — con el perfil y el estado de sesión preservados — leyendo las páginas a través del árbol de accesibilidad, o un navegador aislado/privado cuando lo pidas. |
| Notebooks | Archivos `.ipynb` reales, creación Python/R, kernel local, entorno Jupyter gestionado con `uv` incluido y acción para abrir JupyterLab. |
| Ejecuciones | Logs append-only, índice SQLite global, búsqueda/facetas/paginación, superficies locales/remotas, enlaces a salidas, logs y prompts de reproducción. |
| Procedencia | `.openscience/provenance.jsonl` registra versiones de archivos y conecta artefactos con la ejecución o edición que los creó. |
| Visores | PDF, imagen, vídeo, HTML, Markdown, código, CSV/TSV con gráficos, DOCX, XLSX, PPTX, moléculas, 3D mesh, genoma, FITS, DOS/DOSCAR, EIGENVAL bands, qcode, mapas de anomalías y phase. |
| Idiomas de UI | English, 简体中文, 日本語, Español, Deutsch, Français y 한국어. Portuguese (Brazil) y Arabic están registrados, pero aún no son seleccionables. |

## Skills y conectores

En build se obtienen `ai4s-skills`, los skills `docx`/`pdf`/`pptx`/`xlsx` de `anthropics/skills`, y los skills propios en `runtime/skills/core/`: `traceability-review`, `stats-integrity`, `domain-check`, `large-file`, `publication-figures`, `remote-compute` y `modal-run`.

Conectores MCP científicos de un clic: búsqueda bibliográfica, bases biomédicas, Materials Project, FRED, Space weather, Open-Meteo y USGS water data. También puedes agregar cualquier servidor MCP local o remoto desde Settings.

## Instalación

Descarga la versión más reciente desde [Releases](https://github.com/ai4s-research/open-science/releases/latest).

- **macOS**: `.dmg` / `.app`, Apple Silicon e Intel, macOS 13 Ventura o posterior.
- **Windows**: `.exe` NSIS y `.msi`, Windows 10/11 x64.
- **Linux**: `.deb` y `.rpm` para x86_64.

Los paquetes de macOS están firmados con Developer ID, notarizados y con el ticket adjunto, así que se abren con normalidad: no hace falta el truco de `xattr`. Los builds de Windows y Linux aún no están firmados.

En Windows, usa **More info -> Run anyway** en SmartScreen.

## Compilar desde el código

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

Comprobaciones:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Seguridad y privacidad

Los archivos del workspace, datos crudos, historial, procedencia, notebooks y run records permanecen locales por defecto. La ejecución de comandos, borrado de archivos, instalación de dependencias y conexiones remotas pasan por aprobación humana. Las credenciales se guardan en configuración privada de la app, no en el workspace, procedencia, git, exportaciones ni configuración global de OpenCode.

## Estructura del repositorio

| Ruta | Propósito |
| --- | --- |
| `apps/desktop/` | App de escritorio Tauri + React. |
| `packages/sdk/` | `OpenCodeClient`, la capa que evita llamadas directas desde la UI a OpenCode. |
| `packages/shared/` | Tipos compartidos y paleta de gráficos. |
| `runtime/skills/core/` | Skills científicos propios. |
| `runtime/skills/external/` | Skills externos obtenidos durante build. |
| `examples/` | Workspaces de ejemplo incluidos. |
| `scripts/dev/` | Fetchers de sidecar, `uv`, skills y pruebas enfocadas. |
| `docs/` | Notas de producto, técnica, operator, conectores e investigación. |

## Estado

El registro de implementación más fiable es [`PROGRESS.md`](./PROGRESS.md). El trabajo cercano se centra en la firma de código en Windows, auto-update, más verificación en Windows/Linux, endurecimiento de conectores y revisión de reproducibilidad. Las releases de macOS ya están firmadas y notarizadas. Para discutir el proyecto, únete al [Open Science Discord](https://discord.gg/fWNMDKcd5P).

[MIT](./LICENSE). Open Science Desktop es tooling beta de investigación: trata las salidas como borradores y verifica números, citas, código y conclusiones antes de publicar o decidir.

## Cita

Si usas Open Science Desktop en tu investigación, cítalo así:

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

El botón **“Cite this repository”** de GitHub (generado desde [`CITATION.cff`](./CITATION.cff)) ofrece la misma referencia en APA y BibTeX.
