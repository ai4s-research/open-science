import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GLViewer } from "3dmol";
import { Atom, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  defaultStyleMode,
  isSmilesFile,
  looksLikeMacromolecule,
  moleculeFormatFor,
  smilesToMolblock,
  type MoleculeStyleMode,
} from "@/lib/molecule";
import { cn } from "@/lib/cn";

/**
 * Whether this WebView can actually give 3Dmol a WebGL context. It cannot on
 * every Linux box: WebKitGTK hands back a null context when its renderer and
 * the GPU driver disagree, and 3Dmol then dereferences that null deep inside
 * its constructor — the user is shown `this._gl.clearDepth` and told nothing.
 * Probe for it so the failure can be explained instead.
 */
function hasWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false; // some builds throw here rather than return null
  }
}

const STYLE_OPTIONS: Array<{ value: MoleculeStyleMode }> = [
  { value: "stick" },
  { value: "sphere" },
  { value: "cartoon" },
];

/**
 * Interactive 3D structure viewer (P1-3) for chemical files
 * (cif/pdb/mol/mol2/sdf/xyz/pqr/cube and SMILES). 3Dmol.js renders a rotatable,
 * zoomable model entirely locally via WebGL — no service. SMILES has no
 * coordinates, so it is converted to a molblock first. The scene sits on a
 * white stage (chemistry convention), consistent in light and dark themes.
 */
export function MoleculeView({ filename, text }: { filename: string; text: string }) {
  const { t } = useTranslation(["inspector", "common"]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const format = useMemo(() => moleculeFormatFor(filename), [filename]);
  const isMacromolecule = useMemo(() => looksLikeMacromolecule(text), [text]);
  // Cartoon depicts a residue backbone — meaningless for small molecules, and
  // 3Dmol crashes reading a missing atom.resn. Offer it only for macromolecules.
  const styleOptions = useMemo(
    () => STYLE_OPTIONS.filter((o) => o.value !== "cartoon" || isMacromolecule),
    [isMacromolecule],
  );

  const [styleMode, setStyleMode] = useState<MoleculeStyleMode>(() =>
    defaultStyleMode(filename, text),
  );
  const [isDragging, setIsDragging] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [atomCount, setAtomCount] = useState<number | null>(null);

  useEffect(() => {
    setStyleMode(defaultStyleMode(filename, text));
  }, [filename, text]);

  const resetView = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.zoomTo();
    v.render();
  }, []);

  // Build (or rebuild) the scene whenever the file or style changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !format) return;

    let cancelled = false;
    setRendering(true);
    setError(null);
    setAtomCount(null);
    container.replaceChildren();

    (async () => {
      try {
        // SMILES carries no coordinates — lay it out into a molblock first.
        const model = isSmilesFile(filename) ? await smilesToMolblock(text) : text;
        if (cancelled) return;
        if (!model) {
          setError(t("molecule.noStructuresFound"));
          return;
        }
        // Checked after the file itself: what's wrong with this file is the more
        // useful answer, and it is one we can give without a GPU at all.
        if (!hasWebgl()) {
          setError(t("molecule.webglUnavailable"));
          return;
        }

        const $3Dmol = await import("3dmol");
        if (cancelled || !containerRef.current) return;

        const viewer = $3Dmol.createViewer(containerRef.current, { backgroundColor: "white" });
        viewerRef.current = viewer;
        viewer.setBackgroundColor(0xffffff, 0); // transparent → our white stage shows
        viewer.addModel(model, format);
        applyStyle(viewer, styleMode, isMacromolecule);
        viewer.zoomTo();
        viewer.render();
        setAtomCount(viewer.selectedAtoms({}).length);
        requestAnimationFrame(() => {
          if (!cancelled) {
            viewer.resize();
            viewer.render();
          }
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      dragRef.current = null;
      viewerRef.current?.clear();
      viewerRef.current = null;
      container.replaceChildren();
    };
  }, [filename, text, format, styleMode, isMacromolecule, t]);

  // Keep the scene sized to its container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const v = viewerRef.current;
      if (!v) return;
      v.resize();
      v.render();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('[data-molecule-controls="true"]')) return;
    if (e.button !== 0 || !viewerRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    setIsDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const v = viewerRef.current;
    if (!drag || !v || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    if (Math.abs(dx) > 0.1) v.rotate(dx * 0.45, "y");
    if (Math.abs(dy) > 0.1) v.rotate(dy * 0.45, "x");
    v.render();
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const v = viewerRef.current;
    if (!v) return;
    v.zoom(e.deltaY > 0 ? 0.9 : 1.1);
    v.render();
  }, []);

  if (!format) return <div className="p-4 text-sm text-muted">{t("molecule.notChemicalFile")}</div>;

  return (
    <div
      className={cn(
        "relative h-full min-h-[420px] w-full touch-none select-none overflow-hidden bg-white",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
      data-molecule-viewer="true"
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onPointerUpCapture={endDrag}
      onPointerCancelCapture={endDrag}
      onWheel={onWheel}
    >
      <div ref={containerRef} className="absolute inset-0" aria-label={t("molecule.moleculeViewerAria", { filename })} />

      <div
        className="absolute left-3 top-3 flex items-center gap-2 rounded-input border border-border/70 bg-surface/90 p-1 shadow-card backdrop-blur"
        data-molecule-controls="true"
      >
        <div className="flex items-center gap-1 px-1.5 text-xs font-medium text-muted">
          <Atom size={13} /> {t("molecule.badge3D")}
        </div>
        <div className="flex rounded bg-surface-2 p-0.5">
          {styleOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setStyleMode(o.value)}
              className={cn(
                "rounded px-2 py-1 text-xs font-medium transition-colors",
                styleMode === o.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
              )}
            >
              {t(`molecule.style.${o.value}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={resetView}
          aria-label={t("molecule.resetView")}
          title={t("molecule.resetView")}
          className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text"
        >
          <RotateCcw size={13} />
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 rounded-input border border-border/70 bg-surface/90 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
        <span className="font-medium text-text">{format.toUpperCase()}</span>
        {atomCount !== null && <span className="ml-2">{t("molecule.atomCount", { count: atomCount })}</span>}
      </div>

      {(rendering || error) && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[70%] rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
          {rendering ? t("molecule.renderingStructure") : error}
        </div>
      )}
    </div>
  );
}

/** Apply a render style, mirroring 3Dmol's Jmol color scheme conventions. */
function applyStyle(viewer: GLViewer, mode: MoleculeStyleMode, isMacromolecule: boolean) {
  if (mode === "sphere") {
    viewer.setStyle({}, { sphere: { colorscheme: "Jmol", scale: 0.36 } });
    return;
  }
  // Cartoon needs a residue backbone; on a small molecule 3Dmol dereferences a
  // missing atom.resn and throws, so only draw it for macromolecules.
  if (mode === "cartoon" && isMacromolecule) {
    viewer.setStyle({}, { cartoon: { color: "spectrum" } });
    // Ligands/hetero atoms have no secondary structure — show them as sticks.
    viewer.setStyle({ hetflag: true }, { stick: { colorscheme: "Jmol", radius: 0.12 } });
    return;
  }
  viewer.setStyle({}, { stick: { colorscheme: "Jmol", radius: 0.18 }, sphere: { colorscheme: "Jmol", scale: 0.26 } });
}
