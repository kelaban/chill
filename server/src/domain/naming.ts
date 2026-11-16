// Library paths Plex and Jellyfin both understand:
//   Movies/Heat (1995) {tmdb-949}/Heat (1995) {tmdb-949} - 2160p.mkv

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

export function safeName(s: string): string {
  return s.replace(ILLEGAL, "").replace(/\s+/g, " ").trim().replace(/\.+$/, "") || "Untitled";
}

export function libraryPath(title: string, year: number | null, tmdbId: number, resolution: number | null, ext: string): string {
  const base = `${safeName(title)}${year ? ` (${year})` : ""} {tmdb-${tmdbId}}`;
  const res = resolution ? ` - ${resolution}p` : "";
  const e = ext.replace(/^\./, "").toLowerCase() || "mkv";
  return `Movies/${base}/${base}${res}.${e}`;
}
