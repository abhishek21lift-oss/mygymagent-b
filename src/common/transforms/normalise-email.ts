import { Transform } from 'class-transformer';

/**
 * Login emails are matched exactly, so they are stored and looked up in
 * one form: trimmed and lower-case. Before this, "Asha@Gym.in" at sign-up
 * and "asha@gym.in" at login were two different people -- and the member
 * portal, which already lower-cased, created accounts its members could
 * not sign in to if they typed their address the way the gym saved it.
 */
export function NormaliseEmail(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}
