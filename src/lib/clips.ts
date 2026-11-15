import type { Kill } from "./backend";
import { baseName, clock, gameClock, stripExt } from "./format";
import type { Clip, Settings } from "./store";

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "clip";
}

/** A clip around one kill or a multi-kill, following the killer. */
export function clipFromKills(demo: string, map: string, kills: Kill[], s: Settings, bounds?: { first: number; last: number }): Omit<Clip, "id"> {
  const first = kills[0];
  const last = kills[kills.length - 1];
  let startTime = first.serverTime - s.clipLeadIn * 1000;
  let endTime = last.serverTime + s.clipLeadOut * 1000;
  if (bounds) {
    startTime = Math.max(startTime, bounds.first);
    endTime = Math.min(endTime, bounds.last);
  }
  const weapons = [...new Set(kills.map((k) => k.weapon))].join("+");
  const what = kills.length > 1 ? `${kills.length}x ${weapons}` : `${weapons} on ${first.victimName}`;
  return {
    name: slug(`${first.killerName}-${map}-${clock(first.clockMs).replace(":", "m")}s-${kills.length > 1 ? kills.length + "k" : first.weapon}`),
    demo, map, startTime, endTime,
    pov: first.killer >= 0 && first.killer < 64 ? first.killer : null,
    povName: first.killerName,
    label: `${what} at ${gameClock(first.clockMs, first.warmup)}`,
  };
}

export function clipFromRange(demo: string, map: string, startTime: number, endTime: number, pov: number | null, povName: string, label: string): Omit<Clip, "id"> {
  return { name: slug(`${stripExt(baseName(demo))}-${Math.round(startTime / 1000)}`), demo, map, startTime, endTime, pov, povName, label };
}
