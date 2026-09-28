# verity-cfg

Control plane for the Verity build. The build fetches these files on every page
load with `cache: no-store`, so an edit here takes effect on the next load
without redeploying anything.

## verity-gate.txt

Kill switch. Anything other than `on` stops every copy.

    on

## verity-denylist.json

Per-user deny. Matched on `id` (numeric legacy user id) or `uuid`; an entry
matches if **either** matches. `name` is a scaffold only, for before you know
the id.

    {
      "deny": [
        { "id": 7308501, "uuid": null, "name": "Mariam N", "why": "leaked copy" }
      ],
      "notice": "..."
    }

Workflow: add the entry by `name`, let them load once, read their real `id` and
`uuid` out of the denied webhook card, then paste those in and drop the name.
Name matching alone is ambiguous and fails open, so treat it as temporary.

`notice` is the alert body, so the wording can be changed here without a
rebuild.
