import { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { FileQuestion, Paperclip, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { previewKindForName } from "@/lib/artifacts";
import { absoluteArtifactPath, previewUrl, readArtifact } from "@/lib/artifactFile";

/** Lines of a text file the hover card shows before it runs out of room. */
const PEEK_LINES = 8;

/** `412 KB`, `1.2 MB` — the workbench's files run from a pasted screenshot to a
 *  dataset, so this keeps a whole unit either side rather than rounding to MB
 *  like the memory readout does (`lib/systemStatus`). */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Peek =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "image"; url: string }
  | { state: "text"; body: string; lines: number; size: number }
  | { state: "opaque"; path: string | null }
  | { state: "unreadable"; reason?: string };

/**
 * An attached file, and what it actually is.
 *
 * The chip alone is a filename — `pasted.png` says nothing about whether the
 * screenshot in the clipboard is the one that got written, which is the only
 * question a person has right after pasting one. Hovering answers it with the
 * thing itself: the image, or the first lines of the text.
 *
 * The card is also the honest failure report. Every preview in this app
 * resolves against the ACTIVE workspace (`preview_url` takes no directory), so
 * a file the composer wrote somewhere else cannot be read back — and the card
 * says so, with the runtime's own reason, instead of showing an empty frame.
 *
 * Read on open, not on mount: a draft with six attachments would otherwise
 * decode six files to render six chips nobody has looked at yet. The result is
 * kept per chip — never in a module-level cache keyed by name, because
 * `pasted.png` names a different file in every workspace.
 */
export function AttachmentChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  const { t } = useTranslation(["session", "common"]);
  const [peek, setPeek] = useState<Peek>({ state: "idle" });
  // Read off the loaded <img>, not from the file: the pixel size is the fact a
  // person wants about a screenshot, and the browser already knows it.
  const [dims, setDims] = useState<string | null>(null);

  const load = async () => {
    if (peek.state !== "idle") return;
    setPeek({ state: "loading" });
    try {
      if (previewKindForName(name) === "image") {
        const url = await previewUrl(name);
        if (!url) {
          setPeek({ state: "unreadable" });
          return;
        }
        // Warm the bytes without waiting on them. The <img> in the card only
        // mounts when the card opens, so fetching now means it usually paints
        // at once — and NOT awaiting this is deliberate: an image that never
        // loads would otherwise leave the card on its skeleton forever.
        new Image().src = url;
        setPeek({ state: "image", url });
        return;
      }
      // Anything the file inspector would show as text gets its opening lines;
      // a PDF or a video would have to be decoded whole to show nothing useful,
      // so those stay a name and a kind.
      if (!TEXTUAL.has(previewKindForName(name))) {
        // Nothing to draw, so answer the other question a chip raises: WHERE
        // the file went. Decoding a PDF to base64 for a 248px card would not.
        setPeek({ state: "opaque", path: await absoluteArtifactPath(name) });
        return;
      }
      const file = await readArtifact(name);
      if (!file || file.encoding !== "utf8") {
        setPeek({ state: "opaque", path: await absoluteArtifactPath(name) });
        return;
      }
      const all = file.data.split("\n");
      setPeek({
        state: "text",
        body: all.slice(0, PEEK_LINES).join("\n"),
        lines: all.length,
        size: file.size,
      });
    } catch (err) {
      setPeek({ state: "unreadable", reason: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <span className="flex items-center gap-1.5 rounded-input bg-surface-2 py-1 pl-2 pr-1 font-mono text-xs text-text ring-1 ring-border transition-colors hover:ring-accent/40">
      {/* The read starts on the pointer ARRIVING, not on the card opening, so
          the round trip runs during the hover delay instead of after it — the
          first hover used to wait out the delay and then the invoke, and the
          first image also paid for starting the preview server. */}
      <Tooltip.Provider delayDuration={140}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span
              tabIndex={0}
              aria-label={t("composer.file.previewAria", { name })}
              onPointerEnter={() => void load()}
              onFocus={() => void load()}
              className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <Paperclip size={11} className="shrink-0 text-muted" />
              <span className="max-w-[220px] truncate">{name}</span>
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              // eslint-disable-next-line i18next/no-literal-string -- Radix placement, not UI copy
              side="top"
              // eslint-disable-next-line i18next/no-literal-string -- Radix placement, not UI copy
              align="start"
              sideOffset={6}
              collisionPadding={8}
              className="z-50 w-[248px] overflow-hidden rounded-card border border-border bg-surface shadow-pop"
            >
              <PeekBody peek={peek} name={name} onDims={setDims} />
              <div className="flex items-center gap-2 border-t border-faint px-2.5 py-1.5 text-[11px]">
                <span className="min-w-0 truncate font-mono text-text" title={name}>
                  {name}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-muted">
                  <PeekMeta peek={peek} name={name} dims={dims} />
                </span>
              </div>
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      <button
        className="rounded p-0.5 text-muted hover:bg-border hover:text-text"
        aria-label={t("composer.file.removeAria", { name })}
        onClick={onRemove}
      >
        <X size={11} />
      </button>
    </span>
  );
}

/** Preview kinds whose opening lines are worth reading in a 248px card. */
const TEXTUAL = new Set(["text", "markdown", "table"]);

function PeekBody({
  peek,
  name,
  onDims,
}: {
  peek: Peek;
  name: string;
  onDims: (dims: string) => void;
}) {
  const { t } = useTranslation(["session", "common"]);

  if (peek.state === "image") {
    return (
      <img
        src={peek.url}
        alt={name}
        onLoad={(e) => onDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        // `max-h-40` with `object-contain`: a tall screenshot shrinks to fit
        // rather than cropping to a strip of its top edge.
        className="block max-h-40 w-full bg-surface-2 object-contain"
      />
    );
  }
  if (peek.state === "text") {
    return peek.body.trim() === "" ? (
      <p className="px-2.5 py-3 text-[11px] text-muted">{t("composer.file.preview.empty")}</p>
    ) : (
      // `whitespace-pre`, not wrapped: a config line broken mid-token reads
      // worse than one that runs off the edge, so the overflow fades out to
      // say "there is more to the right" instead of being cut mid-glyph.
      <pre className="max-h-40 overflow-hidden whitespace-pre bg-surface-2 px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-muted [mask-image:linear-gradient(to_right,#000_86%,transparent)]">
        {peek.body}
      </pre>
    );
  }
  if (peek.state === "unreadable") {
    return (
      <div className="flex items-start gap-1.5 px-2.5 py-3">
        <FileQuestion size={13} strokeWidth={1.5} className="mt-px shrink-0 text-warn" />
        <div className="min-w-0">
          <p className="text-[11px] text-text">{t("composer.file.preview.unreadable")}</p>
          {peek.reason && (
            <p className="mt-0.5 break-words font-mono text-[10px] leading-snug text-muted">
              {peek.reason}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (peek.state === "opaque") {
    return (
      <div className="px-2.5 py-2.5">
        <p className="text-[11px] text-muted">{t("composer.file.preview.none")}</p>
        {peek.path && (
          <p className="mt-1 break-all font-mono text-[10px] leading-snug text-muted/80">
            {peek.path}
          </p>
        )}
      </div>
    );
  }
  // Idle and loading draw the same bar, so opening the card never jumps: the
  // frame is already the height the picture will land in.
  return <div className={cn("h-28 bg-surface-2", peek.state === "loading" && "animate-pulse")} />;
}

function PeekMeta({ peek, name, dims }: { peek: Peek; name: string; dims: string | null }) {
  const { t } = useTranslation(["session", "common"]);
  if (peek.state === "text") {
    return (
      <>
        {t("composer.file.preview.lines", { count: peek.lines })} · {fmtBytes(peek.size)}
      </>
    );
  }
  // The picture's own size once it has decoded; until then the extension, so
  // the line is never empty and never changes width twice.
  if (peek.state === "image") return <>{dims ?? extOf(name)}</>;
  if (peek.state === "opaque") return <>{extOf(name)}</>;
  return null;
}

/** `PNG`, `PDF` — the chip already shows the name, so this is just the kind. */
function extOf(name: string): string {
  return (name.split(".").pop() ?? "").toUpperCase();
}
