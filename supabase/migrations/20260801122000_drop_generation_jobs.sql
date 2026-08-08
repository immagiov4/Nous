select cron.unschedule(jobid)
from cron.job
where jobname = 'cleanup-generation-jobs';

drop table if exists public.generation_jobs;
