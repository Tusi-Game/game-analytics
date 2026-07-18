/**
 * Runs AFTER the jest framework is installed (setupFilesAfterEnv), so `beforeEach`
 * is available. Resets the shared fake IndexedDB between tests so no open-session
 * record, queued event, or persisted identity bleeds across cases — each `init`
 * sees a clean storage scope.
 */
import { IDBFactory } from 'fake-indexeddb';

beforeEach(() => {
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = new IDBFactory();
});
