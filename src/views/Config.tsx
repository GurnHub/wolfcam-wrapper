import { Copy, Download, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Field, Toggle } from "../components/ui";
import { backend, invoke, type GameFile } from "../lib/backend";
import { CVAR_GROUPS, NAME_POSITIONS, namePositionValues, needsRestart, toCss, toEngine, type CvarDef } from "../lib/cvars";
import { uid } from "../lib/format";
import { defaultProfiles, profileParts, useStore, type Profile } from "../lib/store";

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

type HudMode = "unset" | "ql" | "compact" | "q3" | "custom";

function hudMode(values: Record<string, string>): HudMode {
  const files = values.cg_hudFiles;
  if (values.cg_qlhud === "0") return "q3";
  if (files === undefined) return values.cg_qlhud === undefined ? "unset" : "ql";
  if (files === "ui/hud.txt") return "ql";
  if (files === "ui/hud2.txt") return "compact";
  return "custom"; // including "", while no file has been picked yet
}

/** Chooses the HUD: the stock ones, or a custom `.menu` file. */
function HudChooser({ profile, onChange }: { profile: Profile; onChange: (values: Record<string, string>) => void }) {
  const settings = useStore((s) => s.settings);
  const [menus, setMenus] = useState<GameFile[]>([]);
  const mode = hudMode(profile.values);
  useEffect(() => {
    void invoke<GameFile[]>("list_game_files", { exe: settings.wolfcamExe, home: settings.wolfcamHome, sub: "ui", exts: ["menu"] }).then(setMenus).catch(() => setMenus([]));
  }, [settings.wolfcamExe, settings.wolfcamHome]);

  const set = (patch: Record<string, string | null>) => {
    const values = { ...profile.values };
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) delete values[k];
      else values[k] = v;
    }
    onChange(values);
  };
  const choose = (m: HudMode) => {
    if (m === "unset") set({ cg_qlhud: null, cg_hudFiles: null });
    else if (m === "ql") set({ cg_qlhud: "1", cg_hudFiles: "ui/hud.txt" });
    else if (m === "compact") set({ cg_qlhud: "1", cg_hudFiles: "ui/hud2.txt" });
    else if (m === "q3") set({ cg_qlhud: "0", cg_hudFiles: null });
    else set({ cg_qlhud: "1", cg_hudFiles: profile.values.cg_hudFiles && mode === "custom" ? profile.values.cg_hudFiles : "" });
  };
  const install = async (menu: string) => {
    try {
      const value = await invoke<string>("install_hud", { exe: settings.wolfcamExe, home: settings.wolfcamHome, menu });
      set({ cg_qlhud: "1", cg_hudFiles: value });
    } catch (e) {
      useStore.getState().toast("error", String(e));
    }
  };
  const OPTIONS: [HudMode, string][] = [["unset", "Not set by this profile"], ["ql", "Quake Live HUD"], ["compact", "Quake Live compact HUD"], ["q3", "Quake 3 HUD"], ["custom", "Custom HUD"]];
  return (
    <div className={"hud-chooser" + (mode !== "unset" ? " is-set" : "")}>
      <div className="chips" role="radiogroup" aria-label="HUD">
        {OPTIONS.map(([m, l]) => (
          <button type="button" key={m} role="radio" aria-checked={mode === m} className={"chip" + (mode === m ? " is-active" : "")} onClick={() => choose(m)}>{l}</button>
        ))}
      </div>
      {mode === "custom" && (
        <div className="row">
          <select value="" onChange={(e) => e.target.value && void install(e.target.value)} aria-label="HUD files in WolfcamQL's ui folder">
            <option value="">{menus.length ? "Choose from WolfcamQL's ui folder…" : "No .menu files in WolfcamQL's ui folder"}</option>
            {menus.map((m) => <option key={m.path} value={m.path}>{m.name}</option>)}
          </select>
          <Button onClick={async () => { const f = await (await backend()).pickFile("Choose a HUD .menu file", ["menu"]); if (f) void install(f); }}>Browse</Button>
        </div>
      )}
      <small className="muted">
        {mode === "custom"
          ? profile.values.cg_hudFiles ? <>Using <code>{profile.values.cg_hudFiles}</code>. A file from outside WolfcamQL is copied into its ui folder.</> : "Pick a HUD file with the extension .menu."
          : mode === "q3" ? "The original Quake 3 status bar (cg_qlhud 0)." : mode === "unset" ? "The HUD stays whatever your WolfcamQL config uses." : "Sets cg_qlhud and cg_hudFiles."}
      </small>
    </div>
  );
}

const NAME_CVARS = ["cg_drawFollowing", "cg_drawFollowingX", "cg_drawFollowingY", "cg_drawFollowingAlign"];

/** Position of the watched player's name on the HUD. */
function NameChooser({ profile, onChange }: { profile: Profile; onChange: (values: Record<string, string>) => void }) {
  const v = profile.values;
  const current =
    v.cg_drawFollowing === undefined ? "unset"
    : v.cg_drawFollowing === "0" ? "hidden"
    : NAME_POSITIONS.find((p) => String(p.x) === v.cg_drawFollowingX && String(p.y) === v.cg_drawFollowingY && String(p.align) === v.cg_drawFollowingAlign)?.id ?? "custom";
  const choose = (id: string) => {
    const values = { ...profile.values };
    for (const k of NAME_CVARS) delete values[k];
    if (id !== "unset") Object.assign(values, namePositionValues(id === "hidden" ? null : id));
    onChange(values);
  };
  return (
    <div className={"cvar" + (current !== "unset" ? " is-set" : "")}>
      <div className="cvar-label">
        <span>Watched player's name</span>
        <small><code>cg_drawFollowing</code> · Where the name of the player you are watching is drawn.</small>
      </div>
      <select value={current} onChange={(e) => choose(e.target.value)} aria-label="Watched player's name position">
        <option value="unset">Not set by this profile</option>
        {NAME_POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        <option value="hidden">Hidden</option>
        {current === "custom" && <option value="custom">Custom position</option>}
      </select>
      <span />
    </div>
  );
}

export function ConfigView() {
  const profiles = useStore((s) => s.profiles);
  const settings = useStore((s) => s.settings);
  const { saveProfiles, updateSettings, toast, restoreDefaultProfiles } = useStore.getState();
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
      items: g.items.filter(
        (i) => (!q || g.title.toLowerCase().includes(q) || i.label.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)) && (!onlySet || i.name in profile.values),
      ),
    })).filter((g) => g.items.length);
  }, [query, onlySet, profile]);

  const exportCfg = async () => {
    const parts = profileParts(profile);
    const text = `// ${profile.name} - exported from Wolfcam Wrapper\n` + parts.cvars.map(([k, v]) => `seta ${k} "${v}"\n`).join("") + parts.config;
    const name = `wolfcam-wrapper-${profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile"}.cfg`;
    try {
      const path = await invoke<string>("write_game_file", { home: settings.wolfcamHome, name, text });
      toast("ok", `Saved ${path}. Use "exec ${name}" in WolfcamQL.`);
    } catch (e) {
      toast("error", String(e));
    }
  };

  const setCount = Object.keys(profile.values).length;
  const original = defaultProfiles.find((p) => p.id === profile.id);
  const modified = !!original && (original.name !== profile.name || original.extra !== profile.extra || JSON.stringify(original.values) !== JSON.stringify(profile.values));
  const builtInChanged = defaultProfiles.some((d) => {
    const p = profiles.find((x) => x.id === d.id);
    return !p || p.name !== d.name || p.extra !== d.extra || JSON.stringify(p.values) !== JSON.stringify(d.values);
  });

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
        <Button
          small
          disabled={!builtInChanged}
          title="Put the built-in profiles (Viewing, Movie (clean), Movie (with HUD)) back to how they shipped. Profiles you created are kept."
          onClick={() => {
            if (!confirm("Reset the built-in profiles to their original settings? Your own profiles are not touched.")) return;
            restoreDefaultProfiles();
            toast("ok", "Built-in profiles restored");
          }}
        >
          <RotateCcw size={13} /> Restore default profiles
        </Button>
        <p className="muted small">
          A profile is the set of WolfcamQL settings Wolfcam Wrapper applies when it starts a demo or a render. Anything a profile does not set stays as it is in your own WolfcamQL config.
        </p>
      </aside>

      <section className="pane config-main">
        <header className="toolbar">
          <input className="profile-name" value={profile.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Profile name" />
          <Button variant={profile.id === settings.activeProfile ? "default" : "primary"} disabled={profile.id === settings.activeProfile} onClick={() => updateSettings({ activeProfile: profile.id })}>
            {profile.id === settings.activeProfile ? "In use" : "Use this profile"}
          </Button>
          <span className="spacer" />
          {modified && (
            <Button
              title="Reset this built-in profile to its original settings"
              onClick={() => confirm(`Reset "${profile.name}" to its original settings?`) && original && patch({ name: original.name, extra: original.extra, values: { ...original.values } })}
            >
              <RotateCcw size={14} /> Reset
            </Button>
          )}
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
          <span className="muted small toolbar-note"><span className="badge-restart">vid_restart</span> needs a video restart to apply; starting a demo or render from Wolfcam Wrapper does that automatically.</span>
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
              {g.legend && (
                <details className="legend">
                  <summary>Tokens you can use in the messages</summary>
                  <dl>{g.legend.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}</dl>
                </details>
              )}
              {g.id === "hud" && !query && <HudChooser profile={profile} onChange={(values) => patch({ values })} />}
              {g.id === "hud" && (!onlySet || "cg_drawFollowing" in profile.values) && (!query || "watched player's name position following".includes(query.trim().toLowerCase())) && (
                <NameChooser profile={profile} onChange={(values) => patch({ values })} />
              )}
              {g.items.filter((def) => g.id !== "hud" || query || (def.name !== "cg_hudFiles" && def.name !== "cg_qlhud")).map((def) => {
                const isSet = def.name in profile.values;
                return (
                  <div key={def.name} className={"cvar" + (isSet ? " is-set" : "")}>
                    <div className="cvar-label">
                      <span>{def.label}</span>
                      <small>
                        <code>{def.name}</code>
                        {needsRestart(def.name) && <span className="badge-restart" title="The engine latches this setting: a new value takes effect after vid_restart">vid_restart</span>}
                        {def.help ? ` · ${def.help}` : ""}
                      </small>
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
