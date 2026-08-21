import type { Job } from 'bullmq';
import { MailerService } from '../common/mailer/mailer.service';
import { JOB_NAMES } from '../queue/queue.constants';
import { WelcomeEmailProcessor } from './welcome-email.processor';

describe('WelcomeEmailProcessor', () => {
  it('sends a welcome email for a send-welcome-email job', async () => {
    const mailer = { sendWelcomeEmail: jest.fn().mockResolvedValue(undefined) };
    const processor = new WelcomeEmailProcessor(
      mailer as unknown as MailerService,
    );

    const job = {
      name: JOB_NAMES.SEND_WELCOME_EMAIL,
      data: { memberId: 'member-1', email: 'a@example.com', firstName: 'Alex' },
    } as Job;

    await processor.process(job);

    expect(mailer.sendWelcomeEmail).toHaveBeenCalledWith(
      'a@example.com',
      'Alex',
    );
  });

  it('ignores a job with an unrecognized name', async () => {
    const mailer = { sendWelcomeEmail: jest.fn() };
    const processor = new WelcomeEmailProcessor(
      mailer as unknown as MailerService,
    );

    const job = { name: 'some-other-job', data: {} } as Job;
    await processor.process(job);

    expect(mailer.sendWelcomeEmail).not.toHaveBeenCalled();
  });
});
