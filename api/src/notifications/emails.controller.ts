import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators';
import { EmailLinks } from './email-links';

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<title>Invites</title><body style="font:17px/1.5 system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">${body}</body>`;

// The link in every invitation email. GET only shows a button, because mail
// scanners and link previews open GET links on their own; the POST, from
// that button or from a mail app's one-tap unsubscribe (RFC 8058), turns
// invitation emails off. No sign-in needed: the link is signed per person.
// The query is read by hand, not through a DTO, so a link cut short or with
// tracking parameters added by a mail app still gets a page, not JSON; the
// signature alone decides whether it is valid.
@ApiTags('emails')
@Controller('emails/unsubscribe')
export class EmailsController {
  constructor(
    private readonly links: EmailLinks,
    private readonly db: DataSource,
  ) {}

  @Public()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  confirm(
    @Query('u') u: unknown,
    @Query('t') t: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Opened in a browser from a mail app: a broken link gets a page too.
    if (!this.valid(u, t)) {
      res.status(400);
      return page(
        `<p>This link no longer works. You can turn invitation emails off in the app, under Profile.</p>`,
      );
    }
    return page(
      `<p>Stop emails about new invitations? You'll still see them in the app.</p>` +
        `<form method="post"><button style="font:inherit;padding:.5rem 1rem">Stop invitation emails</button></form>`,
    );
  }

  @Public()
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'text/html; charset=utf-8')
  async unsubscribe(@Query('u') u: unknown, @Query('t') t: unknown) {
    if (!this.valid(u, t))
      throw new BadRequestException({
        code: 'invalid_link',
        message: 'This link is not valid',
      });
    await this.db.query(
      `UPDATE users SET invitation_emails = false, updated_at = now() WHERE id = $1`,
      [u],
    );
    return page(
      `<p>Done: no more invitation emails. You can turn them back on in the app, under Profile.</p>`,
    );
  }

  // A passing signature proves u is a user id this server signed. A repeated
  // parameter arrives as an array, hence the type checks.
  private valid(u: unknown, t: unknown): u is string {
    return (
      typeof u === 'string' && typeof t === 'string' && this.links.verify(u, t)
    );
  }
}
