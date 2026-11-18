import { Play, Plus, RotateCcw, Search } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Field, Toggle, WeaponTag } from "../components/ui";
import { invoke, type Frag, type FragFilter } from "../lib/backend";
import { clipFromKills } from "../lib/clips";
import { duration, gameClock, stripExt, WEAPONS } from "../lib/format";
import { defaultFragForm, useStore, type FragForm } from "../lib/store";

// The form, results, selection and list position live in the store, so playing a result (which
// switches to the Player) or visiting another view and coming back keeps everything as it was.
export function FragsView() {
  const demos = useStore((s) => s.demos);
  const selected = useStore((s) => s.selected);
  const settings = useStore((s) => s.settings);
  const { form, results, picked: pickedList } = useStore((s) => s.frags);
  const { play, addClip, toast, setFrags } = useStore.getState();
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const picked = useMemo(() => new Set(pickedList), [pickedList]);
  const setForm = (patch: Partial<FragForm>) => setFrags({ form: patch });
  const setPicked = (next: Set<number>) => setFrags({ picked: [...next] });
  const { scope, players, victim, weapons, minKills, windowSec, povOnly, warmup } = form;

  const paths = useMemo(
    () => (scope === "selected" && selected.length ? selected : demos.filter((d) => !d.error).map((d) => d.path)),
    [scope, selected, demos],
  );

  // Put the result list back where it was scrolled to.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = useStore.getState().frags.scrollTop;
  }, [results]);

  const search = async () => {
    setBusy(true);
    const filter: FragFilter = {
      players: players.split(",").map((p) => p.trim()).filter(Boolean),
      povOnly, weapons, victim: victim.trim(), minKills, windowMs: Math.round(windowSec * 1000), includeWarmup: warmup, includeOwnGoals: false,
    };
    try {
      const found = await invoke<Frag[]>("search_frags", { paths, filter });
      setFrags({ results: found, picked: [], scrollTop: 0 });
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
          <select value={scope === "selected" && !selected.length ? "all" : scope} onChange={(e) => setForm({ scope: e.target.value as FragForm["scope"] })}>
            <option value="all">Whole library ({demos.length} demos)</option>
            <option value="selected" disabled={!selected.length}>Library selection ({selected.length})</option>
          </select>
        </Field>
        <Field label="Killer" hint="Part of a name; separate several with commas. Empty matches anyone.">
          <input value={players} onChange={(e) => setForm({ players: e.target.value })} placeholder="anyone" spellCheck={false} />
        </Field>
        <Toggle checked={povOnly} onChange={(v) => setForm({ povOnly: v })} label="Only the player who recorded the demo" />
        <Field label="Victim">
          <input value={victim} onChange={(e) => setForm({ victim: e.target.value })} placeholder="anyone" spellCheck={false} />
        </Field>
        <div className="field">
          <span className="field-label">Weapons {weapons.length > 0 && <button type="button" className="link" onClick={() => setForm({ weapons: [] })}>any</button>}</span>
          <div className="chips">
            {WEAPONS.map((w) => (
              <button
                type="button"
                key={w}
                className={"chip" + (weapons.includes(w) ? " is-active" : "")}
                onClick={() => setForm({ weapons: weapons.includes(w) ? weapons.filter((x) => x !== w) : [...weapons, w] })}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
        <div className="field-pair">
          <Field label="Kills in a row">
            <select value={minKills} onChange={(e) => setForm({ minKills: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 1 ? "1 (every kill)" : `${n} or more`}</option>)}
            </select>
          </Field>
          <Field label="Max gap between kills">
            <select value={windowSec} onChange={(e) => setForm({ windowSec: Number(e.target.value) })} disabled={minKills === 1}>
              {[1, 2, 3, 4, 6, 8, 10, 15].map((n) => <option key={n} value={n}>{n} s</option>)}
            </select>
          </Field>
        </div>
        <Toggle checked={warmup} onChange={(v) => setForm({ warmup: v })} label="Include warmup" />
        <div className="row">
          <Button variant="primary" onClick={() => void search()} disabled={busy || !paths.length}>
            <Search size={14} /> {busy ? "Searching…" : `Search ${paths.length} demo${paths.length === 1 ? "" : "s"}`}
          </Button>
          <Button title="Reset the filters to their defaults and clear the results" onClick={() => setFrags({ form: defaultFragForm, results: null, picked: [], scrollTop: 0 })}>
            <RotateCcw size={14} /> Reset
          </Button>
        </div>
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
            {/* Written in place rather than with setFrags, so scrolling does not re-render the view. */}
            <div className="frag-list" ref={listRef} onScroll={(e) => { useStore.getState().frags.scrollTop = e.currentTarget.scrollTop; }}>
              {results.slice(0, 600).map((f, i) => (
                <div key={i} className={"frag" + (picked.has(i) ? " is-selected" : "")} onClick={() => toggle(i)}>
                  <input type="checkbox" checked={picked.has(i)} readOnly tabIndex={-1} aria-label="Select" />
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
