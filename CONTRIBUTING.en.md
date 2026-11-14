# Contributing

[中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

Thanks for your interest in dsh-restart-now! This file covers the dev setup, contribution norms,
and where help is needed most right now.

## Dev setup

```bash
git clone https://github.com/Mr54233/dsh-restart-now.git
cd dsh-restart-now
npm install
npm test            # node:test, runs on Windows / macOS, no process side effects
npm pack --dry-run  # verify tarball contents
```

- Tests run on both Windows and macOS; no real DSH restart is involved;
- CI (GitHub Actions, an `ubuntu/windows/macos` matrix) runs the full suite on every PR;
- Architecture and implementation details (gate chain, restart mechanism, client slots, errata history)
  live in `docs/` (in Chinese).

## Contribution norms

- One PR, one focus. Release notes are assembled from commits — a clean history helps everyone;
- Behavior changes must come with tests; for bug fixes, first add a case that reproduces the bug;
- Copy changes (README / locale / settings hints) must stay in sync across Chinese and English —
  the client hints are bilingual, and a missing key degrades to Chinese text or the raw key name.

## macOS

**macOS support currently has code and isolated tests only — no verification on real hardware.**
The maintainer has no macOS machine. We deliberately avoid blind changes to this part: an adaptation
that cannot be verified cannot be trusted. macOS-related changes are therefore merged **only after
verification by a contributor with real hardware**.

What exists (the macOS path came from community PR #4 in v1.3.0, enhanced in v1.4.0; all covered by
unit tests, none verified on real hardware):

- Restart chain: SIGTERM → 10s grace → SIGKILL; the host exits gracefully via IPC disconnect;
- Process identity verification: `lsof` image mapping + `ps` start time, at three checkpoints
  (before acting / before SIGKILL escalation / before force-stopping the host);
- Launch-argument reuse: `ps -ww` + POSIX tokenization (paths with spaces handled);
- Failure dialog: `osascript display alert`.

### Verification checklist (items welcome, one by one)

| # | Item | Notes |
| --- | --- | --- |
| 1 | Basic restart chain | Trigger a restart from each entry; confirm the window comes back and session logs are intact |
| 2 | Quit-confirmation semantics | macOS apps may show their own quit confirmation (e.g. with scheduled tasks). The current implementation escalates to SIGKILL on timeout, which may bypass that dialog; the ideal behavior may be to abort the restart and notify when the dialog is left unanswered |
| 3 | Conservative identity rejection | With `lsof` unavailable or output malformed, the helper currently refuses to act — does this wrongly reject normal cases on real hardware? |
| 4 | Failure dialog | Does the `osascript` dialog actually appear in failure scenarios (e.g. relaunch failure)? |
| 5 | Close only | The v1.4.0 close-only action, end to end, on macOS |
| 6 | Title-bar menu entry | Currently Windows-only (the macOS menu bar is a native system menu; the mechanism differs). Whether and how to build one — open an issue first to discuss |

### How to help

- **Verify and report**: if you have macOS 12+ (Intel / Apple Silicon) + DSH Desktop, work through the
  checklist and open an issue with results (DSH version, what you saw, the `dsh-restart-now-*.err.log`
  from `$TMPDIR`);
- **Send a PR**: the macOS helper lives in `buildMacHelperScript` in `lib/helper-src.js`, its tests in
  `test/mac-helper.test.js` (the isolated tests run on any platform). Please include a note on how you
  verified the change on real hardware;
- **For larger items** (quit-confirmation semantics, menu entry) please open an issue to discuss the
  approach before writing code — it saves rework.

## Other directions

- Window-state restoration (keeping window position / size / monitor across a restart) is a confirmed
  need and not yet implemented;
- Linux support: not currently supported; whether it is worth doing depends on DSH Desktop shipping a
  Linux build — feel free to discuss.

## License

By submitting, you agree your contributions are published under the [MIT](LICENSE) license.
