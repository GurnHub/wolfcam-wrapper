// Capture presets (what WolfcamQL records) and encode presets (what ffmpeg
// turns the recording into), and the translation of both into engine cvars
// and ffmpeg arguments.

export interface CapturePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  /** Frames blended per output frame by the engine's motion blur; 0 = off. */
  blurFrames: number;
  blurOverlap: number;
  /** Container/format written by the engine. */
  format: "avi" | "avi-nosound" | "avi-wav" | "tga" | "png" | "jpg";
  codec: "huffyuv" | "mjpeg" | "uncompressed";
  /** Also write a depth-buffer video (for depth of field in an editor). */
  depth: boolean;
  /** Extra cvars, one "name value" per line. */
  extra: string;
}

export interface EncodePreset {
  id: string;
  name: string;
  extension: string;
  /** ffmpeg arguments between inputs and output. {fps} is substituted. */
  args: string;
  builtin?: boolean;
}

export const RESOLUTIONS: [string, number, number][] = [
  ["720p", 1280, 720],
  ["1080p", 1920, 1080],
  ["1440p", 2560, 1440],
  ["4K", 3840, 2160],
  ["Square 1080", 1080, 1080],
  ["Vertical 1080×1920", 1080, 1920],
];

export const defaultCapturePresets: CapturePreset[] = [
  { id: "hq1080", name: "1080p60 high quality", width: 1920, height: 1080, fps: 60, blurFrames: 0, blurOverlap: 0, format: "avi", codec: "huffyuv", depth: false, extra: "" },
  { id: "blur1080", name: "1080p60 motion blur", width: 1920, height: 1080, fps: 60, blurFrames: 16, blurOverlap: 0, format: "avi", codec: "huffyuv", depth: false, extra: "" },
  { id: "film4k", name: "4K30 cinematic blur", width: 3840, height: 2160, fps: 30, blurFrames: 32, blurOverlap: 0, format: "avi", codec: "huffyuv", depth: false, extra: "" },
  { id: "draft", name: "720p30 quick draft", width: 1280, height: 720, fps: 30, blurFrames: 0, blurOverlap: 0, format: "avi", codec: "mjpeg", depth: false, extra: "" },
];

export const defaultEncodePresets: EncodePreset[] = [
  { id: "none", name: "Keep the AVI (no encode)", extension: "", args: "", builtin: true },
  { id: "h264", name: "H.264 MP4, high quality", extension: "mp4", args: "-c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -c:a aac -b:a 320k -movflags +faststart", builtin: true },
  { id: "youtube", name: "H.264 MP4 for YouTube", extension: "mp4", args: "-c:v libx264 -preset slow -crf 18 -bf 2 -g {fps} -pix_fmt yuv420p -c:a aac -b:a 384k -ar 48000 -movflags +faststart", builtin: true },
  { id: "h265", name: "H.265 MP4", extension: "mp4", args: "-c:v libx265 -preset medium -crf 18 -pix_fmt yuv420p -tag:v hvc1 -c:a aac -b:a 320k -movflags +faststart", builtin: true },
  { id: "prores", name: "ProRes 422 HQ (editing)", extension: "mov", args: "-c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -c:a pcm_s16le", builtin: true },
  { id: "dnxhr", name: "DNxHR HQ (editing)", extension: "mov", args: "-c:v dnxhd -profile:v dnxhr_hq -pix_fmt yuv422p -c:a pcm_s16le", builtin: true },
  { id: "ffv1", name: "FFV1 MKV (lossless)", extension: "mkv", args: "-c:v ffv1 -level 3 -c:a flac", builtin: true },
];

export function parseCvarLines(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^(seta?|set)\s+/i, "");
    if (!line || line.startsWith("//")) continue;
    const i = line.search(/\s/);
    if (i < 0) continue;
    out.push([line.slice(0, i), line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1")]);
  }
  return out;
}

/** Engine cvars for a capture preset; set on the command line before the demo loads. */
export function captureCvars(p: CapturePreset): [string, string][] {
  const c: [string, string][] = [
    ["r_fullscreen", "0"],
    ["r_mode", "-1"],
    ["r_customwidth", String(p.width)],
    ["r_customheight", String(p.height)],
    ["cl_aviFrameRate", String(p.fps)],
    ["cl_aviCodec", p.codec],
    ["cl_aviAllowLargeFiles", "1"],
    // The engine can only record sound through the SDL backend.
    ["s_useOpenAL", "0"],
    ["mme_blurFrames", String(p.blurFrames)],
    ["mme_blurOverlap", String(p.blurOverlap)],
    ["mme_saveDepth", p.depth ? "1" : "0"],
    ["com_logo", "0"],
  ];
  return [...c, ...parseCvarLines(p.extra)];
}

/** Arguments for the engine's `video` command. */
export function videoArgs(p: CapturePreset): string {
  switch (p.format) {
    case "avi":
      return "avi";
    case "avi-nosound":
      return "avins";
    case "avi-wav":
      return "avins wav";
    default:
      return `${p.format} wav`;
  }
}

export function encodeArgs(p: EncodePreset, fps: number): string[] {
  return p.args
    .replace(/\{fps\}/g, String(Math.max(1, Math.round(fps / 2))))
    .split(/\s+/)
    .filter(Boolean);
}

/** Rough disk usage of the engine's own output, per second of footage. */
export function estimateBytesPerSecond(p: CapturePreset): number {
  const raw = p.width * p.height * 3 * p.fps;
  const ratio = p.codec === "uncompressed" ? 1 : p.codec === "huffyuv" ? 0.45 : 0.12;
  return raw * (p.format === "tga" ? 1 : p.format === "png" ? 0.5 : p.format === "jpg" ? 0.12 : ratio);
}
