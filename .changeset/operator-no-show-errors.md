---
'@reservajs/astro': patch
---

The operator no-show endpoint no longer reports an internal failure after the no-show is saved as a `409 invalid_transition` carrying the raw database error; it now returns the generic `500 internal_error`, like the other booking actions.
