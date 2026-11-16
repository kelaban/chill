// Library paths Plex and Jellyfin both understand:
//   Movies/Heat (1995) {tmdb-949}/Heat (1995) {tmdb-949} - 2160p.mkv

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

export function safeName(s: string): string {
  return s.replace(ILLEGAL, "").replace(/\s+/g, " ").trim().replace(/\.+$/, "") || "Untitled";
}

/** Plex/Jellyfin TV layout: TV Shows/Show (2016)/Season 01/Show (2016) - S01E02 - Name.mkv */
export function episodeLibraryPath(show: string, year: number | null, season: number, episode: number, name: string | null, ext: string): string {
  const base = `${safeName(show)}${year ? ` (${year})` : ""}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const e = ext.replace(/^\./, "").toLowerCase() || "mkv";
  const ep = `${base} - S${pad(season)}E${pad(episode)}${name ? ` - ${safeName(name)}` : ""}`;
  return `TV Shows/${base}/Season ${pad(season)}/${ep}.${e}`;
}

export function libraryPath(title: string, year: number | null, tmdbId: number, resolution: number | null, ext: string): string {
  const base = `${safeName(title)}${year ? ` (${year})` : ""} {tmdb-${tmdbId}}`;
  const res = resolution ? ` - ${resolution}p` : "";
  const e = ext.replace(/^\./, "").toLowerCase() || "mkv";
  return `Movies/${base}/${base}${res}.${e}`;
}
