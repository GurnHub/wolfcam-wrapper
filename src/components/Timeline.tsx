import { useEffect, useMemo, useRef, useState } from "react";
import type { DemoInfo, Kill } from "../lib/backend";
import { clock, gameClock } from "../lib/format";

interface Props {
  info: DemoInfo;
  /** Returns the current server time; polled every animation frame when given. */
  position?: () => number;
  markIn?: number | null;
  markOut?: number | null;
  /** Client whose kills are emphasised. */
  highlight?: number | null;
  onSeek?: (serverTime: number) => void;
  onKill?: (kill: Kill) => void;
}

/** Match timeline: warmup/game spans, one tick per kill, playhead and in/out marks. */
export function Timeline({ info, position, markIn, markOut, highlight, onSeek, onKill }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const first = info.firstServerTime;
  const span = Math.max(1, info.lastServerTime - first);
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - first) / span) * 100))}%`;

  useEffect(() => {
    if (!position) return;
    let raf = 0;
    const tick = () => {
      if (head.current) head.current.style.left = pct(position());
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, first, span]);

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return first + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };

  const kills = useMemo(() => info.kills.filter((k) => !k.ownGoal || k.killer === highlight), [info, highlight]);
  const gameStart = info.gameStartTime ?? first;
  const gameEnd = info.gameEndTime ?? info.lastServerTime;
  const label = (t: number) => (t < gameStart ? "w" + clock(t - first) : clock(t - gameStart));

  return (
    <div
      className={"timeline" + (onSeek ? " is-seekable" : "")}
      ref={ref}
      onMouseMove={(e) => setHover({ x: e.clientX - ref.current!.getBoundingClientRect().left, t: timeAt(e.clientX) })}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => onSeek?.(timeAt(e.clientX))}
    >
      <div className="timeline-game" style={{ left: pct(gameStart), right: `calc(100% - ${pct(gameEnd)})` }} />
      {markIn != null && markOut != null && markOut > markIn && <div className="timeline-range" style={{ left: pct(markIn), right: `calc(100% - ${pct(markOut)})` }} />}
      {kills.map((k, i) => (
        <button
          type="button"
          key={i}
          className={"timeline-kill" + (highlight != null && k.killer === highlight ? " is-hot" : "") + (highlight != null && k.victim === highlight ? " is-death" : "")}
          style={{ left: pct(k.serverTime) }}
          title={`${gameClock(k.clockMs, k.warmup)}  ${k.killerName} › ${k.victimName} (${k.weapon})`}
          onClick={(e) => {
            if (onKill) {
              e.stopPropagation();
              onKill(k);
            }
          }}
        />
      ))}
      {markIn != null && <div className="timeline-mark" style={{ left: pct(markIn) }} data-label="in" />}
      {markOut != null && <div className="timeline-mark" style={{ left: pct(markOut) }} data-label="out" />}
      {position && <div className="timeline-head" ref={head} />}
      {hover && (
        <div className="timeline-hover" style={{ left: hover.x }}>
          {label(hover.t)}
        </div>
      )}
    </div>
  );
}
