import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, MonitorCog, ScanEye } from "lucide-react";
import { Row, Section } from "@/components/settings/Section";
import { chipCls } from "@/components/settings/inputCls";
import { toast } from "@/lib/toast";
import {
  getComputerUseStatus,
  isTauri,
  openComputerUsePermissions,
  type ComputerUseStatus,
} from "@/lib/tauri";

/** The two macOS permissions the helper can hold, as the backend names them. */
const PERMISSIONS = { accessibility: "accessibility", screenshots: "screenshots" } as const;

/** Settings → Computer Use.
 *
 *  This card cannot grant anything: macOS gives Accessibility and Screen
 *  Recording to a bundle identifier, on the user's own say-so, in System
 *  Settings. What it can do is say where things stand and open the helper's own
 *  setup window — and make it visible that the identity holding those two
 *  permissions is a small separate helper, not the whole workbench.
 *
 *  Linux and Windows have no such per-app grant, so there both rows report
 *  "unsupported" and the card is a plain availability readout. */
export function ComputerUseCard() {
  const { t } = useTranslation(["settings"]);
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(() => {
    setChecking(true);
    void getComputerUseStatus()
      .then(setStatus)
      .catch((e) => toast.error(`${t("computer.error")}: ${String(e)}`))
      .finally(() => setChecking(false));
  }, [t]);

  useEffect(refresh, [refresh]);

  // Granting happens in System Settings, in another app; coming back here is the
  // moment the answer has changed. Only while something is still missing —
  // re-checking launches the helper, which is not free.
  useEffect(() => {
    if (status?.accessibility === "granted" && status.screenshots !== "not-granted") return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, status]);

  if (!isTauri) return null;

  const open = (permission?: "accessibility" | "screenshots") => {
    void openComputerUsePermissions(permission)
      .then(() => {
        // The grant happens in another app, so nothing tells us when it lands;
        // re-reading on the next render of this card is the honest refresh.
        toast.success(t("computer.opened"));
      })
      .catch((e) => toast.error(`${t("computer.error")}: ${String(e)}`));
  };

  // Until the first answer arrives there is nothing true to say. Checking means
  // launching the helper app, which takes seconds — long enough that showing
  // "Grant…" meanwhile reads as "you have not granted this", which is a lie the
  // user acts on.
  const checked = status !== null;
  const grantable = !checked || status.accessibility !== "unsupported";

  /** Accessibility is what makes computer use work at all; Screen Recording only
   *  adds the ability to look at a window that cannot be read as text. */
  const permissions = [
    { id: PERMISSIONS.accessibility, icon: MonitorCog, state: status?.accessibility },
    { id: PERMISSIONS.screenshots, icon: ScanEye, state: status?.screenshots },
  ] as const;

  return (
    <Section
      title={t("computer.title")}
      hint={t("computer.hint")}
      flush
      action={
        <button type="button" className={chipCls("shrink-0")} disabled={checking} onClick={refresh}>
          {t("computer.recheck")}
        </button>
      }
    >
      <Row
        title={t("computer.state")}
        hint={
          !checked
            ? t("computer.checking")
            : status.available
              ? t("computer.ready")
              : (status.reason ?? t("computer.unavailable"))
        }
        control={
          checked && grantable ? (
            <button type="button" className={chipCls("shrink-0")} onClick={() => open()}>
              {t("computer.setup")}
            </button>
          ) : undefined
        }
      />
      {checked &&
        grantable &&
        permissions.map(({ id, icon: Icon, state }) => (
          <Row
            key={id}
            title={
              <span className="inline-flex items-center gap-2">
                <Icon size={13} className="shrink-0 text-muted" />
                {t(`computer.${id}`)}
              </span>
            }
            hint={t(`computer.${id}Hint`)}
            control={
              state === "granted" ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
                  <Check size={13} />
                  {t("computer.granted")}
                </span>
              ) : (
                <button type="button" className={chipCls("shrink-0")} onClick={() => open(id)}>
                  {t("computer.grant")}
                </button>
              )
            }
          />
        ))}
    </Section>
  );
}
