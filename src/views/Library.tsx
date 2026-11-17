import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Crosshair, FolderInput, FolderSearch, Pencil, Play, Plus, RefreshCw, Search, Star, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Timeline } from "../components/Timeline";
import { Button, Empty, Modal, WeaponTag } from "../components/ui";
import { backend, invoke, type DemoEntry, type DemoInfo, type Kill } from "../lib/backend";
import { clipFromKills, clipFromRange } from "../lib/clips";
import { clock, dateTime, fileSize, gameClock, stripExt, TEAM_NAMES } from "../lib/format";
import { useStore } from "../lib/store";

type SortKey = "fileName" | "map" | "gametypeName" | "povName" | "date" | "durationMs" | "killCount" | "size";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "fileName", label: "Demo" },
  { key: "map", label: "Map" },
  { key: "gametypeName", label: "Mode" },
  { key: "povName", label: "Recorded by" },
  { key: "date", label: "Date" },
  { key: "durationMs", label: "Length", numeric: true },
  { key: "killCount", label: "Kills", numeric: true },
  { key: "size", label: "Size", numeric: true },
];

function sortValue(d: DemoEntry, key: SortKey): string | number {
  if (key === "date") return d.timestamp ?? d.modified;
  const v = d[key];
  return typeof v === "string" ? v.toLowerCase() : v;
}

export function LibraryView() {
  const demos = useStore((s) => s.demos);
  const meta = useStore((s) => s.meta);
  const selected = useStore((s) => s.selected);
  const scanning = useStore((s) => s.scanning);
  const settings = useStore((s) => s.settings);
  const { setSelected, rescan, play, setView, setMeta } = useStore.getState();

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("");
  const [map, setMap] = useState("");
  const [tag, setTag] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: -1 });
  const anchor = useRef<string | null>(null);

  const modes = useMemo(() => [...new Set(demos.map((d) => d.gametypeName).filter(Boolean))].sort(), [demos]);
  const maps = useMemo(() => [...new Set(demos.map((d) => d.map).filter(Boolean))].sort(), [demos]);
  const tags = useMemo(() => [...new Set(Object.values(meta).flatMap((m) => m.tags ?? []))].sort(), [meta]);

  const rows = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = demos.filter((d) => {
      if (mode && d.gametypeName !== mode) return false;
      if (map && d.map !== map) return false;
      const m = meta[d.path];
      if (favOnly && !m?.favorite) return false;
      if (tag && !m?.tags?.includes(tag)) return false;
      if (!words.length) return true;
      const hay = `${d.fileName} ${d.map} ${d.gametypeName} ${d.hostname} ${d.players.join(" ")} ${m?.tags?.join(" ") ?? ""} ${m?.notes ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    out.sort((a, b) => {
      const [x, y] = [sortValue(a, sort.key), sortValue(b, sort.key)];
      return (x < y ? -1 : x > y ? 1 : a.path.localeCompare(b.path)) * sort.dir;
    });
    return out;
  }, [demos, meta, query, mode, map, tag, favOnly, sort]);

  const parent = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 30, overscan: 12 });

  const click = (d: DemoEntry, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((r) => r.path === anchor.current);
      const b = rows.findIndex((r) => r.path === d.path);
      if (a >= 0 && b >= 0) return setSelected(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.path));
    }
    anchor.current = d.path;
    if (e.ctrlKey || e.metaKey) setSelected(selected.includes(d.path) ? selected.filter((p) => p !== d.path) : [...selected, d.path]);
    else setSelected([d.path]);
  };

  const current = selected.length === 1 ? demos.find((d) => d.path === selected[0]) : undefined;
  const filtered = !!(query || mode || map || tag || favOnly);

  if (!settings.demoDirs.length) {
    return (
      <Empty title="No demo folders yet" action={<Button variant="primary" onClick={() => setView("settings")}>Open settings</Button>}>
        Add the folders that hold your .dm_91 / .dm_90 / .dm_73 demos and WolfDeck will index them.
      </Empty>
    );
  }

  return (
    <div className="library">
      <section className="pane">
        <header className="toolbar">
          <div className="search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, map, player, server, tag…" spellCheck={false} />
            {query && (
              <button type="button" className="icon-btn" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Game mode">
            <option value="">All modes</option>
            {modes.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select value={map} onChange={(e) => setMap(e.target.value)} aria-label="Map">
            <option value="">All maps</option>
            {maps.map((m) => <option key={m}>{m}</option>)}
          </select>
          {tags.length > 0 && (
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
              <option value="">Any tag</option>
              {tags.map((t) => <option key={t}>{t}</option>)}
            </select>
          )}
          <Button active={favOnly} onClick={() => setFavOnly(!favOnly)} title="Show favourites only">
            <Star size={14} fill={favOnly ? "currentColor" : "none"} />
          </Button>
          <span className="spacer" />
          <span className="muted">
            {scanning ? `Indexing ${scanning.done}/${scanning.total || "…"}` : `${rows.length}${filtered ? ` of ${demos.length}` : ""} demos`}
          </span>
          <Button onClick={() => void rescan(false)} disabled={!!scanning} title="Look for new and changed demos">
            <RefreshCw size={14} className={scanning ? "spin" : ""} /> Rescan
          </Button>
        </header>

        <div className="table">
          <div className="thead trow">
            <span />
            {COLUMNS.map((c) => (
              <button
                type="button"
                key={c.key}
                className={c.numeric ? "num" : ""}
                onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (sort.dir === 1 ? -1 : 1) : c.numeric || c.key === "date" ? -1 : 1 })}
              >
                {c.label}
                {sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </button>
            ))}
          </div>
          <div className="tbody" ref={parent}>
            {rows.length === 0 && !scanning && (
              <Empty title={filtered ? "Nothing matches these filters" : "No demos found in the configured folders"} />
            )}
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((v) => {
                const d = rows[v.index];
                const m = meta[d.path];
                return (
                  <div
                    key={d.path}
                    className={"trow" + (selected.includes(d.path) ? " is-selected" : "") + (d.error ? " is-broken" : "")}
                    style={{ position: "absolute", top: v.start, height: v.size, left: 0, right: 0 }}
                    onClick={(e) => click(d, e)}
                    onDoubleClick={() => !d.error && void play(d.path)}
                  >
                    <button
                      type="button"
                      className={"star" + (m?.favorite ? " is-on" : "")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMeta(d.path, { favorite: !m?.favorite });
                      }}
                      aria-label="Favourite"
                    >
                      <Star size={13} fill={m?.favorite ? "currentColor" : "none"} />
                    </button>
                    <span className="cell-name" title={d.path}>
                      {(d.error || d.warning) && <TriangleAlert size={12} className="warn" />}
                      {stripExt(d.fileName)}
                      <small>.{d.fileName.split(".").pop()}</small>
                      {m?.tags?.map((t) => <i key={t} className="tag">{t}</i>)}
                    </span>
                    <span>{d.map}</span>
                    <span>{d.gametypeName}</span>
                    <span>{d.povName}</span>
                    <span className="muted">{dateTime(d.timestamp ?? d.modified)}</span>
                    <span className="num">{d.error ? "" : clock(d.durationMs)}</span>
                    <span className="num">{d.error ? "" : d.killCount}</span>
                    <span className="num muted">{fileSize(d.size)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <aside className="detail">
        {current ? (
          <DemoDetail demo={current} />
        ) : selected.length > 1 ? (
          <BulkActions paths={selected} />
        ) : (
          <Empty title="Select a demo">Double-click a demo to play it. Select one to see its players, kills and chat.</Empty>
        )}
      </aside>
    </div>
  );
}

function BulkActions({ paths }: { paths: string[] }) {
  const { rescan, toast, setView } = useStore.getState();
  const moveAll = async () => {
    const dir = await (await backend()).pickFolder("Move demos to");
    if (!dir) return;
    try {
      await invoke("demo_move", { paths, dir });
      toast("ok", `Moved ${paths.length} demos`);
      void rescan();
    } catch (e) {
      toast("error", String(e));
    }
  };
  const trashAll = async () => {
    if (!confirm(`Move ${paths.length} demos to the recycle bin?`)) return;
    try {
      await invoke("demo_trash", { paths });
      void rescan();
    } catch (e) {
      toast("error", String(e));
    }
  };
  return (
    <div className="detail-body">
      <h2>{paths.length} demos selected</h2>
      <div className="actions">
        <Button onClick={() => setView("frags")}><Crosshair size={14} /> Find frags in selection</Button>
        <Button onClick={() => void moveAll()}><FolderInput size={14} /> Move to folder…</Button>
        <Button variant="danger" onClick={() => void trashAll()}><Trash2 size={14} /> Move to recycle bin</Button>
      </div>
    </div>
  );
}

function DemoDetail({ demo }: { demo: DemoEntry }) {
  const info = useStore((s) => s.demoInfo[demo.path]) as DemoInfo | undefined;
  const meta = useStore((s) => s.meta[demo.path]) ?? {};
  const settings = useStore((s) => s.settings);
  const { loadDemoInfo, play, setMeta, addClip, toast, rescan, setSelected, setView } = useStore.getState();
  const [tab, setTab] = useState<"kills" | "players" | "chat">("kills");
  const [who, setWho] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tagText, setTagText] = useState("");

  useEffect(() => {
    setWho(null);
    if (!demo.error) void loadDemoInfo(demo.path);
  }, [demo.path, demo.error, loadDemoInfo]);

  const kills = useMemo(() => (info?.kills ?? []).filter((k) => who == null || k.killer === who || k.victim === who), [info, who]);
  const tally = useMemo(() => {
    const t = new Map<number, { kills: number; deaths: number }>();
    for (const k of info?.kills ?? []) {
      if (k.warmup) continue;
      if (!k.ownGoal) t.set(k.killer, { kills: (t.get(k.killer)?.kills ?? 0) + 1, deaths: t.get(k.killer)?.deaths ?? 0 });
      t.set(k.victim, { kills: t.get(k.victim)?.kills ?? 0, deaths: (t.get(k.victim)?.deaths ?? 0) + 1 });
    }
    return t;
  }, [info]);

  const playKill = (k: Kill) => void play(demo.path, { startTime: k.serverTime - settings.clipLeadIn * 1000, pov: k.killer < 64 ? k.killer : null });
  const clipKill = (k: Kill) => {
    addClip(clipFromKills(demo.path, demo.map, [k], settings, info && { first: info.firstServerTime, last: info.lastServerTime }));
    toast("ok", "Clip added");
  };

  const rename = async () => {
    if (!renaming?.trim()) return setRenaming(null);
    try {
      const path = await invoke<string>("demo_rename", { path: demo.path, newName: renaming.trim() });
      setRenaming(null);
      await rescan();
      setSelected([path]);
    } catch (e) {
      toast("error", String(e));
    }
  };

  const addTag = () => {
    const t = tagText.trim();
    if (t && !meta.tags?.includes(t)) setMeta(demo.path, { tags: [...(meta.tags ?? []), t] });
    setTagText("");
  };

  return (
    <div className="detail-body">
      <header className="detail-head">
        <h2 title={demo.path}>{stripExt(demo.fileName)}</h2>
        <p className="muted">
          {demo.error ? "Could not be read" : `${demo.gametypeName} on ${demo.map} · ${clock(demo.durationMs)} · protocol ${demo.protocol}`}
        </p>
        {demo.hostname && <p className="muted">{demo.hostname}{demo.timestamp ? ` · ${dateTime(demo.timestamp)}` : ""}</p>}
      </header>

      {demo.error && <p className="notice notice-bad">{demo.error}</p>}
      {demo.warning && <p className="notice">This demo is incomplete ({demo.warning}); everything up to that point is usable.</p>}

      <div className="actions">
        <Button variant="primary" disabled={!!demo.error} onClick={() => void play(demo.path)}><Play size={14} /> Play</Button>
        <Button disabled={!info} onClick={() => info?.gameStartTime != null && void play(demo.path, { startTime: info.gameStartTime })} title="Skip the warmup">
          Play from match start
        </Button>
        <Button
          disabled={!info}
          title="Queue the whole match for rendering"
          onClick={() => {
            if (!info) return;
            addClip(clipFromRange(demo.path, demo.map, info.gameStartTime ?? info.firstServerTime, info.gameEndTime ?? info.lastServerTime, null, info.povName, "Whole match"));
            toast("ok", "Whole match added to clips");
          }}
        >
          <Plus size={14} /> Match as clip
        </Button>
        <Button onClick={() => { setSelected([demo.path]); setView("frags"); }} disabled={!!demo.error}><Crosshair size={14} /> Find frags</Button>
      </div>
      <div className="actions actions-quiet">
        <Button small variant="ghost" onClick={async () => (await backend()).reveal(demo.path)}><FolderSearch size={13} /> Show in folder</Button>
        <Button small variant="ghost" onClick={() => setRenaming(stripExt(demo.fileName))}><Pencil size={13} /> Rename</Button>
        <Button
          small
          variant="ghost"
          onClick={async () => {
            if (!confirm(`Move ${demo.fileName} to the recycle bin?`)) return;
            await invoke("demo_trash", { paths: [demo.path] }).catch((e) => toast("error", String(e)));
            void rescan();
          }}
        >
          <Trash2 size={13} /> Delete
        </Button>
      </div>

      <div className="tags">
        {meta.tags?.map((t) => (
          <span key={t} className="tag">
            {t}
            <button type="button" onClick={() => setMeta(demo.path, { tags: meta.tags!.filter((x) => x !== t) })} aria-label={`Remove tag ${t}`}><X size={10} /></button>
          </span>
        ))}
        <input value={tagText} onChange={(e) => setTagText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()} onBlur={addTag} placeholder="Add tag…" />
      </div>
      <textarea className="notes" value={meta.notes ?? ""} onChange={(e) => setMeta(demo.path, { notes: e.target.value })} placeholder="Notes" rows={2} />

      {info && (
        <>
          <Timeline info={info} highlight={who} onKill={playKill} />
          <div className="tabs">
            <button type="button" className={tab === "kills" ? "is-active" : ""} onClick={() => setTab("kills")}>Kills <em>{kills.length}</em></button>
            <button type="button" className={tab === "players" ? "is-active" : ""} onClick={() => setTab("players")}>Players <em>{info.players.length}</em></button>
            <button type="button" className={tab === "chat" ? "is-active" : ""} onClick={() => setTab("chat")}>Chat <em>{info.chats.length}</em></button>
            {who != null && (
              <button type="button" className="chip" onClick={() => setWho(null)}>
                {info.players.find((p) => p.clientNum === who)?.name} <X size={11} />
              </button>
            )}
          </div>
          <div className="list">
            {tab === "kills" &&
              kills.map((k, i) => (
                <div key={i} className={"kill" + (k.ownGoal ? " is-own" : "")} onDoubleClick={() => playKill(k)}>
                  <time>{gameClock(k.clockMs, k.warmup)}</time>
                  <span className="kill-text">
                    <b>{k.killerName}</b> <WeaponTag weapon={k.weapon} /> {k.victimName}
                  </span>
                  <button type="button" className="icon-btn" title="Play from just before this kill" onClick={() => playKill(k)}><Play size={13} /></button>
                  <button type="button" className="icon-btn" title="Add as clip" onClick={() => clipKill(k)}><Plus size={13} /></button>
                </div>
              ))}
            {tab === "players" &&
              [...info.players].sort((a, b) => a.team - b.team || (tally.get(b.clientNum)?.kills ?? 0) - (tally.get(a.clientNum)?.kills ?? 0)).map((p, i) => (
                <div key={i} className="player-row">
                  <span className={`team team-${p.team}`} title={TEAM_NAMES[p.team]} />
                  <button type="button" className="link" onClick={() => { setWho(p.clientNum); setTab("kills"); }} title="Show this player's kills and deaths">
                    {p.name}{p.clientNum === info.povClient && <em> recorded this demo</em>}
                  </button>
                  <span className="num muted">{p.team === 3 ? "spectator" : `${tally.get(p.clientNum)?.kills ?? 0} / ${tally.get(p.clientNum)?.deaths ?? 0}`}</span>
                  <button type="button" className="icon-btn" title="Play from this player's point of view" disabled={p.team === 3} onClick={() => void play(demo.path, { pov: p.clientNum, startTime: info.gameStartTime ?? undefined })}>
                    <Play size={13} />
                  </button>
                </div>
              ))}
            {tab === "chat" &&
              info.chats.map((c, i) => (
                <div key={i} className="chat-row">
                  <time>{clock(c.clockMs)}</time>
                  <span>{c.text}</span>
                </div>
              ))}
          </div>
        </>
      )}

      {renaming != null && (
        <Modal title="Rename demo" onClose={() => setRenaming(null)} footer={<><Button onClick={() => setRenaming(null)}>Cancel</Button><Button variant="primary" onClick={() => void rename()}>Rename</Button></>}>
          <input className="input-wide" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void rename()} />
        </Modal>
      )}
    </div>
  );
}
