import { useEffect } from "react";
import { isDesignTheme } from "@shared/appearance";
import { api } from "@/lib/api";
import { useTheme } from "./theme";
import { setTabBar } from "./tabBar";

/** After sign-in, pull the per-user design and tab bar from the server once; the localStorage copies already painted the first frame. */
export function useAppearanceSync() {
  const { setPrefs } = useTheme();
  useEffect(() => {
    let alive = true;
    api.get<{ settings: Record<string, any> }>("/settings").then(({ settings }) => {
      if (!alive) return;
      const d = settings.ui_design?.design;
      if (isDesignTheme(d)) setPrefs({ design: d }, { sync: false });
      if (Array.isArray(settings.tab_bar?.keys)) setTabBar(settings.tab_bar.keys, { sync: false });
    }).catch(() => { /* keep cached values */ });
    return () => { alive = false; };
  }, [setPrefs]);
}
