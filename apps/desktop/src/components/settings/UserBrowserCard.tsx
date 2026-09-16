import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { Row, Section } from "@/components/settings/Section";
import { detectUserBrowser, isTauri, type UserBrowser } from "@/lib/tauri";

/** Settings → Browser → a browser the user installed themselves.
 *
 *  Nothing here is configurable, on purpose: the agent reaches such a browser
 *  through `bash`, not through a connector this app registers, so there is no
 *  wiring to expose. What there IS to say is that it can be reached at all —
 *  the bundled connector drives an isolated profile this app owns, and this one
 *  carries the user's real logged-in sessions. That difference is the user's to
 *  know about, and the approval prompt is where they act on it.
 *
 *  Renders nothing when no such browser is installed, which is the common case. */
export function UserBrowserCard() {
  const { t } = useTranslation(["settings"]);
  const [browser, setBrowser] = useState<UserBrowser | null>(null);

  useEffect(() => {
    void detectUserBrowser().then(setBrowser);
  }, []);

  if (!isTauri || !browser) return null;

  return (
    <Section title={t("userBrowser.title")} hint={t("userBrowser.hint")} flush>
      <Row
        title={
          <span className="inline-flex items-center gap-2">
            <Compass size={13} className="shrink-0 text-muted" />
            {t("userBrowser.name")}
          </span>
        }
        hint={
          browser.command
            ? t("userBrowser.reachable")
            : t("userBrowser.notReachable")
        }
      >
        <p className="mt-2.5 text-xs leading-relaxed text-muted">
          {t("userBrowser.tradeoff")}
        </p>
        <code className="mt-2 block overflow-x-auto whitespace-pre rounded-input bg-surface-2 px-3 py-2 font-mono text-[12px] text-muted">
          {browser.command ?? browser.appPath}
        </code>
      </Row>
    </Section>
  );
}
