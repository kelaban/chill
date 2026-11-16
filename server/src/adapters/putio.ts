import { http, HttpError, httpJson } from "../http.js";
import type { PutioApi, PutioFile, PutioSubtitle, PutioTransfer } from "./types.js";

// put.io API v2. Endpoint shapes per https://api.put.io/v2/docs (Swagger);
// re-verify against the live docs with `npm run test:live`.
const API = "https://api.put.io/v2";

const toTransfer = (t: any): PutioTransfer => ({
  id: t.id,
  name: t.name ?? "",
  status: t.status,
  percentDone: t.percent_done ?? 0,
  etaS: t.estimated_time ?? null,
  fileId: t.file_id ?? null,
  error: t.error_message ?? null,
  size: t.size ?? 0,
});

const toFile = (f: any): PutioFile => ({
  id: f.id,
  name: f.name,
  size: f.size ?? 0,
  fileType: f.file_type,
  parentId: f.parent_id ?? 0,
  contentType: f.content_type,
});

export function putioClient(token: string): PutioApi {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const get = <T>(path: string, q: Record<string, string | number> = {}) => {
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
    return httpJson<T>(u.toString(), { headers, what: `put.io ${path}` });
  };
  const post = <T>(path: string, form: Record<string, string | number>) =>
    httpJson<T>(API + path, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString(),
      what: `put.io ${path}`,
    });

  const api: PutioApi = {
    async ensureFolder(name) {
      const root = await api.listFiles(0);
      const existing = root.find((f) => f.fileType === "FOLDER" && f.name === name);
      if (existing) return existing.id;
      const r = await post<{ file: any }>("/files/create-folder", { name, parent_id: 0 });
      return r.file.id;
    },
    async addTransfer(url, parentId) {
      return toTransfer((await post<{ transfer: any }>("/transfers/add", { url, save_parent_id: parentId })).transfer);
    },
    async getTransfer(id) {
      return toTransfer((await get<{ transfer: any }>(`/transfers/${id}`)).transfer);
    },
    async cancelTransfers(ids) {
      if (ids.length) await post("/transfers/cancel", { transfer_ids: ids.join(",") });
    },
    async listFiles(parentId) {
      return (await get<{ files: any[] }>("/files/list", { parent_id: parentId, per_page: 1000 })).files.map(toFile);
    },
    async getFile(id) {
      return toFile((await get<{ file: any }>(`/files/${id}`)).file);
    },
    async downloadUrl(fileId) {
      return (await get<{ url: string }>(`/files/${fileId}/url`)).url;
    },
    async deleteFiles(ids) {
      if (ids.length) await post("/files/delete", { file_ids: ids.join(",") });
    },
    async subtitles(fileId) {
      // Shape per put.io's own API client (@putdotio/api-client: GET /files/{id}/subtitles);
      // parsed tolerantly — DECISIONS D37.
      const r = await get<{ subtitles?: any[] }>(`/files/${fileId}/subtitles`);
      return (r.subtitles ?? [])
        .filter((s) => s && s.key)
        .map((s): PutioSubtitle => ({ key: String(s.key), language: s.language_code ?? s.language ?? null, name: String(s.name ?? s.key), source: String(s.source ?? "unknown") }));
    },
    async subtitleText(fileId, key, format) {
      const res = await http(`${API}/files/${fileId}/subtitles/${encodeURIComponent(key)}?format=${format}`, { headers });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "put.io subtitle");
      return res.text();
    },
    async accountDisk() {
      const r = await get<{ info: { disk: { size: number; used: number; avail: number } } }>("/account/info");
      return r.info.disk;
    },
  };
  return api;
}
