// Typed access to the Rust backend. When the page is opened in a plain
// browser (no Tauri runtime) a mock backend with sample data is used, which
// makes it possible to work on the UI without WolfcamQL.

export interface PlayerInfo {
  clientNum: number;
  name: string;
  rawName: string;
  team: number;
  clan: string;
}

export interface Kill {
  serverTime: number;
  clockMs: number;
  warmup: boolean;
  killer: number;
  victim: number;
  killerName: string;
  victimName: string;
  killerTeam: number;
  victimTeam: number;
  modId: number;
  weapon: string;
  ownGoal: boolean;
}

export interface Chat {
  serverTime: number;
  clockMs: number;
  team: boolean;
  text: string;
}

export interface Round {
  number: number;
  startTime: number;
  endTime: number;
  /** 1 red, 2 blue, 0 not known. */
  winner: number;
}

/** A player left as the last one alive on their team ("1vN"). */
export interface Clutch {
  round: number;
  serverTime: number;
  clockMs: number;
  client: number;
  name: string;
  team: number;
  enemies: number;
  won: boolean;
  kills: number;
  roundEnd: number;
}

export interface PlayerScore {
  client: number;
  name: string;
  team: number;
  score: number;
  kills: number;
  deaths: number;
  accuracy: number;
  damageGiven: number;
  damageTaken: number | null;
}

export interface DemoInfo {
  protocol: number;
  map: string;
  gametype: number;
  gametypeName: string;
  hostname: string;
  timestamp: number | null;
  povClient: number;
  povName: string;
  players: PlayerInfo[];
  firstServerTime: number;
  lastServerTime: number;
  durationMs: number;
  gameStartTime: number | null;
  gameEndTime: number | null;
  hasWarmup: boolean;
  snapshots: number;
  kills: Kill[];
  chats: Chat[];
  rounds: Round[];
  clutches: Clutch[];
  /** Last scoreboard the server sent (Clan Arena and Duel). */
  scores: PlayerScore[];
  teamScores: [number, number] | null;
  warning: string | null;
}

export interface DemoEntry {
  path: string;
  fileName: string;
  dir: string;
  size: number;
  modified: number;
  protocol: number;
  map: string;
  gametypeName: string;
  hostname: string;
  timestamp: number | null;
  povName: string;
  players: string[];
  durationMs: number;
  killCount: number;
  povKills: number;
  roundCount: number;
  clutchCount: number;
  error: string | null;
  warning: string | null;
}

export interface FragFilter {
  players: string[];
  povOnly: boolean;
  weapons: string[];
  victim: string;
  minKills: number;
  windowMs: number;
  includeWarmup: boolean;
  includeOwnGoals: boolean;
}

export interface Frag {
  path: string;
  fileName: string;
  map: string;
  gametypeName: string;
  killer: string;
  killerClient: number;
  startTime: number;
  endTime: number;
  clockMs: number;
  warmup: boolean;
  kills: Kill[];
}

export interface ClutchFilter {
  players: string[];
  povOnly: boolean;
  minEnemies: number;
  wonOnly: boolean;
}

export interface ClutchHit extends Clutch {
  path: string;
  fileName: string;
  map: string;
  gametypeName: string;
  timestamp: number | null;
}

export interface GameFilter {
  players: string[];
  povOnly: boolean;
  gametypes: string[];
  minKills: number;
}

/** One player's game in one demo. */
export interface GameStat {
  path: string;
  fileName: string;
  map: string;
  gametypeName: string;
  timestamp: number | null;
  durationMs: number;
  startTime: number;
  client: number;
  name: string;
  team: number;
  pov: boolean;
  kills: number;
  deaths: number;
  suicides: number;
  bestSpree: number;
  bestMulti: number;
  clutches: number;
  clutchesWon: number;
  score: number | null;
  accuracy: number | null;
  damageGiven: number | null;
  damageTaken: number | null;
  /** 1 won, -1 lost, 0 not known or a draw. */
  result: number;
}

export interface Detected {
  wolfcamExe: string[];
  wolfcamHome: string;
  quakeLive: string[];
  demoDirs: string[];
  ffmpeg: string | null;
}

export interface InstallStatus {
  exeOk: boolean;
  baseDir: string;
  home: string;
  gameDirOk: boolean;
  paks: string[];
  hasCorePak: boolean;
  missingPaks: string[];
  qlOk: boolean;
  problems: string[];
}

export interface GameFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export interface LaunchSpec {
  exe: string;
  home: string;
  cvars: [string, string][];
  demo: string | null;
  config: string;
  extraArgs: string[];
}

export interface EncodeSpec {
  ffmpeg: string;
  args: string[];
  extension: string;
  outputDir: string;
  deleteSource: boolean;
}

export interface RenderJob {
  id: string;
  demo: string;
  name: string;
  startTime: number;
  endTime: number;
  pov: number | null;
  preRollMs: number;
  cvars: [string, string][];
  config: string;
  videoArgs: string;
  encode: EncodeSpec | null;
  /** Game speed while recording; 0.5 is half-speed slow motion. */
  speed: number;
  /** Encode while recording through WolfcamQL's ffmpeg pipe (no AVI on disk). */
  pipe: EncodeSpec | null;
}

export interface RenderUpdate {
  id: string;
  status: "queued" | "capturing" | "encoding" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  outputs?: string[];
}

export interface WolfcamState {
  running: boolean;
  pid?: number;
  demo?: string | null;
  exitCode?: number | null;
  /** It closed soon after starting with an error, so the demo most likely did not load. */
  early?: boolean;
}

export interface Backend {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  pickFolder(title: string): Promise<string | null>;
  pickFile(title: string, extensions?: string[]): Promise<string | null>;
  reveal(path: string): Promise<void>;
  /** Opens a folder in the system file manager. */
  openPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  readonly mock: boolean;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let instance: Promise<Backend> | null = null;

async function create(): Promise<Backend> {
  if (!isTauri) {
    return (await import("./mock")).createMockBackend();
  }
  const core = await import("@tauri-apps/api/core");
  const event = await import("@tauri-apps/api/event");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const opener = await import("@tauri-apps/plugin-opener");
  return {
    mock: false,
    invoke: (cmd, args) => core.invoke(cmd, args),
    listen: async (name, handler) => event.listen(name, (e) => handler(e.payload as never)),
    pickFolder: async (title) => {
      const r = await dialog.open({ directory: true, title });
      return typeof r === "string" ? r : null;
    },
    pickFile: async (title, extensions) => {
      const r = await dialog.open({
        title,
        filters: extensions ? [{ name: "Files", extensions }] : undefined,
      });
      return typeof r === "string" ? r : null;
    },
    reveal: (path) => opener.revealItemInDir(path),
    openPath: (path) => core.invoke("open_folder", { path }),
    openUrl: (url) => opener.openUrl(url),
  };
}

export function backend(): Promise<Backend> {
  if (!instance) instance = create();
  return instance;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await backend()).invoke<T>(cmd, args);
}
