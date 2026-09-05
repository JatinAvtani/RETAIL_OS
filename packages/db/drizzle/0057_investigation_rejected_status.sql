-- A human explicitly declining a draft action is a real, distinct outcome — neither RUNNING nor
-- COMPLETE (the investigation itself succeeded; something else beyond investigate.ts's own scope
-- happened next) nor FAILED (a rejection is not an error — the pipeline worked correctly and
-- produced a real draft; a human simply chose not to act on it). Overloading FAILED for this would
-- make "the model broke" and "a human said no" indistinguishable in every query/UI that reads
-- status, which is exactly the kind of status-overloading this codebase's own conventions avoid
-- elsewhere (see purchase_order_delivery_status's own separate-fact reasoning).
ALTER TYPE "investigation_status" ADD VALUE IF NOT EXISTS 'REJECTED';
