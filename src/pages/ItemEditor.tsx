import { useEffect, useState } from "react";
import Header from "../components/Header";
import Thumb from "../components/Thumb";
import {
  analyzeItem, deleteItem, deletePhoto, getItem, listItems, makeWhite, mergeInto, priceCheck, rememberCategory,
  updateItem, updatePhoto,
} from "../lib/api";
import { go } from "../lib/router";
import type { Item, ItemStatus, Photo } from "../lib/types";
import { CONDITIONS, DESCRIPTION_MAX, SHIPPING_SIZES, SUBTITLE_MAX, TITLE_MAX } from "../../supabase/functions/_shared/limits";

/** Edit one listing. In review mode, "Approve & next" walks through every draft in the batch. */
export default function ItemEditor({ itemId, review = false }: { itemId: string; review?: boolean }) {
  const [item, setItem] = useState<Item | null>(null);
  const [draft, setDraft] = useState<Item | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(true);
  const [left, setLeft] = useState<number | null>(null);

  const load = async () => {
    const it = await getItem(itemId);
    setItem(it);
    setDraft(it);
    setSaved(true);
    if (review) {
      const all = await listItems(it.batch_id);
      setLeft(all.filter((i) => i.status === "draft").length);
    }
  };
  useEffect(() => { load().catch((e) => setError(e.message)); }, [itemId]);

  // Desktop shortcut: Ctrl/Cmd + Enter = approve (& next in review mode)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft && (e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); approve().catch(() => {}); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!draft || !item) return <main className="page"><p className="muted">{error || "Loading…"}</p></main>;

  const set = <K extends keyof Item>(k: K, v: Item[K]) => { setDraft({ ...draft, [k]: v }); setSaved(false); };

  async function save(extra: Partial<Item> = {}) {
    const d = { ...draft!, ...extra };
    setBusy("Saving…");
    try {
      await updateItem(d.id, {
        title: d.title, subtitle: d.subtitle, description: d.description, category_path: d.category_path,
        condition: d.condition, start_price: d.start_price, buy_now_price: d.buy_now_price,
        shipping_size: d.shipping_size, attributes: d.attributes, status: d.status, hint: d.hint,
        tm_category: d.tm_category,
      });
      if (d.tm_category && d.tm_category !== item!.tm_category) await rememberCategory(d.category_path, d.tm_category);
      setDraft(d);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy("");
    }
  }

  async function nextDraft(): Promise<string | null> {
    const all = await listItems(draft!.batch_id);
    const idx = all.findIndex((i) => i.id === draft!.id);
    const after = [...all.slice(idx + 1), ...all.slice(0, idx)];
    return after.find((i) => i.status === "draft")?.id ?? null;
  }

  async function approve() {
    if (busy) return;
    if (!draft!.title.trim()) return setError("Add a title first.");
    await save({ status: "ready" });
    if (review) {
      const next = await nextDraft();
      go(next ? `#/i/${next}/review` : `#/b/${draft!.batch_id}`);
    }
  }

  async function skip() {
    const next = await nextDraft();
    go(next ? `#/i/${next}/review` : `#/b/${draft!.batch_id}`);
  }

  async function setStatus(status: ItemStatus) {
    await save({ status });
  }

  async function rerun() {
    setBusy("AI is writing…");
    setError("");
    try {
      await save();
      await analyzeItem(draft!);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function checkPrice() {
    setBusy("Checking prices online…");
    setError("");
    try {
      if (!saved) await save();
      const r = await priceCheck(draft!);
      const fresh = await getItem(itemId);
      setItem(fresh);
      setDraft(r.applied ? fresh : { ...draft!, price_check: fresh.price_check, price_checked_at: fresh.price_checked_at });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  function usePriceCheck() {
    const c = draft!.price_check;
    if (!c) return;
    setDraft({ ...draft!, start_price: c.start, buy_now_price: c.buy_now });
    setSaved(false);
  }

  async function mergePrev() {
    const items = await listItems(draft!.batch_id);
    const idx = items.findIndex((i) => i.id === draft!.id);
    if (idx <= 0) return setError("This is the first item.");
    if (!confirm("Move these photos onto the previous item and delete this one?")) return;
    await mergeInto(items[idx - 1], items[idx]);
    go(`#/i/${items[idx - 1].id}`);
  }

  async function removeItem() {
    if (!confirm("Delete this item and its photos?")) return;
    await deleteItem(item!);
    go(`#/b/${item!.batch_id}`);
  }

  async function photoAction(p: Photo, action: "rotate" | "crop" | "delete" | "first" | "white" | "makeWhite") {
    if (action === "rotate") await updatePhoto(p.id, { rotation: ((p.rotation + 90) % 360) as Photo["rotation"] });
    if (action === "crop") await updatePhoto(p.id, { crop: null });
    if (action === "white") await updatePhoto(p.id, { use_white: !p.use_white });
    if (action === "makeWhite") {
      setBusy("Removing background…");
      try {
        if (!await makeWhite(p)) setError("Couldn't find a clear item in that photo - keeping the original.");
      } finally {
        setBusy("");
      }
    }
    if (action === "first") {
      const others = draft!.photos.filter((x) => x.id !== p.id);
      await Promise.all([p, ...others].map((x, i) => updatePhoto(x.id, { position: i })));
    }
    if (action === "delete") {
      if (!confirm("Delete this photo?")) return;
      await deletePhoto(p);
    }
    const fresh = await getItem(itemId);
    setItem(fresh);
    setDraft({ ...draft!, photos: fresh.photos });
  }

  const pc = draft.price_check;
  return (
    <>
      <Header back={`#/b/${draft.batch_id}`} title={review ? `Review${left !== null ? ` · ${left} left` : ""}` : "Edit item"} right={
        <button className="link" disabled={saved || !!busy} onClick={() => save()}>{saved ? "Saved" : "Save"}</button>
      } />
      <main className="page editor">
        <div className="editor-photos">
          <div className="photos">
            {draft.photos.map((p, i) => (
              <figure key={p.id}>
                <Thumb photo={p} />
                <figcaption className="row wrap small">
                  <button className="link" title="Rotate" onClick={() => photoAction(p, "rotate")}>↻</button>
                  {i > 0 && <button className="link" onClick={() => photoAction(p, "first")}>Main</button>}
                  {p.bg_status === "done"
                    ? <button className="link" onClick={() => photoAction(p, "white")}>{p.use_white ? "Original" : "White bg"}</button>
                    : <button className="link" onClick={() => photoAction(p, "makeWhite")}>{p.bg_status === "failed" ? "Retry white" : "White bg"}</button>}
                  {p.crop && !(p.use_white && p.bg_status === "done") && <button className="link" title="AI suggested a crop; tap to use the full photo" onClick={() => photoAction(p, "crop")}>Uncrop</button>}
                  <button className="link danger" title="Delete photo" onClick={() => photoAction(p, "delete")}>✕</button>
                </figcaption>
              </figure>
            ))}
          </div>

          {draft.needs_check.length > 0 && (
            <div className="card warn-box">
              <b>Please check</b>
              <ul>{draft.needs_check.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          )}
        </div>

        <div className="editor-form stack">
          {draft.ai_error && <p className="error">{draft.ai_error}</p>}
          {error && <p className="error">{error}</p>}
          {busy && <p className="muted">{busy}</p>}

          <div className="card stack">
            <label>Title <span className="muted small">{draft.title.length}/{TITLE_MAX}</span>
              <input value={draft.title} maxLength={TITLE_MAX} onChange={(e) => set("title", e.target.value)} />
            </label>
            <label>Subtitle (optional, Trade Me charges for this) <span className="muted small">{draft.subtitle.length}/{SUBTITLE_MAX}</span>
              <input value={draft.subtitle} maxLength={SUBTITLE_MAX} onChange={(e) => set("subtitle", e.target.value)} />
            </label>
            <label>Description
              <textarea rows={7} value={draft.description} maxLength={DESCRIPTION_MAX} onChange={(e) => set("description", e.target.value)} />
            </label>
            <div className="row wrap">
              <label className="grow">Category (AI suggestion)
                <input value={draft.category_path} maxLength={200} onChange={(e) => set("category_path", e.target.value)} />
              </label>
              <label style={{ flex: "0 1 170px" }}>Trade Me category code
                <input value={draft.tm_category} maxLength={60} placeholder="optional" onChange={(e) => set("tm_category", e.target.value.replace(/[^\w\-./ ]/g, ""))} />
              </label>
            </div>
            <div className="row wrap">
              <label className="grow">Condition
                <select value={draft.condition} onChange={(e) => set("condition", e.target.value as Item["condition"])}>
                  {CONDITIONS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="grow">Shipping
                <select value={draft.shipping_size} onChange={(e) => set("shipping_size", e.target.value)}>
                  {SHIPPING_SIZES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
            </div>
            <div className="row wrap">
              <label className="grow">Start price $
                <input type="number" inputMode="decimal" min={0} step="0.5" value={draft.start_price ?? ""}
                  onChange={(e) => set("start_price", e.target.value === "" ? null : Number(e.target.value))} />
              </label>
              <label className="grow">Buy Now $
                <input type="number" inputMode="decimal" min={0} step="0.5" value={draft.buy_now_price ?? ""}
                  onChange={(e) => set("buy_now_price", e.target.value === "" ? null : Number(e.target.value))} />
              </label>
            </div>
            {draft.price_reasoning && (
              <p className="muted small">Price note ({draft.price_confidence ?? "low"} confidence): {draft.price_reasoning}</p>
            )}
            {pc ? (
              <div className="card small stack price-box">
                <span>
                  <b>Online check:</b> {pc.found ? <>typically ${pc.typical ?? "?"} (range ${pc.low ?? "?"}–${pc.high ?? "?"})</> : "no close matches found"}
                  {" · "}suggests start ${pc.start}{pc.buy_now ? `, Buy Now $${pc.buy_now}` : ""}
                </span>
                {pc.summary && <span className="muted">{pc.summary}</span>}
                {pc.sources.length > 0 && (
                  <span className="muted">Sources: {pc.sources.map((s, i) => (
                    <a key={i} href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title || "link"}{i < pc.sources.length - 1 ? ", " : ""}</a>
                  ))}</span>
                )}
                <span className="row">
                  <button className="link" onClick={usePriceCheck}>Use these prices</button>
                  <button className="link" disabled={!!busy} onClick={checkPrice}>Check again</button>
                </span>
              </div>
            ) : (
              <button className="button small" disabled={!!busy || !draft.title} onClick={checkPrice}>🔎 Check price online (~2c)</button>
            )}

            <b>Details</b>
            {draft.attributes.map((a, i) => (
              <div key={i} className="row">
                <input style={{ flex: "0 0 35%" }} value={a.name} maxLength={40} onChange={(e) => set("attributes", draft.attributes.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input className="grow" value={a.value} maxLength={120} onChange={(e) => set("attributes", draft.attributes.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                <button className="link danger" onClick={() => set("attributes", draft.attributes.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button className="link" onClick={() => set("attributes", [...draft.attributes, { name: "", value: "" }])}>+ Add detail</button>
          </div>

          <div className="card stack">
            <label>Note for the AI (optional, e.g. "works, remote included")
              <input value={draft.hint} maxLength={300} onChange={(e) => set("hint", e.target.value)} />
            </label>
            <button className="button" disabled={!!busy || !draft.photos.length} onClick={rerun}>✨ Re-write with AI</button>
          </div>

          <div className="row wrap sticky-actions">
            {review ? (
              <>
                <button className="button" onClick={skip}>Skip</button>
                <button className="button primary grow" disabled={!!busy} onClick={() => approve().catch(() => {})} title="Ctrl/Cmd + Enter">✓ Approve &amp; next ›</button>
              </>
            ) : (
              <>
                {draft.status !== "ready" && <button className="button primary grow" disabled={!!busy} onClick={() => approve().catch(() => {})} title="Ctrl/Cmd + Enter">✓ Approve</button>}
                {draft.status === "ready" && <button className="button grow" onClick={() => setStatus("draft")}>Back to draft</button>}
                {draft.status !== "listed" && <button className="button" onClick={() => setStatus("listed")}>Listed</button>}
                {draft.status !== "sold" && <button className="button" onClick={() => setStatus("sold")}>Sold</button>}
              </>
            )}
          </div>
          <div className="row wrap">
            <button className="link" onClick={mergePrev}>Merge into previous item</button>
            <button className="link danger" onClick={removeItem}>Delete item</button>
          </div>
        </div>
      </main>
    </>
  );
}
