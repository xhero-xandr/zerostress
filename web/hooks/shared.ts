// One guarded hooks thread for the texts that belong to no running task: a chat question, the context the chat sends,
// the model's answer in the chat, a second opinion's page title. They are scanned with the same deadline as a task's
// texts (review B4), never in the web layer's own thread, where a runaway pattern would hold every request.

import { createGuardedHooks, type GuardedHooks, type TextScan } from './guarded.ts';

let shared: GuardedHooks | null = null;

/** Starts the thread ahead of the first text (it takes a few hundred milliseconds to boot and warm up). */
export function warmGuarded(): void {
  shared ??= createGuardedHooks();
}

export function scanGuarded(place: string, text: string): Promise<TextScan> {
  shared ??= createGuardedHooks();
  return shared.scan(place, text);
}
