import {
  Camera, ChevronsLeft, ChevronsRight, CircleDot, Eye, FastForward, Music, Pause, Play, Plus, RefreshCw, Rewind, Scissors, SkipForward, Square, Trash2, Video,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Timeline } from "../components/Timeline";
import { Button, Empty } from "../components/ui";
import { backend, invoke, type DemoInfo, type GameFile } from "../lib/backend";
import { clipFromRange } from "../lib/clips";
import { baseName, clock, stripExt, uid } from "../lib/format";
import { useStore } from "../lib/store";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];
const CAMERA_EXTS = [...Array.from({ length: 12 }, (_, i) => `cam${i + 1}`), "q3mmecam", "record"];

function label(info: DemoInfo, t: number): string {
  const gs = info.gameStartTime ?? info.firstServerTime;
  return t < gs ? "w" + clock(t - info.firstServerTime, true) : clock(t - gs, true);
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
  const quick = useStore((s) => s.quick);
  const vo = useStore((s) => (s.playingDemo ? s.voiceOvers[s.playingDemo] : undefined));
  const st = useStore.getState();
  const { cmd, seekBy, seekTo, setPaused, setTimescale, follow, setMarks, position } = st;

  const [fragPre, setFragPre] = useState(5);
  const [cameras, setCameras] = useState<GameFile[]>([]);
  const [camName, setCamName] = useState("");
  const [recording, setRecording] = useState(false);
  const [editQuick, setEditQuick] = useState(false);

  const refreshCameras = () => {
    const s = useStore.getState().settings;
    void invoke<GameFile[]>("list_game_files", { exe: s.wolfcamExe, home: s.wolfcamHome, sub: "cameras", exts: CAMERA_EXTS }).then(setCameras).catch(() => setCameras([]));
  };
  useEffect(refreshCameras, [demo]);

  // Keyboard shortcuts while the Player view is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !useStore.getState().wolfcam.ready) return;
      const s = useStore.getState();
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

  const playing = useMemo(() => [...(info?.players ?? [])].filter((p) => p.team !== 3).sort((a, b) => a.team - b.team || a.name.localeCompare(b.name)), [info]);

  if (!wolfcam.running || !demo) {
    return (
      <Empty title="Nothing is playing" action={<Button variant="primary" onClick={() => st.setView("library")}>Open the library</Button>}>
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
  const addMarked = () => {
    if (markIn == null || markOut == null || markOut <= markIn || !info) return;
    const who = info.players.find((p) => p.clientNum === followed);
    st.addClip(clipFromRange(demo, info.map, markIn, markOut, followed, who?.name ?? info.povName, `${label(info, markIn)} – ${label(info, markOut)}`));
    st.toast("ok", "Clip added");
    setMarks(null, null);
  };
  const camBase = camName.trim().replace(/[^A-Za-z0-9_-]+/g, "_");

  return (
    <div className="player">
      <VoiceOverPlayer demo={demo} />
      <header className="player-head">
        <div>
          <h2 title={demo}>{stripExt(baseName(demo))}</h2>
          <p className="muted">{info ? `${info.gametypeName} on ${info.map}` : ""}{!ready && " · WolfcamQL is loading the demo…"}</p>
        </div>
        <Button onClick={() => void cmd("servertime")} disabled={!ready} title="Ask WolfcamQL for its real position. Use after seeking with WolfcamQL's own keys.">
          <RefreshCw size={14} /> Sync position
        </Button>
        <Button variant="danger" onClick={() => void st.stop()}><Square size={13} /> Quit WolfcamQL</Button>
      </header>

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
              <Button key={sp} small active={playhead.timescale === sp} onClick={() => setTimescale(sp)}>{sp}×</Button>
            ))}
          </div>
        </div>
        <div className="transport-row">
          <div className="btn-group">
            <Button small onClick={() => setMarks(position(), markOut)} title="Mark clip start (I)">Mark in</Button>
            <Button small onClick={() => setMarks(markIn, position())} title="Mark clip end (O)">Mark out</Button>
            <Button small variant="primary" disabled={markIn == null || markOut == null || markOut <= markIn} onClick={addMarked}>
              <Scissors size={13} /> Add clip{markIn != null && markOut != null && markOut > markIn ? ` (${clock(markOut - markIn, true)})` : ""}
            </Button>
          </div>
          <span className="spacer" />
          <Button
            small
            variant={recording ? "danger" : "default"}
            title="Record what is playing right now with WolfcamQL's current video settings"
            onClick={() => {
              void cmd(recording ? "stopvideo" : `video avi name live_${Date.now().toString(36)}`);
              setRecording(!recording);
            }}
          >
            {recording ? <Square size={12} /> : <CircleDot size={13} />} {recording ? "Stop recording" : "Record now"}
          </Button>
        </div>
      </section>

      <div className={"player-grid" + (ready ? "" : " is-disabled")}>
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
            <Button small onClick={() => void cmd("toggle cg_draw2D")}>HUD</Button>
            <Button small onClick={() => void cmd("toggle cg_drawGun")}>Weapon</Button>
            <Button small onClick={() => void cmd("toggle cg_drawCrosshair 0 5")}>Crosshair</Button>
            <Button small onClick={() => void cmd("toggle cg_wh")}>Wallhack</Button>
            <Button small onClick={() => void cmd("toggle in_nograb")} title="Stop or let WolfcamQL capture the mouse while its window is focused">Mouse capture</Button>
          </div>
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

        <section className="card">
          <h3><Camera size={14} /> Camera</h3>
          <p className="muted small">Fly with the free camera in WolfcamQL, add a point at each key position, then play the path.</p>
          <div className="btn-row">
            <Button small onClick={() => void cmd("addcamerapoint")}><Plus size={13} /> Add point</Button>
            <Button small onClick={() => void cmd("playcamera")}><Play size={13} /> Play</Button>
            <Button small onClick={() => void cmd("stopcamera")}><Square size={12} /> Stop</Button>
            <Button small onClick={() => confirm("Remove all camera points?") && void cmd("clearcamerapoints")}><Trash2 size={13} /> Clear</Button>
          </div>
          <div className="btn-row">
            <input value={camName} onChange={(e) => setCamName(e.target.value)} placeholder="Camera name" />
            <Button small disabled={!camBase} onClick={() => void cmd(`savecamera ${camBase}`).then(() => setTimeout(refreshCameras, 600))}>Save</Button>
          </div>
          <div className="file-list">
            {cameras.length === 0 && <span className="muted small">No saved cameras yet.</span>}
            {cameras.map((c) => {
              const ext = c.name.split(".").pop()!.toLowerCase();
              const base = stripExt(c.name);
              const load = ext === "q3mmecam" ? `loadq3mmecamera ${base}` : ext === "record" ? `playpath ${base}` : `loadcamera ${base}`;
              return (
                <button type="button" key={c.name} onClick={() => void cmd(load)} title={ext === "record" ? "Play this recorded path" : "Load this camera"}>
                  {c.name}
                </button>
              );
            })}
          </div>
          <h4>Recorded path</h4>
          <div className="btn-row">
            <Button small disabled={!camBase} onClick={() => void cmd(`recordpath ${camBase}`)} title="Record your own movement as a path (run again to stop)"><Video size={13} /> Record path</Button>
            <Button small onClick={() => void cmd("stopplaypath")}>Stop path</Button>
          </div>
        </section>

        <section className="card">
          <h3>Quick commands <button type="button" className="link" onClick={() => setEditQuick(!editQuick)}>{editQuick ? "done" : "edit"}</button></h3>
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
          <Console />
        </section>
      </div>
    </div>
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
