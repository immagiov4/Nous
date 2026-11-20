alter table public.workflow_ai_usage
  add column decision_id uuid,
  add column call_role text,
  add constraint workflow_ai_usage_decision_attribution_check check (
    (decision_id is null and call_role is null)
    or (
      decision_id is not null and call_role is not null
      and call_role in ('studio-selection', 'catalog-fallback', 'catalog-repair')
    )
  );

create index workflow_ai_usage_decision_idx
  on public.workflow_ai_usage(decision_id)
  where decision_id is not null;
