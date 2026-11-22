import { Check, FolderPlus, RefreshCw, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { Button, Field } from "../components/ui";
import { backend, invoke } from "../lib/backend";
import { useStore, type Settings } from "../lib/store";

function PathField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  kind: "file" | "folder";
  hint?: React.ReactNode;
  placeholder?: string;
  suggestions?: string[];
}) {
  const pick = async () => {
    const b = await backend();
    const p = props.kind === "file" ? await b.pickFile(props.label) : await b.pickFolder(props.label);
    if (p) props.onChange(p);
  };
  const others = (props.suggestions ?? []).filter((s) => s && s !== props.value);
  return (
    <Field label={props.label} hint={props.hint} wide>
      <div className="row">
        <input value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder={props.placeholder} spellCheck={false} />
        <Button onClick={() => void pick()}>Browse</Button>
      </div>
      {others.length > 0 && (
        <span className="suggest">
          Found: {others.map((s) => <button type="button" className="link" key={s} onClick={() => props.onChange(s)}>{s}</button>)}
        </span>
      )}
    </Field>
  );
}

let recheckTimer: ReturnType<typeof setTimeout> | undefined;

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const detected = useStore((s) => s.detected);
  const install = useStore((s) => s.install);
  const ffmpeg = useStore((s) => s.ffmpegVersion);
  const installedMaps = useStore((s) => s.installedMaps);
  const { updateSettings, refreshInstall, rescan, toast } = useStore.getState();
  const [syncing, setSyncing] = useState(false);

  const set = (patch: Partial<Settings>, recheck = true) => {
    updateSettings({ ...patch, setupDone: true });
    if (recheck) {
      // Path fields change on every keystroke; check the install once typing pauses.
      clearTimeout(recheckTimer);
      recheckTimer = setTimeout(() => void refreshInstall(), 500);
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const copied = await invoke<string[]>("sync_paks", { exe: settings.wolfcamExe, home: settings.wolfcamHome, qlPath: settings.qlPath });
      toast("ok", copied.length ? `Copied ${copied.length} pak file(s) into WolfcamQL` : "WolfcamQL already has every pak");
    } catch (e) {
      toast("error", String(e));
    } finally {
      setSyncing(false);
      void refreshInstall();
    }
  };

  const addDir = async () => {
    const d = await (await backend()).pickFolder("Add a demo folder");
    if (d && !settings.demoDirs.includes(d)) {
      set({ demoDirs: [...settings.demoDirs, d] }, false);
      void rescan();
    }
  };

  return (
    <div className="settings">
      <h1>Settings</h1>

      <section className="card">
        <h3>WolfcamQL</h3>
        <div className={"health " + (install?.problems.length ? "health-bad" : install?.exeOk ? "health-ok" : "")}>
          {install?.problems.length ? <TriangleAlert size={16} /> : <Check size={16} />}
          <div>
            {install?.problems.length ? install.problems.map((p) => <p key={p}>{p}</p>) : <p>{install?.exeOk ? `Ready. ${install.paks.length} pak files available.` : "Not checked yet."}</p>}
            {install?.exeOk && <small>Home folder: {install.home}</small>}
          </div>
          {install?.qlOk && install.missingPaks.length > 0 && (
            <Button variant="primary" onClick={() => void sync()} disabled={syncing}>
              <RefreshCw size={14} className={syncing ? "spin" : ""} /> Sync {install.missingPaks.length} paks
            </Button>
          )}
        </div>
        <div className="form-grid">
          <PathField label="WolfcamQL executable" kind="file" value={settings.wolfcamExe} onChange={(v) => set({ wolfcamExe: v })} suggestions={detected?.wolfcamExe} placeholder="wolfcamql.exe" hint="Wolfcam Wrapper starts your existing WolfcamQL; it does not include or change it." />
          <PathField label="Quake Live folder" kind="folder" value={settings.qlPath} onChange={(v) => set({ qlPath: v })} suggestions={detected?.quakeLive} placeholder="…/steamapps/common/Quake Live" hint="Only used to copy the game's pak files into WolfcamQL (Sync paks)." />
          <PathField label="WolfcamQL home folder" kind="folder" value={settings.wolfcamHome} onChange={(v) => set({ wolfcamHome: v })} placeholder={detected?.wolfcamHome || "default"} hint="Where WolfcamQL keeps configs, videos and cameras. Leave empty for the default." />
        </div>
      </section>

      <section className="card">
        <h3>Demo folders</h3>
        <ul className="dir-list">
          {settings.demoDirs.length === 0 && <li className="muted">No folders yet.</li>}
          {settings.demoDirs.map((d) => (
            <li key={d}>
              <span>{d}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${d}`} onClick={() => { set({ demoDirs: settings.demoDirs.filter((x) => x !== d) }, false); void rescan(); }}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
        <div className="btn-row">
          <Button onClick={() => void addDir()}><FolderPlus size={14} /> Add folder</Button>
          <Button onClick={() => void rescan(true)} title="Read every demo again, ignoring the cache">Rebuild index</Button>
          {(detected?.demoDirs ?? []).filter((d) => !settings.demoDirs.includes(d)).map((d) => (
            <button type="button" className="link" key={d} onClick={() => { set({ demoDirs: [...settings.demoDirs, d] }, false); void rescan(); }}>
              Add {d}
            </button>
          ))}
        </div>
        <p className="muted small">Sub-folders are included. Supported: Quake Live .dm_73, .dm_90, .dm_91 and Quake 3 .dm_66 to .dm_71.</p>
      </section>

      <section className="card">
        <h3>Maps</h3>
        <p className="muted small">
          {installedMaps ? `WolfcamQL can load ${installedMaps.size} maps.` : "The maps WolfcamQL has could not be read yet."} Demos whose map is missing are marked in the Library.
          Quake Live's own maps arrive with <b>Sync paks</b>; maps from the Steam Workshop are downloaded by WolfcamQL itself when it can run SteamCMD.
        </p>
        <div className="form-grid">
          <PathField label="SteamCMD" kind="file" value={settings.steamcmdPath} onChange={(v) => set({ steamcmdPath: v })} placeholder="steamcmd (optional)" hint="Lets WolfcamQL download Steam Workshop content a demo needs. Free from Valve; leave empty to skip." />
        </div>
      </section>

      <section className="card">
        <h3>Encoding</h3>
        <div className="form-grid">
          <PathField label="ffmpeg" kind="file" value={settings.ffmpegPath} onChange={(v) => set({ ffmpegPath: v })} suggestions={detected?.ffmpeg ? [detected.ffmpeg] : []} placeholder="ffmpeg (from PATH)" hint={ffmpeg ? ffmpeg : "Not found. Needed only for encoding renders to MP4/MOV; get it from ffmpeg.org."} />
          <PathField label="Default output folder" kind="folder" value={settings.outputDir} onChange={(v) => set({ outputDir: v }, false)} placeholder="WolfcamQL videos folder" />
        </div>
      </section>

      <section className="card">
        <h3>Clips</h3>
        <div className="form-grid">
          <Field label="Seconds before the first kill">
            <input type="number" min={0} max={60} step={0.5} value={settings.clipLeadIn} onChange={(e) => set({ clipLeadIn: Math.max(0, Number(e.target.value) || 0) }, false)} />
          </Field>
          <Field label="Seconds after the last kill">
            <input type="number" min={0} max={60} step={0.5} value={settings.clipLeadOut} onChange={(e) => set({ clipLeadOut: Math.max(0, Number(e.target.value) || 0) }, false)} />
          </Field>
        </div>
        <p className="muted small">Applied when a clip is created from a kill or a highlight. Each clip can be adjusted afterwards.</p>
      </section>

      <section className="card">
        <h3>Help</h3>
        <div className="btn-row">
          <Button onClick={async () => (await backend()).openUrl("https://github.com/brugal/wolfcamql/blob/master/README-wolfcam.txt")}>WolfcamQL commands and cvars</Button>
          <Button onClick={async () => (await backend()).openUrl("https://github.com/GurnHub/wolfcam-wrapper#readme")}>Wolfcam Wrapper guide</Button>
        </div>
        <p className="muted small">The WolfcamQL reference lists every console command and setting; anything in it can be used in a profile's extra commands or typed into WolfcamQL's console.</p>
      </section>

      <section className="card">
        <h3>Advanced</h3>
        <div className="form-grid">
          <Field label="Extra WolfcamQL arguments" hint="Added to every launch, e.g. +set r_forceMap campgrounds" wide>
            <input value={settings.extraArgs} onChange={(e) => set({ extraArgs: e.target.value }, false)} spellCheck={false} />
          </Field>
        </div>
      </section>
    </div>
  );
}
