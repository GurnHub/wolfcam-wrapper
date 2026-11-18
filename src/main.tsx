import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary, recordError } from "./components/ErrorBoundary";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary whole>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// The app shell fills the window and never scrolls; only panes inside it do. If the webview scrolls the
// page anyway (for example to reveal a focused element), the whole UI slides out of view and the window
// looks blank, so put it straight back.
const root = document.getElementById("root");
document.addEventListener(
  "scroll",
  (e) => {
    const t = e.target;
    if (t === document || t === document.documentElement || t === document.body || t === root) {
      for (const el of [document.scrollingElement, document.documentElement, document.body, root]) {
        if (el && (el.scrollTop || el.scrollLeft)) el.scrollTo(0, 0);
      }
    }
  },
  true,
);

// Errors outside rendering (event handlers, promises) do not blank the window, but are worth keeping.
window.addEventListener("error", (e) => recordError(e.error ?? e.message, "window error"));
window.addEventListener("unhandledrejection", (e) => recordError(e.reason, "unhandled promise rejection"));
