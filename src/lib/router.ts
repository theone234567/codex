import { useEffect, useState } from "react";

export type Route =
  | { name: "batches" }
  | { name: "batch"; id: string }
  | { name: "capture"; id: string }
  | { name: "quicklist"; id: string }
  | { name: "item"; id: string };

const UUID = "[0-9a-f-]{36}";

export function parseRoute(hash: string): Route {
  let m: RegExpMatchArray | null;
  if ((m = hash.match(new RegExp(`^#/b/(${UUID})$`)))) return { name: "batch", id: m[1] };
  if ((m = hash.match(new RegExp(`^#/b/(${UUID})/capture$`)))) return { name: "capture", id: m[1] };
  if ((m = hash.match(new RegExp(`^#/b/(${UUID})/list$`)))) return { name: "quicklist", id: m[1] };
  if ((m = hash.match(new RegExp(`^#/i/(${UUID})$`)))) return { name: "item", id: m[1] };
  return { name: "batches" };
}

export function go(hash: string): void {
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
