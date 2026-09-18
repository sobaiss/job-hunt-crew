# Role replaces `isAdmin`; Plan drops its vestigial `administrateur` value

ADR 0015 split admin access off Plan into a boolean `isAdmin`, deliberately leaving Plan's `administrateur` value in the enum rather than risk a live drop. Introducing External/Internal/Administrator as a real three-way access tier makes a bare boolean insufficient, and once `administrator` is a Role value, `administrateur` in Plan has nothing left to mean — keeping both would let a User's admin status be represented two different ways at once.

We added `Role` (`external` | `internal` | `administrator`) and moved every admin gate (`admin/layout.tsx`, `require_admin`, the `X-User-Is-Admin` header) from `isAdmin` onto `role === administrator`, dropping the `isAdmin` column outright. Existing Users were migrated by their current `isAdmin` value: `true` → `administrator`, everything else → `external` — nobody is migrated to `internal`, which ships with no assigned Users and no distinct behavior yet. Because `User.plan` itself is retired in the same release (docs/adr/0018), the old `administrateur` Plan value has zero remaining references anywhere and gets removed by recreating the Plan enum type without it, rather than left vestigial a second time.

## Consequences
- Any future need to distinguish Internal from External behavior has an enum value ready and waiting, with no migration required to introduce it.
- A Plan can never again be read as a stand-in for admin access — Role is the only source of truth for that, closing the gap ADR 0015 opened.
