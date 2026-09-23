import { useCallback, useEffect, useRef, useState } from "react";
import Header from "../components/Header";
import Thumb from "../components/Thumb";
import { analyzeItem, getItem, getSettings, listItems, makeWhite, priceCheck, updateItem } from "../lib/api";
import { itemsToCsv } from "../lib/csv";
import { DEFAULT_PREFS, type Item, type Photo, type Prefs } from "../lib/types";

const AI_CONCURRENCY = 3;
const PRICE_CONCURRENCY = 2;
const STALE_MS = 3 * 60_000;

type Filter = "all" | "check" | "ready" | "listed";

function needsAi(i: Item): boolean {
  if (!i.photos.length) return false;
  if (i.ai_status === "pending") return true;
  return i.ai_status === "processing" && Date.now() - new Date(i.ai_updated_at ?? 0).getTime() > STALE_MS;
}

function needsWhite(p: Photo, prefs: Prefs): boolean {
  return p.bg_status === "none" && (prefs.whiteBg === "all" || (prefs.whiteBg === "main" && p.position === 0));
}

function needsPrice(i: Item, prefs: Prefs): boolean {
  return prefs.autoPriceCheck && i.ai_status === "done" && i.status === "draft" && !i.price_checked_at
    && (i.start_price ?? 0) >= prefs.priceCheckMin;
}

export default function BatchView({ batchId }: { batchId: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [whiteBusy, setWhiteBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const itemsRef = useRef<Item[]>([]);
  const inFlight = useRef(new Set<string>());
  const priceFlight = useRef(new Set<string>());
  const whiteFlight = useRef(false);
  const failed = useRef(new Set<string>()); // item/photo ids that failed this session: don't loop on them

  const setAll = (list: Item[]) => { itemsRef.current = list; setItems(list); };
  const refresh = async (id: string) => {
    try {
      const it = await getItem(id);
      setAll(itemsRef.current.map((x) => (x.id === it.id ? it : x)));
    } catch { /* ignore */ }
  };

  useEffect(() => {
    listItems(batchId).then(setAll).catch((e) => setError(e.message));
    getSettings().then((s) => setPrefs(s.prefs)).catch(() => {});
  }, [batchId]);

  const pump = useCallback(() => {
    if (paused) return;
    const list = itemsRef.current;

    // 1. AI writes listings
    const queue = list.filter((i) => needsAi(i) && !inFlight.current.has(i.id) && !failed.current.has(i.id));
    while (inFlight.current.size < AI_CONCURRENCY && queue.length) {
      const item = queue.shift()!;
      inFlight.current.add(item.id);
      setRunning(new Set(inFlight.current));
      analyzeItem(item)
        .catch((e: Error) => {
          failed.current.add(item.id);
          if (/limit/i.test(e.message)) { setPaused(true); setError(e.message); }
        })
        .finally(async () => {
          inFlight.current.delete(item.id);
          setRunning(new Set(inFlight.current));
          await refresh(item.id);
        });
    }

    // 2. Online price checks (cheap, only for items worth it)
    const pq = list.filter((i) => needsPrice(i, prefs) && !priceFlight.current.has(i.id) && !failed.current.has(`p${i.id}`));
    while (priceFlight.current.size < PRICE_CONCURRENCY && pq.length) {
      const item = pq.shift()!;
      priceFlight.current.add(item.id);
      priceCheck(item)
        .catch((e: Error) => {
          failed.current.add(`p${item.id}`);
          if (/limit/i.test(e.message)) { setPaused(true); setError(e.message); }
        })
        .finally(async () => { priceFlight.current.delete(item.id); await refresh(item.id); });
    }

    // 3. White backgrounds, one photo at a time on this device
    if (!whiteFlight.current && prefs.whiteBg !== "off") {
      for (const item of list) {
        const photo = item.photos.find((p) => needsWhite(p, prefs) && !failed.current.has(p.id));
        if (!photo) continue;
        whiteFlight.current = true;
        setWhiteBusy(true);
        makeWhite(photo)
          .catch(() => failed.current.add(photo.id))
          .finally(async () => { whiteFlight.current = false; setWhiteBusy(false); await refresh(item.id); });
        break;
      }
    }
  }, [paused, prefs]);

  useEffect(() => { pump(); }, [items, pump]);

  async function retry(item: Item) {
    failed.current.delete(item.id);
    await updateItem(item.id, { ai_status: "pending" });
    setAll(itemsRef.current.map((x) => (x.id === item.id ? { ...x, ai_status: "pending", ai_error: null } : x)));
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
  const whiteLeft = prefs.whiteBg === "off" ? 0
    : list.reduce((n, i) => n + i.photos.filter((p) => needsWhite(p, prefs) && !failed.current.has(p.id)).length, 0);
  const priceLeft = list.filter((i) => needsPrice(i, prefs) && !failed.current.has(`p${i.id}`)).length;
  const drafts = list.filter((i) => i.status === "draft" && i.ai_status === "done");
  const approved = list.filter((i) => i.status === "ready").length;
  const shown = list.filter((i) =>
    filter === "all" ? true
      : filter === "check" ? i.status === "draft" && (i.needs_check.length > 0 || i.ai_status === "failed")
      : filter === "ready" ? i.status === "ready"
      : i.status === "listed" || i.status === "sold");
  const busyAnything = waiting > 0 || whiteLeft > 0 || priceLeft > 0;

  return (
    <>
      <Header back="#/" title="Items" right={<a className="link" href={`#/b/${batchId}/capture`}>+ Add items</a>} />
      <main className="page">
        <div className="card stack">
          <div className="row wrap">
            <span className="grow">
              AI: <b>{done}</b>/{list.length} written
              {waiting > 0 && !paused && <span className="muted"> · {running.size} working, {waiting} waiting</span>}
            </span>
            {busyAnything && (
              <button className="link" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</button>
            )}
          </div>
          {list.length > 0 && <progress max={list.length} value={done} />}
          {(whiteLeft > 0 || priceLeft > 0) && !paused && (
            <span className="muted small">
              {whiteLeft > 0 && <>⬜ White backgrounds: {whiteLeft} to go{whiteBusy ? "…" : ""} (keep this page open) </>}
              {priceLeft > 0 && <>· 🔎 Price checks: {priceLeft} to go</>}
            </span>
          )}
          <div className="row wrap">
            <button className="button primary grow" disabled={!drafts.length} onClick={() => { location.hash = `#/i/${drafts[0].id}/review`; }}>
              ✓ Review &amp; approve ({drafts.length})
            </button>
            <a className={`button grow ${approved ? "primary" : ""}`} href={`#/b/${batchId}/export`}>⬆ Upload to Trade Me ({approved})</a>
          </div>
          <div className="row wrap small">
            <a className="link" href={`#/b/${batchId}/list`}>Copy-paste mode</a>
            <button className="link" onClick={exportCsv} disabled={!list.length}>Spreadsheet (CSV)</button>
            <a className="link" href="#/settings">Settings</a>
          </div>
        </div>
        {error && <p className="error">{error}</p>}

        <div className="tabs">
          {(["all", "check", "ready", "listed"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {{ all: "All", check: "Check", ready: "Approved", listed: "Listed" }[f]}
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
                    <span className="row small wrap">
                      {i.start_price != null && <span>${Number(i.start_price).toFixed(0)}</span>}
                      <span className={`pill ${i.status}`}>{i.status === "ready" ? "approved" : i.status}</span>
                      {i.needs_check.length > 0 && i.status === "draft" && <span className="pill warn">check</span>}
                      {i.price_check?.found && <span className="pill" title={i.price_check.summary}>🔎</span>}
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
