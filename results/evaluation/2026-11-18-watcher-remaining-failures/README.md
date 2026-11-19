# The watcher on the seeded failures not scored in calibration or held-out runs

Label: live, scripted traces. Date: 2026-11-18. Watcher model: claude-opus-5-5. Rubric version 3, the frozen hash in `src/bench/frozen.json`, not changed. Cost, calls and prices: `manifest.json` and `summary.json` (the usage field). The command was `npm run eval -- --half all --judge-all --only-unjudged --label watcher-live-judge-all`. The folder and its label were renamed afterwards to say what the run is.

The traces are authored (see D-045 and D-066). `runs/<id>/scores.json` holds each call, and `deterministic.json` holds the deterministic part of the same invocation. `summary.json` has the by-detector table.
