import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@shared/types";
import { api } from "@/lib/api";

type AuthState = { user: User | null; loading: boolean; googleConfigured: boolean; devLogin: boolean; refresh: () => Promise<void>; logout: () => Promise<void> };
const Ctx = createContext<AuthState>({ user: null, loading: true, googleConfigured: false, devLogin: false, refresh: async () => {}, logout: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user: User | null; loading: boolean; googleConfigured: boolean; devLogin: boolean }>({ user: null, loading: true, googleConfigured: false, devLogin: false });
  const refresh = useCallback(async () => {
    try { const r = await api.get<{ user: User | null; googleConfigured: boolean; devLogin: boolean }>("/auth/me"); setState({ user: r.user, loading: false, googleConfigured: r.googleConfigured, devLogin: r.devLogin }); }
    catch { setState((s) => ({ ...s, user: null, loading: false })); }
  }, []);
  useEffect(() => { refresh(); const h = () => setState((s) => ({ ...s, user: null })); window.addEventListener("lifeos:unauthorized", h); return () => window.removeEventListener("lifeos:unauthorized", h); }, [refresh]);
  const logout = useCallback(async () => { await api.post("/auth/logout"); setState((s) => ({ ...s, user: null })); }, []);
  return <Ctx.Provider value={{ ...state, refresh, logout }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
