import { init } from "@noriginmedia/norigin-spatial-navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { profileId } from "./api";
import "./index.css";
import { isBack, isTV } from "./keys";
import { About } from "./pages/About";
import { Browse } from "./pages/Browse";
import { Detail } from "./pages/Detail";
import { Downloads } from "./pages/Downloads";
import { Home } from "./pages/Home";
import { MyList } from "./pages/MyList";
import { Profiles } from "./pages/Profiles";
import { Search } from "./pages/Search";
import { Watch } from "./pages/Watch";

// /tv (the webOS shell's entry point) or a webOS user agent turns on TV mode.
if (location.pathname === "/tv" || location.search.includes("tv=1")) {
  try {
    localStorage.setItem("chill.tv", "1");
  } catch {
    /* ignore */
  }
}
const tv = isTV() || (() => {
  try {
    return localStorage.getItem("chill.tv") === "1";
  } catch {
    return false;
  }
})();
if (tv) document.documentElement.classList.add("tv");

init({ debug: false, visualDebug: false, throttle: 80, throttleKeypresses: true });

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (loc.pathname.startsWith("/watch")) return; // the player owns its keys
      if (isBack(e)) {
        e.preventDefault();
        if (loc.pathname !== "/") nav(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loc.pathname, nav]);

  const needsProfile = !profileId() && loc.pathname !== "/profiles";
  if (needsProfile) return <Navigate to="/profiles" replace />;
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/tv" element={<Navigate to="/" replace />} />
      <Route path="/profiles" element={<Profiles />} />
      <Route path="/search" element={<Search />} />
      <Route path="/browse" element={<Browse />} />
      <Route path="/my-list" element={<MyList />} />
      <Route path="/title/:id" element={<Detail />} />
      <Route path="/watch/:id" element={<Watch />} />
      <Route path="/downloads" element={<Downloads />} />
      <Route path="/about" element={<About />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
