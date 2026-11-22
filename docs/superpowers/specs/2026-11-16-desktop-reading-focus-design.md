# Desktop reading focus

Approved by the user on November 16, 2026.

Give desktop readers substantially more width and height. Start Reading enters
Focus mode automatically: hide shelves, app navigation, metadata, analysis tabs,
and extra actions; retain a compact title, timer, Pause, Finish, and Exit Focus.
Escape or Exit Focus restores the normal layout without stopping the timer.
Finishing, discarding, or leaving the reader restores the normal layout too.
Dictionary lookups open on demand and remain closable. Preserve the mobile layout.

Approaches: merely widening the page leaves the surrounding distractions in place;
browser fullscreen changes the browser chrome and needs separate browser support.
The approved approach uses the full browser viewport with an in-app Focus mode,
plus a manual Focus mode button for reading without a timed session.

Use the existing TypeScript views, CSS tokens, and Playwright setup. Keep session
tracking intact and avoid introducing dependencies. Verify desktop width, focus
entry and exit, dictionary lookup, session completion, navigation, and mobile.
