import { Copy, Download, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button, Field, Toggle } from "../components/ui";
import { invoke } from "../lib/backend";
import { CVAR_GROUPS, toCss, toEngine, type CvarDef } from "../lib/cvars";
import { uid } from "../lib/format";
import { profileParts, useStore, type Profile } from "../lib/store";

function Control({ def, value, onChange }: { def: CvarDef; value: string; onChange: (v: string) => void }) {
  const k = def.kind;
  switch (k.type) {
    case "bool":
      return <Toggle checked={value !== "0" && value !== ""} onChange={(v) => onChange(v ? "1" : "0")} />;
    case "range":
      return (
        <span className="range">
          <input type="range" min={k.min} max={k.max} step={k.step} value={Number(value) || 0} onChange={(e) => onChange(e.target.value)} aria-label={def.label} />
          <input type="number" min={k.min} max={k.max} step={k.step} value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${def.label} value`} />
        </span>
      );
    case "select":
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={def.label}>
          {!k.options.some((o) => o[0] === value) && <option value={value}>{value}</option>}
          {k.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      );
    case "color":
      return (
        <span className="range">
          <input type="color" value={toCss(value)} onChange={(e) => onChange(toEngine(e.target.value))} aria-label={def.label} />
          <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-label={`${def.label} value`} />
        </span>
      );
    default:
      return <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-label={def.label} />;
  }
}

export function ConfigView() {
  const profiles = useStore((s) => s.profiles);
  const settings = useStore((s) => s.settings);
  const { saveProfiles, updateSettings, toast } = useStore.getState();
  const [currentId, setCurrentId] = useState(settings.activeProfile);
  const [query, setQuery] = useState("");
  const [onlySet, setOnlySet] = useState(false);

  const profile = profiles.find((p) => p.id === currentId) ?? profiles[0];
  const patch = (p: Partial<Profile>) => saveProfiles(profiles.map((x) => (x.id === profile.id ? { ...x, ...p } : x)));
  const setValue = (name: string, value: string | null) => {
    const values = { ...profile.values };
    if (value == null) delete values[name];
    else values[name] = value;
    patch({ values });
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CVAR_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => (!q || i.label.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)) && (!onlySet || i.name in profile.values)),
    })).filter((g) => g.items.length);
  }, [query, onlySet, profile]);

  const exportCfg = async () => {
    const parts = profileParts(profile);
    const text = `// ${profile.name} - exported from WolfDeck\n` + parts.cvars.map(([k, v]) => `seta ${k} "${v}"\n`).join("") + parts.config.replace(/^set /gm, "seta ");
    const name = `wolfdeck-${profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile"}.cfg`;
    try {
      const path = await invoke<string>("write_game_file", { home: settings.wolfcamHome, name, text });
      toast("ok", `Saved ${path}. Use "exec ${name}" in WolfcamQL.`);
    } catch (e) {
      toast("error", String(e));
    }
  };

  const setCount = Object.keys(profile.values).length;

  return (
    <div className="config">
      <aside className="profiles">
        <h2>Profiles</h2>
        <ul>
          {profiles.map((p) => (
            <li key={p.id}>
              <button type="button" className={p.id === profile.id ? "is-active" : ""} onClick={() => setCurrentId(p.id)}>
                {p.name}
                {p.id === settings.activeProfile && <em>in use</em>}
              </button>
            </li>
          ))}
        </ul>
        <Button
          small
          onClick={() => {
            const p: Profile = { id: uid(), name: "New profile", values: {}, extra: "" };
            saveProfiles([...profiles, p]);
            setCurrentId(p.id);
          }}
        >
          <Plus size={13} /> New profile
        </Button>
        <p className="muted small">
          A profile is the set of WolfcamQL settings WolfDeck applies when it starts a demo or a render. Anything a profile does not set stays as it is in your own WolfcamQL config.
        </p>
      </aside>

      <section className="pane config-main">
        <header className="toolbar">
          <input className="profile-name" value={profile.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Profile name" />
          <Button variant={profile.id === settings.activeProfile ? "default" : "primary"} disabled={profile.id === settings.activeProfile} onClick={() => updateSettings({ activeProfile: profile.id })}>
            {profile.id === settings.activeProfile ? "In use" : "Use this profile"}
          </Button>
          <span className="spacer" />
          <Button
            title="Duplicate"
            onClick={() => {
              const p = { ...profile, id: uid(), name: `${profile.name} copy`, values: { ...profile.values } };
              saveProfiles([...profiles, p]);
              setCurrentId(p.id);
            }}
          >
            <Copy size={14} />
          </Button>
          <Button title="Export as a .cfg file into the WolfcamQL folder" onClick={() => void exportCfg()}><Download size={14} /></Button>
          <Button
            title="Delete profile"
            disabled={profiles.length < 2}
            onClick={() => {
              if (!confirm(`Delete the profile "${profile.name}"?`)) return;
              const rest = profiles.filter((p) => p.id !== profile.id);
              saveProfiles(rest);
              if (settings.activeProfile === profile.id) updateSettings({ activeProfile: rest[0].id });
              setCurrentId(rest[0].id);
            }}
          >
            <Trash2 size={14} />
          </Button>
        </header>
        <div className="toolbar toolbar-sub">
          <div className="search">
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a setting…" spellCheck={false} />
          </div>
          <Toggle checked={onlySet} onChange={setOnlySet} label={`Only what this profile sets (${setCount})`} />
        </div>

        <div className="config-scroll">
          {!query && !onlySet && (
            <fieldset className="cvar-group">
              <legend>Playback window</legend>
              <div className="cvar">
                <div className="cvar-label"><span>Fullscreen</span><small>Used when playing demos; renders always use the capture preset's size.</small></div>
                <Toggle checked={settings.viewFullscreen} onChange={(v) => updateSettings({ viewFullscreen: v })} />
              </div>
              <div className="cvar">
                <div className="cvar-label"><span>Window size</span></div>
                <span className="range">
                  <input type="number" min={640} step={2} value={settings.viewWidth} onChange={(e) => updateSettings({ viewWidth: Number(e.target.value) || 1280 })} aria-label="Width" />
                  <input type="number" min={360} step={2} value={settings.viewHeight} onChange={(e) => updateSettings({ viewHeight: Number(e.target.value) || 720 })} aria-label="Height" />
                </span>
              </div>
            </fieldset>
          )}
          {groups.map((g) => (
            <fieldset key={g.id} className="cvar-group">
              <legend>{g.title}</legend>
              {g.items.map((def) => {
                const isSet = def.name in profile.values;
                return (
                  <div key={def.name} className={"cvar" + (isSet ? " is-set" : "")}>
                    <div className="cvar-label">
                      <span>{def.label}</span>
                      <small><code>{def.name}</code>{def.help ? ` · ${def.help}` : ""}</small>
                    </div>
                    <Control def={def} value={profile.values[def.name] ?? def.def} onChange={(v) => setValue(def.name, v)} />
                    <button type="button" className="icon-btn" title="Stop setting this (leave it to your WolfcamQL config)" disabled={!isSet} onClick={() => setValue(def.name, null)}>
                      <RotateCcw size={13} />
                    </button>
                  </div>
                );
              })}
            </fieldset>
          ))}
          {!query && (
            <fieldset className="cvar-group">
              <legend>Extra commands</legend>
              <Field label="Run after the demo has loaded" hint="Any console commands or cvars, one per line. Example: exec myhud.cfg" wide>
                <textarea rows={6} value={profile.extra} onChange={(e) => patch({ extra: e.target.value })} spellCheck={false} placeholder={"exec mymovie.cfg\nset cg_drawFragMessageSeparate 0"} />
              </Field>
            </fieldset>
          )}
        </div>
      </section>
    </div>
  );
}
