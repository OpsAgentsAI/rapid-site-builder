// @opsagentsai/observability — public entry. App code imports the four-call API here;
// platform packages are imported from the ./web ./native ./wordpress subpaths.
export { initObservability, track, captureException, setUser, EVENT_TAXONOMY, createNoopAdapter, } from './core.js';
