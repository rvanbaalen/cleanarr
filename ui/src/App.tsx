import { useEffect, useState } from "react";
import { Dashboard } from "./pages/Dashboard.js";
import { Events } from "./pages/Events.js";
import { Pending } from "./pages/Pending.js";
import { Settings } from "./pages/Settings.js";

type Tab = "dashboard" | "events" | "pending" | "settings";

const VALID: Tab[] = ["dashboard", "events", "pending", "settings"];

function tabFromHash(): Tab {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (VALID as string[]).includes(h) ? (h as Tab) : "dashboard";
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(tabFromHash);

  useEffect(() => {
    const onHashChange = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setTab = (t: Tab) => {
    if (window.location.hash !== `#/${t}`) {
      window.location.hash = `#/${t}`;
    }
    setTabState(t);
  };

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>cleanarr</h1>
          <div className="sub">
            Jellyfin → Radarr/Sonarr deletion bridge
          </div>
        </div>
      </div>

      <div className="tabs">
        <button
          className={`tab ${tab === "dashboard" ? "active" : ""}`}
          onClick={() => setTab("dashboard")}
        >
          Dashboard
        </button>
        <button
          className={`tab ${tab === "events" ? "active" : ""}`}
          onClick={() => setTab("events")}
        >
          Events
        </button>
        <button
          className={`tab ${tab === "pending" ? "active" : ""}`}
          onClick={() => setTab("pending")}
        >
          Pending
        </button>
        <button
          className={`tab ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
      </div>

      {tab === "dashboard" && <Dashboard />}
      {tab === "events" && <Events />}
      {tab === "pending" && <Pending />}
      {tab === "settings" && <Settings />}
    </div>
  );
}
