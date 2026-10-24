import { Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./theme";
import { AuthProvider, useAuth } from "./auth";
import { Shell } from "./Shell";
import { RouteErrorBoundary, ThrowPage, lazyPage } from "./ErrorBoundary";
import { PageSkeleton, ToastProvider } from "@/components/ui";
import Login from "./pages/Login";

const pages = {
  dashboard: lazyPage(() => import("@/modules/dashboard/Page")),
  planner: lazyPage(() => import("@/modules/planner/Page")),
  ideas: lazyPage(() => import("@/modules/ideas/Page")),
  notes: lazyPage(() => import("@/modules/notes/Page")),
  health: lazyPage(() => import("@/modules/health/Page")),
  training: lazyPage(() => import("@/modules/training/Page")),
  assets: lazyPage(() => import("@/modules/assets/Page")),
  cards: lazyPage(() => import("@/modules/cards/Page")),
  fx: lazyPage(() => import("@/modules/fx/Page")),
  finance: lazyPage(() => import("@/modules/finance/Page")),
  royalty: lazyPage(() => import("@/modules/royalty/Page")),
  images: lazyPage(() => import("@/modules/images/Page")),
  backups: lazyPage(() => import("@/modules/backups/Page")),
  requests: lazyPage(() => import("@/modules/requests/Page")),
  settings: lazyPage(() => import("@/modules/settings/Page")),
};

/** Each routed page gets its own error boundary (so one module failing never blanks the app) and suspense fallback. */
const page = (el: ReactNode) => <RouteErrorBoundary><Suspense fallback={<PageSkeleton />}>{el}</Suspense></RouteErrorBoundary>;

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-6 md:p-10"><PageSkeleton /></div>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={page(<pages.dashboard />)} />
        <Route path="/planner/*" element={page(<pages.planner />)} />
        <Route path="/ideas/*" element={page(<pages.ideas />)} />
        <Route path="/notes/*" element={page(<pages.notes />)} />
        <Route path="/health/*" element={page(<pages.health />)} />
        <Route path="/training/*" element={page(<pages.training />)} />
        <Route path="/assets/*" element={page(<pages.assets />)} />
        <Route path="/cards/*" element={page(<pages.cards />)} />
        <Route path="/fx/*" element={page(<pages.fx />)} />
        <Route path="/finance/*" element={page(<pages.finance />)} />
        <Route path="/royalty/*" element={page(<pages.royalty />)} />
        <Route path="/images/*" element={page(<pages.images />)} />
        <Route path="/backups/*" element={page(<pages.backups />)} />
        <Route path="/requests/*" element={page(<pages.requests />)} />
        <Route path="/settings/*" element={page(<pages.settings />)} />
        {import.meta.env.DEV && <Route path="/__error" element={page(<ThrowPage />)} />}
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <ThemeProvider><ToastProvider><AuthProvider><BrowserRouter><Gate /></BrowserRouter></AuthProvider></ToastProvider></ThemeProvider>
  );
}
