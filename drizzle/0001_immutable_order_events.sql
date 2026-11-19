CREATE FUNCTION reject_order_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON order_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_event_mutation();
