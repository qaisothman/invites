// When an invitation is due an email, shared by the emailer and the backlog
// gauge so the alert measures the queue the worker drains. Positional:
// $1 = EMAIL_TYPES, $2 = EMAIL_AFTER_SECONDS, $3 = INVITE_TTL_DAYS; it joins
// notifications n to invitations i. All of these hold:
// - its type is worth an email (EMAIL_TYPES: a new invitation);
// - no phone could show it: none was reachable when it was dispatched, or
//   the push failed for good;
// - it has waited EMAIL_AFTER_SECONDS, so an invitee using the app right now
//   sees the invitation there first;
// - it is younger than an invitation can live, which bounds the scan to the
//   last INVITE_TTL_DAYS of the index however long the table grows;
// - the invitation is still open: pending, not expired, not yet seen.
export const EMAIL_ELIGIBLE = `
  n.email_status = 'none'
  AND n.status IN ('unreachable', 'failed')
  AND n.type = ANY($1)
  AND n.created_at <= now() - make_interval(secs => $2)
  AND n.created_at > now() - make_interval(days => $3)
  AND i.id = (n.data->>'invitationId')::uuid
  AND i.status = 'pending' AND i.expires_at > now() AND i.opened_at IS NULL`;
