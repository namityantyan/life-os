import { motion, AnimatePresence } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

/* ---------- Buttons ---------- */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "tinted"; size?: "sm" | "md" | "lg"; loading?: boolean };
export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: BtnProps) {
  const base = "pressable focus-ring inline-flex items-center justify-center gap-1.5 font-medium rounded-[var(--radius-md)] whitespace-nowrap select-none disabled:opacity-40 disabled:pointer-events-none";
  const sizes = { sm: "h-8 px-3 text-sm", md: "h-10 px-4 text-base", lg: "h-12 px-5 text-lg" }[size];
  const variants = {
    primary: "bg-accent text-white hover:brightness-110",
    secondary: "bg-fill text-label hover:bg-fill-strong",
    tinted: "bg-accent-soft text-accent hover:brightness-105",
    ghost: "text-accent hover:bg-fill",
    danger: "bg-red/12 text-red hover:bg-red/20",
  }[variant];
  return <button className={cx(base, sizes, variants, className)} disabled={disabled || loading} {...rest}>{loading && <Spinner />}{children}</button>;
}
export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block size-4 rounded-full border-2 border-current border-t-transparent animate-spin", className)} />;
}
export function IconButton({ className, children, label, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} title={label} className={cx("pressable focus-ring inline-flex size-9 items-center justify-center rounded-full text-label-2 hover:bg-fill hover:text-label", className)} {...rest}>{children}</button>;
}

/* ---------- Surfaces ---------- */
export function Card({ className, children, onClick, padded = true, as = "div", "data-testid": testId }: { className?: string; children: ReactNode; onClick?: () => void; padded?: boolean; as?: "div" | "section"; "data-testid"?: string }) {
  const Tag = as;
  return <Tag onClick={onClick} data-testid={testId} className={cx("card", padded && "p-5", onClick && "pressable cursor-pointer hover:brightness-[1.02]", className)}>{children}</Tag>;
}
export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("space-y-3", className)}>
      {(title || action) && <div className="flex items-end justify-between px-1"><h2 className="text-lg font-semibold tracking-tight">{title}</h2>{action}</div>}
      {children}
    </section>
  );
}
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  useEffect(() => { document.title = `Life OS｜${title}`; }, [title]);
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }} className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div><h1 className="text-3xl font-bold tracking-tight">{title}</h1>{subtitle && <p className="text-label-2 mt-1 text-sm">{subtitle}</p>}</div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </motion.div>
  );
}
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "green" | "red" | "orange" | "accent" }) {
  const color = tone ? { green: "text-green", red: "text-red", orange: "text-orange", accent: "text-accent" }[tone] : "";
  return <div className="min-w-0"><div className="text-xs text-label-2 font-medium">{label}</div><div className={cx("text-2xl font-semibold tabular tracking-tight mt-0.5 truncate", color)}>{value}</div>{hint && <div className="text-xs text-label-2 mt-0.5">{hint}</div>}</div>;
}
export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "green" | "red" | "orange" | "purple"; className?: string }) {
  const t = { neutral: "bg-fill text-label-2", accent: "bg-accent-soft text-accent", green: "bg-green/15 text-green", red: "bg-red/15 text-red", orange: "bg-orange/15 text-orange", purple: "bg-purple/15 text-purple" }[tone];
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", t, className)}>{children}</span>;
}
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center text-center py-12 gap-2"><div className="text-label-2 font-medium">{title}</div>{hint && <div className="text-label-3 text-sm max-w-xs">{hint}</div>}{action && <div className="mt-2">{action}</div>}</div>;
}
export function Divider() { return <div className="h-px bg-separator" />; }

/* ---------- Skeletons ---------- */
export function Skeleton({ className }: { className?: string }) { return <div className={cx("skeleton", className)} />; }
export function PageSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="animate-[fadeIn_.2s]" aria-busy="true" aria-label="読み込み中" data-testid="page-skeleton">
      <Skeleton className="h-9 w-48 mb-2" /><Skeleton className="h-4 w-72 mb-8" />
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="card p-5 space-y-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-40" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-3/4" /></div>
        ))}
      </div>
    </div>
  );
}
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return <div className="space-y-2" aria-busy="true">{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
}

/* ---------- Inputs ---------- */
const inputCls = "focus-ring w-full h-10 px-3 rounded-[var(--radius-md)] bg-fill text-label placeholder:text-label-3 outline-none transition-[box-shadow] focus:shadow-[0_0_0_3px_var(--accent-soft)]";
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) { return <input className={cx(inputCls, className)} {...rest} />; }
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className={cx(inputCls, "h-auto min-h-24 py-2 resize-y", className)} {...rest} />; }
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) { return <select className={cx(inputCls, "appearance-none pr-8", className)} {...rest}>{children}</select>; }
export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return <label className={cx("block space-y-1.5", className)}><span className="text-xs font-medium text-label-2">{label}</span>{children}{hint && <span className="block text-xs text-label-3">{hint}</span>}</label>;
}
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cx("focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors", checked ? "bg-green" : "bg-fill-strong")}>
      <motion.span layout transition={{ type: "spring", stiffness: 600, damping: 35 }} className={cx("absolute size-6 rounded-full bg-white shadow", checked ? "left-[calc(100%-1.625rem)]" : "left-0.5")} />
    </button>
  );
}
export function Segmented<T extends string>({ value, onChange, options, className, testId }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string; testId?: string }) {
  return (
    <div className={cx("inline-flex p-0.5 rounded-[var(--radius-md)] bg-fill relative", className)} role="tablist" data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} data-value={o.value} onClick={() => onChange(o.value)} className={cx("focus-ring relative z-10 px-3 h-8 rounded-[calc(var(--radius-md)-2px)] text-sm font-medium transition-colors", value === o.value ? "text-label" : "text-label-2 hover:text-label")}>
          {value === o.value && <motion.span layoutId={`seg-${options.map((x) => x.value).join("|")}`} className="absolute inset-0 -z-10 rounded-[calc(var(--radius-md)-2px)] bg-elevated shadow-[var(--shadow-card)]" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Modal / Sheet ---------- */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
          <motion.div role="dialog" aria-modal="true" aria-label={title} initial={{ y: 40, opacity: 0, scale: 0.98 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 40, opacity: 0, scale: 0.98 }} transition={{ type: "spring", stiffness: 400, damping: 34 }}
            className={cx("relative w-full sm:w-auto sm:min-w-[28rem] max-h-[92dvh] overflow-auto bg-elevated rounded-t-[var(--radius-xl)] sm:rounded-[var(--radius-xl)] shadow-[var(--shadow-pop)] p-5 sm:p-6", wide ? "sm:max-w-4xl sm:w-[56rem]" : "sm:max-w-lg")}>
            {title && <div className="flex items-center justify-between mb-4"><h3 className="text-xl font-semibold tracking-tight">{title}</h3><IconButton label="閉じる" onClick={onClose}>✕</IconButton></div>}
            {children}
            {footer && <div className="flex justify-end gap-2 mt-5">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------- Toast ---------- */
type Toast = { id: number; text: string; tone?: "neutral" | "error" | "success" };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "neutral") => { const id = Date.now() + Math.random(); setItems((s) => [...s, { id, text, tone }]); setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 3200); }, []);
  return (
    <ToastCtx.Provider value={push}>{children}
      <div className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center pointer-events-none">
        <AnimatePresence>{items.map((t) => (
          <motion.div key={t.id} role="status" initial={{ y: 16, opacity: 0, scale: 0.95 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: 8, opacity: 0, scale: 0.95 }} className={cx("glass rounded-full px-4 py-2 text-sm font-medium shadow-[var(--shadow-pop)]", t.tone === "error" && "text-red", t.tone === "success" && "text-green")}>{t.text}</motion.div>
        ))}</AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------- Animated list helpers ---------- */
export const listVariants = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
export const itemVariants = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] as const } } };
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  return <motion.div variants={listVariants} initial="hidden" animate="show" className={className}>{children}</motion.div>;
}
export function Item({ children, className, layout = true }: { children: ReactNode; className?: string; layout?: boolean }) {
  return <motion.div layout={layout} variants={itemVariants} className={className}>{children}</motion.div>;
}

/* ---------- Chat panel (shared by health / meal / beauty / FP / discord preview) ---------- */
export type ChatMsg = { role: "user" | "assistant"; content: string; provider?: string };
export function ChatPanel({ messages, onSend, placeholder = "相談する…", busy, actions, emptyHint }: { messages: ChatMsg[]; onSend: (text: string) => Promise<void> | void; placeholder?: string; busy?: boolean; actions?: ReactNode; emptyHint?: string }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }); }, [messages.length, busy]);
  const send = async () => { const t = text.trim(); if (!t || busy) return; setText(""); await onSend(t); };
  return (
    <div className="flex flex-col h-full min-h-[24rem]">
      <div ref={ref} className="flex-1 overflow-auto space-y-3 p-1" data-testid="chat-log">
        {messages.length === 0 && emptyHint && <div className="text-label-3 text-sm text-center py-8">{emptyHint}</div>}
        <AnimatePresence initial={false}>
          {messages.map((m, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cx("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cx("max-w-[85%] rounded-[var(--radius-lg)] px-4 py-2.5 text-base whitespace-pre-wrap leading-relaxed", m.role === "user" ? "bg-accent text-white rounded-br-[6px]" : "bg-fill rounded-bl-[6px]")}>
                {m.content}{m.provider === "fallback" && <div className="text-xs opacity-60 mt-1">AI未接続</div>}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {busy && <div className="flex"><div className="bg-fill rounded-[var(--radius-lg)] px-4 py-3 flex gap-1">{[0, 1, 2].map((i) => <motion.span key={i} className="size-1.5 rounded-full bg-label-2" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: i * 0.15 }} />)}</div></div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 py-2">{actions}</div>}
      <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2 pt-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="メッセージ" />
        <Button type="submit" variant="primary" disabled={!text.trim() || busy}>送信</Button>
      </form>
    </div>
  );
}
