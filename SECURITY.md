# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/quakesense/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static QuakeSense browser application and its Node modules, including seismic modeling, wave picking, bookmark links, laboratory state, accessibility output, exports and generated reports.

In scope:

- A cross-site scripting or HTML injection path through station names, event labels, bookmark state, picker output or rendered report content.
- A bookmark decoder or serialization flaw that bypasses validation, corrupts another laboratory state or executes attacker-controlled code.
- A generated CSV, JSON, SVG, Markdown or report export flaw that makes generated output execute a formula or script when opened.
- A hash, checksum or verification bypass that makes altered output validate as untampered.
- A malformed input path that evades documented validation and corrupts application state beyond the attacker's own tab.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Scientific accuracy of a user-selected seismic model without a security impact.
- Denial of service that only affects the attacker's own browser tab.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
