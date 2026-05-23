"""app/notifications/receipts.py — Phase 3D PR-01 compatibility shim.

The receipts poller was moved to `app.workers.receipts_poll`. This module
remains as a backwards-compatible re-export for the public entrypoint
`poll_receipts_once`, which `app/notifications/customer_pipeline.py`
still imports.

Phase 3.4 C-3 update: the `receipts_poll_loop` re-export is dropped here
because the symbol itself has been removed (supervisor now drives the
tick). No external caller of `receipts_poll_loop` exists — verified via
codebase grep before removal.

No new code lives here. Do not add behaviour to this file.
"""
from app.workers.receipts_poll.loop import poll_receipts_once

__all__ = ["poll_receipts_once"]
