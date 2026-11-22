# Chapter structure repair

Approved in chat: give every chapter a shelf at the same level, preserving original book order and all existing text IDs, content, and reading history. Keep existing reading sections intact.

Approaches: a dedicated chapter model would be a larger product change; consistent chapter shelves fit the current schema and were selected. This task is a one-time data repair, not a change to future splitting behavior.

Use a dependency-free Python maintenance command with read-only preview, explicitly selected book shelf IDs, a SQLite backup, and one atomic transaction. Existing chapter/text sort_order values retain imported sequence. Reject ambiguous positions or unexpected nested shelves instead of guessing. Allow an explicit complete title sequence from the source EPUB to resolve ambiguity. Rerunning is a no-op. Only shelf creation/order and text shelf_id may change. Apply to the active library once identified; the local Mac copy appears stale. Do not alter unrelated working-tree edits.
