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

- **2026-08-18** — 🖥️ **Funciona sin pantalla.** `osd server` levanta el banco de trabajo completo — workspace, runtime del agente y la *misma* UI web — en una máquina sin display, y `osd session send … --wait` lo maneja desde un script o desde otro agente. Un archivo comprimido, sin instalador. `osd` viaja dentro del instalador de escritorio y se pone en tu PATH al primer arranque; en un servidor basta el archivo comprimido. Modelos, claves y aprobaciones se configuran desde la terminal (`osd model`, `osd auth`, `osd approval`).
- **2026-08-13** — 🔌 **Habla el Agent Client Protocol, en ambas direcciones.** Maneja Codex, Gemini CLI, Claude Code o cualquier otro agente ACP desde dentro de esta app — con sus propios modelos, su historial y tus conectores MCP — o maneja Open Science desde Zed, JetBrains o Neovim. *(v0.4.0)*
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
- [🖥️ Sin pantalla y CLI (`osd`)](#sin-pantalla-y-cli-osd)
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
| Sin pantalla y CLI | `osd server` ejecuta el banco de trabajo sin ventana — el mismo workspace, el mismo runtime, la misma UI web, servidos desde un único directorio autocontenido — y `osd` lo maneja (o maneja una app de escritorio en marcha) desde la terminal: sesiones, proyectos, ejecuciones, archivos, aprobaciones, `--wait`, `--json`. |
| Acceso remoto | Gateway autenticado por token que sirve la UI real a una CLI, un navegador web en la LAN o tu teléfono (loopback por defecto, LAN opcional); modos de solo lectura frente a acceso completo; copia un enlace con el token incrustado para conectarte con un toque. Las API keys nunca cruzan la red. |
| Interoperabilidad con editores (ACP) | Habla el Agent Client Protocol en ambas direcciones: ejecuta cualquier agente ACP (Codex, Gemini CLI, Claude Code, …) como el runtime detrás de la UI de siempre, con sus propios selectores de modelo y de esfuerzo de razonamiento, reproducción del historial y los conectores MCP de esta app; o deja que un editor externo (Zed, JetBrains, Neovim, …) maneje Open Science reutilizando el token del gateway. |
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
- **Windows**: `.exe` NSIS, Windows 10/11 x64: se instala por usuario, sin permisos de administrador. También se publica un `.msi` para despliegue gestionado por TI; elige un formato y mantente en él.
- **Linux**: `.deb` y `.rpm` para x86_64.

Los paquetes de macOS están firmados con Developer ID, notarizados y con el ticket adjunto, así que se abren con normalidad: no hace falta el truco de `xattr`. Los builds de Windows y Linux aún no están firmados.

En Windows, usa **More info -> Run anyway** en SmartScreen.

## Sin pantalla y CLI (`osd`)

Una máquina de investigación normalmente no tiene pantalla. `osd` es el mismo banco de trabajo sin ella: la misma organización del workspace, el mismo runtime del agente, los mismos proyectos y la misma UI web — servida por HTTP en lugar de dibujada en una ventana.

**En un servidor, usa el archivo comprimido.** `osd-<version>-<target>` de
Releases se descomprime y funciona sin instalar nada — verificado en un
contenedor Ubuntu desnudo, sin añadir un solo paquete.

```bash
# Configurar la máquina (funciona antes de que haya un servidor)
./osd auth set anthropic --key sk-…       # se queda en esta máquina, nunca viaja por la red
./osd model set anthropic/claude-opus-4-5 # el modelo por defecto de cada turno
./osd server --lan                        # imprime su URL y su token de acceso
```

Las claves no tienen que tocar ningún archivo: el runtime del agente hereda el
entorno de este proceso, así que `ANTHROPIC_API_KEY=sk-… ./osd server` no
necesita `auth set`. Un endpoint propio o tras proxy va en el mismo comando
(`--base-url https://my-gateway.internal/v1`), y `osd auth ls` imprime solo
nombres de proveedores — ninguna clave se imprime en ninguna parte. Cambiar una
clave exige reiniciar; la CLI lo dice en lugar de dejarte a oscuras.

Abre la URL que imprime y tendrás la UI de escritorio real en un navegador, teléfono incluido. O manéjalo desde una terminal: en la misma máquina, por SSH o desde tu portátil:

```bash
osd project new "Reef survey"
id=$(osd session new --project "Reef survey")
osd session send "$id" "Fit the 2015–2024 bleaching trend and write report.md" \
    --model anthropic/claude-sonnet-4-5 --wait
osd fs ls figures/
osd fs get report.md --output ./report.md
```

En Windows los mismos comandos funcionan en PowerShell; solo cambia la sintaxis
del shell:

```powershell
$id = osd session new --project "Reef survey"
osd session send $id "Fit the 2015-2024 bleaching trend and write report.md" --wait
```

**En tu propia máquina ya está instalado.** El instalador de escritorio lleva
`osd` dentro, y la app lo pone en tu PATH la primera vez que arranca: una
terminal nueva ya tiene el comando, sin configurar nada. Escribe un pequeño
envoltorio (`~/.local/bin/osd`, o `~/bin` cuando una terminal ya busca ahí) —
nunca un enlace simbólico, porque `osd` encuentra su runtime junto a su
ejecutable real. Si esa carpeta no está en el PATH, la app la añade a tu perfil
de inicio y Ajustes → Acceso remoto dice qué archivo tocó. Nada más de tu shell
cambia.

`--wait` vuelve cuando el turno ha terminado, no cuando fue aceptado, y falla de forma explícita si no produjo respuesta. `--json` imprime la respuesta de la propia API, para scripts. Las aprobaciones siguen vigentes — el agente pregunta antes de ejecutar comandos, y `osd permission ls` / `osd permission allow <id>` es cómo se responde sin ventana.

### Qué modelo, y quién aprueba

`osd model` muestra el modelo por defecto, `osd model ls` lista lo que el runtime
**realmente puede servir** (los proveedores con credenciales en esta máquina; el
actual va marcado) y `osd model set <provider/model>` lo cambia — a través del
gateway, así que también sirve contra un servidor remoto. Cualquier turno puede
imponer otro con `osd session send --model … --agent … --effort …`.

Las aprobaciones siguen vigentes: el agente pregunta antes de ejecutar comandos,
borrar archivos, instalar dependencias o salir a la red. Sin ventana, `--wait`
dice **qué** está esperando y ofrece las dos formas de responder — en la terminal
`osd permission ls` / `osd permission allow <id>`, o la URL del gateway que
imprime, que lleva el token para que un navegador en tu portátil o tu móvil lo
apruebe.

Para una máquina sin nadie delante, sal explícitamente:

```bash
osd approval            # qué hay que preguntar hoy
osd approval set full   # no preguntar nunca: comandos, borrados, instalaciones, red
```

`full` es una decisión deliberada, no un valor por defecto: el agente sigue
confinado al workspace, pero nada se detiene a esperarte.
`osd approval set approve` devuelve todas las reglas.

### Como servicio

`osd server` es un proceso en primer plano corriente, así que systemd lo ejecuta
tal cual. Esta unit se probó de principio a fin en Ubuntu — activar, reiniciar,
caer, detener:

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

`sudo systemctl enable --now osd` y la URL con el token acaban en
`journalctl -u osd`. Una unit es además la forma más limpia de operarlo: systemd
detiene todo el cgroup, así que el runtime del agente nunca sobrevive al
servidor, muera como muera.


Sin `--gateway`, `osd` habla con un gateway que ya esté corriendo en la misma máquina — incluido el de la app de escritorio — así que con la app abierta, `osd session ls` funciona sin más. Si no, apúntalo a donde quieras con `osd login --gateway <url> --token <token>`.

Lo que *no* hay sin escritorio: kernels locales de Jupyter, diálogos de archivo nativos y el gestor de archivos del sistema — la UI web los oculta en lugar de ofrecer controles que fallarían. Dos cosas más: **la procedencia y los registros de ejecución los escribe el cliente de escritorio**, así que un servidor sin pantalla conserva el historial de archivos vía snapshots de git, pero no añade a `provenance.jsonl` ni al índice de ejecuciones.

## Compilar desde el código

```bash
git clone https://github.com/ai4s-research/open-science
cd open-science
pnpm install
bash scripts/dev/fetch-opencode.sh
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh

# El cliente de terminal osd también va incluido: es nuestro, así que se compila, no se descarga.
bash scripts/dev/build-osd-sidecar.sh $(rustc -vV | sed -n 's/host: //p')
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
| `crates/osd-core/` | El núcleo del servidor — workspace, sidecar, gateway. Sin Tauri, por eso funciona sin pantalla. |
| `crates/osd-cli/` | `osd`: el servidor sin pantalla y su cliente. |
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
  version = {0.5.1},
  doi     = {10.5281/zenodo.22004919},
  url     = {https://github.com/ai4s-research/open-science},
  license = {MIT}
}
```

El botón **“Cite this repository”** de GitHub (generado desde [`CITATION.cff`](./CITATION.cff)) ofrece la misma referencia en APA y BibTeX.
