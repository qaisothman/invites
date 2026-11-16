// The growth funnel for invitations created in [$1, $2). Kept free of Nest
// and TypeORM so the database benchmark times this exact query.
//
// delivered_at is written only when a phone confirms the push (an ack, or a
// tap on it), so "delivered" and the time to delivery measure push delivery;
// seeing the invitation in the app counts as opened, not delivered.
export const FUNNEL_SQL = `SELECT
  count(*)::int                                                        AS created,
  count(*) FILTER (WHERE n.sent_at IS NOT NULL)::int                    AS push_sent,
  count(*) FILTER (WHERE n.sent_at IS NOT NULL AND n.delivered_at IS NOT NULL)::int AS delivered,
  count(*) FILTER (WHERE i.opened_at IS NOT NULL)::int                  AS opened,
  count(*) FILTER (WHERE i.status = 'accepted')::int                    AS accepted,
  count(*) FILTER (WHERE i.status = 'declined')::int                    AS declined,
  count(*) FILTER (WHERE n.status = 'unreachable')::int                 AS unreachable,
  count(*) FILTER (WHERE n.status = 'failed')::int                      AS push_failed,
  count(*) FILTER (WHERE n.status = 'withdrawn')::int                   AS withdrawn,
  count(*) FILTER (WHERE n.email_status = 'sent')::int                  AS email_sent,
  count(*) FILTER (WHERE n.email_status = 'opted_out')::int             AS email_opted_out,
  count(*) FILTER (WHERE n.email_status = 'sent' AND i.opened_at > n.email_at)::int AS email_opened,
  count(*) FILTER (WHERE n.email_status = 'sent' AND i.status = 'accepted'
                         AND i.responded_at > n.email_at)::int          AS email_accepted,
  count(*) FILTER (WHERE n.status IN ('pending', 'sending'))::int       AS still_queued,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM n.delivered_at - i.created_at))
    FILTER (WHERE n.sent_at IS NOT NULL) AS p50_seconds_to_delivery,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM n.delivered_at - i.created_at))
    FILTER (WHERE n.sent_at IS NOT NULL) AS p95_seconds_to_delivery
FROM invitations i
LEFT JOIN notifications n ON n.dedupe_key = 'invitation:' || i.id || ':received'
WHERE i.created_at >= $1 AND i.created_at < $2`;
