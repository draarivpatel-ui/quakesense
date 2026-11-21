# QuakeSense

QuakeSense is a classroom workbench for exploring why earthquake warnings can reach some places ahead of strong shaking but not others. All earthquakes, stations, sites, and traces are synthetic. It does not connect to a sensor feed, predict earthquakes, or send alerts. It is not a replacement for USGS ShakeAlert or school emergency procedures.

## Run locally

```sh
npm start
```

Open the loopback address printed in the terminal. Node 22+ is enough. No install, API keys, internet connection, or runtime packages are needed. The static application can also be served from an HTTPS subdirectory. ES modules require HTTP(S), not opening `index.html` directly as a file.

## Try a three-minute exercise

1. Start with **Coastal Subduction** and play or scrub along the timeline. Compare the P and S wavefronts with a named station's three traces.
2. Add two closer stations and reduce telemetry latency. Read the change in blind-zone area and usable lead time at each site. The comparison uses the same source, original stations, and noise seeds.
3. Switch to **Urban Strike-Slip** to see a school with no usable lead time. Switch to **Sparse Rural Network** to see how stations on one side can pick an event without locating its depth precisely.
4. Choose a custom epicenter or station position using the map or its equivalent coordinate form. Download the full exercise, or print the school drill card in English or Spanish.

Use Tab to reach native controls and arrow keys to move the time slider. The single-letter playback shortcut starts disabled and can be turned off at any time.

## What the numbers mean

| Quantity | Definition and limits |
| --- | --- |
| Uniform travel | Euclidean source-to-station distance divided by constant speed, plus origin time. P is 6.0 km/s and S is 3.5 km/s. |
| Two-layer travel | A flat, horizontal interface at 8 km. The upper speeds are 5.2 and 3.0 km/s and the lower speeds are 6.0 and 3.5 km/s. Rays obey Snell's law. At long distances above the interface, the first arrival can be a critically refracted head wave. The model does not include an actual crustal profile, terrain, or converted phases. |
| P candidate | Three-component sample energy averaged over a short window divided by energy over an adjacent earlier long window. The first sustained threshold crossing is the candidate pick; the final sample in that run is when a trigger can be confirmed. This simple STA/LTA detector does not classify phases: weak P signals can be missed or confused with the larger S signal. |
| 3D solution | Damped nonlinear least squares with an analytic arrival-time Jacobian fits the horizontal source, positive depth, and origin time. The live inversion uses only confirmed candidate P picks. At least four distinct, non-collinear stations and a full-rank Jacobian are required. A small residual does not imply unique depth or good station coverage. |
| Wadati check | Median of per-station origin times from synthetic P/S pairs with the fixed P/S speed ratio. It is a reference check, not an input to the online alert or location, and is disabled in the two-layer model. |
| Gap and GDOP | Largest angular gap between station bearings and the square root of the trace of the scaled inverse normal matrix. The ellipse is a conditional 95% horizontal approximation using independent timing errors with 45 ms standard deviation. It is not calibrated confidence for a real event; bad geometry, biased triggers, and model errors can dominate. |
| Alert and blind zone | The kth confirmed trigger plus latency. The blind zone is the S-wave surface footprint at that instant, with planar area `pi * radius^2`. Site lead is S arrival minus alert, clipped to zero for available action time. A missing quorum yields no alert, not a zero-second alert. |
| Illustrative MMI | The teaching proxy `clamp(1.5 M + 1.5 - 3 log10(max(1, distance_km)), 1, 12)`. It is not an empirical shaking forecast. Ring levels are calculated from the same proxy and omit levels that never reach the surface. |
| Picker bench | Deterministic trials vary peak P amplitude relative to the uniform noise RMS before component polarization. This is the configured input scale, not a measured trace-wide signal-to-noise ratio or a field performance estimate. Misses are reported separately from timing error. |

## Exports

- **GeoJSON** projects local east/north distances around a stated synthetic geographic anchor. It contains the fictional stations, sites, source, nonzero blind zone, and illustrative isoseismal boundaries.
- **CSV** contains separate station and site records in one table. Untrusted formula-like strings are prefixed with an apostrophe even after invisible or whitespace prefixes; real numeric values remain numeric.
- **Audit JSON** contains the event, velocity and trigger settings, trace seed, picks, modeled sites, and a SHA-256 checksum of the payload. The digest uses UTF-8 ECMAScript JSON serialization with recursively sorted object keys, preserving array order. It is a reproducibility checksum, not a signature. Web Crypto needs HTTPS or localhost.
- **Drill card** prints the selected English or Spanish version as a separate one-page sheet. Follow local school drill and accessibility procedures in actual exercises.

## Verify

```sh
nice -n 15 npm test
nice -n 15 npm run test:browser
```

The browser check needs local Chrome, optionally specified with `CHROME_PATH`. It uses an isolated headless profile and a temporary loopback server. Screenshots are in `docs/`.
