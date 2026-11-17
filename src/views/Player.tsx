import {
  Camera, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CircleDot, Eye, FastForward, Film, FolderOpen, ImageDown, Music, Pause, Play, Plus,
  RefreshCw, Repeat, Rewind, RotateCcw, RotateCw, Scissors, SkipForward, Square, Trash2, Undo2, Video, Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Timeline } from "../components/Timeline";
import { Button, Empty, Toggle } from "../components/ui";
import { backend, invoke, type DemoInfo, type GameFile } from "../lib/backend";
import { clipFromRange } from "../lib/clips";
import { baseName, clock, stripExt, uid } from "../lib/format";
import { NAME_POSITIONS, namePositionValues } from "../lib/cvars";
import { useStore, type CameraSettings } from "../lib/store";

const SPEEDS = [0.05, 0.1, 0.2, 0.5, 1, 2, 4, 100];
const CAMERA_EXTS = [...Array.from({ length: 12 }, (_, i) => `cam${i + 1}`), "q3mmecam", "record"];
const CAMERA_TYPES: [CameraSettings["type"], string, string][] = [
  ["curve", "Curve", "Every three points define a quadratic curve: the first and last are the ends, the middle one sets how steep it is. More precise than a spline."],
  ["spline", "Spline", "A best-fitting curve through all points. Smooth, but it may not pass exactly through each point."],
  ["splineBezier", "Bezier spline", "The q3mme Bezier spline (WolfcamQL's default)."],
  ["splineCatmullRom", "Catmull-Rom spline", "The q3mme Catmull-Rom spline; passes through every point."],
  ["interp", "Straight lines", "The camera moves in a straight line from point to point."],
  ["jump", "Jump", "No movement between points; the camera cuts from one to the next."],
];

function label(info: DemoInfo, t: number): string {
  const gs = info.gameStartTime ?? info.firstServerTime;
  return t < gs ? "w" + clock(t - info.firstServerTime, true) : clock(t - gs, true);
}

function safeName(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9_-]+/g, "_");
}

async function openGameFolder(sub: string) {
  const s = useStore.getState();
  try {
    const [path] = await invoke<[string, number | null]>("game_folder", { home: s.settings.wolfcamHome, sub });
    await (await backend()).openPath(path);
  } catch (e) {
    s.toast("error", String(e));
  }
}

/** Live clock, updated outside React's render cycle. */
function Readout({ info }: { info: DemoInfo }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (ref.current) ref.current.textContent = label(info, useStore.getState().position());
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [info]);
  return <span className="readout" ref={ref} />;
}

/** Plays a commentary/music file in step with the demo position. */
function VoiceOverPlayer({ demo }: { demo: string }) {
  const vo = useStore((s) => s.voiceOvers[demo]);
  const audio = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (vo) void backend().then((b) => setSrc(b.fileUrl(vo.audio)));
  }, [vo]);
  useEffect(() => {
    if (!vo) return;
    const id = setInterval(() => {
      const a = audio.current;
      const st = useStore.getState();
      if (!a || !a.duration) return;
      const want = (st.position() - vo.startTime) / 1000;
      const { paused, timescale } = st.playhead;
      const audible = st.wolfcam.ready && !paused && want >= 0 && want < a.duration && timescale >= 0.25 && timescale <= 4;
      if (!audible) return a.pause();
      a.playbackRate = timescale;
      if (Math.abs(a.currentTime - want) > 0.25) a.currentTime = want;
      if (a.paused) void a.play().catch(() => undefined);
    }, 200);
    return () => clearInterval(id);
  }, [vo]);
  return vo && src ? <audio ref={audio} src={src} preload="auto" /> : null;
}

export function PlayerView() {
  const wolfcam = useStore((s) => s.wolfcam);
  const demo = useStore((s) => s.playingDemo);
  const info = useStore((s) => (s.playingDemo ? s.demoInfo[s.playingDemo] : undefined));
  const playhead = useStore((s) => s.playhead);
  const markIn = useStore((s) => s.markIn);
  const markOut = useStore((s) => s.markOut);
  const followed = useStore((s) => s.followed);
  const looping = useStore((s) => s.looping);
  const st = useStore.getState();
  const { cmd, seekBy, seekTo, setPaused, setTimescale, setMarks, position } = st;

  const [video, setVideo] = useState(false);
  const [cut, setCut] = useState(false);

  // Keyboard shortcuts while the Player view is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const s = useStore.getState();
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !s.wolfcam.ready || !s.playingDemo) return;
      if (e.key === " ") s.setPaused(!s.playhead.paused);
      else if (e.key === "ArrowLeft") s.seekBy(e.shiftKey ? -30 : -5);
      else if (e.key === "ArrowRight") s.seekBy(e.shiftKey ? 30 : 5);
      else if (e.key === "i") s.setMarks(s.position(), s.markOut);
      else if (e.key === "o") s.setMarks(s.markIn, s.position());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!wolfcam.running) {
    return (
      <Empty
        title="Nothing is playing"
        action={
          <div className="actions">
            <Button variant="primary" onClick={() => st.setView("library")}>Open the library</Button>
            <Button onClick={() => void st.play(null)} title="Start WolfcamQL without a demo, with the active profile applied">Open WolfcamQL</Button>
          </div>
        }
      >
        Start a demo from the library or the frag finder. This view then becomes the remote control for WolfcamQL: seeking, speed, points of view, camera tools and clip marking.
      </Empty>
    );
  }

  const ready = !!wolfcam.ready;
  const jump = (dir: 1 | -1) => {
    if (!info) return;
    const now = position();
    const mine = info.kills.filter((k) => followed == null || k.killer === followed);
    const next = dir === 1 ? mine.find((k) => k.serverTime - 3000 > now + 500) : [...mine].reverse().find((k) => k.serverTime - 3000 < now - 1500);
    if (next) seekTo(next.serverTime - 3000);
  };
  const marked = markIn != null && markOut != null && markOut > markIn;
  const addMarked = () => {
    if (!marked || !info || !demo) return;
    const who = info.players.find((p) => p.clientNum === followed);
    st.addClip(clipFromRange(demo, info.map, markIn, markOut, followed, who?.name ?? info.povName, `${label(info, markIn)} – ${label(info, markOut)}`));
    st.toast("ok", "Clip added");
    setMarks(null, null);
  };
  const stamp = () => Date.now().toString(36);

  return (
    <div className="player">
      {demo && <VoiceOverPlayer demo={demo} />}
      <header className="player-head">
        <div>
          <h2 title={demo ?? ""}>{demo ? stripExt(baseName(demo)) : "WolfcamQL"}</h2>
          <p className="muted">
            {info ? `${info.gametypeName} on ${info.map}` : demo ? "" : "Running without a demo"}
            {!ready && " · WolfcamQL is starting…"}
          </p>
        </div>
        {demo && (
          <>
            <Button onClick={() => st.reloadDemo()} disabled={!ready} title="Restart WolfcamQL with this demo at the current position, applying the active config profile">
              <RotateCw size={14} /> Reload demo
            </Button>
            <Button onClick={() => void cmd("servertime")} disabled={!ready} title="Ask WolfcamQL for its real position. Use after seeking with WolfcamQL's own keys.">
              <RefreshCw size={14} /> Sync position
            </Button>
          </>
        )}
        <Button variant="danger" onClick={() => void st.stop()}><Square size={13} /> Close WolfcamQL</Button>
      </header>

      {demo && (
        <section className={"transport" + (ready ? "" : " is-disabled")}>
          {info && <Timeline info={info} position={position} markIn={markIn} markOut={markOut} highlight={followed} onSeek={seekTo} onKill={(k) => seekTo(k.serverTime - 3000)} />}
          <div className="transport-row">
            <div className="btn-group">
              <Button onClick={() => jump(-1)} title="Previous kill"><ChevronsLeft size={15} /></Button>
              <Button onClick={() => seekBy(-30)} title="Back 30 s (Shift+Left)"><Rewind size={15} /> 30</Button>
              <Button onClick={() => seekBy(-5)} title="Back 5 s (Left)">5</Button>
              <Button variant="primary" onClick={() => setPaused(!playhead.paused)} title="Play / pause (Space)">
                {playhead.paused ? <Play size={15} /> : <Pause size={15} />}
              </Button>
              <Button onClick={() => seekBy(5)} title="Forward 5 s (Right)">5</Button>
              <Button onClick={() => seekBy(30)} title="Forward 30 s (Shift+Right)">30 <FastForward size={15} /></Button>
              <Button onClick={() => jump(1)} title="Next kill"><ChevronsRight size={15} /></Button>
            </div>
            {info && <Readout info={info} />}
            <div className="btn-group" role="group" aria-label="Playback speed">
              {SPEEDS.map((sp) => (
                <Button key={sp} small active={playhead.timescale === sp} onClick={() => setTimescale(sp)} title={sp === 1 ? "Real time" : sp === 100 ? "Fast scan" : undefined}>
                  {sp === 1 ? "Realtime" : `${sp}×`}
                </Button>
              ))}
            </div>
          </div>
          <div className="transport-row">
            <div className="btn-group">
              <Button small onClick={() => setMarks(position(), markOut)} title="Mark clip / loop start (I)">Mark in</Button>
              <Button small onClick={() => setMarks(markIn, position())} title="Mark clip / loop end (O)">Mark out</Button>
              <Button small variant="primary" disabled={!marked} onClick={addMarked}>
                <Scissors size={13} /> Add clip{marked ? ` (${clock(markOut - markIn, true)})` : ""}
              </Button>
            </div>
            <Button small active={looping} disabled={!marked && !looping} onClick={() => st.toggleLoop()} title="Play the marked range over and over">
              <Repeat size={13} /> {looping ? "Stop loop" : "Loop marks"}
            </Button>
            <span className="spacer" />
            <Button small onClick={() => void cmd("screenshotJPEG")} title="Save a JPG screenshot to WolfcamQL's screenshots folder"><ImageDown size={13} /> Screenshot</Button>
            <Button
              small
              variant={cut ? "danger" : "default"}
              title="Record a new, shorter demo from the one that is playing (saved to WolfcamQL's demos folder)"
              onClick={() => {
                void cmd(cut ? "stoprecord" : `record cut_${demo ? safeName(stripExt(baseName(demo))).slice(0, 40) : "demo"}_${stamp()}`);
                setCut(!cut);
              }}
            >
              {cut ? <Square size={12} /> : <Film size={13} />} {cut ? "Stop demo" : "Record demo"}
            </Button>
            <Button
              small
              variant={video ? "danger" : "default"}
              title="Record video of what is playing right now, with WolfcamQL's current video settings"
              onClick={() => {
                void cmd(video ? "stopvideo" : `video avi name live_${stamp()}`);
                setVideo(!video);
              }}
            >
              {video ? <Square size={12} /> : <CircleDot size={13} />} {video ? "Stop video" : "Record video"}
            </Button>
          </div>
        </section>
      )}

      <div className={"player-grid" + (ready ? "" : " is-disabled")}>
        {demo && <PovCard info={info} />}
        {demo && <CameraCard demo={demo} />}
        <ToolsCard demo={demo} info={info} />
      </div>
    </div>
  );
}

function PovCard({ info }: { info?: DemoInfo }) {
  const followed = useStore((s) => s.followed);
  const { cmd, follow } = useStore.getState();
  const [fragPre, setFragPre] = useState(5);
  const [ent, setEnt] = useState("");
  // Position of the watched player's name; -1 until the button has been used, then cycles (the last step hides it).
  const [namePos, setNamePos] = useState(-1);
  const cycleName = () => {
    const next = (namePos + 1) % (NAME_POSITIONS.length + 1);
    setNamePos(next);
    const values = namePositionValues(NAME_POSITIONS[next]?.id ?? null);
    void cmd(...Object.entries(values).map(([k, v]) => `set ${k} ${v}`));
  };
  const playing = useMemo(() => [...(info?.players ?? [])].filter((p) => p.team !== 3).sort((a, b) => a.team - b.team || a.name.localeCompare(b.name)), [info]);
  const entNum = /^\d+$/.test(ent.trim()) ? ent.trim() : null;
  return (
    <section className="card">
      <h3><Eye size={14} /> Point of view</h3>
      <div className="pov-list">
        <button type="button" className={followed == null ? "is-active" : ""} onClick={() => follow(null)}>Demo taker</button>
        {playing.map((p) => (
          <button type="button" key={`${p.clientNum}-${p.name}`} className={followed === p.clientNum ? "is-active" : ""} onClick={() => follow(p.clientNum)}>
            <span className={`team team-${p.team}`} />
            {p.name}
          </button>
        ))}
      </div>
      <div className="btn-row">
        <Button small onClick={() => void cmd("follow killer")}>Killer</Button>
        <Button small onClick={() => void cmd("follow victim")}>Victim</Button>
        <Button small onClick={() => void cmd("freecam")}>Free camera</Button>
        <Button small onClick={() => void cmd("toggle cg_thirdPerson")}>Third person</Button>
      </div>
      <h4>Show / hide</h4>
      <div className="btn-row">
        <Button small onClick={() => void cmd("toggle cg_draw2D")} title="Toggle all 2D elements">HUD</Button>
        <Button small onClick={() => void cmd("toggle cg_drawGun")}>Weapon</Button>
        <Button small onClick={() => void cmd("toggle cg_drawCrosshair 0 5")}>Crosshair</Button>
        <Button small onClick={() => void cmd("toggle cg_wh")}>Wallhack</Button>
        <Button small onClick={() => void cmd("toggle cg_drawEntNumbers")} title="Label rockets, grenades, items and players with their entity numbers">Entity numbers</Button>
        <Button small onClick={cycleName} title="Move the watched player's name: each click goes to the next position, the last one hides it">
          Name: {namePos < 0 ? "move" : NAME_POSITIONS[namePos]?.label.toLowerCase() ?? "hidden"}
        </Button>
      </div>
      <h4>Follow an entity</h4>
      <div className="btn-row">
        <input className="short" value={ent} onChange={(e) => setEnt(e.target.value)} placeholder="Number" inputMode="numeric" aria-label="Entity number" />
        <Button small disabled={!entNum} onClick={() => void cmd(`view ${entNum}`)} title="Keep the camera pointed at this entity (use with the free camera)">Look at</Button>
        <Button small disabled={!entNum} onClick={() => void cmd(`chase ${entNum}`)} title="Chase camera behind this entity, e.g. a rocket">Chase</Button>
        <Button small onClick={() => void cmd("view -1", "chase -1")}>Release</Button>
      </div>
      <p className="muted small">Turn on entity numbers to find the number of a rocket, grenade or player.</p>
      <h4>Frag forward</h4>
      <div className="btn-row">
        <label className="inline">
          Lead-in
          <input type="number" min={1} max={30} value={fragPre} onChange={(e) => setFragPre(Number(e.target.value) || 5)} /> s
        </label>
        <Button small onClick={() => void cmd(`fragforward ${fragPre}`)} title="Skip from kill to kill of the followed player"><SkipForward size={13} /> Start</Button>
        <Button small onClick={() => void cmd("fragforward stop")}>Stop</Button>
      </div>
    </section>
  );
}

function CameraCard({ demo }: { demo: string }) {
  const camera = useStore((s) => s.settings.camera);
  const { cmd, setCamera } = useStore.getState();
  const [cameras, setCameras] = useState<GameFile[]>([]);
  const [name, setName] = useState("");
  const base = safeName(name);

  const refresh = () => {
    const s = useStore.getState().settings;
    void invoke<GameFile[]>("list_game_files", { exe: s.wolfcamExe, home: s.wolfcamHome, sub: "cameras", exts: CAMERA_EXTS }).then(setCameras).catch(() => setCameras([]));
  };
  useEffect(refresh, [demo]);
  const type = CAMERA_TYPES.find((t) => t[0] === camera.type) ?? CAMERA_TYPES[0];

  return (
    <section className="card">
      <h3><Camera size={14} /> Camera</h3>
      <p className="muted small">Fly with the free camera in WolfcamQL and add a point at each key position and time. WolfcamQL's own keys are shown in brackets.</p>
      <div className="btn-row">
        <Button small onClick={() => void cmd("addcamerapoint")} title="Add a camera point here. At the time of an existing point it updates that point instead. (V)"><Plus size={13} /> Add point</Button>
        <Button small onClick={() => void cmd("selectcamerapoint last", "deletecamerapoint")} title="Remove the newest camera point"><Undo2 size={13} /> Undo point</Button>
        <Button small onClick={() => confirm("Remove all camera points and start over?") && void cmd("clearcamerapoints")} title="Remove all camera points"><RotateCcw size={13} /> Start over</Button>
      </div>
      <div className="btn-row">
        <span className="muted small">Edit point</span>
        <div className="btn-group">
          <Button small onClick={() => void cmd("editcamerapoint previous")} title="Jump to the previous camera point to edit it ([)"><ChevronLeft size={13} /> Previous</Button>
          <Button small onClick={() => void cmd("editcamerapoint next")} title="Jump to the next camera point to edit it (])">Next <ChevronRight size={13} /></Button>
        </div>
        <Button small onClick={() => void cmd("deletecamerapoint")} title="Delete the camera point being edited"><Trash2 size={13} /></Button>
      </div>
      <p className="muted small">After jumping to a point, move the free camera and press Add point to store the new position.</p>
      <div className="btn-row">
        <Button small variant="primary" onClick={() => void cmd("playcamera")} title="Play the camera path from the first point (O)"><Play size={13} /> Play camera</Button>
        <Button small onClick={() => void cmd("stopcamera")}><Square size={12} /> Stop</Button>
      </div>

      <h4>Camera settings</h4>
      <div className="cam-settings">
        <label>
          <span>Path between new points</span>
          <select value={camera.type} onChange={(e) => setCamera({ type: e.target.value as CameraSettings["type"] })}>
            {CAMERA_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <p className="muted small">{type[2]}</p>
        <div className="btn-row">
          <Button small onClick={() => void cmd("selectcamerapoint all", `ecam type ${camera.type}`)} title="Change the path type of the points that already exist">Apply to all points</Button>
        </div>
        <div className="btn-row">
          <label className="inline">Free camera speed <input type="number" min={25} max={5000} step={25} value={camera.freecamSpeed} onChange={(e) => setCamera({ freecamSpeed: Math.max(1, Number(e.target.value) || 400) })} /></label>
          <label className="inline">Sensitivity <input type="number" min={0.01} max={2} step={0.01} value={camera.sensitivity} onChange={(e) => setCamera({ sensitivity: Math.max(0.001, Number(e.target.value) || 0.1) })} /></label>
        </div>
        <div className="btn-row">
          <Toggle checked={camera.pointInfo} onChange={(v) => setCamera({ pointInfo: v })} label="Camera point info" />
          <Toggle checked={camera.drawPath} onChange={(v) => setCamera({ drawPath: v })} label="Draw camera path" />
        </div>
      </div>

      <h4>Save and load</h4>
      <div className="btn-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <Button small disabled={!base} onClick={() => void cmd(`savecamera ${base}`).then(() => setTimeout(refresh, 600))}>Save camera</Button>
        <Button small disabled={!base} onClick={() => void cmd(`recordpath ${base}`).then(() => setTimeout(refresh, 600))} title="Record your own free-camera movement as a path; press again to stop"><Video size={13} /> Record path</Button>
      </div>
      <div className="file-list">
        {cameras.length === 0 && <span className="muted small">No saved cameras or paths yet.</span>}
        {cameras.map((c) => {
          const ext = c.name.split(".").pop()!.toLowerCase();
          const stem = stripExt(c.name);
          const isPath = ext === "record";
          const load = ext === "q3mmecam" ? `loadq3mmecamera ${stem}` : isPath ? `playpath ${stem}` : `loadcamera ${stem}`;
          return (
            <button type="button" key={c.name} onClick={() => void cmd(load)} title={isPath ? "Play this recorded path" : "Load this camera"}>
              {isPath ? "▶ " : ""}{c.name}
            </button>
          );
        })}
      </div>
      <div className="btn-row">
        <Button small onClick={() => void cmd("stopplaypath")}>Stop path</Button>
        <Button small variant="ghost" onClick={() => void openGameFolder("cameras")}><FolderOpen size={13} /> Cameras folder</Button>
      </div>
    </section>
  );
}

function ToolsCard({ demo, info }: { demo: string | null; info?: DemoInfo }) {
  const quick = useStore((s) => s.quick);
  const vo = useStore((s) => (demo ? s.voiceOvers[demo] : undefined));
  const st = useStore.getState();
  const { cmd, position } = st;
  const [editQuick, setEditQuick] = useState(false);
  const [volume, setVolume] = useState(0.8);
  return (
    <section className="card">
      <h3><Wrench size={14} /> Tools</h3>
      <div className="btn-row">
        <Button small onClick={() => void cmd("toggle r_fullscreen")} title="Switch WolfcamQL between window and fullscreen">Fullscreen</Button>
        <Button small onClick={() => void cmd("vid_restart")} title="Restart WolfcamQL's video system; needed for some graphics settings">Vid restart</Button>
        <Button small onClick={() => void cmd("toggle in_nograb")} title="Stop or let WolfcamQL capture the mouse while its window is focused">Mouse capture</Button>
      </div>
      <div className="btn-row">
        <label className="inline grow">
          Volume
          <input
            type="range" min={0} max={1} step={0.05} value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            onMouseUp={() => void cmd(`set s_volume ${volume}`)}
            onKeyUp={() => void cmd(`set s_volume ${volume}`)}
          />
          <span className="num">{Math.round(volume * 100)}%</span>
        </label>
      </div>
      <div className="btn-row">
        <Button small variant="ghost" onClick={() => void openGameFolder("videos")}><FolderOpen size={13} /> Videos</Button>
        <Button small variant="ghost" onClick={() => void openGameFolder("screenshots")}><FolderOpen size={13} /> Screenshots</Button>
        <Button small variant="ghost" onClick={() => void openGameFolder("demos")}><FolderOpen size={13} /> Recorded demos</Button>
      </div>

      <h4>Quick commands <button type="button" className="link" onClick={() => setEditQuick(!editQuick)}>{editQuick ? "done" : "edit"}</button></h4>
      {editQuick ? (
        <div className="quick-edit">
          {quick.map((q) => (
            <div key={q.id}>
              <input value={q.label} placeholder="Label" onChange={(e) => st.saveQuick(quick.map((x) => (x.id === q.id ? { ...x, label: e.target.value } : x)))} />
              <input value={q.command} placeholder="Console command" onChange={(e) => st.saveQuick(quick.map((x) => (x.id === q.id ? { ...x, command: e.target.value } : x)))} />
              <button type="button" className="icon-btn" onClick={() => st.saveQuick(quick.filter((x) => x.id !== q.id))} aria-label="Remove"><Trash2 size={13} /></button>
            </div>
          ))}
          <Button small onClick={() => st.saveQuick([...quick, { id: uid(), label: "", command: "" }])}><Plus size={13} /> Add</Button>
        </div>
      ) : (
        <div className="btn-row">
          {quick.filter((q) => q.label && q.command).map((q) => <Button small key={q.id} onClick={() => void cmd(q.command)} title={q.command}>{q.label}</Button>)}
        </div>
      )}

      {demo && (
        <>
          <h4><Music size={13} /> Voice-over</h4>
          {vo ? (
            <div className="btn-row">
              <span className="muted small" title={vo.audio}>{baseName(vo.audio)} starts at {info ? label(info, vo.startTime) : ""}</span>
              <Button small onClick={() => st.setVoiceOver(demo, { ...vo, startTime: position() })} title="Make the audio start at the current demo position">Start here</Button>
              <Button small onClick={() => st.setVoiceOver(demo, null)}>Remove</Button>
            </div>
          ) : (
            <div className="btn-row">
              <Button
                small
                onClick={async () => {
                  const f = await (await backend()).pickFile("Choose an audio file", ["mp3", "ogg", "wav", "m4a", "flac", "opus"]);
                  if (f) st.setVoiceOver(demo, { audio: f, startTime: position() });
                }}
              >
                Attach audio…
              </Button>
              <span className="muted small">Commentary or music that plays in sync with this demo.</span>
            </div>
          )}
        </>
      )}
      <Console />
    </section>
  );
}

function Console() {
  const log = useStore((s) => s.log);
  const [text, setText] = useState("");
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log]);
  const send = () => {
    const c = text.trim();
    if (!c) return;
    history.current = [c, ...history.current.filter((h) => h !== c)].slice(0, 50);
    cursor.current = -1;
    setText("");
    void useStore.getState().cmd(c);
  };
  return (
    <div className="console">
      <h4>Console</h4>
      <div className="console-log" ref={box}>
        {log.slice(-300).map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <input
        value={text}
        placeholder="Type a WolfcamQL console command and press Enter"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
          else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            const h = history.current;
            cursor.current = Math.min(h.length - 1, Math.max(-1, cursor.current + (e.key === "ArrowUp" ? 1 : -1)));
            setText(cursor.current < 0 ? "" : h[cursor.current]);
            e.preventDefault();
          }
        }}
      />
    </div>
  );
}
