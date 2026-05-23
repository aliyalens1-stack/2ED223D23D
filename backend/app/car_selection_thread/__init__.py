"""car_selection_thread — append-only communication for car-selection requests.

This is a SEPARATE namespace from `car_selection` and from the platform-wide
`notifications` subsystem. Discipline:

  - thread ≠ workflow. A message NEVER mutates lifecycle.
  - lifecycle ≠ thread. A status transition NEVER auto-fabricates a message.
  - notifications are PROJECTIONS over thread + lifecycle. The thread
    collection is the source of truth for what was actually said; the
    notification collection is just a per-recipient inbox view.

The namespace ships:

  - models.py       : Pydantic shapes for messages + notifications
  - repository.py   : data access (append-only writes, role-gated reads)
  - notifier.py     : helper that records notification rows from
                      messages/lifecycle without coupling the source
                      collections
  - router_customer.py / router_provider.py / router_admin.py :
                      three role-scoped thread surfaces sharing the
                      same access discipline as the parent car_selection
                      namespace (404 on foreign requests for non-admins)
  - router_inbox.py : unified `/api/car-selection/notifications/me` for
                      every authenticated principal
"""
