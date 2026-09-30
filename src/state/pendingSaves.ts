// Tabs register a function that writes their unsaved edits; the shell runs them
// all before signing out, while the session is still valid.
type Flusher = () => Promise<void>;
const flushers = new Set<Flusher>();

export function registerFlusher(fn: Flusher): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export async function flushAllPending(): Promise<void> {
  await Promise.allSettled([...flushers].map((f) => f()));
}
