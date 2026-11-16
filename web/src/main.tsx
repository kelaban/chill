import { init } from "@noriginmedia/norigin-spatial-navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
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
import { Show } from "./pages/Show";
import { Shows } from "./pages/Shows";

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

/** A fresh player per title, so rolling into the next episode starts clean. */
function WatchKeyed() {
  const { id } = useParams();
  return <Watch key={id} />;
}

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
      <Route path="/watch/:id" element={<WatchKeyed />} />
      <Route path="/shows" element={<Shows />} />
      <Route path="/show/:imdb" element={<Show />} />
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
