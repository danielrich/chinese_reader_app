# Ordered descendant texts in shelf view

User requests opening a book shelf such as 王者之路-上 to select any section from its child chapter shelves in reading order. Show direct texts first, then each child subtree in existing shelf order, with texts inside each shelf in existing text order. Preserve shelf structure and text ownership. Previous/Next follows the displayed list across chapter boundaries; Back returns to the selected book.

Approaches: fetching every chapter individually adds dozens of requests; an optional recursive backend list returns the ordered book in one request and is selected. Existing direct-only callers remain compatible. Shelf view requests recursion; offline downloads cache recursive lists for intermediate shelves too. Use a separate cache key for parent shelves so old empty direct lists are never mistaken for complete book lists. Completed reads update cached ancestor lists and the owning chapter without contaminating other shelves.

No database migration or content changes. Deliver and verify on chasmfiend, retaining deployed files for rollback. Preserve unrelated local and server changes.
