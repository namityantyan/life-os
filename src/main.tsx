import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
if ("serviceWorker" in navigator && import.meta.env.PROD) { navigator.serviceWorker.register("/sw.js").catch(() => {}); }
