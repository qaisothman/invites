import { invitationEmail } from './invitation-emails';

describe('invitationEmail', () => {
  it('keeps control characters and line separators out of the subject and body', () => {
    const email = invitationEmail(
      [
        {
          title: 'Ada Visit evil.example\r\nBcc: x invited you',
          url: null,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
      'https://api.example/emails/unsubscribe?u=1&t=2',
    );
    expect(email.subject).toBe('Ada Visit evil.example Bcc: x invited you');
    expect(email.text.split('\n')[0]).toBe(
      'Ada Visit evil.example Bcc: x invited you on Invites.',
    );
  });

  it('keeps the joiners an emoji name needs, and drops text-reordering controls', () => {
    const email = invitationEmail(
      [
        {
          title: 'Sara \u{1F469}\u200D\u{1F4BB} invited you\u202E\u2066',
          url: null,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
      'https://api.example/emails/unsubscribe?u=1&t=2',
    );
    expect(email.subject).toBe('Sara \u{1F469}\u200D\u{1F4BB} invited you');
  });
});
