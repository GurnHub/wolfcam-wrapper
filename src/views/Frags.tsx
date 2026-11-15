import { Play, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Empty, Field, Toggle, WeaponTag } from "../components/ui";
import { invoke, type Frag, type FragFilter } from "../lib/backend";
import { clipFromKills } from "../lib/clips";
import { duration, gameClock, stripExt, WEAPONS } from "../lib/format";
import { useStore } from "../lib/store";

type Scope = "all" | "selected";

export function FragsView() {
  const demos = useStore((s) => s.demos);
  const selected = useStore((s) => s.selected);
  const settings = useStore((s) => s.settings);
  const { play, addClip, toast } = useStore.getState();

  const [scope, setScope] = useState<Scope>(selected.length ? "selected" : "all");
  const [players, setPlayers] = useState("");
  const [victim, setVictim] = useState("");
  const [weapons, setWeapons] = useState<string[]>([]);
  const [minKills, setMinKills] = useState(2);
  const [windowSec, setWindowSec] = useState(4);
  const [povOnly, setPovOnly] = useState(false);
  const [warmup, setWarmup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Frag[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const paths = useMemo(
    () => (scope === "selected" && selected.length ? selected : demos.filter((d) => !d.error).map((d) => d.path)),
    [scope, selected, demos],
  );

  const search = async () => {
    setBusy(true);
    setPicked(new Set());
    const filter: FragFilter = {
      players: players.split(",").map((p) => p.trim()).filter(Boolean),
      povOnly, weapons, victim: victim.trim(), minKills, windowMs: Math.round(windowSec * 1000), includeWarmup: warmup, includeOwnGoals: false,
    };
    try {
      setResults(await invoke<Frag[]>("search_frags", { paths, filter }));
    } catch (e) {
      toast("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = (frags: Frag[]) => {
    for (const f of frags) addClip(clipFromKills(f.path, f.map, f.kills, settings));
    toast("ok", `${frags.length} clip${frags.length === 1 ? "" : "s"} added`);
    setPicked(new Set());
  };
  const toggle = (i: number) => {
    const next = new Set(picked);
    if (!next.delete(i)) next.add(i);
    setPicked(next);
  };

  return (
    <div className="frags">
      <section className="filters">
        <h2>Frag finder</h2>
        <p className="muted small">Searches the kills of indexed demos for single frags and multi-kills.</p>
        <Field label="Search in">
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="all">Whole library ({demos.length} demos)</option>
            <option value="selected" disabled={!selected.length}>Library selection ({selected.length})</option>
          </select>
        </Field>
        <Field label="Killer" hint="Part of a name; separate several with commas. Empty matches anyone.">
          <input value={players} onChange={(e) => setPlayers(e.target.value)} placeholder="anyone" spellCheck={false} />
        </Field>
        <Toggle checked={povOnly} onChange={setPovOnly} label="Only the player who recorded the demo" />
        <Field label="Victim">
          <input value={victim} onChange={(e) => setVictim(e.target.value)} placeholder="anyone" spellCheck={false} />
        </Field>
        <div className="field">
          <span className="field-label">Weapons {weapons.length > 0 && <button type="button" className="link" onClick={() => setWeapons([])}>any</button>}</span>
          <div className="chips">
            {WEAPONS.map((w) => (
              <button
                type="button"
                key={w}
                className={"chip" + (weapons.includes(w) ? " is-active" : "")}
                onClick={() => setWeapons(weapons.includes(w) ? weapons.filter((x) => x !== w) : [...weapons, w])}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
        <div className="field-pair">
          <Field label="Kills in a row">
            <select value={minKills} onChange={(e) => setMinKills(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 1 ? "1 (every kill)" : `${n} or more`}</option>)}
            </select>
          </Field>
          <Field label="Max gap between kills">
            <select value={windowSec} onChange={(e) => setWindowSec(Number(e.target.value))} disabled={minKills === 1}>
              {[1, 2, 3, 4, 6, 8, 10, 15].map((n) => <option key={n} value={n}>{n} s</option>)}
            </select>
          </Field>
        </div>
        <Toggle checked={warmup} onChange={setWarmup} label="Include warmup" />
        <Button variant="primary" onClick={() => void search()} disabled={busy || !paths.length}>
          <Search size={14} /> {busy ? "Searching…" : `Search ${paths.length} demo${paths.length === 1 ? "" : "s"}`}
        </Button>
      </section>

      <section className="pane">
        {results == null ? (
          <Empty title="Set the filters and search">Results list the killer, weapons and time of each sequence. Play one to check it, or add it to the clip list for rendering.</Empty>
        ) : results.length === 0 ? (
          <Empty title="No frags match">Try fewer kills in a row, a longer gap, or more weapons.</Empty>
        ) : (
          <>
            <header className="toolbar">
              <span>{results.length}{results.length === 5000 ? "+" : ""} result{results.length === 1 ? "" : "s"}</span>
              <span className="spacer" />
              <Button onClick={() => setPicked(picked.size === results.length ? new Set() : new Set(results.map((_, i) => i)))}>
                {picked.size === results.length ? "Select none" : "Select all"}
              </Button>
              <Button variant="primary" disabled={!picked.size} onClick={() => add(results.filter((_, i) => picked.has(i)))}>
                <Plus size={14} /> Add {picked.size || ""} to clips
              </Button>
            </header>
            <div className="frag-list">
              {results.slice(0, 600).map((f, i) => (
                <div key={i} className={"frag" + (picked.has(i) ? " is-selected" : "")} onClick={() => toggle(i)}>
                  <input type="checkbox" checked={picked.has(i)} readOnly aria-label="Select" />
                  <span className="frag-count">{f.kills.length}×</span>
                  <div className="frag-main">
                    <strong>{f.killer}</strong>
                    <span className="frag-weapons">{f.kills.map((k, j) => <WeaponTag key={j} weapon={k.weapon} />)}</span>
                    <small className="muted">{f.kills.map((k) => k.victimName).join(", ")}</small>
                  </div>
                  <div className="frag-where">
                    <span title={f.path}>{stripExt(f.fileName)}</span>
                    <small className="muted">{f.gametypeName} · {f.map} · {gameClock(f.clockMs, f.warmup)}{f.kills.length > 1 ? ` · ${duration(f.endTime - f.startTime)}` : ""}</small>
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Play this in WolfcamQL"
                    onClick={(e) => {
                      e.stopPropagation();
                      void play(f.path, { startTime: f.startTime - settings.clipLeadIn * 1000, pov: f.killerClient < 64 ? f.killerClient : null });
                    }}
                  >
                    <Play size={14} />
                  </button>
                  <button type="button" className="icon-btn" title="Add to clips" onClick={(e) => { e.stopPropagation(); add([f]); }}>
                    <Plus size={14} />
                  </button>
                </div>
              ))}
              {results.length > 600 && <p className="muted small pad">Showing the first 600 results. Narrow the filters to see the rest.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
