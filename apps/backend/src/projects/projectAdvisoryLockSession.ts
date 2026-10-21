import type { Sql } from 'postgres';
import { measureRequestPhase } from '../workflows/requestObservability.js';

type ReservedSql = Awaited<ReturnType<Sql['reserve']>>;

export const releaseAdvisoryLockSession = async (sql: ReservedSql): Promise<void> => {
  let safeToRelease = false;
  try {
    // The reserved connection belongs only to this operation, so clearing every
    // session lock is both simpler and safer than trusting a list of lock keys.
    await measureRequestPhase('query', () => sql.unsafe('select pg_advisory_unlock_all()'));
    safeToRelease = true;
  } finally {
    // A session that could not be cleared must not re-enter the shared pool.
    if (safeToRelease) sql.release();
  }
};
