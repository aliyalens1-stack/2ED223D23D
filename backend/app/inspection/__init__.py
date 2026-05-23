"""app.inspection — Berlin Launch B1: Inspection Report generator.

MVP logic (NOT ML — deterministic rules):
  - Input: parsed car data (title, price, mileage, year, fuel, marketAvg) from B2.
  - Output: structured report → score, risk, summary, reasons[], costEstimate, decision.

Designed to replace client-side `computeRiskHints` in InspectPage.
"""
