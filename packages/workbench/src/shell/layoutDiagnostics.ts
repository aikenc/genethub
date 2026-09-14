/** Geometry only: no chat text, input values, device IDs or DOM dumps. */
export function captureLayoutGeometry() {
  const rect = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
  };
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const safeArea = { top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft };
  probe.remove();
  const viewport = window.visualViewport;
  return {
    screen: { width: screen.width, height: screen.height },
    layout: { width: innerWidth, height: innerHeight, clientHeight: document.documentElement.clientHeight },
    visual: viewport ? { width: viewport.width, height: viewport.height, offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft, scale: viewport.scale } : null,
    pixelRatio: devicePixelRatio,
    standalone: matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    zoom: getComputedStyle(document.documentElement).zoom,
    safeArea,
    focusKind: document.activeElement?.tagName ?? null,
    bounds: { html: rect("html"), body: rect("body"), root: rect("#root"), shell: rect(".genehub-ui"), navigation: rect(".workbench-navigation"), composer: rect('[data-composer-shell]') },
  };
}
