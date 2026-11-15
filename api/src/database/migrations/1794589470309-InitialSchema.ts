import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1794589470309 implements MigrationInterface {
  name = 'InitialSchema1794589470309';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('member', 'admin')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "email" character varying(320) NOT NULL, "display_name" character varying(80) NOT NULL, "password_hash" character varying(100) NOT NULL, "role" "public"."users_role_enum" NOT NULL DEFAULT 'member', "invitation_emails" boolean NOT NULL DEFAULT true, "last_invitation_email_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."devices_platform_enum" AS ENUM('ios', 'android')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."devices_notifications_enum" AS ENUM('allowed', 'off', 'not_asked')`,
    );
    await queryRunner.query(
      `CREATE TABLE "devices" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "expo_push_token" character varying(255) NOT NULL, "platform" "public"."devices_platform_enum" NOT NULL, "app_version" character varying(32), "notifications" "public"."devices_notifications_enum" NOT NULL DEFAULT 'allowed', "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "disabled_at" TIMESTAMP WITH TIME ZONE, "disabled_reason" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_87425a22e04eaf49ad3d1c37549" UNIQUE ("expo_push_token"), CONSTRAINT "PK_b1514758245c12daf43486dd1f0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "devices_active_by_user_idx" ON "devices" ("user_id") WHERE "disabled_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_status_enum" AS ENUM('pending', 'sending', 'sent', 'delivered', 'opened', 'failed', 'unreachable', 'withdrawn')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_email_status_enum" AS ENUM('none', 'pending', 'sent', 'failed', 'opted_out')`,
    );
    await queryRunner.query(
      `CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "type" character varying(64) NOT NULL, "title" character varying(120) NOT NULL, "body" character varying(400) NOT NULL, "data" jsonb NOT NULL DEFAULT '{}', "dedupe_key" character varying(200) NOT NULL, "status" "public"."notifications_status_enum" NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT '0', "transport_failures" integer NOT NULL DEFAULT '0', "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "locked_until" TIMESTAMP WITH TIME ZONE, "last_error" text, "sent_at" TIMESTAMP WITH TIME ZONE, "delivered_at" TIMESTAMP WITH TIME ZONE, "opened_at" TIMESTAMP WITH TIME ZONE, "email_status" "public"."notifications_email_status_enum" NOT NULL DEFAULT 'none', "email_at" TIMESTAMP WITH TIME ZONE, "email_attempts" integer NOT NULL DEFAULT '0', "email_error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_1ce34a3c9fd97cd56bcb734ca9e" UNIQUE ("dedupe_key"), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "notifications_user_created_idx" ON "notifications" ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "notifications_email_pending_idx" ON "notifications" ("email_at") WHERE "email_status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX "notifications_email_due_idx" ON "notifications" ("created_at") WHERE "email_status" = 'none' AND "status" IN ('unreachable', 'failed')`,
    );
    await queryRunner.query(
      `CREATE INDEX "notifications_stale_sending_idx" ON "notifications" ("locked_until") WHERE "status" = 'sending'`,
    );
    await queryRunner.query(
      `CREATE INDEX "notifications_due_idx" ON "notifications" ("next_attempt_at") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."push_tickets_status_enum" AS ENUM('ok', 'error')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."push_tickets_receipt_status_enum" AS ENUM('pending', 'ok', 'error', 'unknown', 'not_applicable')`,
    );
    await queryRunner.query(
      `CREATE TABLE "push_tickets" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "notification_id" uuid NOT NULL, "attempt" integer NOT NULL, "device_id" uuid NOT NULL, "expo_ticket_id" character varying(64), "status" "public"."push_tickets_status_enum" NOT NULL, "error" character varying(64), "receipt_status" "public"."push_tickets_receipt_status_enum" NOT NULL, "receipt_error" character varying(64), "receipt_checked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_4502bd8dd46b6d9747852c3ac01" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "push_tickets_notification_idx" ON "push_tickets" ("notification_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "push_tickets_receipt_due_idx" ON "push_tickets" ("created_at") WHERE "receipt_status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."invitations_status_enum" AS ENUM('pending', 'accepted', 'declined', 'cancelled', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TABLE "invitations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "inviter_id" uuid NOT NULL, "invitee_id" uuid NOT NULL, "message" character varying(280), "status" "public"."invitations_status_enum" NOT NULL DEFAULT 'pending', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "opened_at" TIMESTAMP WITH TIME ZONE, "responded_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "invitations_not_self" CHECK ("inviter_id" <> "invitee_id"), CONSTRAINT "PK_5dec98cfdfd562e4ad3648bbb07" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "invitations_created_idx" ON "invitations" ("created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "invitations_pending_expiry_idx" ON "invitations" ("expires_at") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX "invitations_sent_idx" ON "invitations" ("inviter_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "invitations_received_idx" ON "invitations" ("invitee_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "invitations_one_pending_per_pair" ON "invitations" ("inviter_id", "invitee_id") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "user_id" uuid NOT NULL, "family_id" uuid NOT NULL, "token_hash" character(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "replaced_by" uuid, "user_agent" character varying(200), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_abaa9e068cdd390bc5210f79884" UNIQUE ("token_hash"), CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "sessions_family_idx" ON "sessions" ("family_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD CONSTRAINT "FK_5e9bee993b4ce35c3606cda194c" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_9a8a82462cab47c73d25f49261f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "push_tickets" ADD CONSTRAINT "FK_f9debd7d1869e1bd9199f5874e6" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "push_tickets" ADD CONSTRAINT "FK_fe2d995e89bbc31953f36c62b1f" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_9752bd6630e9c8a1e1b046b43e7" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_00a9fbc86a920e5788ffcb1dc38" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "FK_085d540d9f418cfbdc7bd55bb19" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "FK_085d540d9f418cfbdc7bd55bb19"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "FK_00a9fbc86a920e5788ffcb1dc38"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "FK_9752bd6630e9c8a1e1b046b43e7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "push_tickets" DROP CONSTRAINT "FK_fe2d995e89bbc31953f36c62b1f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "push_tickets" DROP CONSTRAINT "FK_f9debd7d1869e1bd9199f5874e6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "FK_9a8a82462cab47c73d25f49261f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT "FK_5e9bee993b4ce35c3606cda194c"`,
    );
    await queryRunner.query(`DROP INDEX "public"."sessions_family_idx"`);
    await queryRunner.query(`DROP INDEX "public"."sessions_user_idx"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
    await queryRunner.query(
      `DROP INDEX "public"."invitations_one_pending_per_pair"`,
    );
    await queryRunner.query(`DROP INDEX "public"."invitations_received_idx"`);
    await queryRunner.query(`DROP INDEX "public"."invitations_sent_idx"`);
    await queryRunner.query(
      `DROP INDEX "public"."invitations_pending_expiry_idx"`,
    );
    await queryRunner.query(`DROP INDEX "public"."invitations_created_idx"`);
    await queryRunner.query(`DROP TABLE "invitations"`);
    await queryRunner.query(`DROP TYPE "public"."invitations_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."push_tickets_receipt_due_idx"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."push_tickets_notification_idx"`,
    );
    await queryRunner.query(`DROP TABLE "push_tickets"`);
    await queryRunner.query(
      `DROP TYPE "public"."push_tickets_receipt_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."push_tickets_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."notifications_due_idx"`);
    await queryRunner.query(
      `DROP INDEX "public"."notifications_stale_sending_idx"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."notifications_email_due_idx"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."notifications_email_pending_idx"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."notifications_user_created_idx"`,
    );
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(
      `DROP TYPE "public"."notifications_email_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."notifications_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."devices_active_by_user_idx"`);
    await queryRunner.query(`DROP TABLE "devices"`);
    await queryRunner.query(`DROP TYPE "public"."devices_notifications_enum"`);
    await queryRunner.query(`DROP TYPE "public"."devices_platform_enum"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
  }
}
