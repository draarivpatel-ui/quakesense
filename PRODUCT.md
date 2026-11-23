# QuakeSense: product truth

## What it is

An offline, fully synthetic earthquake early warning workbench for physics
classes and school drill planners. Nothing on the page is live data: three
authored scenarios (coastal, urban, rural) are simulated in the browser, and
every trace, pick, alert and lead time is computed locally. It is a teaching
tool, not a warning product; the disclaimer sits in the header and the
"Not a live warning" wording is a hard requirement, not decoration.

## Who uses it and where

A teacher projecting the workbench in a classroom, or a drill planner checking
what a sensor layout buys a school, hospital or bridge. The mode is Operate:
the visitor picks a scenario, scrubs or plays the exercise timeline, reads
modeled warning lead times at named sites, edits the network (epicenter,
manual stations, velocity model, latency, trigger count, SNR, depth), and
exports the run or prints a bilingual drill card.

## Behavior contract

- Starts on the coastal preset, paused at an authored 16.5 s snapshot.
- Selecting a preset resets time, edits, toggles and station selection.
- Playback is learner-triggered only; it pauses at 45 s and wraps to 0.
- `null` vs `0` is meaningful everywhere: `null` lead is "No alert", `0` is
  "No lead"; negative signed leads are never shown as positive.
- Site leads shown beside live countdowns are the precomputed end-of-run
  modeled values and are labeled as such.
- Exports capture the whole configured run regardless of playhead position.
- Manual stations are capped at 18 total, duplicate coordinates are refused,
  and only manual stations can be removed.
- Every map function (inspect, move epicenter, add station) has a keyboard
  path through mode buttons plus the coordinate form.
- The P keyboard shortcut is opt-in via an unchecked preference checkbox.
- The distance lab charts modeled P/S arrivals, usable lead, blind radius and
  soil-adjusted MMI/PGA on disclosed planning proxies, never measured data.
- The preparedness comparator reports five deterministic planning measures;
  EEW-triggered ones honestly fail when the lead cannot cover activation.
- The readiness brief is JSON/CSV/Markdown plus an unkeyed SHA-256
  tamper-detection digest, labeled as not a signature; bookmark links encode
  the whole exercise in a strict `#qs=` URL hash.

## Voice

Plain, precise, school-lab language. Numbers carry units (s, km, ms, deg).
No hype, no alert-alarm styling: the UI should read like an instrument print,
not a warning siren.
