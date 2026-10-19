alter table public.project_source_entries
  add column pdf_pages jsonb;

alter table public.project_source_entries
  add constraint project_source_entries_pdf_pages_array
  check (pdf_pages is null or jsonb_typeof(pdf_pages) = 'array');
