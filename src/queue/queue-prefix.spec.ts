import { queuePrefix } from './queue-prefix';

describe('queuePrefix (B-P1-10)', () => {
  const PROD = 'postgresql://app:secret@db.example.com:5432/gym?schema=public';

  it('gives two deployments on different databases different queues', () => {
    // The bug: both used BullMQ's constant `bull`, so a dev API sharing the
    // test suite's Redis took the suite's jobs.
    expect(
      queuePrefix({
        DATABASE_URL:
          'postgresql://postgres:postgres@localhost:5432/mygymagent_dev',
      }),
    ).not.toBe(
      queuePrefix({
        DATABASE_URL:
          'postgresql://postgres:postgres@localhost:5432/mygymagent_test',
      }),
    );
    expect(queuePrefix({ DATABASE_URL: PROD })).not.toBe('bull');
  });

  it('gives instances of one deployment the same queues', () => {
    expect(queuePrefix({ DATABASE_URL: PROD })).toBe(
      queuePrefix({ DATABASE_URL: PROD }),
    );
  });

  it('does not move the queues when the database password is rotated', () => {
    expect(queuePrefix({ DATABASE_URL: PROD })).toBe(
      queuePrefix({
        DATABASE_URL:
          'postgresql://app:rotated@db.example.com:5432/gym?schema=public',
      }),
    );
  });

  it('keeps credentials and host names out of Redis key names', () => {
    const prefix = queuePrefix({ DATABASE_URL: PROD });
    expect(prefix).toMatch(/^bull-[0-9a-f]{12}$/);
    expect(prefix).not.toMatch(/secret|example|gym/);
  });

  it('separates two schemas in the same database', () => {
    expect(
      queuePrefix({ DATABASE_URL: 'postgresql://u:p@h:5432/db?schema=a' }),
    ).not.toBe(
      queuePrefix({ DATABASE_URL: 'postgresql://u:p@h:5432/db?schema=b' }),
    );
  });

  it('uses QUEUE_PREFIX when set', () => {
    expect(
      queuePrefix({ QUEUE_PREFIX: 'production', DATABASE_URL: PROD }),
    ).toBe('production');
  });
});
