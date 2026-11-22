import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "../lib/backend";

interface Props {
  /** Changing this clears a caught error, e.g. when the user switches view. */
  resetKey?: unknown;
  /** Wraps the whole app rather than one view. */
  whole?: boolean;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** "Name: message" plus the stack, without repeating the message when the stack already starts with it. */
function describe(error: Error): string {
  const head = `${error.name}: ${error.message}`;
  const stack = error.stack ?? "";
  return stack.startsWith(head) ? stack : `${head}\n${stack}`;
}

/** Saves the error as last-error.json in Wolfcam Wrapper's data folder, for bug reports. */
export function recordError(error: unknown, where: string) {
  const e = error instanceof Error ? error : new Error(String(error));
  const value = { time: new Date().toISOString(), name: e.name, message: e.message, stack: e.stack ?? "", where, userAgent: navigator.userAgent };
  invoke("store_save", { name: "last-error", value }).catch(() => undefined);
}

/**
 * Keeps a rendering error in one view from blanking the whole window: the
 * view is replaced by the error and the rest of the app keeps working.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("view crashed", error, info.componentStack);
    recordError(error, info.componentStack ?? "");
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h2>This view ran into a problem</h2>
        <p className="muted">
          {this.props.whole
            ? "Wolfcam Wrapper ran into a problem. Please report this with the text below; it is also saved as last-error.json in Wolfcam Wrapper's data folder."
            : "The rest of Wolfcam Wrapper still works. Please report this with the text below; it is also saved as last-error.json in Wolfcam Wrapper's data folder."}
        </p>
        <pre>{describe(error)}</pre>
        <div className="actions">
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
          <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(describe(error))}>Copy error</button>
          {this.props.whole && <button type="button" className="btn" onClick={() => location.reload()}>Reload Wolfcam Wrapper</button>}
        </div>
      </div>
    );
  }
}
