import type { PressureAssessment, WeatherLocation } from "../../shared/types";

export const PRESSURE_THRESHOLDS = {
  delta3h: { caution: 2.5, strong: 4.0 },
  delta6h: { caution: 4.0, strong: 6.0 },
  range: { caution: 5.0, strong: 8.0 },
};

/** Standard pressure-change judgement from the spec (section 7). Both rising and falling count. */
export function assessPressure(series: { time: string; hpa: number | null }[], nowIndex: number): PressureAssessment {
  const at = (i: number) => (i >= 0 && i < series.length ? series[i].hpa : null);
  const current = at(nowIndex);
  const p3 = at(nowIndex - 3);
  const p6 = at(nowIndex - 6);
  const delta3h = current != null && p3 != null ? current - p3 : null;
  const delta6h = current != null && p6 != null ? current - p6 : null;
  const window = series.slice(Math.max(0, nowIndex - 12), nowIndex + 1).map((s) => s.hpa);
  const missing = current == null || p3 == null || p6 == null || window.some((v) => v == null);
  const valid = window.filter((v): v is number => v != null);
  const range12h = valid.length >= 2 ? Math.max(...valid) - Math.min(...valid) : null;
  let level: PressureAssessment["level"] = "stable";
  const strong = (delta3h != null && Math.abs(delta3h) >= PRESSURE_THRESHOLDS.delta3h.strong) || (delta6h != null && Math.abs(delta6h) >= PRESSURE_THRESHOLDS.delta6h.strong) || (range12h != null && range12h >= PRESSURE_THRESHOLDS.range.strong);
  const caution = (delta3h != null && Math.abs(delta3h) >= PRESSURE_THRESHOLDS.delta3h.caution) || (delta6h != null && Math.abs(delta6h) >= PRESSURE_THRESHOLDS.delta6h.caution) || (range12h != null && range12h >= PRESSURE_THRESHOLDS.range.caution);
  if (strong) level = "strong"; else if (caution) level = "caution"; else if (missing) level = "unknown";
  const direction = delta3h == null ? null : delta3h > 0.5 ? "up" : delta3h < -0.5 ? "down" : "flat";
  return { current, delta3h, delta6h, range12h, level, direction, missing };
}

export type WeatherSnapshot = {
  location: WeatherLocation;
  temperature: number | null; weather_code: number | null; precipitation_probability: number | null;
  pressure: PressureAssessment;
  pressure_series: { time: string; hpa: number | null }[];
  fetched_at: string;
};

export async function fetchWeather(loc: WeatherLocation): Promise<WeatherSnapshot> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.lat));
  url.searchParams.set("longitude", String(loc.lon));
  url.searchParams.set("hourly", "pressure_msl,precipitation_probability,temperature_2m,weather_code");
  url.searchParams.set("current", "temperature_2m,weather_code,pressure_msl");
  url.searchParams.set("timezone", "Asia/Tokyo");
  url.searchParams.set("past_days", "1");
  url.searchParams.set("forecast_days", "2");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = (await res.json()) as any;
  const times: string[] = j.hourly?.time ?? [];
  const series = times.map((t, i) => ({ time: t, hpa: j.hourly.pressure_msl?.[i] ?? null }));
  const nowStr = (j.current?.time as string | undefined) ?? "";
  let idx = times.findIndex((t) => t >= nowStr.slice(0, 13));
  if (idx < 0) idx = times.length - 1;
  const nowHourIdx = times.findIndex((t) => t.slice(0, 13) === nowStr.slice(0, 13));
  const i = nowHourIdx >= 0 ? nowHourIdx : idx;
  return {
    location: loc,
    temperature: j.current?.temperature_2m ?? null,
    weather_code: j.current?.weather_code ?? null,
    precipitation_probability: j.hourly?.precipitation_probability?.[i] ?? null,
    pressure: assessPressure(series, i),
    pressure_series: series,
    fetched_at: new Date().toISOString(),
  };
}

export const WEATHER_CODE_LABEL: Record<number, string> = {
  0: "快晴", 1: "晴れ", 2: "一部曇り", 3: "曇り", 45: "霧", 48: "霧氷", 51: "霧雨", 53: "霧雨", 55: "霧雨",
  61: "小雨", 63: "雨", 65: "大雨", 71: "小雪", 73: "雪", 75: "大雪", 80: "にわか雨", 81: "にわか雨", 82: "激しいにわか雨", 95: "雷雨", 96: "雷雨", 99: "雷雨",
};
