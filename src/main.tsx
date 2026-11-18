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

// Errors outside rendering (event handlers, promises) do not blank the window, but are worth keeping.
window.addEventListener("error", (e) => recordError(e.error ?? e.message, "window error"));
window.addEventListener("unhandledrejection", (e) => recordError(e.reason, "unhandled promise rejection"));
