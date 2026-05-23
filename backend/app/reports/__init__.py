"""app.reports — Sprint 4 Inspection Execution Layer.

Job lifecycle: open → claimed → on_route → arrived → inspecting → report_upload → done | canceled
Credit model: consume credit ONLY when valid report submitted (not on complete).
Cancel before inspecting: release job back to open.
Cancel after inspecting (admin only): canceled + release credit.
"""
