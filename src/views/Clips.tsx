import { Clapperboard, Copy, FolderOpen, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Empty, Field, Modal, Progress, Toggle } from "../components/ui";
import { backend, invoke } from "../lib/backend";
import { baseName, duration, fileSize, stripExt, uid } from "../lib/format";
import { estimateBytesPerSecond, RESOLUTIONS, type CapturePreset, type EncodePreset } from "../lib/presets";
import { useStore, type Clip } from "../lib/store";

const FORMATS: [CapturePreset["format"], string][] = [
  ["avi", "AVI with sound"],
  ["avi-nosound", "AVI without sound"],
  ["avi-wav", "AVI + separate WAV"],
  ["tga", "TGA image sequence + WAV"],
  ["png", "PNG image sequence + WAV"],
  ["jpg", "JPG image sequence + WAV"],
];

export function ClipsView() {
  const clips = useStore((s) => s.clips);
  const rendering = useStore((s) => s.rendering);
  const settings = useStore((s) => s.settings);
  const capturePresets = useStore((s) => s.capturePresets);
  const encodePresets = useStore((s) => s.encodePresets);
  const profiles = useStore((s) => s.profiles);
  const ffmpeg = useStore((s) => s.ffmpegVersion);
  const st = useStore.getState();

  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<Clip | null>(null);
  const [editPreset, setEditPreset] = useState(false);
  const [videos, setVideos] = useState<{ path: string; free: number | null } | null>(null);
  useEffect(() => {
    // Free space where WolfcamQL writes its captures; refreshed when a render ends.
    void invoke<[string, number | null]>("game_folder", { home: settings.wolfcamHome, sub: "videos" })
      .then(([path, free]) => setVideos({ path, free }))
      .catch(() => setVideos(null));
  }, [settings.wolfcamHome, rendering]);

  const capture = capturePresets.find((p) => p.id === settings.capturePreset) ?? capturePresets[0];
  const encode = encodePresets.find((p) => p.id === settings.encodePreset) ?? encodePresets[0];
  const targets = picked.length ? clips.filter((c) => picked.includes(c.id)) : clips;
  const totalMs = targets.reduce((n, c) => n + (c.endTime - c.startTime), 0);
  const canEncode = capture?.format.startsWith("avi");
  const perMinute = capture ? estimateBytesPerSecond(capture) * 60 : 0;
  const needed = capture ? (estimateBytesPerSecond(capture) * totalMs) / 1000 : 0;
  const tooLittle = videos?.free != null && needed > videos.free;

  const toggle = (id: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
    else setPicked(picked.length === 1 && picked[0] === id ? [] : [id]);
  };

  const patchPreset = (patch: Partial<CapturePreset>) => st.savePresets(capturePresets.map((p) => (p.id === capture.id ? { ...p, ...patch } : p)), encodePresets);

  return (
    <div className="clips">
      <section className="pane">
        <header className="toolbar">
          <h2>Clips</h2>
          <span className="muted">{clips.length} clip{clips.length === 1 ? "" : "s"} · {duration(clips.reduce((n, c) => n + c.endTime - c.startTime, 0))} of footage</span>
          <span className="spacer" />
          <Button onClick={async () => videos && (await backend()).openPath(videos.path)} disabled={!videos} title="Open the folder WolfcamQL records into">
            <FolderOpen size={14} /> Videos
          </Button>
          {picked.length > 0 && (
            <Button
              onClick={() => {
                st.removeClips(picked);
                setPicked([]);
              }}
              disabled={rendering}
            >
              <Trash2 size={14} /> Remove {picked.length}
            </Button>
          )}
        </header>
        {clips.length === 0 ? (
          <Empty title="No clips yet">
            Add clips from a demo's kill list, from the frag finder, or by marking in and out points in the Player. They are rendered here in one unattended batch.
          </Empty>
        ) : (
          <div className="clip-list">
            {clips.map((c) => {
              const r = c.render;
              const active = r && (r.status === "capturing" || r.status === "encoding");
              return (
                <div key={c.id} className={"clip" + (picked.includes(c.id) ? " is-selected" : "")} onClick={(e) => toggle(c.id, e)} onDoubleClick={() => !rendering && setEditing(c)}>
                  <div className="clip-main">
                    <strong>{c.name}</strong>
                    <small className="muted">{c.label} · {c.povName ? `POV ${c.povName}` : "recorded POV"} · {stripExt(baseName(c.demo))}</small>
                    {r && (
                      <div className={`clip-status clip-${r.status}`}>
                        {r.status === "queued" ? (
                          <span>Queued</span>
                        ) : active ? (
                          <>
                            <Progress value={r.progress} />
                            <span>{r.message} {Math.round(r.progress * 100)}%</span>
                          </>
                        ) : (
                          <span title={r.message}>{r.status === "done" ? `Done · ${baseName(r.outputs?.[0] ?? "")}` : r.status === "failed" ? `Failed: ${r.message}` : "Cancelled"}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="num">{duration(c.endTime - c.startTime)}</span>
                  {r?.status === "done" && r.outputs?.[0] && (
                    <button type="button" className="icon-btn" title="Show the file" onClick={async (e) => { e.stopPropagation(); (await backend()).reveal(r.outputs![0]); }}>
                      <FolderOpen size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    title="Preview in WolfcamQL"
                    disabled={rendering}
                    onClick={(e) => {
                      e.stopPropagation();
                      void st.play(c.demo, { startTime: c.startTime, pov: c.pov });
                    }}
                  >
                    <Play size={14} />
                  </button>
                  <button type="button" className="icon-btn" title="Remove" disabled={rendering} onClick={(e) => { e.stopPropagation(); st.removeClips([c.id]); }}>
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <aside className="detail">
        <div className="detail-body">
          <h2>Render</h2>
          <Field label="Capture preset" hint={capture ? `${capture.width}×${capture.height} at ${capture.fps} fps${capture.blurFrames ? `, ${capture.blurFrames}-frame motion blur` : ""}` : ""}>
            <div className="row">
              <select value={capture?.id} onChange={(e) => st.updateSettings({ capturePreset: e.target.value })}>
                {capturePresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <Button onClick={() => setEditPreset(true)}>Edit</Button>
            </div>
          </Field>
          <Field label="Config profile" hint="HUD, models and graphics settings used while recording.">
            <select value={settings.activeProfile} onChange={(e) => st.updateSettings({ activeProfile: e.target.value })}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field
            label="Encode with ffmpeg"
            hint={!canEncode ? "Image sequences are left as they are." : encode?.id !== "none" && !ffmpeg ? "ffmpeg was not found; set its location in Settings." : undefined}
          >
            <select value={encode?.id} disabled={!canEncode} onChange={(e) => st.updateSettings({ encodePreset: e.target.value })}>
              {encodePresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          {canEncode && encode?.id !== "none" && (
            <>
              <EncodeArgs preset={encode} />
              <Field label="Output folder" hint={settings.outputDir ? undefined : "Empty: next to the capture, in WolfcamQL's videos folder."}>
                <div className="row">
                  <input value={settings.outputDir} onChange={(e) => st.updateSettings({ outputDir: e.target.value })} placeholder="WolfcamQL videos folder" spellCheck={false} />
                  <Button onClick={async () => { const d = await (await backend()).pickFolder("Output folder"); if (d) st.updateSettings({ outputDir: d }); }}>Browse</Button>
                </div>
              </Field>
              <Toggle checked={settings.deleteSource} onChange={(v) => st.updateSettings({ deleteSource: v })} label="Delete the AVI after a successful encode" />
            </>
          )}
          <Field label="Lead-in before recording" hint="Seconds played before each clip starts recording, so effects and positions have settled.">
            <input type="number" min={0} max={30} step={0.5} value={settings.capturePreRoll} onChange={(e) => st.updateSettings({ capturePreRoll: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>

          {capture && (
            <dl className="disk-info">
              <dt>Video</dt>
              <dd>{capture.width}×{capture.height} at {capture.fps} fps{capture.blurFrames ? `, ${capture.blurFrames}-frame blur` : ""}</dd>
              <dt>Quality</dt>
              <dd>{canEncode && encode?.id !== "none" ? encode?.name : `${capture.format.startsWith("avi") ? capture.codec + " AVI" : capture.format.toUpperCase() + " sequence"} (not encoded)`}</dd>
              <dt>Capture size</dt>
              <dd>about {fileSize(perMinute)} per minute, before encoding</dd>
              <dt>Disk space left</dt>
              <dd className={tooLittle ? "is-low" : ""}>{videos?.free != null ? fileSize(videos.free) : "unknown"}</dd>
            </dl>
          )}
          {capture && targets.length > 0 && (
            <p className={"notice" + (tooLittle ? " notice-bad" : "")}>
              {targets.length} clip{targets.length === 1 ? "" : "s"}, {duration(totalMs)} of footage: WolfcamQL's own output needs roughly {fileSize(needed)}
              {tooLittle ? ", which is more than the free space on that disk." : "."}
            </p>
          )}
          <div className="actions">
            {rendering ? (
              <Button variant="danger" onClick={() => void st.cancelRender()}>Cancel render</Button>
            ) : (
              <Button variant="primary" disabled={!targets.length} onClick={() => void st.startRender(targets.map((c) => c.id))}>
                <Clapperboard size={14} /> Render {picked.length ? `${picked.length} selected` : "all"}
              </Button>
            )}
          </div>
          <p className="muted small">WolfcamQL opens once per clip, records it and closes again. Leave its window alone while it works.</p>
        </div>
      </aside>

      {editing && <ClipEditor clip={editing} onClose={() => setEditing(null)} />}
      {editPreset && capture && (
        <Modal
          title="Capture preset"
          wide
          onClose={() => setEditPreset(false)}
          footer={
            <>
              <Button
                onClick={() => {
                  const copy = { ...capture, id: uid(), name: `${capture.name} copy` };
                  st.savePresets([...capturePresets, copy], encodePresets);
                  st.updateSettings({ capturePreset: copy.id });
                }}
              >
                <Copy size={14} /> Duplicate
              </Button>
              <Button
                disabled={capturePresets.length < 2}
                onClick={() => {
                  const rest = capturePresets.filter((p) => p.id !== capture.id);
                  st.savePresets(rest, encodePresets);
                  st.updateSettings({ capturePreset: rest[0].id });
                }}
              >
                <Trash2 size={14} /> Delete
              </Button>
              <span className="spacer" />
              <Button variant="primary" onClick={() => setEditPreset(false)}>Done</Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Name" wide>
              <input value={capture.name} onChange={(e) => patchPreset({ name: e.target.value })} />
            </Field>
            <Field label="Resolution">
              <select
                value={RESOLUTIONS.find((r) => r[1] === capture.width && r[2] === capture.height)?.[0] ?? "custom"}
                onChange={(e) => {
                  const r = RESOLUTIONS.find((x) => x[0] === e.target.value);
                  if (r) patchPreset({ width: r[1], height: r[2] });
                }}
              >
                {RESOLUTIONS.map((r) => <option key={r[0]} value={r[0]}>{r[0]} ({r[1]}×{r[2]})</option>)}
                <option value="custom">Custom</option>
              </select>
            </Field>
            <Field label="Width × height">
              <div className="row">
                <input type="number" min={320} step={2} value={capture.width} onChange={(e) => patchPreset({ width: Number(e.target.value) || capture.width })} />
                <input type="number" min={200} step={2} value={capture.height} onChange={(e) => patchPreset({ height: Number(e.target.value) || capture.height })} />
              </div>
            </Field>
            <Field label="Frame rate">
              <select value={capture.fps} onChange={(e) => patchPreset({ fps: Number(e.target.value) })}>
                {[24, 25, 30, 50, 60, 100, 120, 125, 240].map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </Field>
            <Field label="Motion blur" hint={capture.blurFrames ? `Renders ${capture.fps * capture.blurFrames} frames per second of footage.` : "Off"}>
              <select value={capture.blurFrames} onChange={(e) => patchPreset({ blurFrames: Number(e.target.value) })}>
                {[0, 2, 4, 8, 16, 32, 64].map((f) => <option key={f} value={f}>{f === 0 ? "Off" : `${f} frames blended`}</option>)}
              </select>
            </Field>
            <Field label="Output">
              <select value={capture.format} onChange={(e) => patchPreset({ format: e.target.value as CapturePreset["format"] })}>
                {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="AVI codec" hint="HuffYUV is lossless; MJPEG is small and lossy.">
              <select value={capture.codec} disabled={!capture.format.startsWith("avi")} onChange={(e) => patchPreset({ codec: e.target.value as CapturePreset["codec"] })}>
                <option value="huffyuv">HuffYUV (lossless)</option>
                <option value="mjpeg">MJPEG</option>
                <option value="uncompressed">Uncompressed</option>
              </select>
            </Field>
            <div className="field field-wide">
              <Toggle checked={capture.depth} onChange={(v) => patchPreset({ depth: v })} label="Also record a depth-buffer video (for depth of field in an editor)" />
            </div>
            <Field label="Extra cvars" hint="One 'name value' per line, applied before the demo loads. Example: r_useFbo 1" wide>
              <textarea rows={3} value={capture.extra} onChange={(e) => patchPreset({ extra: e.target.value })} spellCheck={false} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EncodeArgs({ preset }: { preset: EncodePreset }) {
  const { capturePresets, encodePresets, savePresets, updateSettings } = useStore.getState();
  if (preset.builtin) {
    return (
      <p className="muted small code-line">
        {preset.args}{" "}
        <button
          type="button"
          className="link"
          onClick={() => {
            const copy: EncodePreset = { ...preset, id: uid(), name: `${preset.name} (custom)`, builtin: false };
            savePresets(capturePresets, [...encodePresets, copy]);
            updateSettings({ encodePreset: copy.id });
          }}
        >
          customise
        </button>
      </p>
    );
  }
  const patch = (p: Partial<EncodePreset>) => savePresets(capturePresets, encodePresets.map((x) => (x.id === preset.id ? { ...x, ...p } : x)));
  return (
    <div className="form-grid">
      <Field label="Preset name"><input value={preset.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
      <Field label="File extension"><input value={preset.extension} onChange={(e) => patch({ extension: e.target.value.replace(/[^a-z0-9]/gi, "") })} /></Field>
      <Field label="ffmpeg arguments" hint="Placed between the input and the output file." wide>
        <textarea rows={3} value={preset.args} onChange={(e) => patch({ args: e.target.value })} spellCheck={false} />
      </Field>
      <div className="field field-wide">
        <Button
          small
          onClick={() => {
            savePresets(capturePresets, encodePresets.filter((x) => x.id !== preset.id));
            updateSettings({ encodePreset: "h264" });
          }}
        >
          <Trash2 size={13} /> Delete this preset
        </Button>
      </div>
    </div>
  );
}

function ClipEditor({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const info = useStore((s) => s.demoInfo[clip.demo]);
  const { updateClip, loadDemoInfo } = useStore.getState();
  const [c, setC] = useState(clip);
  useEffect(() => {
    void loadDemoInfo(clip.demo);
  }, [clip.demo, loadDemoInfo]);
  const save = () => {
    updateClip(clip.id, { name: c.name, startTime: c.startTime, endTime: Math.max(c.endTime, c.startTime + 500), pov: c.pov, povName: c.povName });
    onClose();
  };
  const nudge = (key: "startTime" | "endTime", sec: number) => setC({ ...c, [key]: c[key] + sec * 1000 });
  return (
    <Modal title="Edit clip" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="File name" wide><input autoFocus value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
        {(["startTime", "endTime"] as const).map((key) => (
          <Field key={key} label={key === "startTime" ? "Start" : "End"} hint="Demo server time in ms">
            <div className="row">
              <Button small onClick={() => nudge(key, -1)}>−1 s</Button>
              <input type="number" step={100} value={c[key]} onChange={(e) => setC({ ...c, [key]: Number(e.target.value) || c[key] })} />
              <Button small onClick={() => nudge(key, 1)}><Plus size={11} />1 s</Button>
            </div>
          </Field>
        ))}
        <Field label="Point of view" wide hint={`Length ${duration(Math.max(0, c.endTime - c.startTime))}`}>
          <select
            value={c.pov ?? -1}
            onChange={(e) => {
              const n = Number(e.target.value);
              setC({ ...c, pov: n < 0 ? null : n, povName: n < 0 ? "" : (info?.players.find((p) => p.clientNum === n)?.name ?? c.povName) });
            }}
          >
            <option value={-1}>As recorded</option>
            {info ? info.players.filter((p) => p.team !== 3).map((p) => <option key={`${p.clientNum}-${p.name}`} value={p.clientNum}>{p.name}</option>) : c.pov != null && <option value={c.pov}>{c.povName}</option>}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
