import { create } from "zustand";
import {
  backend, invoke,
  type ClutchHit, type DemoEntry, type DemoInfo, type Detected, type Frag, type GameStat, type InstallStatus, type LaunchSpec, type RenderJob, type RenderUpdate,
  type WolfcamState,
} from "./backend";
import { baseName, safeName, stripExt, uid } from "./format";
import { WRAPPER_DEFAULTS } from "./cvars";
import { bindCommands, normalizeBinds, WRAPPER_LAYOUT, type BindMap } from "./keys";
import {
  captureCvars, defaultCapturePresets, defaultEncodePresets, encodeArgs, parseCvarLines, videoArgs,
  type CapturePreset, type EncodePreset,
} from "./presets";

export type View = "library" | "highlights" | "clips" | "config" | "keys" | "settings";

export interface Settings {
  wolfcamExe: string;
  wolfcamHome: string;
  qlPath: string;
  demoDirs: string[];
  outputDir: string;
  ffmpegPath: string;
  extraArgs: string;
  /** Seconds of footage kept before the first and after the last kill of a new clip. */
  clipLeadIn: number;
  clipLeadOut: number;
  /** Seconds the engine plays before recording starts. */
  capturePreRoll: number;
  deleteSource: boolean;
  /** Encode while recording through WolfcamQL's ffmpeg pipe instead of writing an AVI first. */
  encodeLive: boolean;
  /** SteamCMD executable, used by WolfcamQL to download Steam Workshop maps a demo needs. */
  steamcmdPath: string;
  activeProfile: string;
  capturePreset: string;
  encodePreset: string;
  viewFullscreen: boolean;
  viewWidth: number;
  viewHeight: number;
  setupDone: boolean;
}

export interface Profile {
  id: string;
  name: string;
  values: Record<string, string>;
  extra: string;
}

export interface Clip {
  id: string;
  name: string;
  demo: string;
  map: string;
  startTime: number;
  endTime: number;
  pov: number | null;
  povName: string;
  label: string;
  /** Game speed while recording (slow motion below 1). Missing means real time. */
  speed?: number;
  /** Extra console commands for this clip, run after the demo has loaded. */
  commands?: string;
  render?: RenderUpdate;
}

export interface KeyState {
  /** When on, Wolfcam Wrapper replaces WolfcamQL's binds with `binds` each time it opens a demo. */
  enabled: boolean;
  binds: BindMap;
  /** WolfcamQL's own binds as they were when management was first switched on. */
  previous: BindMap | null;
}

export interface DemoMeta {
  favorite?: boolean;
  tags?: string[];
  notes?: string;
}

export interface Toast {
  id: string;
  kind: "info" | "error" | "ok";
  text: string;
}

const defaultSettings: Settings = {
  wolfcamExe: "", wolfcamHome: "", qlPath: "", demoDirs: [], outputDir: "", ffmpegPath: "", extraArgs: "",
  clipLeadIn: 5, clipLeadOut: 3, capturePreRoll: 3, deleteSource: false, encodeLive: false, steamcmdPath: "",
  activeProfile: "viewing", capturePreset: "hq1080", encodePreset: "h264",
  viewFullscreen: false, viewWidth: 1600, viewHeight: 900, setupDone: false,
};

/** The profiles Wolfcam Wrapper ships with; "Restore defaults" puts these back. */
export const defaultProfiles: Profile[] = [
  { id: "viewing", name: "Viewing", values: {}, extra: "" },
  {
    id: "movie", name: "Movie (clean)", extra: "",
    values: { cg_draw2D: "0", cg_drawGun: "1", cg_drawFPS: "0", cg_drawSpeed: "0", cg_lagometer: "0", r_picmip: "0", cg_gibs: "15", cg_marks: "1" },
  },
  {
    id: "movie-hud", name: "Movie (with HUD)", extra: "",
    values: { cg_draw2D: "1", cg_drawFPS: "0", cg_drawSpeed: "0", cg_lagometer: "0", cg_drawAttacker: "0", r_picmip: "0" },
  },
];

export type HighlightTab = "frags" | "clutches" | "games";
export type Scope = "all" | "selected";

/** The Frag finder's form. Highlight forms are kept in the store (and saved) so leaving the view keeps them. */
export interface FragForm {
  scope: Scope;
  players: string;
  victim: string;
  weapons: string[];
  minKills: number;
  windowSec: number;
  povOnly: boolean;
  warmup: boolean;
}

export const defaultFragForm: FragForm = {
  scope: "all", players: "", victim: "", weapons: [], minKills: 2, windowSec: 4, povOnly: false, warmup: false,
};

export interface FragFinder {
  form: FragForm;
  /** Results of the last search; null before the first one. Kept for the session only. */
  results: Frag[] | null;
  /** Indexes into results. */
  picked: number[];
  /** Scroll position of the result list, restored when the view is shown again. */
  scrollTop: number;
}

/** Last-man-alive search ("clutches"). */
export interface ClutchForm {
  scope: Scope;
  players: string;
  povOnly: boolean;
  minEnemies: number;
  wonOnly: boolean;
}

export const defaultClutchForm: ClutchForm = { scope: "all", players: "", povOnly: false, minEnemies: 2, wonOnly: false };

export interface ClutchFinder {
  form: ClutchForm;
  results: ClutchHit[] | null;
  scrollTop: number;
}

export type GameSortKey = "kills" | "deaths" | "kd" | "damageGiven" | "accuracy" | "score" | "bestSpree" | "bestMulti" | "clutchesWon" | "timestamp";

/** Per-player game statistics ("top games"). */
export interface GameForm {
  scope: Scope;
  players: string;
  povOnly: boolean;
  gametypes: string[];
  minKills: number;
  sort: GameSortKey;
}

export const defaultGameForm: GameForm = { scope: "all", players: "", povOnly: false, gametypes: [], minKills: 0, sort: "kills" };

export interface GameFinder {
  form: GameForm;
  results: GameStat[] | null;
  scrollTop: number;
}

interface State {
  ready: boolean;
  view: View;
  settings: Settings;
  profiles: Profile[];
  clips: Clip[];
  capturePresets: CapturePreset[];
  encodePresets: EncodePreset[];
  meta: Record<string, DemoMeta>;
  keys: KeyState;
  highlightTab: HighlightTab;
  frags: FragFinder;
  clutches: ClutchFinder;
  games: GameFinder;

  detected: Detected | null;
  install: InstallStatus | null;
  /** Maps WolfcamQL can load (lower case); null until read. */
  installedMaps: Set<string> | null;
  ffmpegVersion: string | null;

  demos: DemoEntry[];
  scanning: { done: number; total: number } | null;
  selected: string[];
  demoInfo: Record<string, DemoInfo>;

  wolfcam: WolfcamState;
  rendering: boolean;
  toasts: Toast[];
  mock: boolean;

  init(): Promise<void>;
  setView(v: View): void;
  setHighlightTab(tab: HighlightTab): void;
  /** Update a highlight search; a form change is saved. */
  setFrags(patch: Partial<Omit<FragFinder, "form">> & { form?: Partial<FragForm> }): void;
  setClutches(patch: Partial<Omit<ClutchFinder, "form">> & { form?: Partial<ClutchForm> }): void;
  setGames(patch: Partial<Omit<GameFinder, "form">> & { form?: Partial<GameForm> }): void;
  toast(kind: Toast["kind"], text: string): void;
  dismissToast(id: string): void;
  updateSettings(patch: Partial<Settings>): void;
  refreshInstall(): Promise<void>;
  rescan(force?: boolean): Promise<void>;
  loadDemoInfo(path: string): Promise<DemoInfo | null>;
  setSelected(paths: string[]): void;
  setMeta(path: string, patch: DemoMeta): void;

  /** Opens a demo in WolfcamQL, optionally at a server time and following a player. Wolfcam Wrapper does not control it after that. */
  play(path: string, opts?: { startTime?: number; pov?: number | null }): Promise<void>;
  restoreDefaultProfiles(): void;
  /** Closes the WolfcamQL that Wolfcam Wrapper opened. */
  stop(): Promise<void>;

  addClip(c: Omit<Clip, "id">): void;
  updateClip(id: string, patch: Partial<Clip>): void;
  removeClips(ids: string[]): void;
  saveProfiles(profiles: Profile[]): void;
  savePresets(capture: CapturePreset[], encode: EncodePreset[]): void;
  setKeysEnabled(enabled: boolean): Promise<void>;
  /** Replaces the key map; it is applied the next time a demo is opened. */
  setBinds(binds: BindMap): void;
  /** Reads the binds WolfcamQL has saved in its own config. */
  readEngineBinds(): Promise<BindMap | null>;
  startRender(ids: string[]): Promise<void>;
  cancelRender(): Promise<void>;
}

let initStarted = false;
let installCheck = 0;
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function persist(name: string, value: unknown) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    invoke("store_save", { name, value }).catch((e) => console.error("save failed", name, e));
  }, 250);
}

async function load<T>(name: string, fallback: T): Promise<T> {
  try {
    const v = await invoke<T | null>("store_load", { name });
    return v ?? fallback;
  } catch (e) {
    console.error("load failed", name, e);
    return fallback;
  }
}

/** Settings that apply to every WolfcamQL start, demo or render. */
function baseCvars(s: Settings): [string, string][] {
  const c: [string, string][] = [];
  if (s.steamcmdPath.trim()) c.push(["fs_steamcmd", s.steamcmdPath.trim()], ["cl_downloadWorkshops", "1"]);
  return c;
}

function splitArgs(s: string): string[] {
  return s.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"(.*)"$/, "$1")) ?? [];
}

/** A profile's cvar values, plus the settings Wolfcam Wrapper always sends when the profile leaves them unset. */
function profileValues(p: Profile | undefined): Record<string, string> {
  return { ...WRAPPER_DEFAULTS, ...(p?.values ?? {}) };
}

/**
 * A profile's settings are applied before the demo loads, so the game module
 * starts with them (the HUD file and player models are only read then). Its
 * extra commands run once the demo has loaded.
 */
export function profileParts(p: Profile | undefined): { cvars: [string, string][]; config: string } {
  const cvars: [string, string][] = [];
  for (const [k, v] of Object.entries(profileValues(p))) {
    if (k === "cg_hudFiles" && !v) continue; // custom HUD selected but no file picked yet
    cvars.push([k, v.replace(/"/g, "")]);
  }
  return { cvars, config: p?.extra.trim() ? p.extra.trim() + "\n" : "" };
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  view: "library",
  settings: defaultSettings,
  profiles: defaultProfiles,
  clips: [],
  capturePresets: defaultCapturePresets,
  encodePresets: defaultEncodePresets,
  meta: {},
  keys: { enabled: false, binds: { ...WRAPPER_LAYOUT }, previous: null },
  highlightTab: "frags",
  frags: { form: defaultFragForm, results: null, picked: [], scrollTop: 0 },
  clutches: { form: defaultClutchForm, results: null, scrollTop: 0 },
  games: { form: defaultGameForm, results: null, scrollTop: 0 },
  detected: null,
  install: null,
  installedMaps: null,
  ffmpegVersion: null,
  demos: [],
  scanning: null,
  selected: [],
  demoInfo: {},
  wolfcam: { running: false },
  rendering: false,
  toasts: [],
  mock: false,

  async init() {
    if (initStarted) return; // React strict mode runs effects twice in development
    initStarted = true;
    const b = await backend();
    const [settings, profiles, clips, presets, meta, keys, fragForm, clutchForm, gameForm] = await Promise.all([
      load<Partial<Settings>>("settings", {}),
      load<Profile[]>("profiles", defaultProfiles),
      load<Clip[]>("clips", []),
      load<{ capture: CapturePreset[]; encode: EncodePreset[] }>("presets", { capture: defaultCapturePresets, encode: defaultEncodePresets }),
      load<Record<string, DemoMeta>>("meta", {}),
      load<Partial<KeyState>>("keys", {}),
      load<Partial<FragForm>>("frags", {}),
      load<Partial<ClutchForm>>("clutches", {}),
      load<Partial<GameForm>>("games", {}),
    ]);
    const s: Settings = { ...defaultSettings, ...settings };
    const detected = await invoke<Detected>("detect_paths").catch(() => null);
    if (detected && !s.setupDone) {
      // First start: adopt whatever could be found; the Settings view shows it for review.
      s.wolfcamExe ||= detected.wolfcamExe[0] ?? "";
      s.qlPath ||= detected.quakeLive[0] ?? "";
      if (s.demoDirs.length === 0) s.demoDirs = detected.demoDirs;
      s.ffmpegPath ||= detected.ffmpeg ?? "";
    }
    set({
      settings: s, profiles, detected, meta, mock: b.mock,
      keys: { enabled: !!keys.enabled, binds: keys.binds ?? { ...WRAPPER_LAYOUT }, previous: keys.previous ?? null },
      // A render that was interrupted by closing the app is not running any more.
      clips: clips.map((c) => (c.render && c.render.status !== "done" ? { ...c, render: undefined } : c)),
      capturePresets: presets.capture, encodePresets: presets.encode,
      frags: { ...get().frags, form: { ...defaultFragForm, ...fragForm } },
      clutches: { ...get().clutches, form: { ...defaultClutchForm, ...clutchForm } },
      games: { ...get().games, form: { ...defaultGameForm, ...gameForm } },
      view: s.wolfcamExe ? "library" : "settings",
    });

    await b.listen<{ done: number; total: number }>("library-progress", (p) => set({ scanning: p }));
    await b.listen<WolfcamState>("wolfcam-state", (st) => {
      set({ wolfcam: st.running ? st : { running: false } });
      if (!st.running && st.early) {
        get().toast("error", "WolfcamQL closed soon after starting, so the demo most likely did not load. Check its location and pak files in Settings; its last console lines are in wolfcam-ql/qconsole.log.");
      }
    });
    await b.listen<RenderUpdate>("render-update", (u) => {
      set({ clips: get().clips.map((c) => (c.id === u.id ? { ...c, render: u } : c)) });
      if (u.status === "done" || u.status === "failed") persist("clips", get().clips);
    });
    await b.listen("render-finished", () => {
      set({ rendering: false });
      const failed = get().clips.filter((c) => c.render?.status === "failed").length;
      get().toast(failed ? "error" : "ok", failed ? `Render finished, ${failed} clip(s) failed` : "Render finished");
    });

    set({ ready: true });
    await get().refreshInstall();
    if (s.demoDirs.length) void get().rescan();
  },

  setView: (view) => set({ view }),
  setHighlightTab: (highlightTab) => set({ highlightTab }),
  setFrags(patch) {
    const cur = get().frags;
    const frags = { ...cur, ...patch, form: patch.form ? { ...cur.form, ...patch.form } : cur.form };
    set({ frags });
    if (patch.form) persist("frags", frags.form);
  },
  setClutches(patch) {
    const cur = get().clutches;
    const clutches = { ...cur, ...patch, form: patch.form ? { ...cur.form, ...patch.form } : cur.form };
    set({ clutches });
    if (patch.form) persist("clutches", clutches.form);
  },
  setGames(patch) {
    const cur = get().games;
    const games = { ...cur, ...patch, form: patch.form ? { ...cur.form, ...patch.form } : cur.form };
    set({ games });
    if (patch.form) persist("games", games.form);
  },

  toast(kind, text) {
    const id = uid();
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    persist("settings", settings);
  },

  async refreshInstall() {
    // Only the newest check may write its result; an older one can finish later.
    const run = ++installCheck;
    const s = get().settings;
    const install = await invoke<InstallStatus>("check_install", { exe: s.wolfcamExe, home: s.wolfcamHome, qlPath: s.qlPath }).catch(() => null);
    const ffmpegVersion = await invoke<string>("ffmpeg_version", { path: s.ffmpegPath }).catch(() => null);
    if (run !== installCheck) return;
    set({ install, ffmpegVersion });
    const maps = await invoke<string[]>("installed_maps", { exe: s.wolfcamExe, home: s.wolfcamHome, qlPath: s.qlPath }).catch(() => null);
    if (run !== installCheck) return;
    // An empty list means the paks could not be read at all; do not flag every demo then.
    set({ installedMaps: maps && maps.length ? new Set(maps) : null });
  },

  async rescan(force = false) {
    if (get().scanning) return;
    set({ scanning: { done: 0, total: 0 } });
    try {
      const demos = await invoke<DemoEntry[]>("scan_library", { dirs: get().settings.demoDirs, force });
      const known = new Set(demos.map((d) => d.path));
      set({ demos, selected: get().selected.filter((p) => known.has(p)), demoInfo: force ? {} : get().demoInfo });
    } catch (e) {
      get().toast("error", `Scan failed: ${e}`);
    } finally {
      set({ scanning: null });
    }
  },

  async loadDemoInfo(path) {
    const cached = get().demoInfo[path];
    if (cached) return cached;
    try {
      const info = await invoke<DemoInfo>("get_demo", { path });
      set({ demoInfo: { ...get().demoInfo, [path]: info } });
      return info;
    } catch (e) {
      get().toast("error", `${baseName(path)}: ${e}`);
      return null;
    }
  },

  setSelected: (selected) => set({ selected }),

  setMeta(path, patch) {
    const meta = { ...get().meta, [path]: { ...get().meta[path], ...patch } };
    set({ meta });
    persist("meta", meta);
  },

  async play(path, opts = {}) {
    const { settings: s, profiles } = get();
    if (get().rendering) return get().toast("error", "A render is in progress.");
    if (!s.wolfcamExe) {
      get().toast("error", "Set the WolfcamQL location in Settings first.");
      return set({ view: "settings" });
    }
    const profile = profileParts(profiles.find((p) => p.id === s.activeProfile));
    let config = profile.config;
    if (get().keys.enabled) config += bindCommands(get().keys.binds).join("\n") + "\n";
    // WolfcamQL crashes on `follow` before the first frame is drawn; `at 1` defers it to that frame.
    if (opts.pov != null) config += `at 1 follow ${opts.pov}\n`;
    if (opts.startTime != null) config += `seekservertime ${Math.round(opts.startTime)}\n`;
    const spec: LaunchSpec = {
      exe: s.wolfcamExe,
      home: s.wolfcamHome,
      cvars: [
        ["r_fullscreen", s.viewFullscreen ? "1" : "0"],
        ["r_mode", "-1"],
        ["r_customwidth", String(s.viewWidth)],
        ["r_customheight", String(s.viewHeight)],
        ...profile.cvars,
        ...baseCvars(s),
      ],
      demo: path,
      config,
      extraArgs: splitArgs(s.extraArgs),
    };
    try {
      set({ wolfcam: { running: true, demo: path } });
      await invoke("launch", { spec });
      get().toast("info", `Opening ${baseName(path)} in WolfcamQL`);
    } catch (e) {
      set({ wolfcam: { running: false } });
      get().toast("error", String(e));
    }
  },

  restoreDefaultProfiles() {
    const builtIn = new Set(defaultProfiles.map((p) => p.id));
    const custom = get().profiles.filter((p) => !builtIn.has(p.id));
    get().saveProfiles([...defaultProfiles.map((p) => ({ ...p, values: { ...p.values } })), ...custom]);
  },

  async stop() {
    await invoke("stop_wolfcam").catch((e) => get().toast("error", String(e)));
    set({ wolfcam: { running: false } });
  },


  addClip(c) {
    const clips = [...get().clips, { ...c, id: uid() }];
    set({ clips });
    persist("clips", clips);
  },
  updateClip(id, patch) {
    const clips = get().clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
    set({ clips });
    persist("clips", clips);
  },
  removeClips(ids) {
    const clips = get().clips.filter((c) => !ids.includes(c.id));
    set({ clips });
    persist("clips", clips);
  },
  saveProfiles(profiles) {
    set({ profiles });
    persist("profiles", profiles);
  },
  savePresets(capture, encode) {
    set({ capturePresets: capture, encodePresets: encode });
    persist("presets", { capture, encode });
  },
  async readEngineBinds() {
    try {
      return normalizeBinds(await invoke<[string, string][]>("read_binds", { home: get().settings.wolfcamHome }));
    } catch (e) {
      get().toast("error", String(e));
      return null;
    }
  },

  async setKeysEnabled(enabled) {
    let { previous } = get().keys;
    if (enabled && !previous) {
      // Keep what WolfcamQL had, so it can be put back.
      previous = await invoke<[string, string][]>("read_binds", { home: get().settings.wolfcamHome }).then(normalizeBinds).catch(() => null);
    }
    const keys = { ...get().keys, enabled, previous };
    set({ keys });
    persist("keys", keys);
  },

  setBinds(binds) {
    const keys = { ...get().keys, binds };
    set({ keys });
    persist("keys", keys);
  },

  async startRender(ids) {
    const { settings: s, clips, capturePresets, encodePresets, profiles } = get();
    const capture = capturePresets.find((p) => p.id === s.capturePreset) ?? capturePresets[0];
    const enc = encodePresets.find((p) => p.id === s.encodePreset) ?? encodePresets[0];
    const profile = profileParts(profiles.find((p) => p.id === s.activeProfile));
    const chosen = clips.filter((c) => ids.includes(c.id));
    if (!chosen.length || !capture) return;
    if (!s.wolfcamExe) return get().toast("error", "Set the WolfcamQL location in Settings first.");
    const encodes = enc && enc.id !== "none" && capture.format.startsWith("avi");
    if (encodes && !get().ffmpegVersion) return get().toast("error", "ffmpeg was not found. Set its location in Settings or choose \"Keep the AVI\".");
    const live = encodes && s.encodeLive;
    const encodeSpec = encodes ? { ffmpeg: s.ffmpegPath, args: encodeArgs(enc, capture.fps), extension: enc.extension, outputDir: s.outputDir, deleteSource: s.deleteSource } : null;
    // Names are compared as the files will be named, so two clips never write the same file.
    const names = new Set<string>();
    const jobs: RenderJob[] = chosen.map((c) => {
      const base = safeName(c.name.trim() || stripExt(baseName(c.demo)));
      let name = base;
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base}_${n}`;
      names.add(name.toLowerCase());
      return {
        id: c.id, demo: c.demo, name, startTime: c.startTime, endTime: c.endTime, pov: c.pov,
        preRollMs: Math.round(s.capturePreRoll * 1000),
        // Capture settings win over the profile's renderer settings.
        cvars: [...profile.cvars.filter(([k]) => !/^r_(mode|customwidth|customheight|fullscreen)$/i.test(k)), ...captureCvars(capture), ...baseCvars(s)],
        config: profile.config + (c.commands?.trim() ? c.commands.trim() + "\n" : ""),
        videoArgs: videoArgs(capture),
        encode: live ? null : encodeSpec,
        pipe: live ? encodeSpec : null,
        speed: c.speed && c.speed > 0 ? c.speed : 1,
      };
    });
    set({
      rendering: true,
      clips: clips.map((c) => (ids.includes(c.id) ? { ...c, render: { id: c.id, status: "queued", progress: 0, message: "Queued" } } : c)),
    });
    try {
      await invoke("start_render", { jobs, base: { exe: s.wolfcamExe, home: s.wolfcamHome, extraArgs: splitArgs(s.extraArgs) } });
    } catch (e) {
      set({ rendering: false });
      get().toast("error", String(e));
    }
  },

  async cancelRender() {
    await invoke("cancel_render").catch(() => undefined);
  },
}));

export { parseCvarLines };
