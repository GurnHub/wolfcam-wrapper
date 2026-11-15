import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger" | "default";
  disabled?: boolean;
  title?: string;
  small?: boolean;
  active?: boolean;
}) {
  const cls = ["btn", props.variant && props.variant !== "default" ? `btn-${props.variant}` : "", props.small ? "btn-sm" : "", props.active ? "is-active" : ""];
  return (
    <button type="button" className={cls.filter(Boolean).join(" ")} onClick={props.onClick} disabled={props.disabled} title={props.title}>
      {props.children}
    </button>
  );
}

export function Field(props: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={"field" + (props.wide ? " field-wide" : "")}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={"toggle" + (props.disabled ? " is-disabled" : "")}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      {props.label && <span>{props.label}</span>}
    </label>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={"modal" + (props.wide ? " modal-wide" : "")} role="dialog" aria-label={props.title}>
        <header className="modal-head">
          <h2>{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>
  );
}

export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{props.title}</h3>
      {props.children && <p>{props.children}</p>}
      {props.action}
    </div>
  );
}

const WEAPON_CLASS: Record<string, string> = {
  RL: "w-rl", RG: "w-rg", LG: "w-lg", SG: "w-sg", PG: "w-pg", GL: "w-gl", MG: "w-mg", HMG: "w-mg", BFG: "w-bfg", Gauntlet: "w-ga",
};

export function WeaponTag({ weapon }: { weapon: string }) {
  return <span className={`weapon ${WEAPON_CLASS[weapon] ?? "w-other"}`}>{weapon}</span>;
}

export function Progress({ value, tone }: { value: number; tone?: "ok" | "busy" | "bad" }) {
  return (
    <div className={`progress progress-${tone ?? "busy"}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}
