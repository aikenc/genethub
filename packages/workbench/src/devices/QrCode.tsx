import { useMemo } from "react";
import { renderSVG } from "uqr";

/**
 * A pairing link as a square, for the common case of pointing a phone at a
 * laptop screen. The link itself is always shown next to it: cameras need
 * HTTPS, and a self-hosted deployment often has none.
 */
export function QrCode({ value, size = 168 }: { value: string; size?: number }) {
  const svg = useMemo(() => renderSVG(value, { border: 1 }), [value]);
  return (
    <div
      role="img"
      aria-label="配对二维码"
      className="shrink-0 rounded bg-white p-2"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
