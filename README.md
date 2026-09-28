# verity-cfg

Control plane for the Verity build. The build fetches these files on every page
load with `cache: no-store`, so an edit here takes effect on the next load
without redeploying anything.

## verity-gate.txt

Kill switch. The build decodes this and compares it, trimmed and lowercased,
against the literal `yes` (VT_GATE_KEY). Anything else stops every copy, and
the build fails closed if the fetch fails.

    yes

## verity-denylist.json

Per-user deny. Matched on `id` (numeric legacy user id) or `uuid`; an entry
matches if **either** matches. `name` is documentation only, for before you
know the id - it deliberately does not match, because two students can share a
name and a name that fails to match fails open.

    {
      "deny": [
        { "id": 7308501, "uuid": null, "name": "Mariam N", "why": "leaked copy" }
      ],
      "notice": "..."
    }

Workflow: add the entry by `id`. If you do not have it yet, leave `id` and
`uuid` null, let them load once, read their real values out of the denied
webhook card, then paste them in.

`notice` is the alert body, so the wording can be changed here without a
rebuild.
