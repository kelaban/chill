import type { StorageReport, TierReport } from "@chill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtBytes } from "../api";
import { FocusGroup, Focusable } from "../components/Focusable";
import { Page, useInitialFocus } from "../components/ui";
import { useServerEvents } from "../events";

const TIER_NAME = { putio: "put.io (staging)", local: "Home server (library)" } as const;

function Bar({ t }: { t: TierReport }) {
  const pct = Math.min(100, (t.usedBytes / t.budgetBytes) * 100);
  return (
    <div className="mb-3">
      <div className="mb-2 flex justify-between text-xl">
        <span className="font-semibold">{TIER_NAME[t.tier]}</span>
        <span className="text-white/70" data-testid={`usage-${t.tier}`}>
          {fmtBytes(t.usedBytes)} of {fmtBytes(t.budgetBytes)}
        </span>
      </div>
      <div className="relative h-4 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full ${pct > t.highWatermark * 100 ? "bg-accent" : "bg-ok"}`} style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-white/60" style={{ left: `${t.highWatermark * 100}%` }} title="cleanup starts" />
      </div>
    </div>
  );
}

export function Downloads() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["storage"], queryFn: api.storage, refetchInterval: 5000 });
  useServerEvents((e) => {
    if (e.type === "storage") qc.setQueryData<StorageReport>(["storage"], e.report);
  });
  useInitialFocus("storage-list", !!data);
  if (!data) return <Page>{null}</Page>;
  const refresh = () => qc.invalidateQueries({ queryKey: ["storage"] });

  return (
    <Page>
      <div className="grid grid-cols-2 gap-16 px-16">
        <div>
          <h1 className="mb-6 text-4xl font-bold">Storage</h1>
          {data.tiers.map((t) => (
            <Bar key={t.tier} t={t} />
          ))}
          <p className="mt-4 text-lg text-white/50">put.io is a staging area: once a copy is safely home, it's deleted there. Cleanup starts at the line and stops at {Math.round((data.tiers[0]?.lowWatermark ?? 0.75) * 100)}%.</p>
          <h2 className="mb-4 mt-10 text-2xl font-bold">In progress</h2>
          {data.jobs.length === 0 && data.waiting.length === 0 && <div className="text-xl text-white/50">Nothing downloading.</div>}
          {data.waiting.map((w, i) => (
            <div key={i} className="mb-2 text-xl text-yellow-300">
              {w}
            </div>
          ))}
          {data.jobs.map((j) => (
            <div key={j.id} className="mb-4" data-testid="job">
              <div className="flex justify-between text-xl">
                <span>{j.title ?? j.type}</span>
                <span className="text-white/60">{j.detail}</span>
              </div>
              {j.percent !== null && (
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-white transition-all" style={{ width: `${j.percent}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
        <FocusGroup focusKey="storage-list" className="flex flex-col gap-3">
          {data.tiers.flatMap((t) => t.variants).length === 0 && <div className="pt-16 text-xl text-white/50">Nothing stored yet.</div>}
          {data.tiers.flatMap((t) =>
            t.variants.map((v) => (
              <div key={v.id} data-row={`v-${v.id}`} className="flex items-center gap-4 rounded-lg bg-white/5 p-4" data-testid="variant">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xl font-semibold">{v.title}</div>
                  <div className="text-lg text-white/60">
                    {v.location === "local" ? "Home" : "put.io"} · {v.label} · <span className="text-white/80">{v.status}</span>
                  </div>
                </div>
                <Focusable onEnter={async () => (await api.pin(v.id, !v.pinned), refresh())} className="rounded px-4 py-2 text-lg ring-2 ring-white/30" focusedClassName="!ring-white bg-white text-black">
                  {v.pinned ? "Unpin" : "Pin"}
                </Focusable>
                <Focusable onEnter={async () => (await api.evict(v.id), refresh())} className="rounded px-4 py-2 text-lg ring-2 ring-white/30" focusedClassName="!ring-accent bg-accent">
                  Delete
                </Focusable>
              </div>
            )),
          )}
        </FocusGroup>
      </div>
    </Page>
  );
}
