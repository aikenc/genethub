import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Page and float chrome share one row while the document stays mounted. */
export const PreviewToolbarContext = createContext<HTMLElement | null>(null);

/** Opens the file-bound preview feedback dialog from the annotation menu. */
export const PreviewFileFeedbackOpenContext = createContext<(() => void) | null>(null);

/** Opens GeneHub product feedback from the preview overflow menu. */
export const PreviewProductFeedbackContext = createContext<(() => void) | null>(null);

export function PreviewToolbarPortal({ children }: { children: ReactNode }) {
  const target = useContext(PreviewToolbarContext);
  return target ? createPortal(children, target) : (
    <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-line bg-surface px-2 text-xs">
      {children}
    </div>
  );
}
