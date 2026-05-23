"""Media abstraction layer (Sprint 2 Step 3).

Goal: stop writing base64 blobs into BSON documents. Provide a clean
storage-agnostic interface so the runtime can be flipped to S3/R2 later
without changing call sites.

v1 backing store: MongoDB GridFS.
v2 (later): S3 / Cloudflare R2 — same interface, new class.
"""
