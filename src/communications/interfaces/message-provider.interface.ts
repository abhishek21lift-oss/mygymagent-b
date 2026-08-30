import { ChannelNotConfiguredError } from './email-provider.interface';

export interface MessageProvider {
  send(message: { organizationId: string; to: string; text: string }): Promise<void>;
}

export class UnimplementedChannelProvider implements MessageProvider {
  constructor(private readonly channelName: string) {}
  send(_message: { organizationId: string; to: string; text: string }): Promise<void> {
    return Promise.reject(
      new ChannelNotConfiguredError(
        `${this.channelName} is not connected on this deployment -- no provider is implemented yet.`,
      ),
    );
  }
}
