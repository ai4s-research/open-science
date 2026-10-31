import "./lib/polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./i18n";
import { LocaleProvider } from "./app/providers/LocaleProvider";
import { ThemeProvider } from "./app/providers/ThemeProvider";
import { ZoomProvider } from "./app/providers/ZoomProvider";
import { router } from "./app/router";
import { logDebug } from "./lib/tauri";
import { consumeUrlToken, installGatewayAuthGuard } from "./lib/webMode";
import "./index.css";

// Web client: adopt a token from the opened link (so a copied URL just works),
// then catch gateway 401s (rotated/revoked token) → re-auth. Both before any
// OpenCodeClient binds fetch or the app reads the stored token.
consumeUrlToken();
installGatewayAuthGuard();

// Errors nothing caught go to debug.log too: a callback that throws can leave
// a view stuck with no other trace (the console is not kept).
const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));
window.addEventListener("error", (e) => void logDebug(`uncaught ${describe(e.error ?? e.message)}`));
window.addEventListener("unhandledrejection", (e) => void logDebug(`unhandled rejection ${describe(e.reason)}`));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider>
      <ThemeProvider>
        <ZoomProvider>
          <RouterProvider router={router} />
        </ZoomProvider>
      </ThemeProvider>
    </LocaleProvider>
  </React.StrictMode>,
);
