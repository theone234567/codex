import type { ReactNode } from "react";

export default function Header({ back, title, right }: { back?: string; title: ReactNode; right?: ReactNode }) {
  return (
    <header className="bar">
      {back ? <a className="back" href={back} aria-label="Back">‹</a> : <span className="logo small">Klick<span>List</span></span>}
      <h1>{title}</h1>
      <div className="bar-right">{right}</div>
    </header>
  );
}
