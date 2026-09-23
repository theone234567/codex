import { useCallback, useEffect, useRef, useState } from "react";
import Header from "../components/Header";
import Thumb from "../components/Thumb";
import { analyzeItem, getItem, listItems, updateItem } from "../lib/api";
import { itemsToCsv } from "../lib/csv";
import type { Item } from "../lib/types";

const CONCURRENCY = 3;
const STALE_MS = 3 * 60_000;

type Filter = "all" | "check" | "ready" | "listed";

function needsAi(i: Item): boolean {
  if (!i.photos.length) return false;
  if (i.ai_status === "pending") return true;
  return i.ai_status === "processing" && Date.now() - new Date(i.ai_updated_at ?? 0).getTime() > STALE_MS;
}

export default function BatchView({ batchId }: { batchId: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const itemsRef = useRef<Item[]>([]);
  const inFlight = useRef(new Set<string>());
  const failedThisSession = useRef(new Set<string>());

  const setAll = (list: Item[]) => { itemsRef.current = list; setItems(list); };
  const replace = (it: Item) => setAll(itemsRef.current.map((x) => (x.id === it.id ? it : x)));

  useEffect(() => {
    listItems(batchId).then(setAll).catch((e) => setError(e.message));
  }, [batchId]);

  const pump = useCallback(() => {
    if (paused) return;
    const queue = itemsRef.current.filter((i) => needsAi(i) && !inFlight.current.has(i.id) && !failedThisSession.current.has(i.id));
    while (inFlight.current.size < CONCURRENCY && queue.length) {
      const item = queue.shift()!;
      inFlight.current.add(item.id);
      setRunning(new Set(inFlight.current));
      analyzeItem(item)
        .catch((e: Error) => {
          failedThisSession.current.add(item.id);
          if (/limit/i.test(e.message)) { setPaused(true); setError(e.message); }
        })
        .finally(async () => {
          inFlight.current.delete(item.id);
          setRunning(new Set(inFlight.current));
          try { replace(await getItem(item.id)); } catch { /* ignore */ }
        });
    }
  }, [paused]);

  useEffect(() => { pump(); }, [items, pump]);

  async function retry(item: Item) {
    failedThisSession.current.delete(item.id);
    await updateItem(item.id, { ai_status: "pending" });
    replace({ ...item, ai_status: "pending", ai_error: null });
  }

  function exportCsv() {
    const blob = new Blob(["﻿" + itemsToCsv(items ?? [])], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "klicklist.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const list = items ?? [];
  const done = list.filter((i) => i.ai_status === "done").length;
  const waiting = list.filter((i) => needsAi(i)).length;
  const shown = list.filter((i) =>
    filter === "all" ? true
      : filter === "check" ? i.status === "draft" && (i.needs_check.length > 0 || i.ai_status === "failed")
      : filter === "ready" ? i.status === "ready"
      : i.status === "listed" || i.status === "sold");

  return (
    <>
      <Header back="#/" title="Items" right={<a className="link" href={`#/b/${batchId}/capture`}>+ Add</a>} />
      <main className="page">
        <div className="card stack">
          <div className="row">
            <span className="grow">
              AI: <b>{done}</b>/{list.length} written
              {waiting > 0 && !paused && <span className="muted"> · {running.size} working, {waiting} waiting</span>}
            </span>
            {waiting > 0 && (
              <button className="link" onClick={() => setPaused((p) => !p)}>{paused ? "Resume AI" : "Pause AI"}</button>
            )}
          </div>
          {list.length > 0 && <progress max={list.length} value={done} />}
          <div className="row wrap">
            <a className="button primary grow" href={`#/b/${batchId}/list`}>⚡ Quick list on Trade Me</a>
            <button className="button" onClick={exportCsv} disabled={!list.length}>Export CSV</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}

        <div className="tabs">
          {(["all", "check", "ready", "listed"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {{ all: "All", check: "Check", ready: "Ready", listed: "Listed" }[f]}
            </button>
          ))}
        </div>

        {items === null ? <p className="muted">Loading…</p> : shown.length === 0 ? (
          <p className="muted center">Nothing here yet.</p>
        ) : (
          <ul className="grid">
            {shown.map((i) => (
              <li key={i.id} className="card tile">
                <a href={`#/i/${i.id}`}>
                  <Thumb photo={i.photos[0]} />
                  <div className="tile-body">
                    <b className="clamp">{i.title || (running.has(i.id) ? "AI is writing…" : i.photos.length ? "Waiting for AI" : "No photos")}</b>
                    <span className="row small">
                      {i.start_price != null && <span>${Number(i.start_price).toFixed(0)}</span>}
                      <span className={`pill ${i.status}`}>{i.status}</span>
                      {i.needs_check.length > 0 && i.status === "draft" && <span className="pill warn">check</span>}
                    </span>
                  </div>
                </a>
                {i.ai_status === "failed" && (
                  <div className="tile-err">
                    <span className="small">{i.ai_error}</span>
                    <button className="link" onClick={() => retry(i)}>Retry</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
