import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setProfileId } from "../api";
import { FocusGroup, Focusable } from "../components/Focusable";
import { useInitialFocus } from "../components/ui";

const COLORS = ["#e50914", "#46d369", "#2f80ed", "#f2c94c", "#bb6bd9", "#f2994a"];

export function Profiles() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  useInitialFocus("profile-0", !!data);

  const choose = (id: number) => {
    setProfileId(id);
    qc.clear();
    nav("/", { replace: true });
  };
  const add = async () => {
    if (!name.trim()) return;
    const p = await api.addProfile(name.trim(), COLORS[(data?.length ?? 0) % COLORS.length]!);
    setAdding(false);
    setName("");
    await qc.invalidateQueries({ queryKey: ["profiles"] });
    choose(p.id);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center">
      <h1 className="mb-12 text-5xl font-semibold">Who's watching?</h1>
      <FocusGroup focusKey="profiles" className="flex gap-10">
        {data?.map((p, i) => (
          <Focusable key={p.id} focusKey={`profile-${i}`} testId={`profile-${p.id}`} onEnter={() => choose(p.id)} className="flex flex-col items-center gap-4 text-white/70" focusedClassName="!text-white">
            {(f) => (
              <>
                <div className={`flex h-40 w-40 items-center justify-center rounded-lg text-6xl font-black transition-transform ${f ? "scale-110 ring-4 ring-white" : ""}`} style={{ background: p.color }}>
                  {p.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="text-2xl">{p.name}</div>
              </>
            )}
          </Focusable>
        ))}
        <Focusable testId="profile-add" onEnter={() => setAdding(true)} className="flex flex-col items-center gap-4 text-white/60" focusedClassName="!text-white">
          {(f) => (
            <>
              <div className={`flex h-40 w-40 items-center justify-center rounded-lg border-4 border-white/30 text-7xl transition-transform ${f ? "scale-110 border-white" : ""}`}>+</div>
              <div className="text-2xl">Add profile</div>
            </>
          )}
        </Focusable>
      </FocusGroup>
      {adding && (
        <form
          className="mt-12 flex gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="rounded bg-white/10 px-5 py-3 text-2xl outline-none ring-2 ring-white/40 focus:ring-white" />
          <button className="rounded bg-white px-6 py-3 text-2xl font-semibold text-black">Save</button>
        </form>
      )}
    </div>
  );
}
