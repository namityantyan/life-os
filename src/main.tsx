import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { listenForNavigation, swReady, syncPush } from "./lib/push";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
if ("serviceWorker" in navigator && import.meta.env.PROD) { swReady().then(() => syncPush()).catch(() => {}); }
// Notification click → in-app route (BrowserRouter follows popstate).
listenForNavigation((url) => { if (url !== location.pathname + location.search + location.hash) { history.pushState(null, "", url); dispatchEvent(new PopStateEvent("popstate")); } });
