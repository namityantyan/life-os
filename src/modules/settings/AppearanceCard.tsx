import type { CSSProperties } from "react";
import { DESIGN_LABELS, DESIGN_THEMES, type DesignTheme } from "@shared/appearance";
import { useTheme } from "@/app/theme";
import { Field, Segmented, cx } from "@/components/ui";
import { Icon } from "@/components/icons";

const DESIGN_HINT: Record<DesignTheme, string> = {
  standard: "落ち着いた標準の見た目",
  glass: "すりガラス風の明るい配色",
  material: "Google のマテリアル風",
};

/** 設定 → 表示: light/dark mode (per device) and the design (per user, saved to the server). */
export function AppearanceCard() {
  const { prefs, setPrefs, resolvedTheme } = useTheme();
  return (
    <div className="space-y-5">
      <Field label="モード">
        <Segmented testId="theme-seg" value={prefs.theme} onChange={(v) => setPrefs({ theme: v })} options={[
          { value: "light", label: <span className="inline-flex items-center gap-1.5"><Icon name="sun" size={16} />ライト</span> },
          { value: "dark", label: <span className="inline-flex items-center gap-1.5"><Icon name="moon" size={16} />ダーク</span> },
          { value: "system", label: <span className="inline-flex items-center gap-1.5"><Icon name="system" size={16} />システム</span> },
        ]} />
      </Field>
      <div>
        <div className="text-xs font-medium text-label-2 mb-2" id="design-label">デザイン</div>
        <div role="radiogroup" aria-labelledby="design-label" className="grid grid-cols-3 gap-2 sm:gap-3" data-testid="design-picker">
          {DESIGN_THEMES.map((d) => {
            const on = prefs.design === d;
            return (
              <button key={d} type="button" role="radio" aria-checked={on} data-testid={`design-${d}`} onClick={() => setPrefs({ design: d })}
                className={cx("focus-ring rounded-[var(--radius-lg)] p-1.5 text-left transition-shadow", on ? "shadow-[inset_0_0_0_2px_var(--accent)]" : "shadow-[inset_0_0_0_1px_var(--separator)] hover:shadow-[inset_0_0_0_1px_var(--label-3)]")}>
                <DesignPreview design={d} mode={resolvedTheme} />
                <div className="flex items-center justify-between gap-1 px-1 pt-2"><span className="text-sm font-medium truncate">{DESIGN_LABELS[d]}</span>{on && <Icon name="check" size={16} strokeWidth={2.25} className="text-accent shrink-0" />}</div>
                <div className="px-1 pb-0.5 text-xs text-label-2 leading-snug">{DESIGN_HINT[d]}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Miniature of the app in a given design. Tokens are scoped via data-design/data-theme on the wrapper, so it renders the real colors and shapes. */
export function DesignPreview({ design, mode }: { design: DesignTheme; mode: "light" | "dark" }) {
  const style = { backgroundColor: "var(--bg)", backgroundImage: "var(--bg-canvas)", color: "var(--label)", fontSize: 10, "--ui-radius-scale": 0.45 } as CSSProperties;
  const pill = design !== "standard";
  return (
    <div data-design={design} data-theme={mode} aria-hidden className="relative h-24 sm:h-28 overflow-hidden rounded-[calc(var(--radius-lg)-4px)]" style={style} data-testid={`design-preview-${design}`}>
      <div className="chrome absolute inset-x-0 top-0 h-4 border-b flex items-center px-2 gap-1"><span className="h-1 w-6 rounded-full bg-label-3" /></div>
      <div className="card absolute left-2 right-2 top-6 p-2 space-y-1.5">
        <div className="h-1.5 w-3/5 rounded-full bg-label" />
        <div className="h-1 w-4/5 rounded-full bg-label-3" />
        <div className="flex gap-1 pt-0.5"><span className="btn h-3.5 w-9 bg-accent" /><span className="btn h-3.5 w-7 bg-accent-soft" /></div>
      </div>
      <div className="chrome absolute inset-x-0 bottom-0 h-6 border-t grid grid-cols-4 place-items-center">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="relative grid place-items-center w-full h-full">
            {i === 0 && (pill ? <span className="absolute w-6 h-3.5 rounded-full" style={{ background: "var(--tab-indicator-bg)" }} /> : <span className="absolute top-0.5 w-4 h-0.5 rounded-full" style={{ background: "var(--tab-indicator-bg)" }} />)}
            <span className={cx("relative size-1.5 rounded-full", i === 0 ? "bg-[var(--tab-active-fg)]" : "bg-label-3")} />
          </span>
        ))}
      </div>
    </div>
  );
}
