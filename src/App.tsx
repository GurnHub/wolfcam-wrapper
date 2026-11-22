import { Clapperboard, FolderOpen, Keyboard, Settings as SettingsIcon, SlidersHorizontal, Sparkles, Square, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { baseName } from "./lib/format";
import { useStore, type View } from "./lib/store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ClipsView } from "./views/Clips";
import { ConfigView } from "./views/Config";
import { HighlightsView } from "./views/Highlights";
import { KeysView } from "./views/Keys";
import { LibraryView } from "./views/Library";
import { SettingsView } from "./views/Settings";

const NAV: { id: View; label: string; icon: typeof FolderOpen }[] = [
  { id: "library", label: "Library", icon: FolderOpen },
  { id: "highlights", label: "Highlights", icon: Sparkles },
  { id: "clips", label: "Clips & render", icon: Clapperboard },
  { id: "config", label: "Config", icon: SlidersHorizontal },
  { id: "keys", label: "Keys", icon: Keyboard },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export default function App() {
  // Select only what the shell shows, so frequent updates (engine log) do not re-render every view.
  const ready = useStore((x) => x.ready);
  const view = useStore((x) => x.view);
  const clips = useStore((x) => x.clips);
  const rendering = useStore((x) => x.rendering);
  const wolfcam = useStore((x) => x.wolfcam);
  const toasts = useStore((x) => x.toasts);
  const install = useStore((x) => x.install);
  const mock = useStore((x) => x.mock);
  const { setView, stop, dismissToast } = useStore.getState();
  const s = { ready, view, clips, rendering, wolfcam, toasts, install, mock, setView, stop, dismissToast };
  useEffect(() => {
    void useStore.getState().init();
  }, []);

  if (!s.ready) return <div className="boot">Loading…</div>;

  const problems = s.install?.problems.length ?? 0;
  const activeRenders = s.clips.filter((c) => c.render && (c.render.status === "capturing" || c.render.status === "encoding")).length;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">W</span>
          <div>
            <strong>Wolfcam Wrapper</strong>
            <small>demos &amp; highlights</small>
          </div>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <button type="button" className={s.view === n.id ? "is-active" : ""} onClick={() => s.setView(n.id)}>
                <n.icon size={16} />
                <span>{n.label}</span>
                {n.id === "clips" && s.clips.length > 0 && <em>{s.clips.length}</em>}
                {n.id === "settings" && problems > 0 && <TriangleAlert size={14} className="warn" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          {s.rendering ? (
            <div className="status status-busy">
              <span className="dot" />
              <div>
                <strong>Rendering</strong>
                <small>{activeRenders ? "clip in progress" : "starting"}</small>
              </div>
            </div>
          ) : s.wolfcam.running ? (
            <div className="status status-on">
              <span className="dot" />
              <div>
                <strong>WolfcamQL open</strong>
                <small title={s.wolfcam.demo ?? ""}>{s.wolfcam.demo ? baseName(s.wolfcam.demo) : ""}</small>
              </div>
              <button type="button" className="icon-btn" title="Close WolfcamQL" onClick={() => void s.stop()}>
                <Square size={13} />
              </button>
            </div>
          ) : (
            <div className="status">
              <span className="dot" />
              <div>
                <strong>WolfcamQL idle</strong>
                <small>{s.mock ? "sample data (no backend)" : "double-click a demo to open it"}</small>
              </div>
            </div>
          )}
        </div>
      </nav>
      <main className="main">
        <ErrorBoundary resetKey={s.view}>
        {s.view === "library" && <LibraryView />}
        {s.view === "highlights" && <HighlightsView />}
        {s.view === "clips" && <ClipsView />}
        {s.view === "config" && <ConfigView />}
        {s.view === "keys" && <KeysView />}
        {s.view === "settings" && <SettingsView />}
        </ErrorBoundary>
      </main>
      <div className="toasts">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => s.dismissToast(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
