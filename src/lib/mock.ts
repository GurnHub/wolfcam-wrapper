// Stand-in backend used when the UI runs in a plain browser (`npm run dev`
// without Tauri). It serves generated demos and simulates opening WolfcamQL and
// render progress so every screen can be exercised.

import type { Backend, Clutch, ClutchFilter, ClutchHit, DemoEntry, DemoInfo, Frag, FragFilter, GameFilter, GameStat, Kill, PlayerScore, Round, RenderJob } from "./backend";

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
  // Clan Arena: one-minute rounds; sometimes someone is left alone against the rest.
  const rounds: Round[] = [];
  const clutches: Clutch[] = [];
  if (mode === "CA") {
    for (let n = 1, rt = gameStart; rt + 60000 < first + durationMs; n++, rt += 60000) {
      const winner = r() < 0.5 ? 1 : 2;
      rounds.push({ number: n, startTime: rt, endTime: rt + 45000, winner });
      if (r() < 0.45) {
        const team = r() < 0.5 ? 1 : 2;
        const who = players.filter((p) => p.team === team)[Math.floor(r() * 4)];
        const t = rt + 20000 + Math.floor(r() * 20000);
        clutches.push({ round: n, serverTime: t, clockMs: t - gameStart, client: who.clientNum, name: who.name, team, enemies: 1 + Math.floor(r() * 4), won: team === winner, kills: team === winner ? 1 + Math.floor(r() * 3) : Math.floor(r() * 2), roundEnd: rt + 45000 });
      }
    }
  }
  const scores: PlayerScore[] = mode === "CA" || mode === "Duel"
    ? players.map((p) => {
      const k = kills.filter((x) => x.killer === p.clientNum && !x.ownGoal).length;
      const d = kills.filter((x) => x.victim === p.clientNum).length;
      return { client: p.clientNum, name: p.name, team: p.team, score: k * 4 + Math.floor(r() * 20), kills: k, deaths: d, accuracy: 25 + Math.floor(r() * 30), damageGiven: 1500 + Math.floor(r() * 5000), damageTaken: mode === "CA" ? 1500 + Math.floor(r() * 4000) : null };
    })
    : [];
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
    rounds, clutches, scores,
    teamScores: mode === "CA" ? [rounds.filter((x) => x.winner === 1).length, rounds.filter((x) => x.winner === 2).length] : null,
    warning: i % 17 === 5 ? "file is truncated" : null,
  };
  const entry: DemoEntry = {
    path: `${dir}/${fileName}`, fileName, dir, size: Math.floor(durationMs * (2.5 + r() * 2)), modified: timestamp + 900,
    protocol: info.protocol, map, gametypeName: mode, hostname: info.hostname, timestamp, povName: info.povName,
    players: players.map((p) => p.name), durationMs, killCount: kills.length, povKills: kills.filter((k) => k.killer === 0 && !k.ownGoal).length,
    roundCount: rounds.length, clutchCount: clutches.length,
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

const matches = (name: string, wanted: string[]) => !wanted.length || wanted.some((w) => name.toLowerCase().includes(w.toLowerCase()));

function findClutches(info: DemoInfo, entry: DemoEntry, f: ClutchFilter): ClutchHit[] {
  return info.clutches
    .filter((c) => c.enemies >= Math.max(1, f.minEnemies) && (!f.wonOnly || c.won) && (!f.povOnly || c.client === info.povClient) && matches(c.name, f.players))
    .map((c) => ({ ...c, path: entry.path, fileName: entry.fileName, map: entry.map, gametypeName: entry.gametypeName, timestamp: entry.timestamp }));
}

function gameStats(info: DemoInfo, entry: DemoEntry): GameStat[] {
  return info.players.map((p) => {
    const mine = info.kills.filter((k) => !k.warmup && (k.killer === p.clientNum || k.victim === p.clientNum));
    let kills = 0, deaths = 0, spree = 0, bestSpree = 0, multi = 0, bestMulti = 0, last = -1e9;
    for (const k of mine) {
      if (k.victim === p.clientNum) { deaths++; spree = 0; multi = 0; continue; }
      if (k.ownGoal) continue;
      kills++; spree++; multi = k.serverTime - last <= 3000 ? multi + 1 : 1; last = k.serverTime;
      bestSpree = Math.max(bestSpree, spree); bestMulti = Math.max(bestMulti, multi);
    }
    const sc = info.scores.find((x) => x.client === p.clientNum);
    const mineClutches = info.clutches.filter((c) => c.client === p.clientNum);
    const ts = info.teamScores;
    const result = ts && p.team > 0 ? Math.sign(p.team === 1 ? ts[0] - ts[1] : ts[1] - ts[0]) : 0;
    return {
      path: entry.path, fileName: entry.fileName, map: entry.map, gametypeName: entry.gametypeName, timestamp: entry.timestamp, durationMs: entry.durationMs,
      startTime: info.gameStartTime ?? info.firstServerTime, client: p.clientNum, name: p.name, team: p.team, pov: p.clientNum === info.povClient,
      kills, deaths, suicides: 0, bestSpree, bestMulti, clutches: mineClutches.length, clutchesWon: mineClutches.filter((c) => c.won).length,
      score: sc?.score ?? null, accuracy: sc?.accuracy ?? null, damageGiven: sc?.damageGiven ?? null, damageTaken: sc?.damageTaken ?? null, result,
    };
  });
}

export function createMockBackend(): Backend {
  const all = Array.from({ length: 140 }, (_, i) => makeDemo(i + 1));
  const byPath = new Map(all.map((d) => [d.entry.path, d]));
  const listeners = new Map<string, Set<(p: never) => void>>();
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload as never));
  const stores = new Map<string, unknown>();
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem("wolfcam-wrapper-mock") ?? "{}"))) stores.set(k, v);
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
        localStorage.setItem("wolfcam-wrapper-mock", JSON.stringify(Object.fromEntries(stores)));
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
    install_hud: (a) => `wolfcam-wrapper/hud-${String(a.menu).split(/[\\/]/).pop()!.replace(/\.menu$/i, "")}.cfg`,
    game_folder: (a) => [`/home/demo/.wolfcamql/wolfcam-ql/${a.sub}`, 13.2 * 1024 ** 3],
    disk_free: () => 13.2 * 1024 ** 3,
    installed_maps: () => MAPS.filter((m) => m !== "cure" && m !== "hiddenfortress"),
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
    search_clutches: (a) =>
      (a.paths as string[])
        .flatMap((p) => {
          const d = byPath.get(p);
          return d ? findClutches(d.info, d.entry, a.filter) : [];
        })
        .sort((x, y) => Number(y.won) - Number(x.won) || y.enemies - x.enemies || y.kills - x.kills),
    search_games: (a) => {
      const f = a.filter as GameFilter;
      return (a.paths as string[])
        .flatMap((p) => {
          const d = byPath.get(p);
          return d ? gameStats(d.info, d.entry) : [];
        })
        .filter((g) => g.kills >= f.minKills && (!f.povOnly || g.pov) && (!f.gametypes.length || f.gametypes.includes(g.gametypeName)) && matches(g.name, f.players))
        .sort((x, y) => y.kills - x.kills);
    },
    demo_trash: () => undefined,
    demo_rename: (a) => a.path,
    demo_move: (a) => (a.paths as string[]).length,
    launch: (a) => {
      const spec = a.spec as { demo: string };
      emit("wolfcam-state", { running: true, pid: 4242, demo: spec.demo });
      return 4242;
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
  };
}
