export const SITE_ORIGIN = "https://cashloom.io";

export const PAGE_METADATA = {
  "/": { title: "CashLoom — Your money. Your direction.", description: "Make a money plan, keep your records together, and understand your options. Practical tools for individuals, households, independent work, and shared projects." },
  "/plan": { title: "Money plan — CashLoom", description: "Build a monthly money plan for yourself, your household, independent work or a shared project. Use it in your browser, without an account or bank connection." },
  "/wallet": { title: "Your workspace — CashLoom", description: "Explore CashLoom's local workspace for accounts, balances and activity. The developer pilot requires repository access; the browser money planner is open to everyone." },
  "/connections": { title: "Connections and what they do — CashLoom", description: "Review CashLoom's supported records, local payment routes and connection limits. Bank linking is sandbox-only; provider setup happens in the private workspace pilot." },
  "/world": { title: "Money insights — CashLoom", description: "Read policy rates, sovereign yields, currency and crypto references, and policy meeting dates with source receipts and coverage gaps. No account or wallet required." },
  "/capital-flows": { title: "Capital flows — CashLoom", description: "Explore selected reported financing and transactions with native units, source receipts and coverage gaps. Delayed observations do not represent a global money-flow total." },
  "/onchain": { title: "Network insights — CashLoom", description: "Explore selected crypto networks, native USDC supply, lending markets, liquidity pools and bridge routes with source evidence and coverage limits." },
  "/atlas": { title: "How it works — CashLoom", description: "Understand CashLoom's local workspace design, accounts, signing keys and payment records. Explore selected source modules and the current developer-pilot limits." },
} as const;

export function metadataForPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const path = normalized === "/blockchain" ? "/onchain" : normalized;
  const known = Object.prototype.hasOwnProperty.call(PAGE_METADATA, path);
  const page = known ? PAGE_METADATA[path as keyof typeof PAGE_METADATA] : {
    title: "Page not found — CashLoom",
    description: "Find your next step with CashLoom's money planner, workspace guide and money insights.",
  };
  return { ...page, canonical: known ? `${SITE_ORIGIN}${path}` : null, robots: known ? "index,follow" : "noindex,follow" };
}

/** Keep browser navigation metadata in sync. Static hosts also need route-aware HTML for non-JS crawlers. */
export function updatePageMetadata(pathname: string, document: Document) {
  const page = metadataForPath(pathname);
  document.title = page.title;
  for (const [attribute, key, content] of [
    ["name", "description", page.description],
    ["name", "robots", page.robots],
    ["property", "og:title", page.title],
    ["property", "og:description", page.description],
    ["name", "twitter:title", page.title],
    ["name", "twitter:description", page.description],
  ]) {
    let tag = document.head.querySelector(`meta[${attribute}="${key}"]`);
    if (!tag) { tag = document.createElement("meta"); tag.setAttribute(attribute, key); document.head.append(tag); }
    tag.setAttribute("content", content);
  }
  for (const [selector, tagName, attribute, value] of [
    ['link[rel="canonical"]', "link", "rel", "canonical"],
    ['meta[property="og:url"]', "meta", "property", "og:url"],
  ]) {
    let tag = document.head.querySelector(selector);
    if (!page.canonical) { tag?.remove(); continue; }
    if (!tag) { tag = document.createElement(tagName); tag.setAttribute(attribute, value); document.head.append(tag); }
    tag.setAttribute(tagName === "link" ? "href" : "content", page.canonical);
  }
}
