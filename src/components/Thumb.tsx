import { useEffect, useState } from "react";
import { signedUrls, thumbPath } from "../lib/api";
import type { Photo } from "../lib/types";

export default function Thumb({ photo, full = false, alt = "" }: { photo?: Photo; full?: boolean; alt?: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!photo) return;
    const path = full ? photo.storage_path : thumbPath(photo.storage_path);
    let live = true;
    signedUrls([path]).then((u) => live && setUrl(u[path])).catch(() => {});
    return () => { live = false; };
  }, [photo, full]);
  if (!photo) return <div className="thumb empty">No photo</div>;
  return (
    <div className="thumb">
      {url && <img src={url} alt={alt} loading="lazy" style={{ transform: `rotate(${photo.rotation}deg)` }} />}
    </div>
  );
}
