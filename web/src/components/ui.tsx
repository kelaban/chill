import type { Row as RowT, TitleSummary } from "@chill/shared";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { type ReactNode, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { img } from "../api";
import { FocusGroup, Focusable } from "./Focusable";

export function Button({ children, onEnter, primary, focusKey, testId, icon }: { children: ReactNode; onEnter: () => void; primary?: boolean; focusKey?: string; testId?: string; icon?: ReactNode }) {
  return (
    <Focusable
      focusKey={focusKey}
      testId={testId}
      onEnter={onEnter}
      className={`btn focus-pop inline-flex items-center gap-3 rounded-md px-8 py-3 text-xl font-semibold ${primary ? "bg-white text-black" : "bg-white/20 text-white"}`}
      focusedClassName="is-focused ring-4 ring-white"
    >
      {icon}
      {children}
    </Focusable>
  );
}

export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
    <path d="M7 4.5v15l12-7.5z" />
  </svg>
);

export function Spinner({ className = "h-12 w-12" }: { className?: string }) {
  return <div className={`${className} animate-spin rounded-full border-4 border-white/20 border-t-white`} />;
}

export function Card({ t, onEnter, focusKey, wide, fill }: { t: TitleSummary; onEnter: () => void; focusKey?: string; wide?: boolean; fill?: boolean }) {
  return (
    <Focusable focusKey={focusKey} onEnter={onEnter} testId={`card-${t.showId && t.kind === "show" ? t.showId : t.tmdbId}`} label={t.title} className={`focus-pop relative shrink-0 overflow-hidden rounded-md bg-ink-3 ${fill ? "w-full" : wide ? "w-[22rem]" : "w-[12rem]"}`}>
      {(focused) => (
        <>
          <div className={wide ? "aspect-video" : "aspect-[2/3]"}>
            {(wide ? t.backdropPath : t.posterPath) ? (
              <img src={img(wide ? "w780" : "w342", wide ? t.backdropPath : t.posterPath)} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center p-3 text-center text-lg font-bold">{t.title}</div>
            )}
          </div>
          {t.ready && <div className="absolute left-2 top-2 rounded bg-ok px-2 py-0.5 text-xs font-bold text-black">READY</div>}
          {t.progress !== undefined && (
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/30">
              <div className="h-full bg-accent" style={{ width: `${Math.round(t.progress * 100)}%` }} />
            </div>
          )}
          {focused && (
            <div className="fade-in absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-transparent p-3 pt-10">
              <div className="truncate text-base font-bold">{t.title}</div>
              {t.subtitle && <div className="truncate text-sm text-white/85">{t.subtitle}</div>}
              <div className="text-sm text-white/70">
                {t.kind === "show" ? "Series · " : ""}
                {t.year ?? ""}
                {t.rating ? <span className="ml-2 text-ok">★ {t.rating.toFixed(1)}</span> : null}
              </div>
            </div>
          )}
        </>
      )}
    </Focusable>
  );
}

export function Row({ row, onOpen, wide }: { row: RowT; onOpen: (t: TitleSummary) => void; wide?: boolean }) {
  return (
    <section data-row={row.id} className="mb-10" data-testid={`row-${row.id}`}>
      <h2 className="mb-3 px-16 text-2xl font-bold">{row.title}</h2>
      <FocusGroup focusKey={`row-${row.id}`} className="no-scrollbar flex gap-4 overflow-x-auto px-16 py-4">
        {row.items.map((t) => (
          <Card key={t.showId ?? t.tmdbId} t={t} wide={wide} onEnter={() => onOpen(t)} />
        ))}
      </FocusGroup>
    </section>
  );
}

const NAV = [
  { to: "/", label: "Home" },
  { to: "/search", label: "Search" },
  { to: "/browse", label: "Movies" },
  { to: "/shows", label: "TV Shows" },
  { to: "/my-list", label: "My List" },
  { to: "/downloads", label: "Downloads" },
];

export function Nav() {
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <FocusGroup focusKey="nav" className="relative z-30 flex items-center gap-2 bg-gradient-to-b from-black/90 to-transparent px-16 py-6">
      <div className="mr-8 text-4xl font-black tracking-tight text-accent">chill</div>
      {NAV.map((n) => (
        <Focusable
          key={n.to}
          testId={`nav-${n.label.toLowerCase().replace(" ", "-")}`}
          onEnter={() => nav(n.to)}
          className={`rounded-full px-5 py-2 text-xl transition-colors ${loc.pathname === n.to ? "font-bold text-white" : "text-white/70"}`}
          focusedClassName="bg-white !text-black"
        >
          {n.label}
        </Focusable>
      ))}
      <div className="flex-1" />
      <Focusable testId="nav-profiles" onEnter={() => nav("/profiles")} className="rounded-full px-5 py-2 text-xl text-white/70" focusedClassName="bg-white !text-black">
        Profiles
      </Focusable>
    </FocusGroup>
  );
}

/** Focus `key` once it exists (after data loads). */
export function useInitialFocus(key: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setFocus(key), 30);
    return () => clearTimeout(t);
  }, [key, ready]);
}

export function Page({ children, nav = true }: { children: ReactNode; nav?: boolean }) {
  return (
    <div className="min-h-screen pb-24">
      {nav && <Nav />}
      {children}
    </div>
  );
}
