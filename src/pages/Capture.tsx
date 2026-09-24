import { useEffect, useRef, useState } from "react";
import Header from "../components/Header";
import { addPhoto, createItem, listItems } from "../lib/api";
import { processPhoto } from "../lib/image";
import type { Item } from "../lib/types";

/**
 * Fast capture: shoot 1-3 photos of an item, tap "Next item", repeat.
 * Photos are tidied and uploaded in the background so you never wait.
 */
export default function Capture({ batchId, userId }: { batchId: string; userId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraOk, setCameraOk] = useState<boolean | null>(null);
  const [pending, setPending] = useState(0);
  const [itemCount, setItemCount] = useState(0);
  const [shots, setShots] = useState<string[]>([]); // local previews for the current item
  const [error, setError] = useState("");
  const [flash, setFlash] = useState(false);
  const [groupFiles, setGroupFiles] = useState<File[] | null>(null);
  const [toast, setToast] = useState("");
  const [dragging, setDragging] = useState(false);

  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef<{ item: Item; photos: number } | null>(null);
  const nextPos = useRef(0);

  useEffect(() => {
    listItems(batchId).then((items) => {
      nextPos.current = items.reduce((m, i) => Math.max(m, i.position + 1), 0);
      setItemCount(items.length);
    }).catch((e) => setError(e.message));
  }, [batchId]);

  // camera
  useEffect(() => {
    let stream: MediaStream | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraOk(true);
      } catch {
        setCameraOk(false);
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (pending > 0) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  /** Queue work so items/photos are created in the order they were shot. */
  function enqueue(task: () => Promise<void>) {
    setPending((n) => n + 1);
    chain.current = chain.current
      .then(task)
      .catch((e) => setError(`Upload problem: ${(e as Error).message}. Photo skipped.`))
      .finally(() => setPending((n) => n - 1));
  }

  async function addToCurrent(blob: Blob) {
    if (!current.current) {
      const item = await createItem(batchId, nextPos.current++);
      current.current = { item, photos: 0 };
      setItemCount((n) => n + 1);
    }
    const cur = current.current;
    const processed = await processPhoto(blob);
    await addPhoto(userId, cur.item, processed, cur.photos++);
  }

  function shoot() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    c.toBlob((blob) => {
      if (!blob) return;
      setShots((s) => [...s, URL.createObjectURL(blob)]);
      enqueue(() => addToCurrent(blob));
    }, "image/jpeg", 0.92);
  }

  function nextItem() {
    if (shots.length) {
      setToast(`✓ Item ${itemCount} saved – now shooting item ${itemCount + 1}`);
      setTimeout(() => setToast(""), 1800);
    }
    shots.forEach(URL.revokeObjectURL);
    setShots([]);
    chain.current = chain.current.then(() => { current.current = null; });
  }

  // Desktop shortcuts: Space = take photo, N or Enter = next item
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (groupFiles || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") { e.preventDefault(); shoot(); }
      if (e.key === "n" || e.key === "N" || e.key === "Enter") { e.preventDefault(); nextItem(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onFiles(files: FileList | null | undefined) {
    if (!files?.length) return;
    const list = [...files].filter((f) => f.type.startsWith("image/")).sort((a, b) => a.lastModified - b.lastModified);
    setGroupFiles(list);
  }

  function importGrouped(perItem: number) {
    const files = groupFiles ?? [];
    setGroupFiles(null);
    nextItem();
    const size = perItem === 0 ? files.length : perItem;
    for (let i = 0; i < files.length; i += size) {
      const group = files.slice(i, i + size);
      group.forEach((f) => enqueue(() => addToCurrent(f)));
      chain.current = chain.current.then(() => { current.current = null; });
    }
  }

  return (
    <>
      <Header back={`#/b/${batchId}`} title={`${itemCount} items`} right={pending > 0 ? <span className="badge">⬆ {pending}</span> : <span className="badge ok">✓ saved</span>} />
      <main
        className={`capture ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer?.files); }}
      >
        {toast && <div className="toast" role="status">{toast}</div>}
        {cameraOk !== false ? (
          <div className={`viewfinder ${flash ? "flash" : ""}`}>
            <video ref={videoRef} playsInline muted />
          </div>
        ) : (
          <div className="card center">
            <p>No camera here. Drag &amp; drop photos onto this page, or:</p>
            <label className="button primary">
              Take / choose photos
              <input hidden type="file" accept="image/*" capture="environment" multiple onChange={(e) => onFiles(e.target.files)} />
            </label>
          </div>
        )}

        <div className="strip">
          {shots.map((u, i) => <img key={u} src={u} alt={`photo ${i + 1}`} />)}
          <span className="muted small">{shots.length
            ? `Item ${itemCount} · ${shots.length} photo${shots.length > 1 ? "s" : ""} – tap Next item when done`
            : "Tip: photo 1 = front, photo 2 = back/label. On a computer you can drag & drop photos here."}</span>
        </div>

        <div className="controls">
          <label className="button">
            Gallery
            <input hidden type="file" accept="image/*" multiple onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
          </label>
          <button className="shutter" onClick={shoot} disabled={!cameraOk} aria-label="Take photo" />
          <button className="button primary next" onClick={nextItem} disabled={!shots.length} title="Shortcut: N">Next item ›</button>
        </div>
        {pending > 0
          ? <button className="button wide" disabled>Saving {pending} photo{pending > 1 ? "s" : ""}…</button>
          : <a className="button wide" href={`#/b/${batchId}`}>Done – write my listings</a>}
        {error && <p className="error">{error}</p>}
      </main>

      {groupFiles && (
        <div className="modal" role="dialog">
          <div className="card stack">
            <b>{groupFiles.length} photos – how are they grouped?</b>
            <p className="muted small">Sorted by the time taken. You can merge items later.</p>
            <button className="button" onClick={() => importGrouped(1)}>1 photo per item</button>
            <button className="button" onClick={() => importGrouped(2)}>2 photos per item (front + back)</button>
            <button className="button" onClick={() => importGrouped(3)}>3 photos per item</button>
            <button className="button" onClick={() => importGrouped(0)}>All one item</button>
            <button className="link" onClick={() => setGroupFiles(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
