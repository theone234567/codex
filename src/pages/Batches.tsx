import { useEffect, useState, type FormEvent } from "react";
import Header from "../components/Header";
import { createBatch, deleteBatch, listBatches, usageToday } from "../lib/api";
import { go } from "../lib/router";
import { supabase } from "../lib/supabase";

type Row = Awaited<ReturnType<typeof listBatches>>[number];

export default function Batches() {
  const [batches, setBatches] = useState<Row[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof usageToday>>>(null);

  const load = () => listBatches().then(setBatches).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    usageToday().then(setUsage).catch(() => {});
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const b = await createBatch(name || `Batch ${new Date().toLocaleDateString("en-NZ")}`);
      go(`#/b/${b.id}/capture`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(b: Row) {
    if (!confirm(`Delete "${b.name}" and all its photos? This can't be undone.`)) return;
    await deleteBatch(b.id).catch((e) => setError(e.message));
    load();
  }

  return (
    <>
      <Header title="Batches" right={<><a className="link" href="#/settings">Settings</a><button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button></>} />
      <main className="page">
        <form onSubmit={add} className="card row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New batch name (e.g. Garage clear-out)" maxLength={80} />
          <button className="primary">+ New batch</button>
        </form>
        {error && <p className="error">{error}</p>}
        {batches === null ? <p className="muted">Loading…</p> : batches.length === 0 ? (
          <p className="muted center">No batches yet. Create one, then snap your items.</p>
        ) : (
          <ul className="list">
            {batches.map((b) => (
              <li key={b.id} className="card row">
                <a href={`#/b/${b.id}`} className="grow">
                  <b>{b.name}</b>
                  <span className="muted"> · {b.items[0]?.count ?? 0} items · {new Date(b.created_at).toLocaleDateString("en-NZ")}</span>
                </a>
                <button className="link danger" onClick={() => remove(b)}>Delete</button>
              </li>
            ))}
          </ul>
        )}
        {usage && (
          <p className="muted small center">
            AI today: {usage.calls} calls · {(usage.input_tokens + usage.output_tokens).toLocaleString()} tokens · about US${(usage.est_cost_micro_usd / 1e6).toFixed(3)}
          </p>
        )}
      </main>
    </>
  );
}
