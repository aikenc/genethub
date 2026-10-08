import { useMemo } from "react";
import { renderSVG } from "uqr";

/**
 * A pairing link as a square, for the common case of pointing a phone at a
 * laptop screen. The link itself is always shown next to it: cameras need
 * HTTPS, and a self-hosted deployment often has none.
 */
export function QrCode({
  value,
  size = 168,
  label = "配对二维码",
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const svg = useMemo(() => {
    // Too much data for any QR version throws. The link is shown beside the
    // square anyway, so no square is the whole fallback.
    try {
      return renderSVG(value, { border: 1 });
    } catch {
      return null;
    }
  }, [value]);
  if (svg === null) return null;
  return (
    <div
      role="img"
      aria-label={label}
      className="shrink-0 rounded bg-white p-2"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
