export type ToastKind = "ok" | "err" | "info";

export interface ToastMsg {
  id: number;
  kind: ToastKind;
  text: string;
}

type Listener = (t: ToastMsg) => void;

let listeners: Listener[] = [];
let counter = 0;

export function toast(text: string, kind: ToastKind = "info"): void {
  const t: ToastMsg = { id: ++counter, kind, text };
  for (const l of listeners) l(t);
}

export function onToast(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}
