/**
 * Focused sheet: a bottom sheet on phones, a centred panel from `sm` up. Header and footer stay put,
 * only the body scrolls, so the save button is always reachable. Escape closes; focus moves into the
 * sheet on open and back to the opener on close.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Icon } from "@/components/icons";
import { IconButton, cx, quick } from "@/components/ui";

/** Open sheets, innermost last: Escape closes only the top one. */
const stack: symbol[] = [];
export function Sheet({ open, onClose, title, children, footer, wide, testId, label }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; testId?: string; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose; // the effect runs per open, not per render
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const me = Symbol("sheet"); stack.push(me);
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && stack.at(-1) === me) { e.preventDefault(); close.current(); } };
    window.addEventListener("keydown", h);
    const t = setTimeout(() => {
      const el = ref.current; if (!el || el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus({ preventScroll: true });
    }, 30);
    const { overflow } = document.body.style; document.body.style.overflow = "hidden";
    return () => { stack.splice(stack.indexOf(me), 1); window.removeEventListener("keydown", h); clearTimeout(t); document.body.style.overflow = overflow; opener?.focus?.({ preventScroll: true }); };
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={quick}>
          <div className="scrim absolute inset-0" onClick={onClose} />
          <motion.div ref={ref} role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)} tabIndex={-1} data-testid={testId}
            initial={{ y: 40, opacity: 0.6 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }} transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            className={cx("sheet relative flex flex-col w-full max-h-[92dvh] sm:max-h-[min(86dvh,52rem)] rounded-t-[var(--radius-xl)] sm:rounded-[var(--radius-xl)] outline-none", wide ? "sm:max-w-2xl" : "sm:max-w-lg")}>
            <div className="sm:hidden mx-auto mt-2 h-1 w-9 rounded-full bg-fill-strong shrink-0" aria-hidden />
            <div className="flex items-center gap-2 px-5 pt-3 sm:pt-5 pb-3 shrink-0">
              <div className="flex-1 min-w-0 text-lg font-semibold tracking-tight truncate">{title}</div>
              <IconButton label="閉じる" onClick={onClose} className="-mr-2"><Icon name="close" /></IconButton>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
            {footer && <div className="shrink-0 flex items-center gap-2 px-5 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-5 border-t border-separator">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
