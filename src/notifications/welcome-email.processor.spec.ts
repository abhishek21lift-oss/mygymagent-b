import type { Job } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import { JOB_NAMES } from '../queue/queue.constants';
import { WelcomeEmailProcessor } from './welcome-email.processor';

describe('WelcomeEmailProcessor', () => {
  it('sends a welcome email for a send-welcome-email job', async () => {
    const communications = {
      sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new WelcomeEmailProcessor(
      communications as unknown as CommunicationsService,
    );

    const job = {
      name: JOB_NAMES.SEND_WELCOME_EMAIL,
      data: {
        organizationId: 'org-1',
        memberId: 'member-1',
        email: 'a@example.com',
        firstName: 'Alex',
      },
    } as Job;

    await processor.process(job);

    expect(communications.sendWelcomeEmail).toHaveBeenCalledWith(
      'org-1',
      'a@example.com',
      'Alex',
      'member-1',
    );
  });

  it('ignores a job with an unrecognized name', async () => {
    const communications = { sendWelcomeEmail: jest.fn() };
    const processor = new WelcomeEmailProcessor(
      communications as unknown as CommunicationsService,
    );

    const job = { name: 'some-other-job', data: {} } as Job;
    await processor.process(job);

    expect(communications.sendWelcomeEmail).not.toHaveBeenCalled();
  });
});
