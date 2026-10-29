import { prisma } from './database.js';

async function runSmokeTest() {
  let stage = 'connect';
  try {
    await prisma.$connect();

    stage = 'database identity';
    const databases = await prisma.$queryRaw<Array<{ database_name: string }>>`
      SELECT current_database() AS database_name
    `;

    stage = 'migration check';
    const migrationTables = await prisma.$queryRaw<Array<{ user_table_exists: boolean }>>`
      SELECT to_regclass('public."User"') IS NOT NULL AS user_table_exists
    `;

    if (!databases[0]?.database_name || !migrationTables[0]?.user_table_exists) {
      throw new Error('The initial migration is not present.');
    }

    stage = 'temporary table round-trip';
    const createTemporaryTable = prisma.$executeRaw`
        CREATE TEMPORARY TABLE crash_club_smoke (
          id integer PRIMARY KEY,
          label text NOT NULL
        ) ON COMMIT DROP
      `;
    const insertTemporaryRow = prisma.$executeRaw`
        INSERT INTO crash_club_smoke (id, label) VALUES (1, 'smoke-ok')
      `;
    const readTemporaryRow = prisma.$queryRaw<Array<{ label: string }>>`
        SELECT label FROM crash_club_smoke WHERE id = 1
      `;
    const [, , roundTrip] = await prisma.$transaction([
      createTemporaryTable,
      insertTemporaryRow,
      readTemporaryRow,
    ]);

    if (roundTrip[0]?.label !== 'smoke-ok') {
      throw new Error('Temporary database write/read check failed.');
    }

    console.log(`PASS: Connected to PostgreSQL database "${databases[0].database_name}".`);
    console.log('PASS: Initial migration is present and a temporary row round-tripped.');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? ` (${String(error.code)})`
      : '';
    const message = error instanceof Error
      ? error.message
          .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[connection string redacted]')
          .replace(/\b[^\s"']+\.neon\.tech\b/gi, '[Neon host redacted]')
          .replace(/(password|pwd)\s*[=:]\s*[^&\s]+/gi, '$1=[REDACTED]')
      : 'Unknown error';
    console.error(`FAIL: Database smoke test failed during ${stage}${code}: ${message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

await runSmokeTest();
