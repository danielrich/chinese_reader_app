# Goal chart zoom and date inspection

The user requested a full chart plus a second chart for the next three months
when a goal's finish is more than six months away. The second chart must be
below the first at the same width; neither chart is shrunk to accommodate it.
The user delegated the graph/library choice. Retain SVG and update only cursor
elements during interaction for fast feedback without a new dependency.

Show the near-term view when the full timeline extends past six calendar months
from today (deadline or a projected finish), or an unfinished forecast exceeds
the finite horizon. Use calendar-month addition with month-end clamping. The
near view spans today through three calendar months ahead, with its own Y scale
based on values visible in that interval. Full chart width, height and timeline
remain intact. Keep all four series and the tabular alternative.

Both charts have an independent vertical cursor and markers at each available
series value. Hover updates it; pointer capture allows dragging beyond plot
bounds with day selection clamped to the displayed range. Touch, arrow keys,
Home/End, and an editable date field provide equivalent access. A compact
readout gives the unambiguous date and exact rounded character counts. Use the
unsampled daily model for values, with projections labeled as end-of-day values;
do not infer values from sparse rendered SVG points. Future actual reading is
not recorded, and unavailable forecasts display an explicit missing value.
Completed forecasts remain at the total thereafter. Deadline curve, table, and
cursor use the same end-of-day pace calculation.

Keep each chart's selected date while assumptions change, clamping it if the
new range becomes shorter. Cursor movement makes no network request, changes
no goal/history data, and does not redraw the curves. Scope and projection
math remain unchanged. Test calendar boundaries, clipping and Y scales, both
chart widths/order, hover/drag/keyboard/touch, exact selected-day values,
preservation across scenario edits, and existing regression coverage. Deploy
the frontend correction to chasmfiend and commit after review and live checks.
