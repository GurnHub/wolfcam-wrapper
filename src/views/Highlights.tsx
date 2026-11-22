import { ArrowDown, Crosshair, Play, Plus, RotateCcw, Search, Swords, Trophy } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Field, Toggle, WeaponTag } from "../components/ui";
import { invoke, type ClutchFilter, type ClutchHit, type Frag, type FragFilter, type GameFilter, type GameStat } from "../lib/backend";
import { clipFromClutch, clipFromKills } from "../lib/clips";
import { dateTime, duration, gameClock, stripExt, WEAPONS } from "../lib/format";
import {
  defaultClutchForm, defaultFragForm, defaultGameForm, useStore,
  type ClutchForm, type FragForm, type GameForm, type GameSortKey, type HighlightTab, type Scope,
} from "../lib/store";

const TABS: { id: HighlightTab; label: string; icon: typeof Crosshair }[] = [
  { id: "frags", label: "Frags & multi-kills", icon: Crosshair },
  { id: "clutches", label: "Last man alive", icon: Swords },
  { id: "games", label: "Top games", icon: Trophy },
];

export function HighlightsView() {
  const tab = useStore((s) => s.highlightTab);
  const { setHighlightTab } = useStore.getState();
  return (
    <div className="highlights">
      <nav className="hl-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "is-active" : ""} onClick={() => setHighlightTab(t.id)}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </nav>
      {tab === "frags" && <FragsTab />}
      {tab === "clutches" && <ClutchesTab />}
      {tab === "games" && <GamesTab />}
    </div>
  );
}

/** Demos a search covers: the library selection or the whole library. */
function useScopePaths(scope: Scope) {
  const demos = useStore((s) => s.demos);
  const selected = useStore((s) => s.selected);
  const paths = useMemo(
    () => (scope === "selected" && selected.length ? selected : demos.filter((d) => !d.error).map((d) => d.path)),
    [scope, selected, demos],
  );
  return { paths, demos, selected };
}

function ScopeField({ scope, onChange }: { scope: Scope; onChange: (s: Scope) => void }) {
  const demos = useStore((s) => s.demos);
  const selected = useStore((s) => s.selected);
  return (
    <Field label="Search in">
      <select value={scope === "selected" && !selected.length ? "all" : scope} onChange={(e) => onChange(e.target.value as Scope)}>
        <option value="all">Whole library ({demos.length} demos)</option>
        <option value="selected" disabled={!selected.length}>Library selection ({selected.length})</option>
      </select>
    </Field>
  );
}

function names(text: string): string[] {
  return text.split(",").map((p) => p.trim()).filter(Boolean);
}

/** Puts a result list back where it was scrolled to when the tab is shown again. */
function useKeptScroll(results: unknown, read: () => number) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);
  return ref;
}

// The form, results, selection and list position live in the store, so opening a result in
// WolfcamQL or visiting another view and coming back keeps everything as it was.
function FragsTab() {
  const settings = useStore((s) => s.settings);
  const { form, results, picked: pickedList } = useStore((s) => s.frags);
  const { play, addClip, toast, setFrags } = useStore.getState();
  const [busy, setBusy] = useState(false);

  const picked = useMemo(() => new Set(pickedList), [pickedList]);
  const setForm = (patch: Partial<FragForm>) => setFrags({ form: patch });
  const setPicked = (next: Set<number>) => setFrags({ picked: [...next] });
  const { scope, players, victim, weapons, minKills, windowSec, povOnly, warmup } = form;
  const { paths } = useScopePaths(scope);
  const listRef = useKeptScroll(results, () => useStore.getState().frags.scrollTop);

  const search = async () => {
    setBusy(true);
    const filter: FragFilter = {
      players: names(players),
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
        <p className="muted small">Searches the kills of indexed demos for single frags and multi-kills.</p>
        <ScopeField scope={scope} onChange={(v) => setForm({ scope: v })} />
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
                    title="Open this in WolfcamQL"
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

function ClutchesTab() {
  const settings = useStore((s) => s.settings);
  const { form, results } = useStore((s) => s.clutches);
  const { play, addClip, toast, setClutches } = useStore.getState();
  const [busy, setBusy] = useState(false);
  const { paths } = useScopePaths(form.scope);
  const setForm = (patch: Partial<ClutchForm>) => setClutches({ form: patch });
  const listRef = useKeptScroll(results, () => useStore.getState().clutches.scrollTop);

  const search = async () => {
    setBusy(true);
    const filter: ClutchFilter = { players: names(form.players), povOnly: form.povOnly, minEnemies: form.minEnemies, wonOnly: form.wonOnly };
    try {
      setClutches({ results: await invoke<ClutchHit[]>("search_clutches", { paths, filter }), scrollTop: 0 });
    } catch (e) {
      toast("error", String(e));
    } finally {
      setBusy(false);
    }
  };
  const lead = settings.clipLeadIn * 1000;
  const add = (c: ClutchHit) => {
    addClip(clipFromClutch(c, settings));
    toast("ok", "Clip added");
  };

  return (
    <div className="frags">
      <section className="filters">
        <p className="muted small">
          Moments in Clan Arena and Freeze Tag rounds when a player was the last one alive on their team. Only Quake Live demos record who is left alive.
        </p>
        <ScopeField scope={form.scope} onChange={(v) => setForm({ scope: v })} />
        <Field label="Player" hint="Part of a name; separate several with commas. Empty matches anyone.">
          <input value={form.players} onChange={(e) => setForm({ players: e.target.value })} placeholder="anyone" spellCheck={false} />
        </Field>
        <Toggle checked={form.povOnly} onChange={(v) => setForm({ povOnly: v })} label="Only the player who recorded the demo" />
        <Field label="Enemies alive">
          <select value={form.minEnemies} onChange={(e) => setForm({ minEnemies: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 1 ? "Any (1v1 or more)" : `1v${n} or harder`}</option>)}
          </select>
        </Field>
        <Toggle checked={form.wonOnly} onChange={(v) => setForm({ wonOnly: v })} label="Only rounds the player's team won" />
        <div className="row">
          <Button variant="primary" onClick={() => void search()} disabled={busy || !paths.length}>
            <Search size={14} /> {busy ? "Searching…" : `Search ${paths.length} demo${paths.length === 1 ? "" : "s"}`}
          </Button>
          <Button title="Reset the filters to their defaults and clear the results" onClick={() => setClutches({ form: defaultClutchForm, results: null, scrollTop: 0 })}>
            <RotateCcw size={14} /> Reset
          </Button>
        </div>
      </section>

      <section className="pane">
        {results == null ? (
          <Empty title="Set the filters and search">Each result is a round where someone was left alone against the rest. Rounds they won come first, hardest odds first.</Empty>
        ) : results.length === 0 ? (
          <Empty title="Nothing matches">Try fewer enemies, or include lost rounds. Demos from other modes have no rounds.</Empty>
        ) : (
          <>
            <header className="toolbar">
              <span>{results.length}{results.length === 5000 ? "+" : ""} result{results.length === 1 ? "" : "s"}, {results.filter((c) => c.won).length} won</span>
            </header>
            <div className="frag-list" ref={listRef} onScroll={(e) => { useStore.getState().clutches.scrollTop = e.currentTarget.scrollTop; }}>
              {results.slice(0, 600).map((c, i) => (
                <div key={i} className="frag clutch">
                  <span className={"clutch-odds" + (c.won ? " is-won" : "")} title={c.won ? "The round was won" : "The round was lost"}>1v{c.enemies}</span>
                  <div className="frag-main">
                    <strong>{c.name}</strong>
                    <small className="muted">
                      <span className={c.won ? "good" : "bad"}>{c.won ? "Won" : "Lost"}</span>
                      {` · ${c.kills} kill${c.kills === 1 ? "" : "s"} after · ${duration(c.roundEnd - c.serverTime)} to the end of the round`}
                    </small>
                  </div>
                  <div className="frag-where">
                    <span title={c.path}>{stripExt(c.fileName)}</span>
                    <small className="muted">{c.gametypeName} · {c.map} · round {c.round} · {gameClock(c.clockMs, false)}</small>
                  </div>
                  <button type="button" className="icon-btn" title="Open this in WolfcamQL, following the player" onClick={() => void play(c.path, { startTime: c.serverTime - lead, pov: c.client })}>
                    <Play size={14} />
                  </button>
                  <button type="button" className="icon-btn" title="Add the rest of the round to clips" onClick={() => add(c)}>
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

const MODES = ["Duel", "CA", "FFA", "TDM", "CTF", "Freeze Tag"];

const kd = (g: GameStat) => g.kills / Math.max(1, g.deaths);

const COLUMNS: { key: GameSortKey; label: string; title: string; value: (g: GameStat) => number | null; show: (g: GameStat) => string }[] = [
  { key: "kills", label: "K", title: "Kills", value: (g) => g.kills, show: (g) => String(g.kills) },
  { key: "deaths", label: "D", title: "Deaths", value: (g) => g.deaths, show: (g) => String(g.deaths) },
  { key: "kd", label: "K/D", title: "Kills per death", value: kd, show: (g) => kd(g).toFixed(2) },
  { key: "damageGiven", label: "Dmg", title: "Damage given (from the final scoreboard)", value: (g) => g.damageGiven, show: (g) => g.damageGiven?.toLocaleString() ?? "–" },
  { key: "accuracy", label: "Acc", title: "Accuracy (from the final scoreboard)", value: (g) => g.accuracy, show: (g) => (g.accuracy == null ? "–" : `${g.accuracy}%`) },
  { key: "score", label: "Score", title: "Score (from the final scoreboard)", value: (g) => g.score, show: (g) => (g.score == null ? "–" : String(g.score)) },
  { key: "bestSpree", label: "Spree", title: "Most kills without dying", value: (g) => g.bestSpree, show: (g) => String(g.bestSpree) },
  { key: "bestMulti", label: "Multi", title: "Most kills within 3 seconds of each other", value: (g) => g.bestMulti, show: (g) => String(g.bestMulti) },
  { key: "clutchesWon", label: "1vN", title: "Rounds won as the last player alive, of those played", value: (g) => g.clutchesWon * 100 + g.clutches, show: (g) => (g.clutches ? `${g.clutchesWon}/${g.clutches}` : "–") },
];

function GamesTab() {
  const { form, results } = useStore((s) => s.games);
  const { play, toast, setGames } = useStore.getState();
  const [busy, setBusy] = useState(false);
  const { paths } = useScopePaths(form.scope);
  const setForm = (patch: Partial<GameForm>) => setGames({ form: patch });

  const sorted = useMemo(() => {
    if (!results) return null;
    const by = (g: GameStat) => (form.sort === "timestamp" ? g.timestamp ?? 0 : COLUMNS.find((c) => c.key === form.sort)?.value(g) ?? null);
    // Missing values (no scoreboard) go last.
    return [...results].sort((a, b) => (by(b) ?? -Infinity) - (by(a) ?? -Infinity));
  }, [results, form.sort]);
  const listRef = useKeptScroll(sorted, () => useStore.getState().games.scrollTop);

  const search = async () => {
    setBusy(true);
    const filter: GameFilter = { players: names(form.players), povOnly: form.povOnly, gametypes: form.gametypes, minKills: form.minKills };
    try {
      setGames({ results: await invoke<GameStat[]>("search_games", { paths, filter }), scrollTop: 0 });
    } catch (e) {
      toast("error", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="frags">
      <section className="filters">
        <p className="muted small">
          Every player's game in every demo, with kills, deaths, sprees and multi-kills from the kill feed. Damage, accuracy and score come from the final scoreboard, which Clan Arena and Duel demos include.
        </p>
        <ScopeField scope={form.scope} onChange={(v) => setForm({ scope: v })} />
        <Field label="Player" hint="Part of a name; separate several with commas. Empty matches anyone.">
          <input value={form.players} onChange={(e) => setForm({ players: e.target.value })} placeholder="anyone" spellCheck={false} />
        </Field>
        <Toggle checked={form.povOnly} onChange={(v) => setForm({ povOnly: v })} label="Only the player who recorded the demo" />
        <div className="field">
          <span className="field-label">Modes {form.gametypes.length > 0 && <button type="button" className="link" onClick={() => setForm({ gametypes: [] })}>any</button>}</span>
          <div className="chips">
            {MODES.map((m) => (
              <button
                type="button"
                key={m}
                className={"chip" + (form.gametypes.includes(m) ? " is-active" : "")}
                onClick={() => setForm({ gametypes: form.gametypes.includes(m) ? form.gametypes.filter((x) => x !== m) : [...form.gametypes, m] })}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <Field label="Kills at least">
          <input type="number" min={0} value={form.minKills} onChange={(e) => setForm({ minKills: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <div className="row">
          <Button variant="primary" onClick={() => void search()} disabled={busy || !paths.length}>
            <Search size={14} /> {busy ? "Searching…" : `Search ${paths.length} demo${paths.length === 1 ? "" : "s"}`}
          </Button>
          <Button title="Reset the filters to their defaults and clear the results" onClick={() => setGames({ form: defaultGameForm, results: null, scrollTop: 0 })}>
            <RotateCcw size={14} /> Reset
          </Button>
        </div>
      </section>

      <section className="pane">
        {sorted == null ? (
          <Empty title="Set the filters and search">One row per player per demo. Click a column heading to rank by it: kills, damage, accuracy, K/D and more.</Empty>
        ) : sorted.length === 0 ? (
          <Empty title="Nothing matches">Try fewer kills or more modes.</Empty>
        ) : (
          <>
            <header className="toolbar">
              <span>{sorted.length}{sorted.length === 5000 ? "+" : ""} game{sorted.length === 1 ? "" : "s"}</span>
              <span className="spacer" />
              <label className="muted small">
                Rank by{" "}
                <select value={form.sort} onChange={(e) => setForm({ sort: e.target.value as GameSortKey })}>
                  {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
                  <option value="timestamp">Newest</option>
                </select>
              </label>
            </header>
            <div className="frag-list" ref={listRef} onScroll={(e) => { useStore.getState().games.scrollTop = e.currentTarget.scrollTop; }}>
              <div className="games-scroll">
              <table className="games">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Demo</th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className={"num sortable" + (form.sort === c.key ? " is-sorted" : "")} title={c.title} onClick={() => setForm({ sort: c.key })}>
                        {c.label}{form.sort === c.key && <ArrowDown size={11} />}
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(0, 600).map((g, i) => (
                    <tr key={i}>
                      <td>
                        <strong>{g.name}</strong>
                        {g.result !== 0 && <small className={g.result > 0 ? "good" : "bad"}> {g.result > 0 ? "won" : "lost"}</small>}
                        {g.pov && <small className="muted"> · POV</small>}
                      </td>
                      <td className="games-where">
                        <span title={g.path}>{stripExt(g.fileName)}</span>
                        <small className="muted">{g.gametypeName} · {g.map}{g.timestamp ? ` · ${dateTime(g.timestamp)}` : ""}</small>
                      </td>
                      {COLUMNS.map((c) => <td key={c.key} className={"num" + (form.sort === c.key ? " is-sorted" : "")}>{c.show(g)}</td>)}
                      <td>
                        <button type="button" className="icon-btn" title="Open this game in WolfcamQL, following the player" onClick={() => void play(g.path, { startTime: g.startTime, pov: g.client < 64 ? g.client : null })}>
                          <Play size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {sorted.length > 600 && <p className="muted small pad">Showing the first 600 rows. Narrow the filters to see the rest.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
