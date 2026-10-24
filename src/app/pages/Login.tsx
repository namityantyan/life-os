import { motion } from "motion/react";
import { useAuth } from "../auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui";

export default function Login() {
  const { googleConfigured, devLogin, refresh } = useAuth();
  const err = new URLSearchParams(location.search).get("error");
  return (
    <div className="min-h-dvh grid place-items-center p-6">
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }} className="card w-full max-w-sm p-8 text-center space-y-6">
        <div className="mx-auto size-14 rounded-2xl bg-label text-bg grid place-items-center text-2xl font-bold">L</div>
        <div><h1 className="text-2xl font-bold tracking-tight">Life OS</h1></div>
        {err === "not_allowed" && <p className="text-red text-sm">このGoogleアカウントは許可されていません。</p>}
        <div className="space-y-2">
          <Button variant="primary" size="lg" className="w-full" disabled={!googleConfigured} onClick={() => { location.href = "/api/auth/google/start"; }}>Googleでログイン</Button>
          {!googleConfigured && <p className="text-xs text-label-3">Google OAuthが未設定です（GOOGLE_CLIENT_ID）。</p>}
          {devLogin && <Button size="lg" className="w-full" data-testid="dev-login" onClick={async () => { await api.post("/auth/dev-login"); await refresh(); }}>開発用ログイン</Button>}
        </div>
      </motion.div>
    </div>
  );
}
