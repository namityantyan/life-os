import { Component, lazy, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Button } from "@/components/ui";

/** Errors thrown when a lazy chunk cannot be fetched (typically right after a deploy). */
export class ChunkLoadError extends Error {
  name = "ChunkLoadError";
}
const CHUNK_RE = /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically imported module|Load failed/i;
export const isChunkError = (e: unknown) => e instanceof ChunkLoadError || (e instanceof Error && (e.name === "ChunkLoadError" || CHUNK_RE.test(e.message)));

/** `lazy()` with one retry; a second failure is re-thrown as ChunkLoadError so the boundary can ask for a reload. */
export function lazyPage<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try { return await loader(); }
    catch (first) {
      await new Promise((r) => setTimeout(r, 400));
      try { return await loader(); }
      catch (second) { throw new ChunkLoadError((second as Error)?.message ?? (first as Error)?.message ?? "chunk load failed"); }
    }
  });
}

type Props = { children: ReactNode; resetKey?: string; onHome?: () => void };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[ErrorBoundary]", error, info.componentStack); }
  componentDidUpdate(prev: Props) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }} className="max-w-xl mx-auto mt-10" role="alert" data-testid="error-boundary">
        <div className="card p-6 space-y-4">
          <div>
            <div className="text-xl font-semibold tracking-tight">{chunk ? "アプリが更新されました" : "この画面でエラーが発生しました"}</div>
            <p className="text-sm text-label-2 mt-1">{chunk ? "新しいバージョンを読み込むため、再読み込みしてください。" : "他の画面は引き続き使えます。再読み込みで直らない場合は、リクエストから知らせてください。"}</p>
          </div>
          {!chunk && <pre className="text-xs text-label-2 bg-fill rounded-[var(--radius-md)] p-3 whitespace-pre-wrap break-words max-h-40 overflow-auto" data-testid="error-message">{error.message || String(error)}</pre>}
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" onClick={() => window.location.reload()} data-testid="error-reload">再読み込み</Button>
            {!chunk && <Button onClick={() => { this.setState({ error: null }); this.props.onHome?.(); }} data-testid="error-home">ダッシュボードへ</Button>}
          </div>
        </div>
      </motion.div>
    );
  }
}

/** Boundary that resets when the route changes and knows how to go home. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  return <ErrorBoundary resetKey={loc.pathname} onHome={() => nav("/")}>{children}</ErrorBoundary>;
}

/** Dev-only page that throws, so the boundary can be exercised by e2e tests at /__error. */
export function ThrowPage(): never {
  throw new Error("テスト用のエラー（/__error）");
}
