// A screenshot opens over the page, in the browser's own modal dialog (as the chat does): the report stays where it was,
// Esc or a click outside closes it. No injected styles, so the production CSP holds.
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { T } from './text.ts';

export function ShotViewer({ src, alt, children, className = '' }: { src: string; alt: string; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" aria-label={T.shot.open(alt)} onClick={() => dialog.current?.showModal()} className={`cursor-zoom-in ${className}`}>
        {children}
      </button>
      <dialog ref={dialog} aria-label={alt} onClick={(e) => { if (e.target === e.currentTarget) dialog.current?.close(); }}
        className="m-auto max-h-[calc(100vh-24px)] w-[min(1280px,calc(100vw-24px))] rounded-2xl border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-slate-950/70">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2.5">
          <span className="min-w-0 truncate text-sm font-semibold">{alt}</span>
          <div className="flex shrink-0 items-center gap-1">
            <a href={src} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-sunken hover:text-fg">{T.shot.newTab}</a>
            <button type="button" aria-label={T.shot.close} onClick={() => dialog.current?.close()} className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-fg"><X className="size-5" aria-hidden /></button>
          </div>
        </div>
        <div className="bg-sunken p-2"><img src={src} alt={alt} className="mx-auto block h-auto max-w-full" /></div>
      </dialog>
    </>
  );
}
