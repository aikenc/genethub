import { useId } from "react";

import type { EffortLevel } from "./catalog/types";

const LEVELS = 5;
/** Glass of the bulb, drawn once as the outline and again as the fill's clip. */
const BULB = "M8 1.7a4.4 4.4 0 0 0-2.7 7.9v1.3h5.4V9.6A4.4 4.4 0 0 0 8 1.7Z";
const GLASS_TOP = 1.7;
const GLASS_BOTTOM = 10.9;

/**
 * How hard the model has been asked to think: a bulb that lights up further at
 * each level.
 *
 * Every level used to share one 🤔, which made the one control whose whole
 * point is "more or less than the last one" look identical at every setting.
 * The first replacement was five rising bars, which ordered the levels but read
 * as signal strength — the same glyph a phone uses for reception, on a control
 * that has nothing to do with a network. A bulb says thinking on its own, and
 * filling it carries the ordering: minimal is a sliver, ultra is lit through.
 *
 * The two levels that are not positions on that scale say so instead of
 * pretending to be one. `off` is the bulb struck through, and `auto` — the
 * Agent's own default, and any level this build has never heard of — is left
 * dark, because a guess at where it sits would be an invention.
 */
export function EffortMeter({
  level,
  className = "h-3.5 w-3.5",
}: {
  level: EffortLevel;
  className?: string;
}) {
  const clip = useId();
  const filled = typeof level === "number" ? level : 0;
  const top = GLASS_BOTTOM - ((GLASS_BOTTOM - GLASS_TOP) * filled) / LEVELS;
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${className} shrink-0`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <defs>
        <clipPath id={clip}>
          <path d={BULB} />
        </clipPath>
      </defs>
      {filled > 0 ? (
        <rect
          x={2}
          y={top}
          width={12}
          height={GLASS_BOTTOM - top}
          clipPath={`url(#${clip})`}
          className="fill-current"
          stroke="none"
        />
      ) : null}
      <path d={BULB} />
      <line x1={6.2} y1={12.6} x2={9.8} y2={12.6} />
      <line x1={7} y1={14.3} x2={9} y2={14.3} />
      {level === "off" ? <line x1={2.6} y1={13.4} x2={13.4} y2={2.6} /> : null}
    </svg>
  );
}
