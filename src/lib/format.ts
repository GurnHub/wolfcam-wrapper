export function clock(ms: number, withFraction = false): string {
  const neg = ms < 0;
  ms = Math.abs(ms);
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const base = `${m}:${s.toString().padStart(2, "0")}`;
  const frac = withFraction ? `.${Math.floor((ms % 1000) / 100)}` : "";
  return (neg ? "-" : "") + base + frac;
}

/** Game clock label for a kill/chat: warmup times are prefixed with "w". */
export function gameClock(clockMs: number, warmup: boolean): string {
  return (warmup ? "w" : "") + clock(clockMs);
}

export function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return clock(ms);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function dateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** File-system safe base name, the same rule the backend applies to output files. */
export function safeName(s: string): string {
  const n = s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[_.]+|[_.]+$/g, "");
  return n || "clip";
}

/**
 * Parses a game clock such as "10:21", "10:21.5" or "95" (seconds); a leading
 * "w" means time since warmup started. Returns milliseconds, or null.
 */
export function parseClock(text: string): { ms: number; warmup: boolean } | null {
  const m = /^\s*(w)?\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/i.exec(text);
  if (!m) return null;
  const minutes = m[2] ? Number(m[2]) : 0;
  const seconds = Number(m[3]);
  if (m[2] && seconds >= 60) return null;
  return { ms: Math.round((minutes * 60 + seconds) * 1000), warmup: !!m[1] };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export const WEAPONS = ["Gauntlet", "MG", "HMG", "SG", "GL", "RL", "LG", "RG", "PG", "BFG", "Nailgun", "Chaingun", "Prox Mine", "Telefrag"];

export const TEAM_NAMES = ["Free", "Red", "Blue", "Spectator"];
