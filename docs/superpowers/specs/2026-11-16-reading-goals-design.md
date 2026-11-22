# Reading goals and interactive projections

Status: approved by the user on November 16, 2026; implementation authorized.

## Intent and confirmed requirements

Finish the Chinese Wheel Of Time and Sanderson / Stormlight shelves by the
user's fiftieth birthday, July 23, 2035, with a planned 30 minutes of daily
reading. Show actual reading, projected completion, and whether progress is
on track. A goal supports multiple selected shelves and all their descendants.
Overlapping selections count each text once.

The user confirmed that all Chinese reading, including rereads and other
shelves, counts toward reading experience. Only a text's first completion
advances goal progress. Existing first completions count too.

The default growth scenario starts from current speed and experience, reaches
200 CPM at 6 million lifetime characters, then 250 CPM at 12 million.
The user additionally requested frontend what-if calculations and editable
assumptions, including smaller speed improvements. Preserve reading history.

## Approaches and choice

Extending Speed with another chart would bury goal configuration among its
existing correlations. Server-side projections would require a request for
every what-if change. The proposed choice is a dedicated Goals tab, durable
goal configuration on the existing server, and pure TypeScript projection
calculations in the browser. Reuse the existing DOM/CSS/SVG patterns and tokens.
No new framework or chart dependency is needed.

## Goal setup and persistence

Support creating, editing, selecting, and deleting named goals. Each goal has:
an ID, name, selected root shelf IDs, creation/start date, deadline, timezone,
daily minutes, and saved forecast assumptions. Shelf selection is a searchable
checkbox tree/list with selected shelf names; it supports arbitrarily deep
sub-shelves. Selection is a union, not a sum of individual shelf totals.

Initial setup offers Wheel Of Time (currently ID 120) and Stormlight (207) by
matching the existing tree; IDs must not be hardcoded into generic goal logic.
Default deadline is 2035-07-23, daily minutes 30, growth milestones 6M/200 CPM
and 12M/250 CPM. The user explicitly saves the initial goal.

Store versioned goal JSON through the existing user_settings API under
reading_goals_v1. This survives reloads and is shared across devices; it needs
no schema migration. Keep unsaved what-if changes in view state. Save assumptions
persists them; Reset restores the last saved assumptions. Saving a scenario
does not reset the goal's start date or its historical schedule.

Scope includes current texts under selected shelves, including future imports.
Show that totals are based on current shelf contents; deleted/moved/new texts
can change totals. Missing selected shelf IDs are shown as missing, not silently
treated as a completed goal.

## Reading facts and backend

Add a typed read-only backend summary command accepting selected shelf IDs.
Resolve the recursive union with bound parameters; empty or nonexistent scopes
must not mean the entire library. Return total goal characters and each scoped
text's character count and earliest completed-session timestamp. Use actual
completed sessions rather than trusting a possibly stale is_first_read flag.
Rereads and overlapping root selections never duplicate goal progress.

Also return global lifetime completed characters and the last five valid
first-read speeds, matching the current Speed page's baseline convention.
Ignore missing/nonfinite/nonpositive speed samples. With no measured speed,
show an unknown forecast and permit a manual starting-speed assumption.
Return compact completed-session activity records (timestamp, duration, character
count, scoped/not-scoped) so the browser can group history by the goal's saved
IANA timezone without server-local timezone assumptions or DST mistakes.

All reading, including rereads, contributes to global experience and the daily
reading habit. Goal progress remains first-completion characters in its scope.
Daily reading minutes and goal completion progress are labeled separately.
Projections assume future planned minutes are spent on unread goal material;
reading other material can improve experience without reducing the goal's
remaining characters.

Refresh facts when entering Goals and after explicit refresh. Attempt pending
session sync first; if it fails, label that newly logged local sessions are not
yet reflected. Never claim unsynced reading is already included. Loading/error/
empty states retain usable unsaved scenario controls where possible.

## Browser projection model

Inputs are factual progress/experience, today's local date, daily minutes,
starting CPM (auto measured or positive manual override), and ordered milestones.
Editable controls include daily minutes, starting CPM, milestone character
thresholds and speeds. Use numeric controls and sliders where useful. Every
change recalculates locally with no network call or write. A no-improvement
comparison remains visible alongside the growth scenario.

Speed is piecewise linear against lifetime characters, not elapsed calendar
time. Anchor it at current experience and the assumed current CPM; interpolate
through future milestones, then hold the last speed. Passed milestones do not
retroactively replace measured current speed. Positive targets below the
starting speed are allowed to model pessimistic scenarios. Milestone character
thresholds must be strictly increasing. Invalid edits show an inline error and
do not produce NaN/Infinity chart coordinates or save invalid values.

Integrate characters per minute across each segment correctly, splitting at
milestones and completion; do not linearly interpolate speed over calendar
days or use a fixed average that ignores changing experience. Zero daily
minutes means no projected completion, except an already completed goal.
Use a finite explicit projection horizon and label completion beyond it.
Compare dates as calendar dates in the saved timezone; the deadline includes
the whole day. Avoid DST causing a planned day to be 23/25 hours of reading.
For the first forecast day (today), subtract all Chinese reading minutes already
logged today from the planned daily minutes, floored at zero. Later days use
the full daily budget. Current experience already includes those logged sessions;
never count today's elapsed reading twice. Future budgets assume unread goal
material. This also prevents refreshing a goal from granting another full day
of projected reading after a completed session.

## Graph and status

The main graph uses calendar time horizontally and completed goal characters
vertically. Show four labeled series: actual first-read progress; projected
progress at constant current speed; projected progress with editable speed
changes; and the required pace to the deadline. Include Today and deadline
markers and finish-date labels. Never draw a forecast as recorded actuals.

Actual history includes existing first completions. The required-pace reference
runs from progress on the goal's original start date to total characters at
the deadline. This start date is stable, so missed days do not disappear as
today's forecasts move forward. Recompute the reference for explicit scope/
deadline edits or changed library contents, never merely for scenario tweaks.

Show remaining characters, today's reading minutes versus daily target,
actual progress ahead/behind required pace, and both projected finish dates
with days early/late. Keep actual schedule status distinct from statements
such as "30 minutes/day would finish before the deadline". Growth is an
assumption, not a promise or an automatically observed trend.

Use an accessible responsive SVG with distinct line styles, legend, readable
date/character labels, point inspection, and a textual summary. Expose a useful
tabular alternative without requiring a mouse. Fit mobile and light/dark themes.

## Validation and delivery

Test multi-shelf unions and nested overlap; first-completion history versus
rereads; global experience; no speed data; zero minutes; completion and overdue
goals; milestone crossing and piecewise integration; timezone/date boundaries;
instant browser-only what-if edits; save/reset/reload; missing shelves and
errors; responsive chart rendering and existing offline/reader regression tests.

After verification, deploy matching frontend and server changes to chasmfiend
using the established key-based access and rollback process, verify actual
HTTP responses and the live UI, then commit the feature. A new server command
requires rebuilding the Linux server; no DB schema migration is necessary.

The builder may choose internal module boundaries, exact control ranges,
sampling density, SVG interaction details, and final visual spacing consistent
with the existing app. Avoid modifying existing reading history or unrelated
Speed/Stats semantics.

## Design check

A fresh builder review raised only the treatment of today's used minutes.
The rule above resolves it as an engineering choice: only today's remaining
budget is available to forecast. No additional user requirements are unresolved.
