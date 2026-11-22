import { Download, Plus, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Toggle } from "../components/ui";
import {
  ALL_KEYS, customBinds, KEY_GROUPS, keyFromCode, keyFromMouseButton, keysFor, prettyKey, sameBinds, WOLFCAM_DEFAULTS, WRAPPER_LAYOUT,
  type BindMap,
} from "../lib/keys";
import { useStore } from "../lib/store";

/** What a key is being chosen for: a known action, or a free-form command. */
type Target = { command: string; label: string } | { command: null; label: string };

function describe(command: string): string {
  const lower = command.toLowerCase();
  for (const g of KEY_GROUPS) for (const x of g.actions) if (x.command.toLowerCase() === lower) return x.label;
  return command;
}

function KeyCap({ k, onRemove }: { k: string; onRemove?: () => void }) {
  return (
    <span className="keycap" title={`Engine key name: ${k}`}>
      {prettyKey(k)}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Unbind ${prettyKey(k)}`}>
          <X size={10} />
        </button>
      )}
    </span>
  );
}

/** Captures the next key press, mouse button or wheel movement. */
function CaptureDialog({ target, binds, onPick, onClose }: { target: Target; binds: BindMap; onPick: (key: string, command: string) => void; onClose: () => void }) {
  const [key, setKey] = useState<string | null>(null);
  const [command, setCommand] = useState(target.command ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      e.preventDefault();
      e.stopPropagation();
      const k = keyFromCode(e.code);
      if (k) setKey(k);
    };
    // Capture phase, so Escape can be bound instead of closing the dialog.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const current = key ? binds[key] : undefined;
  const taken = current !== undefined && current.toLowerCase() !== command.trim().toLowerCase();
  const ok = !!key && !!command.trim();

  return (
    <Modal
      title={target.command ? `Key for "${target.label}"` : "New key bind"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={() => key && onPick(key, command.trim())}>{taken ? "Replace" : "Assign"}</Button>
        </>
      }
    >
      <div
        className={"capture" + (key ? " has-key" : "")}
        tabIndex={0}
        onMouseDown={(e) => {
          const k = keyFromMouseButton(e.button);
          if (k) {
            e.preventDefault();
            setKey(k);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => setKey(e.deltaY < 0 ? "MWHEELUP" : "MWHEELDOWN")}
      >
        {key ? <KeyCap k={key} /> : <span>Press a key, or click or scroll here for a mouse button</span>}
      </div>
      <div className="capture-row">
        <label className="inline">
          or choose
          <select value={key ?? ""} onChange={(e) => setKey(e.target.value || null)} aria-label="Key">
            <option value="">a key…</option>
            {ALL_KEYS.map((k) => <option key={k} value={k}>{prettyKey(k)}{prettyKey(k) !== k ? ` (${k})` : ""}</option>)}
          </select>
        </label>
      </div>
      {target.command === null && (
        <label className="field">
          <span className="field-label">Console command</span>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="exec mymovie.cfg" spellCheck={false} />
          <span className="field-hint">Several commands can be separated with semicolons. Quotes are not possible inside a bind.</span>
        </label>
      )}
      {taken && <p className="notice">{prettyKey(key!)} is currently bound to "{describe(current!)}". Assigning it here replaces that.</p>}
    </Modal>
  );
}

export function KeysView() {
  const keys = useStore((s) => s.keys);
  const { setBinds, setKeysEnabled, readEngineBinds, toast } = useStore.getState();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const binds = keys.binds;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return KEY_GROUPS.map((g) => ({
      ...g,
      actions: g.actions.filter(
        (x) => !q || g.title.toLowerCase().includes(q) || x.label.toLowerCase().includes(q) || x.command.toLowerCase().includes(q) || keysFor(binds, x.command).some((k) => prettyKey(k).toLowerCase() === q || k.toLowerCase() === q),
      ),
    })).filter((g) => g.actions.length);
  }, [query, binds]);
  const custom = useMemo(() => {
    const q = query.trim().toLowerCase();
    return customBinds(binds).filter(([k, c]) => !q || c.toLowerCase().includes(q) || prettyKey(k).toLowerCase() === q || k.toLowerCase() === q);
  }, [binds, query]);

  const unbind = (key: string) => {
    const next = { ...binds };
    delete next[key];
    setBinds(next);
  };
  const replaceAll = (next: BindMap, what: string) => {
    if (sameBinds(next, binds)) return toast("info", `Already using ${what}`);
    if (!confirm(`Replace all ${Object.keys(binds).length} key binds with ${what}?`)) return;
    setBinds({ ...next });
    toast("ok", `Loaded ${what}`);
  };
  const importEngine = async () => {
    const engine = await readEngineBinds();
    if (!engine) return;
    if (!Object.keys(engine).length) return toast("error", "WolfcamQL's config has no key binds.");
    replaceAll(engine, "WolfcamQL's current binds");
  };

  const count = Object.keys(binds).length;

  return (
    <div className="keys">
      <header className="toolbar">
        <h2>Keys</h2>
        <Toggle checked={keys.enabled} onChange={(v) => void setKeysEnabled(v)} label="Use these keys in WolfcamQL" />
        <span className="muted small">
          {keys.enabled
            ? "Applied each time Wolfcam Wrapper opens a demo in WolfcamQL."
            : "Off: WolfcamQL keeps its own binds and this list is not applied."}
        </span>
        <span className="spacer" />
        <div className="search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an action, command or key…" spellCheck={false} />
        </div>
      </header>
      <div className="toolbar toolbar-sub">
        <span className="muted small">Load a layout:</span>
        <Button small onClick={() => replaceAll(WRAPPER_LAYOUT, "the Wolfcam Wrapper layout")} title="Media-player keys for playback, WASD for the free camera, camera tools around V, U, O, P and the brackets">
          <RotateCcw size={13} /> Wolfcam Wrapper layout
        </Button>
        <Button small onClick={() => replaceAll(WOLFCAM_DEFAULTS, "the WolfcamQL defaults")} title="The binds WolfcamQL ships with">WolfcamQL defaults</Button>
        <Button small onClick={() => void importEngine()} title="Read the binds WolfcamQL has saved in its own config"><Download size={13} /> Import from WolfcamQL</Button>
        {keys.previous && (
          <Button small onClick={() => replaceAll(keys.previous!, "the binds WolfcamQL had before Wolfcam Wrapper managed them")} title="The binds WolfcamQL had when you first switched this on">
            Previous WolfcamQL binds
          </Button>
        )}
        <span className="spacer" />
        <span className="muted small">{count} key{count === 1 ? "" : "s"} bound</span>
      </div>

      <div className="keys-scroll">
        {keys.enabled ? (
          <p className="notice">
            Each time Wolfcam Wrapper starts WolfcamQL it clears WolfcamQL's binds and sets the ones listed here, so this list is the whole keyboard. WolfcamQL then saves them in its own config as well.
          </p>
        ) : (
          <p className="notice">
            This list is not applied yet. To start from the keys you already use, press <b>Import from WolfcamQL</b> first; then switch on <b>Use these keys in WolfcamQL</b>.
          </p>
        )}

        {groups.map((g) => (
          <fieldset key={g.id} className="cvar-group key-group">
            <legend>{g.title}</legend>
            {g.actions.map((x) => {
              const assigned = keysFor(binds, x.command);
              return (
                <div key={x.command} className={"key-row" + (assigned.length ? "" : " is-unbound")}>
                  <div className="cvar-label">
                    <span>{x.label}</span>
                    <small><code>{x.command}</code>{x.help ? ` · ${x.help}` : ""}</small>
                  </div>
                  <div className="key-caps">
                    {assigned.map((k) => <KeyCap key={k} k={k} onRemove={() => unbind(k)} />)}
                    {assigned.length === 0 && <span className="muted small">not bound</span>}
                  </div>
                  <button type="button" className="icon-btn" title="Assign a key" onClick={() => setTarget({ command: x.command, label: x.label })}>
                    <Plus size={14} />
                  </button>
                </div>
              );
            })}
          </fieldset>
        ))}

        <fieldset className="cvar-group key-group">
          <legend>Other binds</legend>
          {custom.length === 0 && <p className="muted small pad-row">Keys bound to any other console command appear here.</p>}
          {custom.map(([k, c]) => (
            <div key={k} className="key-row">
              <input
                className="key-command"
                defaultValue={c}
                key={`${k}:${c}`}
                spellCheck={false}
                aria-label={`Command for ${prettyKey(k)}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (!v) unbind(k);
                  else if (v !== c) setBinds({ ...binds, [k]: v.replace(/"/g, "") });
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
              <div className="key-caps"><KeyCap k={k} onRemove={() => unbind(k)} /></div>
              <span />
            </div>
          ))}
          <div className="btn-row">
            <Button small onClick={() => setTarget({ command: null, label: "" })}><Plus size={13} /> Bind a key to a command</Button>
          </div>
        </fieldset>
      </div>

      {target && (
        <CaptureDialog
          target={target}
          binds={binds}
          onClose={() => setTarget(null)}
          onPick={(key, command) => {
            setBinds({ ...binds, [key]: command.replace(/"/g, "") });
            setTarget(null);
          }}
        />
      )}
    </div>
  );
}
