alter table public.workflow_run_requests
  add column request_fingerprint text;

-- Historical dedupe aliases did not retain their original payload. A legacy marker keeps
-- those aliases replayable; the first replay replaces it under the request advisory lock.
update public.workflow_run_requests
set request_fingerprint = 'legacy:' || run_id::text;

-- Null remains temporarily valid so the previous backend can insert during a rolling deploy.
alter table public.workflow_run_requests
  add constraint workflow_run_requests_fingerprint_format_check
    check (
      request_fingerprint is null
      or request_fingerprint ~ '^[a-f0-9]{64}$'
      or request_fingerprint ~ '^legacy:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    );
