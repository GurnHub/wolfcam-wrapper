// Stand-in backend used when the UI runs in a plain browser (`npm run dev`
// without Tauri). It serves generated demos and simulates WolfcamQL and
// render progress so every screen can be exercised.

import type { Backend, DemoEntry, DemoInfo, Frag, FragFilter, Kill, RenderJob } from "./backend";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const MAPS = ["campgrounds", "bloodrun", "toxicity", "aerowalk", "sinister", "furiousheights", "lostworld", "cure", "hiddenfortress", "almostlost"];
const MODES = ["Duel", "CA", "TDM", "CTF", "FFA"];
const NAMES = ["rapha", "cypher", "evil", "k1llsen", "dahang", "tox", "cooller", "av3k", "strenx", "noctis", "base", "clawz", "raisy", "vengeur", "xron", "serious"];
const WEAPONS: [string, number][] = [["RL", 7], ["RG", 10], ["LG", 11], ["SG", 1], ["PG", 8], ["GL", 4], ["MG", 3], ["Gauntlet", 2]];

function makeDemo(i: number): { entry: DemoEntry; info: DemoInfo } {
  const r = rng(i * 7919 + 13);
  const mode = MODES[Math.floor(r() * MODES.length)];
  const map = MAPS[Math.floor(r() * MAPS.length)];
  const count = mode === "Duel" ? 2 : mode === "FFA" ? 8 : 8;
  const start = Math.floor(r() * NAMES.length);
  const players = Array.from({ length: count }, (_, k) => {
    const name = NAMES[(start + k) % NAMES.length];
    return { clientNum: k, name, rawName: `^${(k % 7) + 1}${name}`, team: mode === "Duel" || mode === "FFA" ? 0 : (k % 2) + 1, clan: "" };
  });
  const first = 100000 + Math.floor(r() * 5_000_000);
  const durationMs = (mode === "Duel" ? 600 : 900 + Math.floor(r() * 600)) * 1000;
  const gameStart = first + 12000;
  const kills: Kill[] = [];
  let t = gameStart + 5000;
  while (t < first + durationMs - 5000) {
    const burst = r() < 0.18 ? 2 + Math.floor(r() * 3) : 1;
    const killer = Math.floor(r() * count);
    for (let b = 0; b < burst && t < first + durationMs - 5000; b++) {
      let victim = Math.floor(r() * count);
      if (victim === killer) victim = (victim + 1) % count;
      const [weapon, modId] = WEAPONS[Math.floor(r() * WEAPONS.length)];
      kills.push({
        serverTime: t, clockMs: t - gameStart, warmup: false, killer, victim,
        killerName: players[killer].name, victimName: players[victim].name,
        killerTeam: players[killer].team, victimTeam: players[victim].team,
        modId, weapon, ownGoal: players[killer].team !== 0 && players[killer].team === players[victim].team,
      });
      t += 600 + Math.floor(r() * 2400);
    }
    t += 4000 + Math.floor(r() * (mode === "Duel" ? 40000 : 12000));
  }
  const timestamp = 1700000000 + i * 86400 * 3 + Math.floor(r() * 80000);
  const d = new Date(timestamp * 1000);
  const stamp = `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}_${String(d.getDate()).padStart(2, "0")}`;
  const fileName = mode === "Duel" ? `${players[0].name}(POV)-vs-${players[1].name}-${map}-${stamp}.dm_91` : `${mode.toLowerCase()}-${map}-${stamp}-${i}.dm_${i % 9 === 0 ? 73 : i % 4 === 0 ? 90 : 91}`;
  const dir = i % 3 === 0 ? "/home/demo/quakelive/demos/tournaments" : "/home/demo/quakelive/demos";
  const info: DemoInfo = {
    protocol: Number(fileName.split("dm_")[1]), map, gametype: MODES.indexOf(mode), gametypeName: mode, hostname: `${mode} server #${(i % 12) + 1}`,
    timestamp, povClient: 0, povName: players[0].name, players, firstServerTime: first, lastServerTime: first + durationMs, durationMs,
    gameStartTime: gameStart, gameEndTime: first + durationMs - 3000, hasWarmup: true, snapshots: Math.floor(durationMs / 25), kills,
    chats: [
      { serverTime: first + 3000, clockMs: 3000, team: false, text: `${players[0].name}: gl hf` },
      { serverTime: first + durationMs - 2000, clockMs: durationMs - 14000, team: false, text: `${players[count - 1].name}: gg` },
    ],
    warning: i % 17 === 5 ? "file is truncated" : null,
  };
  const entry: DemoEntry = {
    path: `${dir}/${fileName}`, fileName, dir, size: Math.floor(durationMs * (2.5 + r() * 2)), modified: timestamp + 900,
    protocol: info.protocol, map, gametypeName: mode, hostname: info.hostname, timestamp, povName: info.povName,
    players: players.map((p) => p.name), durationMs, killCount: kills.length, povKills: kills.filter((k) => k.killer === 0 && !k.ownGoal).length,
    error: null, warning: info.warning,
  };
  return { entry, info };
}

function findFrags(info: DemoInfo, entry: DemoEntry, f: FragFilter): Frag[] {
  const out: Frag[] = [];
  const by = new Map<number, Kill[]>();
  for (const k of info.kills) {
    if (k.ownGoal && !f.includeOwnGoals) continue;
    if (f.povOnly && k.killer !== info.povClient) continue;
    if (f.weapons.length && !f.weapons.some((w) => w.toLowerCase() === k.weapon.toLowerCase())) continue;
    if (f.players.length && !f.players.some((p) => k.killerName.toLowerCase().includes(p.toLowerCase()))) continue;
    if (f.victim && !k.victimName.toLowerCase().includes(f.victim.toLowerCase())) continue;
    by.set(k.killer, [...(by.get(k.killer) ?? []), k]);
  }
  for (const [client, kills] of by) {
    let seq: Kill[] = [];
    const flush = () => {
      if (seq.length >= Math.max(1, f.minKills)) {
        out.push({
          path: entry.path, fileName: entry.fileName, map: entry.map, gametypeName: entry.gametypeName, killer: seq[0].killerName, killerClient: client,
          startTime: seq[0].serverTime, endTime: seq[seq.length - 1].serverTime, clockMs: seq[0].clockMs, warmup: false, kills: seq,
        });
      }
      seq = [];
    };
    for (const k of kills) {
      if (seq.length && k.serverTime - seq[seq.length - 1].serverTime > f.windowMs) flush();
      seq.push(k);
    }
    flush();
  }
  return out;
}

export function createMockBackend(): Backend {
  const all = Array.from({ length: 140 }, (_, i) => makeDemo(i + 1));
  const byPath = new Map(all.map((d) => [d.entry.path, d]));
  const listeners = new Map<string, Set<(p: never) => void>>();
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload as never));
  const stores = new Map<string, unknown>();
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem("wolfdeck-mock") ?? "{}"))) stores.set(k, v);
  } catch {
    /* storage unavailable: start empty */
  }
  let cancelled = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function render(jobs: RenderJob[]) {
    for (const j of jobs) {
      for (const status of ["capturing", "encoding"] as const) {
        if (status === "encoding" && !j.encode) continue;
        for (let p = 0; p <= 10; p++) {
          if (cancelled) break;
          emit("render-update", { id: j.id, status, progress: p / 10, message: status === "capturing" ? "Recording" : "Encoding" });
          await sleep(180);
        }
      }
      emit("render-update", cancelled
        ? { id: j.id, status: "cancelled", progress: 0, message: "Cancelled" }
        : { id: j.id, status: "done", progress: 1, message: "Done", outputs: [`/home/demo/Videos/${j.name}.${j.encode?.extension || "avi"}`] });
    }
    emit("render-finished", { cancelled });
  }

  const handlers: Record<string, (a: Record<string, never>) => unknown> = {
    store_load: (a) => stores.get(a.name) ?? null,
    store_save: (a) => {
      stores.set(a.name, a.value);
      try {
        localStorage.setItem("wolfdeck-mock", JSON.stringify(Object.fromEntries(stores)));
      } catch {
        /* ignore */
      }
    },
    detect_paths: () => ({
      wolfcamExe: ["/home/demo/wolfcamql/wolfcamql.x86_64"], wolfcamHome: "/home/demo/.wolfcamql",
      quakeLive: ["/home/demo/.steam/steam/steamapps/common/Quake Live"], demoDirs: ["/home/demo/quakelive/demos"], ffmpeg: "/usr/bin/ffmpeg",
    }),
    check_install: (a) => ({
      exeOk: !!a.exe, baseDir: "/home/demo/wolfcamql", home: a.home || "/home/demo/.wolfcamql", gameDirOk: true,
      paks: ["pak00.pk3", "bin.pk3"], hasCorePak: true, missingPaks: [], qlOk: !!a.qlPath, problems: a.exe ? [] : ["WolfcamQL executable not found. Set its location in Settings."],
    }),
    sync_paks: () => [],
    list_game_files: (a) =>
      (a.sub === "cameras" ? ["intro-flyby.cam10", "mid-orbit.cam10", "strafe-run.record"] : ["hud.menu", "min_hud.menu", "inspectreHUD.menu"]).map((name) => ({
        name, path: `/home/demo/.wolfcamql/wolfcam-ql/${a.sub}/${name}`, size: 2048, modified: 1700000000,
      })),
    read_text: () => "// sample file\n",
    write_game_file: (a) => `/home/demo/.wolfcamql/wolfcam-ql/${a.name}`,
    install_hud: (a) => `wolfdeck/hud-${String(a.menu).split(/[\\/]/).pop()!.replace(/\.menu$/i, "")}.cfg`,
    game_folder: (a) => [`/home/demo/.wolfcamql/wolfcam-ql/${a.sub}`, 13.2 * 1024 ** 3],
    disk_free: () => 13.2 * 1024 ** 3,
    read_binds: () => [["ENTER", "freecam"], ["PAUSE", "pause"], ["UPARROW", "fastforward 60"], ["DOWNARROW", "rewind 60"], ["v", "cg_draw2d 2; addcamerapoint"], ["o", "playcamera"], ["ESCAPE", "togglemenu"], ["`", "toggleconsole"], ["F8", "exec mymovie.cfg"]],
    scan_library: async () => {
      for (let i = 1; i <= 4; i++) {
        emit("library-progress", { done: i * 35, total: 140 });
        await sleep(60);
      }
      return all.map((d) => d.entry);
    },
    get_demo: (a) => {
      const d = byPath.get(a.path);
      if (!d) throw "demo not found";
      return d.info;
    },
    search_frags: (a) =>
      (a.paths as string[])
        .flatMap((p) => {
          const d = byPath.get(p);
          return d ? findFrags(d.info, d.entry, a.filter) : [];
        })
        .sort((x, y) => y.kills.length - x.kills.length),
    demo_trash: () => undefined,
    demo_rename: (a) => a.path,
    demo_move: (a) => (a.paths as string[]).length,
    launch: (a) => {
      const spec = a.spec as { demo: string };
      emit("wolfcam-state", { running: true, ready: false, pid: 4242, demo: spec.demo });
      setTimeout(() => {
        emit("wolfcam-state", { running: true, ready: true, pid: 4242, demo: spec.demo });
        emit("wolfcam-log", ["----- finished R_Init -----", "demo parse protocol 91", "WD_READY"]);
      }, 700);
      return 4242;
    },
    send_commands: (a) => {
      emit("wolfcam-log", (a.commands as string[]).map((c) => `]${c}`));
    },
    stop_wolfcam: () => emit("wolfcam-state", { running: false, exitCode: 0 }),
    wolfcam_running: () => false,
    start_render: (a) => {
      cancelled = false;
      void render(a.jobs);
    },
    cancel_render: () => {
      cancelled = true;
    },
    render_running: () => false,
    ffmpeg_version: () => "ffmpeg version 7.1 (mock)",
  };

  return {
    mock: true,
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}) {
      const h = handlers[cmd];
      if (!h) throw `mock backend: unknown command ${cmd}`;
      return (await h(args as Record<string, never>)) as T;
    },
    async listen(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler as (p: never) => void);
      return () => listeners.get(event)?.delete(handler as (p: never) => void);
    },
    pickFolder: async () => "/home/demo/picked-folder",
    pickFile: async () => "/home/demo/picked-file",
    reveal: async () => undefined,
    openPath: async () => undefined,
    openUrl: async (url) => void window.open(url, "_blank"),
    fileUrl: (p) => p,
  };
}
