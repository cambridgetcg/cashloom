import type { ReactNode } from "react";
import { PublicNav, type PublicPage } from "./PublicNav";
import "./public-header.css";

/** One brand, navigation order and page frame across the public service. */
export function PublicHeader({ current, children }: { current?: PublicPage; children?: ReactNode }) {
  return <header className="cashloom-header">
    <div className="cashloom-header__top">
      <a className="cashloom-brand" href="/" aria-label="CashLoom home"><span className="cashloom-brand-mark" aria-hidden="true">c</span><span>CashLoom</span><span className="cashloom-brand__tag">Your money. Your direction.</span></a>
      <span className="cashloom-header__note">Start with what you have.</span>
    </div>
    <PublicNav current={current} />
    {children && <div className="cashloom-header__module">{children}</div>}
  </header>;
}
