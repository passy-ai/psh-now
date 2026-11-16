// IIFE service worker: the worker itself is not a module, so the bundle must
// attach the listeners at import time. This entry just imports the worker.
import "./sw";
export {};
