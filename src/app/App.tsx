import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./theme";
import { AuthProvider, useAuth } from "./auth";
import { Shell } from "./Shell";
import { PageSkeleton, ToastProvider } from "@/components/ui";
import Login from "./pages/Login";

const pages = {
  dashboard: lazy(() => import("@/modules/dashboard/Page")),
  planner: lazy(() => import("@/modules/planner/Page")),
  ideas: lazy(() => import("@/modules/ideas/Page")),
  notes: lazy(() => import("@/modules/notes/Page")),
  health: lazy(() => import("@/modules/health/Page")),
  training: lazy(() => import("@/modules/training/Page")),
  assets: lazy(() => import("@/modules/assets/Page")),
  cards: lazy(() => import("@/modules/cards/Page")),
  fx: lazy(() => import("@/modules/fx/Page")),
  finance: lazy(() => import("@/modules/finance/Page")),
  royalty: lazy(() => import("@/modules/royalty/Page")),
  backups: lazy(() => import("@/modules/backups/Page")),
  requests: lazy(() => import("@/modules/requests/Page")),
  settings: lazy(() => import("@/modules/settings/Page")),
};

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-6 md:p-10"><PageSkeleton /></div>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  return (
    <Shell>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/" element={<pages.dashboard />} />
          <Route path="/planner/*" element={<pages.planner />} />
          <Route path="/ideas/*" element={<pages.ideas />} />
          <Route path="/notes/*" element={<pages.notes />} />
          <Route path="/health/*" element={<pages.health />} />
          <Route path="/training/*" element={<pages.training />} />
          <Route path="/assets/*" element={<pages.assets />} />
          <Route path="/cards/*" element={<pages.cards />} />
          <Route path="/fx/*" element={<pages.fx />} />
          <Route path="/finance/*" element={<pages.finance />} />
          <Route path="/royalty/*" element={<pages.royalty />} />
          <Route path="/backups/*" element={<pages.backups />} />
          <Route path="/requests/*" element={<pages.requests />} />
          <Route path="/settings/*" element={<pages.settings />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

export default function App() {
  return (
    <ThemeProvider><ToastProvider><AuthProvider><BrowserRouter><Gate /></BrowserRouter></AuthProvider></ToastProvider></ThemeProvider>
  );
}
