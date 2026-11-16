import fs from "node:fs";
import path from "node:path";
import type { ChillApi, PutioApi, PutioFile, PutioTransfer, Services, TmdbApi, TmdbMovie, TvShowInfo } from "../adapters/types.js";
import type { Release } from "../domain/release.js";
import { normalizeTitle } from "../domain/release.js";
import type { Clock } from "../jobs.js";
import { FAKE_NO_RELEASES_ID, fakeDetail, fakeMovies, fakePosterSvg, GENRES } from "./catalog.js";
import { sampleSubtitles, SAMPLE_SECONDS, TARGET_LEAD_IN_S, type Samples } from "./samples.js";

// Stand-ins for TMDB, chill.institute and put.io that behave like the real
// things (latency, progress over time, quota, folders) so demo mode and the
// integration tests exercise the same code paths as production.

// ---------------------------------------------------------------- TMDB

export function fakeTmdb(): TmdbApi {
  const all = fakeMovies().filter((m) => m.id !== FAKE_NO_RELEASES_ID);
  const page = (xs: TmdbMovie[], p = 1, size = 20) => xs.slice((p - 1) * size, p * size);
  return {
    async list(kind, p = 1) {
      const byPop = [...all].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
      if (kind === "trending") return page(byPop.filter((_, i) => i % 2 === 0), p);
      if (kind === "popular") return page(byPop, p);
      if (kind === "top_rated") return page([...all].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0)), p);
      if (kind === "now_playing") return page(all.filter((m) => Number(m.release_date?.slice(0, 4)) >= 2019), p);
      return [];
    },
    async discover(q) {
      let xs = all.filter((m) => !q.genre || m.genre_ids?.includes(q.genre));
      if (q.yearFrom) xs = xs.filter((m) => Number(m.release_date?.slice(0, 4)) >= q.yearFrom!);
      if (q.yearTo) xs = xs.filter((m) => Number(m.release_date?.slice(0, 4)) <= q.yearTo!);
      if (q.minRating) xs = xs.filter((m) => (m.vote_average ?? 0) >= q.minRating!);
      if (q.sort === "vote_average.desc") xs.sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
      else if (q.sort === "primary_release_date.desc") xs.sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
      return { results: page(xs, q.page), totalPages: Math.max(1, Math.ceil(xs.length / 20)) };
    },
    async search(query) {
      const n = normalizeTitle(query);
      return fakeMovies().filter((m) => normalizeTitle(m.title).includes(n));
    },
    async movie(id) {
      const d = fakeDetail(id);
      if (!d) throw Object.assign(new Error(`TMDB /movie/${id} → HTTP 404`), { status: 404 });
      return d;
    },
    async byImdb(imdbId) {
      const m = fakeMovies().find((x) => fakeDetail(x.id)?.imdb_id === imdbId);
      return m ?? null;
    },
    async searchShows(query) {
      const n = normalizeTitle(query);
      return FAKE_SHOWS.filter((s) => normalizeTitle(s[1]).includes(n)).map((s) => fakeShow(s[0])!);
    },
    async genres() {
      return GENRES;
    },
    async image(_size, p) {
      const tv = /\/?fake\/tv-(\d+)(-bd)?\.svg$/.exec(p);
      if (tv) {
        const show = FAKE_SHOWS.find((s) => s[0] === `tt${tv[1]}`);
        return { body: new TextEncoder().encode(fakePosterSvg(Number(tv[1]), !!tv[2], show ? { title: show[1], year: show[2] } : undefined)), contentType: "image/svg+xml" };
      }
      const m = /\/?fake\/(\d+)(-bd)?\.svg$/.exec(p);
      return { body: new TextEncoder().encode(fakePosterSvg(m ? Number(m[1]) : 0, !!m?.[2])), contentType: "image/svg+xml" };
    },
  };
}

// ---------------------------------------------------------------- chill.institute

interface FakeReleaseSpec {
  key: string;
  /** Release service tag (NF, HMAX, …). */
  source?: string;
  resolution: string;
  quality: string;
  codec: string;
  hdr?: string;
  audio: string;
  size: number;
  seeders: number;
  yearDelta?: number;
}

const SPECS: FakeReleaseSpec[] = [
  { key: "cam", resolution: "1080p", quality: "CAM", codec: "x264", audio: "AAC", size: 1.5e9, seeders: 900 },
  { key: "720", source: "AMZN", resolution: "720p", quality: "WEB-DL", codec: "x264", audio: "AAC", size: 1.4e9, seeders: 60 },
  { key: "1080", source: "NF", resolution: "1080p", quality: "WEB-DL", codec: "x264", audio: "DDP5.1", size: 4.2e9, seeders: 300 },
  { key: "1080hdr", source: "NF", resolution: "1080p", quality: "WEB-DL", codec: "x265", hdr: "HDR10", audio: "DDP5.1", size: 3.1e9, seeders: 420 },
  { key: "2160hdr", source: "NF", resolution: "2160p", quality: "WEB-DL", codec: "x265", hdr: "HDR10", audio: "DDP5.1 Atmos", size: 16.4e9, seeders: 140 },
  { key: "2160dv", source: "HMAX", resolution: "2160p", quality: "WEB-DL", codec: "H.265", hdr: "DV", audio: "DDP5.1 Atmos", size: 19.8e9, seeders: 30 },
  { key: "remux", resolution: "2160p", quality: "BluRay REMUX", codec: "HEVC", hdr: "DV HDR10", audio: "TrueHD Atmos", size: 62e9, seeders: 25 },
  { key: "remake", resolution: "1080p", quality: "WEB-DL", codec: "x264", audio: "AAC", size: 3e9, seeders: 500, yearDelta: 30 },
  // Episodes
  { key: "ep1080", source: "NF", resolution: "1080p", quality: "WEB-DL", codec: "x264", audio: "DDP5.1", size: 1.2e9, seeders: 250 },
  { key: "ep720", resolution: "720p", quality: "WEB-DL", codec: "x264", audio: "AAC", size: 0.6e9, seeders: 80 },
];

/** Demo shows: [imdb, title, year, network, chill source, genres]. Two seasons of three episodes each. */
export const FAKE_SHOWS: [string, string, number, string, string, string[]][] = [
  ["tt4574334", "Stranger Things", 2016, "Netflix", "NETFLIX", ["Drama", "Sci-Fi & Fantasy"]],
  ["tt0944947", "Game of Thrones", 2011, "HBO", "HBO_MAX", ["Drama", "Action & Adventure"]],
  ["tt0903747", "Breaking Bad", 2008, "AMC", "AMC_PLUS", ["Drama", "Crime"]],
];
const FAKE_SEASONS = 2;
const FAKE_EPISODES = 3;

function fakeShow(imdb: string): TvShowInfo | null {
  const s = FAKE_SHOWS.find((x) => x[0] === imdb);
  if (!s) return null;
  const n = imdb.slice(2);
  return {
    imdbId: s[0], title: s[1], year: s[2], posterUrl: `/fake/tv-${n}.svg`, backdropUrl: `/fake/tv-${n}-bd.svg`, rating: 8.6,
    overview: `${s[1]}: a ${s[5][0]!.toLowerCase()} series from ${s[2]} on ${s[3]}.`, seasonCount: FAKE_SEASONS, status: "ended",
    networks: [s[3]], genres: s[5], firstAirDate: `${s[2]}-07-15`,
  };
}

export function fakeReleaseSize(link: string): { tmdbId: number; token: string; key: string; size: number; resolution: number } | null {
  const m = /^fake:\/\/([\w-]+)\/([a-z0-9]+)$/.exec(link);
  if (!m) return null;
  const spec = SPECS.find((s) => s.key === m[2]);
  if (!spec) return null;
  return { tmdbId: Number(m[1]), token: m[1]!, key: spec.key, size: spec.size, resolution: parseInt(spec.resolution, 10) };
}

function fakeEpisodeRelease(imdb: string, season: number, episode: number, key: "ep1080" | "ep720"): Release {
  const show = fakeShow(imdb)!;
  const spec = SPECS.find((s) => s.key === key)!;
  const se = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return {
    id: `${imdb}-${se}-${key}`,
    rawTitle: `${show.title.replace(/\W+/g, ".")}.${se}.${spec.resolution}.${spec.quality}.${spec.codec}-FAKE`,
    indexer: "fake",
    link: `fake://${imdb}${se.toLowerCase()}/${key}`,
    imdbId: imdb,
    seeders: spec.seeders,
    peers: spec.seeders * 2,
    sizeBytes: spec.size,
    info: { title: show.title, season, episode, resolution: spec.resolution, quality: spec.quality, source: spec.source, codec: spec.codec, audio: spec.audio },
  };
}

export function fakeChill(opts: { mediaUrl: (fileId: number) => string; latencyMs?: number }): ChillApi {
  const wait = () => new Promise((r) => setTimeout(r, opts.latencyMs ?? 150));
  return {
    async search(query): Promise<Release[]> {
      await wait();
      const ep = /^(.*) S(\d{2})E(\d{2})$/i.exec(query.trim());
      if (ep) {
        const show = FAKE_SHOWS.find((x) => normalizeTitle(x[1]) === normalizeTitle(ep[1]!));
        return show ? (["ep1080", "ep720"] as const).map((k) => fakeEpisodeRelease(show[0], Number(ep[2]), Number(ep[3]), k)) : [];
      }
      const q = normalizeTitle(query.replace(/\s+(19|20)\d{2}$/, ""));
      const movie = fakeMovies().find((m) => normalizeTitle(m.title) === q);
      if (!movie || movie.id === FAKE_NO_RELEASES_ID) return [];
      const year = Number(movie.release_date?.slice(0, 4));
      const imdb = fakeDetail(movie.id)?.imdb_id ?? undefined;
      return SPECS.map((s) => ({
        id: `${movie.id}-${s.key}`,
        rawTitle: `${movie.title.replace(/\W+/g, ".")}.${year + (s.yearDelta ?? 0)}.${s.resolution}.${s.quality}.${s.codec}-FAKE`,
        indexer: "fake",
        link: `fake://${movie.id}/${s.key}`,
        imdbId: s.yearDelta ? undefined : imdb,
        seeders: s.seeders,
        peers: s.seeders * 2,
        sizeBytes: s.size,
        info: { title: movie.title, year: year + (s.yearDelta ?? 0), resolution: s.resolution, quality: s.quality, source: s.source, codec: s.codec, hdr: s.hdr, audio: s.audio },
      }));
    },
    async tvShows(source) {
      await wait();
      return FAKE_SHOWS.filter((s) => source === "ALL_PROVIDERS" || s[4] === source).map((s) => fakeShow(s[0])!);
    },
    async tvShowDetail(imdb) {
      await wait();
      const show = fakeShow(imdb);
      if (!show) throw Object.assign(new Error(`chill: no show ${imdb}`), { status: 404 });
      const seasons = Array.from({ length: FAKE_SEASONS }, (_, i) => ({ seasonNumber: i + 1, name: `Season ${i + 1}`, episodeCount: FAKE_EPISODES, airDate: `${show.year! + i}-07-15`, posterUrl: null }));
      return { show, seasons };
    },
    async tvSeason(imdb, season) {
      await wait();
      const show = fakeShow(imdb);
      if (!show || season < 1 || season > FAKE_SEASONS) return [];
      return Array.from({ length: FAKE_EPISODES }, (_, i) => ({
        seasonNumber: season, episodeNumber: i + 1, name: `Chapter ${season * 10 + i + 1}`, overview: `Episode ${i + 1} of season ${season} of ${show.title}.`,
        airDate: `${show.year! + season - 1}-07-${String(15 + i).padStart(2, "0")}`, runtime: 3, stillUrl: null, rating: 8,
      }));
    },
    async tvEpisodeDownload(imdb, season, episode) {
      await wait();
      return fakeShow(imdb) ? fakeEpisodeRelease(imdb, season, episode, "ep1080") : null;
    },
    async resolvePlayback(fileId, delivery) {
      if (delivery === "HLS") return { kind: "unavailable", reason: "UNAVAILABLE_REASON_CONVERSION_REQUIRED" };
      return { kind: "ready", url: opts.mediaUrl(fileId), subtitles: [] };
    },
    async startConversion() {
      return "unavailable";
    },
  };
}

// ---------------------------------------------------------------- put.io

interface FakeTransfer {
  id: number;
  name: string;
  link: string;
  parentId: number;
  size: number;
  startedAt: number;
  durationMs: number;
  cancelled: boolean;
  fileId: number | null;
}

interface FakeFile extends PutioFile {
  /** Real bytes served for this VIDEO file. */
  sample?: keyof Samples;
}

/** Demo title whose copies carry E-AC3 audio in MKV, like most real releases. */
export const FAKE_EAC3_ID = 496243; // Parasite

interface FakeState {
  nextId: number;
  files: FakeFile[];
  transfers: FakeTransfer[];
}

export interface FakePutio extends PutioApi {
  /** Local path of the bytes behind a fake put.io VIDEO file. */
  mediaPath(fileId: number): string | null;
  state(): FakeState;
}

export function fakePutio(opts: {
  clock: Clock;
  samples: Samples | null;
  stateFile?: string;
  quotaBytes?: number;
  timings: { instantS: number; targetS: number };
  mediaUrl: (fileId: number) => string;
}): FakePutio {
  let st: FakeState = { nextId: 1000, files: [], transfers: [] };
  if (opts.stateFile && fs.existsSync(opts.stateFile)) st = JSON.parse(fs.readFileSync(opts.stateFile, "utf8")) as FakeState;
  const save = () => {
    if (opts.stateFile) {
      fs.mkdirSync(path.dirname(opts.stateFile), { recursive: true });
      fs.writeFileSync(opts.stateFile, JSON.stringify(st));
    }
  };
  const id = () => st.nextId++;
  const quota = opts.quotaBytes ?? 100e9;
  const used = () => st.files.filter((f) => f.fileType !== "FOLDER").reduce((s, f) => s + f.size, 0);

  function settle(t: FakeTransfer): PutioTransfer {
    const elapsed = opts.clock.now() - t.startedAt;
    const pct = t.cancelled ? 0 : Math.min(100, Math.floor((elapsed / t.durationMs) * 100));
    if (pct >= 100 && t.fileId === null) {
      const folder: FakeFile = { id: id(), name: t.name, size: 0, fileType: "FOLDER", parentId: t.parentId };
      const meta = fakeReleaseSize(t.link);
      const eac3 = meta?.tmdbId === FAKE_EAC3_ID;
      const video: FakeFile = {
        id: id(), name: `${t.name}.${eac3 ? "mkv" : "mp4"}`, size: t.size, fileType: "VIDEO", parentId: folder.id, contentType: eac3 ? "video/x-matroska" : "video/mp4",
        sample: eac3 ? "instantEac3" : meta && meta.resolution >= 2160 ? "target" : "instant",
      };
      const nfo: FakeFile = { id: id(), name: `${t.name}.nfo`, size: 2_000, fileType: "TEXT", parentId: folder.id };
      st.files.push(folder, video, nfo);
      t.fileId = folder.id;
      save();
    }
    const done = pct >= 100;
    return {
      id: t.id, name: t.name, size: t.size, fileId: t.fileId, error: null,
      status: t.cancelled ? "ERROR" : done ? "COMPLETED" : pct === 0 ? "IN_QUEUE" : "DOWNLOADING",
      percentDone: pct,
      etaS: done ? 0 : Math.max(1, Math.round((t.durationMs - elapsed) / 1000)),
    };
  }

  const api: FakePutio = {
    async ensureFolder(name) {
      const f = st.files.find((x) => x.fileType === "FOLDER" && x.parentId === 0 && x.name === name);
      if (f) return f.id;
      const folder = { id: id(), name, size: 0, fileType: "FOLDER", parentId: 0 };
      st.files.push(folder);
      save();
      return folder.id;
    },
    async addTransfer(link, parentId) {
      const meta = fakeReleaseSize(link);
      if (!meta) throw Object.assign(new Error("put.io /transfers/add → HTTP 400: invalid url"), { status: 400 });
      if (used() + meta.size > quota) throw Object.assign(new Error("put.io /transfers/add → HTTP 403: not enough disk space"), { status: 403 });
      const t: FakeTransfer = {
        id: id(), name: `${meta.token}.${meta.key}`, link, parentId, size: meta.size, startedAt: opts.clock.now(),
        durationMs: (meta.resolution >= 2160 ? opts.timings.targetS : opts.timings.instantS) * 1000, cancelled: false, fileId: null,
      };
      st.transfers.push(t);
      save();
      return settle(t);
    },
    async getTransfer(tid) {
      const t = st.transfers.find((x) => x.id === tid);
      if (!t) throw Object.assign(new Error(`put.io /transfers/${tid} → HTTP 404`), { status: 404 });
      return settle(t);
    },
    async cancelTransfers(ids) {
      for (const t of st.transfers) if (ids.includes(t.id)) t.cancelled = true;
      save();
    },
    async listFiles(parentId) {
      return st.files.filter((f) => f.parentId === parentId).map(({ sample: _s, ...f }) => f);
    },
    async getFile(fid) {
      const f = st.files.find((x) => x.id === fid);
      if (!f) throw Object.assign(new Error(`put.io /files/${fid} → HTTP 404`), { status: 404 });
      const { sample: _s, ...rest } = f;
      return rest;
    },
    async downloadUrl(fid) {
      return opts.mediaUrl(fid);
    },
    async deleteFiles(ids) {
      const doomed = new Set(ids);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of st.files) if (!doomed.has(f.id) && doomed.has(f.parentId)) (doomed.add(f.id), (grew = true));
      }
      st.files = st.files.filter((f) => !doomed.has(f.id));
      save();
    },
    async accountDisk() {
      return { size: quota, used: used(), avail: quota - used() };
    },
    async subtitles(fid) {
      const f = st.files.find((x) => x.id === fid);
      if (!f?.sample) return [];
      const base = f.name.replace(/\.\w+$/, "");
      return [
        { key: "en", language: "English", name: `${base}.en.srt`, source: "folder" },
        { key: "es", language: "Spanish", name: `${base}.es.srt`, source: "folder" },
      ];
    },
    async subtitleText(fid, key, format) {
      const f = st.files.find((x) => x.id === fid);
      if (!f?.sample) throw Object.assign(new Error(`put.io /files/${fid}/subtitles → HTTP 404`), { status: 404 });
      return sampleSubtitles(key, SAMPLE_SECONDS, f.sample === "target" ? TARGET_LEAD_IN_S : 0, format);
    },
    mediaPath(fid) {
      const f = st.files.find((x) => x.id === fid);
      if (!f?.sample || !opts.samples) return null;
      return opts.samples[f.sample];
    },
    state: () => st,
  };
  return api;
}

export function fakeServices(o: Parameters<typeof fakePutio>[0] & { chillLatencyMs?: number }): Services & { putio: FakePutio } {
  return { tmdb: fakeTmdb(), chill: fakeChill({ mediaUrl: o.mediaUrl, latencyMs: o.chillLatencyMs }), putio: fakePutio(o) };
}
