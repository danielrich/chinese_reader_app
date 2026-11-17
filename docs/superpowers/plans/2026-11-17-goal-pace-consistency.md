# Goal deadline-pace consistency

The live page reported 1,266 characters ahead through yesterday while the chart
showed 8,605 actual characters below today's required 10,592. Two independent
formulas used different day counts. Chart pace included an extra day, and the
summary denominator did not reach the full target until after the deadline.

Use one requiredGoalProgress helper for summary, both charts, cursor and table.
Starting progress includes reads through the start date, so it is day zero.
Interpolate from that baseline to total characters on the deadline; clamp to
the total thereafter, including a same-day goal. Label the summary for today.
Compare whole-character rounded targets consistently with the cursor readout.
Keep reading history and forecast speed/time assumptions unchanged.

- [x] Reproduce on the live page read-only and add failing boundary/consistency tests.
- [x] Share one calendar-day pace calculation and correct the status label.
- [x] Verify model/browser regressions and independent review (no findings).
- [x] Deploy the frontend fix to chasmfiend, verify the live comparison, and commit.

Validation: `npm run test:offline` passed all 60 tests. Added model boundary,
cross-chart consistency, and browser summary/cursor regressions. Live read-only
verification on Nov 17 showed both charts at 8,605 actual versus 7,341 required,
matching the summary's 1,264 ahead. Service healthy; served JavaScript SHA-256
matches the local build. Previous frontend retained as
`dist.before-pace-fix-20261117` on chasmfiend.
