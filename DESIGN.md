# QuakeSense design record

## World

A geophysical field plot printed on warm light survey paper, laid over a
precise ink-navy plotting bed. The page is the paper (warm off-white with a
soft green-paper tint near the header); the two canvases are the bed (near-black green-ink),
where wavefronts, stations and traces glow like plotted marks. Everything
between them is quiet operate chrome: hairline rules, small uppercase labels,
monospace for calibrated numbers only.

Mode: Operate. Familiarity first; the brand lives in the map craft and the
editorial title, not in decorative chrome.

## Tokens

```
--paper:  #f7f4eb   page ground (survey paper)
--ink:    #162626   text and primary rules
--muted:  #52645e   secondary text, labels
--line:   #cdd4c9   hairlines and control borders
--plot:   #142826   canvas plotting bed
--p-wave: #8de1ca   P front, triggered stations, estimates, Z trace
--s-wave: #f5b47d   S front, blind zone hatch, sites, N trace, S ref marker
--accent: #125c49   action color: focus ring, pressed tabs, primary buttons
--card:   #fbf9f2   panel ground (derived, slightly brighter than paper)
--warn:   #9a5518   warnings, "No alert" states (derived dark s-wave)
```

On the bed, palette colors are reused at full saturation; supporting tones
are rgba tints of `--paper` (grid 10%, faint 5.5%, text 66%, subtle 42%).

## Type

- Title: Georgia / Charter serif, `QuakeSense` at 1.7 rem, tight tracking.
  The drill card title repeats it at print scale.
- Body and UI: Avenir Next with system fallbacks, 0.92 rem base, tight
  steps; section headings are 0.8 rem uppercase with 0.07 em tracking.
- Monospace (ui-monospace / SF Mono / Menlo) only for calibrated values:
  times, coordinates, pick errors, table numerals, canvas labels.

## Composition (1280 x 800 target)

Compact header: title, synthetic-exercise chip, always-visible disclaimer,
drill-card action. A three-button scenario row. Primary split: large map
plus transport on the left, three site lead cards plus alert status and
counterfactual toggles on the right. Stacked Z/N/E plus STA/LTA seismogram
below, then a two-column details band (network/model diagnostics and picker
bench), exports last. At 940 px everything collapses to one column with the
map first; at 390 px all controls wrap without horizontal overflow.

## The one motion

Learner-triggered wavefront playback: the P front (mint) and S front
(orange) expand from the epicenter in real time, station triangles fill as
pickers trigger, and site squares switch to warned or missed fills. It runs
only after Play is pressed, pauses on demand, and is the only authored
motion; control transitions are 160 ms state feedback and are disabled under
`prefers-reduced-motion`.

## Print

The drill card prints as one letter/A4 page: only the dialog's article is
rendered, toolbar and backdrop hidden, the rest of the page suppressed. The
subtitle is carried at the foot of the card (flex order), never under the
title. Language toggle selects which single-language article renders.

## Verification notes

- Check status copy against the actual playhead in every captured state.
  The opening snapshot message must be replaced when the user scrubs.
- A one-page PDF can still be blank. Verify that each language prints text
  as well as checking the page count and selected language.
