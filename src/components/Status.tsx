import { phaseLabel, phaseTone } from "@/lib/phases";
import { avatarTone, initials } from "@/lib/format";

export function PhaseStatus({ phase, label }: { phase: string; label?: string }) {
  return <span className={`status s-${phaseTone(phase)}`}>{label ?? phaseLabel(phase)}</span>;
}

export function PhasePill({ phase }: { phase: string }) {
  return <span className={`pill pill-${phaseTone(phase)}`}>{phaseLabel(phase)}</span>;
}

export function Avatar({ name, size }: { name: string | null | undefined; size?: number }) {
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.4) } : undefined;
  return (
    <span className={`avatar av-${avatarTone(name)}`} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
