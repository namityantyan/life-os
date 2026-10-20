import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type ISeriesMarkersPluginApi, type Time } from "lightweight-charts";
import type { ChartResponse } from "@shared/fx";

const jst = (sec: number, withDate: boolean) => {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${t}` : t;
};

type Props = {
  data: ChartResponse;
  hidden: Record<string, boolean>;
  fitAll: boolean;
  onReachStart: () => void;
  onShiftWheel: (dir: -1 | 1) => void;
};

/** Candlestick chart with rule overlays. Gaps (weekends, missing bars) are compacted by lightweight-charts' index-based time scale; labels keep real JST times. */
export default function ChartView({ data, hidden, fitAll, onReachStart, onShiftWheel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const priceLines = useRef<IPriceLine[]>([]);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const latest = useRef({ data, hidden, fitAll, onReachStart, onShiftWheel });
  latest.current = { data, hidden, fitAll, onReachStart, onShiftWheel };

  // create once
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const c = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: css.getPropertyValue("--label-2").trim() || "#888", fontFamily: css.getPropertyValue("--font-sans") || undefined, attributionLogo: false },
      grid: { vertLines: { color: "rgba(120,120,128,0.08)" }, horzLines: { color: "rgba(120,120,128,0.08)" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: (t: Time, type: number) => jst(t as number, type < 3) },
      localization: { timeFormatter: (t: Time) => jst(t as number, true) },
      crosshair: { mode: 0 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: "#34c759", downColor: "#ff3b30", borderVisible: false, wickUpColor: "#34c759", wickDownColor: "#ff3b30",
      autoscaleInfoProvider: (orig: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const { data: d, fitAll: f, hidden: h } = latest.current;
        if (d.candles.length === 0) return orig();
        // Default: candles ± margin plus nearby overlay values; far levels only with 全水準表示.
        let minValue = Math.min(...d.candles.map((b) => b.l)), maxValue = Math.max(...d.candles.map((b) => b.h));
        const span = Math.max(maxValue - minValue, 1e-9);
        const near = (p: number) => p >= minValue - span && p <= maxValue + span;
        for (const l of d.lines) { if (h[l.key]) continue; for (const pt of l.points) if (f || near(pt.value)) { minValue = Math.min(minValue, pt.value); maxValue = Math.max(maxValue, pt.value); } }
        for (const l of d.levels) { if (h[l.group]) continue; if (f || near(l.price)) { minValue = Math.min(minValue, l.price); maxValue = Math.max(maxValue, l.price); } }
        const pad = (maxValue - minValue) * 0.08;
        return { priceRange: { minValue: minValue - pad, maxValue: maxValue + pad } };
      },
    });
    chart.current = c; candles.current = s;
    markers.current = createSeriesMarkers(s, []);
    const onRange = () => {
      const lr = c.timeScale().getVisibleLogicalRange(); if (!lr) return;
      if (lr.from < -5) latest.current.onReachStart();
    };
    c.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const onWheel = (e: WheelEvent) => { if (!e.shiftKey) return; e.preventDefault(); const d = e.deltaY || e.deltaX; if (Math.abs(d) > 20) latest.current.onShiftWheel(d > 0 ? 1 : -1); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { el.removeEventListener("wheel", onWheel); c.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); c.remove(); chart.current = null; candles.current = null; lines.current.clear(); priceLines.current = []; markers.current = null; };
  }, []);

  // data / visibility updates
  useEffect(() => {
    const c = chart.current, s = candles.current; if (!c || !s) return;
    s.setData(data.candles.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })));
    const minT = data.candles[0]?.t ?? data.from, maxT = data.candles[data.candles.length - 1]?.t ?? data.to;
    // overlays
    const seen = new Set<string>();
    for (const l of data.lines) {
      seen.add(l.key);
      let ls = lines.current.get(l.key);
      if (!ls) { ls = c.addSeries(LineSeries, { color: l.color ?? "#888", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: "", autoscaleInfoProvider: () => null }); lines.current.set(l.key, ls); }
      ls.applyOptions({ visible: !hidden[l.key], color: l.color ?? "#888" });
      ls.setData(l.points.filter((p) => p.time >= minT - 1 && p.time <= maxT + 1).map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    for (const [k, ls] of lines.current) if (!seen.has(k)) { c.removeSeries(ls); lines.current.delete(k); }
    for (const pl of priceLines.current) s.removePriceLine(pl);
    priceLines.current = data.levels.filter((l) => !hidden[l.group]).map((l) => s.createPriceLine({ price: l.price, color: l.color ?? "#8e8e93", lineWidth: 1, lineStyle: l.dashed ? 2 : 0, axisLabelVisible: true, title: l.label }));
    markers.current?.setMarkers(hidden.markers ? [] : data.markers.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.kind === "exit" ? (m.side === "BUY" ? "aboveBar" : "belowBar") : m.side === "BUY" ? "belowBar" : "aboveBar",
      shape: m.kind === "signal" ? "circle" : m.side === "BUY" ? "arrowUp" : "arrowDown",
      color: m.kind === "exit" ? "#8e8e93" : m.side === "BUY" ? "#0a84ff" : "#ff3b30",
      text: m.label, size: m.kind === "signal" ? 0.8 : 1,
    })));
    s.priceScale().applyOptions({ autoScale: true });
    c.timeScale().fitContent();
  }, [data, hidden, fitAll]);

  return <div ref={ref} className="absolute inset-0" data-testid="fx-chart-canvas" />;
}
