import { Clapperboard, Crosshair, FolderOpen, MonitorPlay, Settings as SettingsIcon, SlidersHorizontal, Square, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { baseName } from "./lib/format";
import { useStore, type View } from "./lib/store";
import { ClipsView } from "./views/Clips";
import { ConfigView } from "./views/Config";
import { FragsView } from "./views/Frags";
import { LibraryView } from "./views/Library";
import { PlayerView } from "./views/Player";
import { SettingsView } from "./views/Settings";

const NAV: { id: View; label: string; icon: typeof FolderOpen }[] = [
  { id: "library", label: "Library", icon: FolderOpen },
  { id: "player", label: "Player", icon: MonitorPlay },
  { id: "frags", label: "Frag finder", icon: Crosshair },
  { id: "clips", label: "Clips & render", icon: Clapperboard },
  { id: "config", label: "Config", icon: SlidersHorizontal },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export default function App() {
  const s = useStore();
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
            <strong>WolfDeck</strong>
            <small>for WolfcamQL</small>
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
                <strong>{s.wolfcam.ready ? "WolfcamQL running" : "WolfcamQL starting"}</strong>
                <small title={s.playingDemo ?? ""}>{s.playingDemo ? baseName(s.playingDemo) : ""}</small>
              </div>
              <button type="button" className="icon-btn" title="Quit WolfcamQL" onClick={() => void s.stop()}>
                <Square size={13} />
              </button>
            </div>
          ) : (
            <div className="status">
              <span className="dot" />
              <div>
                <strong>WolfcamQL idle</strong>
                <small>{s.mock ? "sample data (no backend)" : "double-click a demo to play"}</small>
              </div>
            </div>
          )}
        </div>
      </nav>
      <main className="main">
        {s.view === "library" && <LibraryView />}
        {s.view === "player" && <PlayerView />}
        {s.view === "frags" && <FragsView />}
        {s.view === "clips" && <ClipsView />}
        {s.view === "config" && <ConfigView />}
        {s.view === "settings" && <SettingsView />}
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
