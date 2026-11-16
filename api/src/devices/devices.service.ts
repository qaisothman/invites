import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { MetricsService } from '../metrics/metrics.service';
import { Device, NotificationsState } from './device.entity';
import { RegisterDeviceDto } from './devices.dto';

// Android puts an app nobody has opened for a few months into hibernation:
// it resets the app's permissions and stops delivering its pushes, and tells
// no one. An Android phone silent for this long is treated as unable to show
// a push. iOS has no equivalent.
const ANDROID_DORMANT_DAYS = 90;

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    private readonly metrics: MetricsService,
  ) {}

  // Called on every launch and token change, and on a return to the
  // foreground when the state changed or 15 minutes have passed. An upsert on
  // the token: the same phone re-registering, or a phone that changed account,
  // both end with one active row owned by the current user, carrying its
  // latest notifications state.
  async register(userId: string, dto: RegisterDeviceDto) {
    const notifications = dto.notifications ?? NotificationsState.Allowed;
    // One atomic statement, so two app starts racing can't create two rows.
    const rows: unknown = await this.devices.query(
      `INSERT INTO devices (user_id, expo_push_token, platform, app_version, notifications)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (expo_push_token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         platform = EXCLUDED.platform,
         app_version = EXCLUDED.app_version,
         notifications = EXCLUDED.notifications,
         last_seen_at = now(),
         disabled_at = NULL,
         disabled_reason = NULL
       RETURNING id, platform, notifications`,
      [
        userId,
        dto.expoPushToken,
        dto.platform,
        dto.appVersion ?? null,
        notifications,
      ],
    );
    // By app version, so a release that breaks the permission prompt shows
    // up as a jump in "off" for that version. The version is client input,
    // so only plain x.y.z becomes a label: anything else can't mint series.
    const version = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(dto.appVersion ?? '')
      ? (dto.appVersion as string)
      : 'other';
    this.metrics.deviceReports
      .labels(dto.platform, notifications, version)
      .inc();
    return (
      rows as { id: string; platform: string; notifications: string }[]
    )[0];
  }

  // Sign-out on this phone: stop pushing to it.
  async unregister(userId: string, id: string) {
    const res = await this.devices.update(
      { id, userId, disabledAt: IsNull() },
      { disabledAt: new Date(), disabledReason: 'signed_out' },
    );
    if (!res.affected)
      throw new NotFoundException({
        code: 'device_not_found',
        message: 'Device not found',
      });
  }

  // The phones that can show a push right now: signed in, notifications
  // allowed at their last report, and not an Android phone gone quiet long
  // enough to be hibernating. A user with none of these is unreachable by
  // push, which is what makes them eligible for the invitation email.
  reachableFor(userIds: string[]): Promise<Device[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.devices
      .createQueryBuilder('d')
      .where('d.user_id IN (:...userIds)', { userIds })
      .andWhere('d.disabled_at IS NULL')
      .andWhere(`d.notifications = 'allowed'`)
      .andWhere(
        `(d.platform = 'ios' OR d.last_seen_at > now() - make_interval(days => :days))`,
        { days: ANDROID_DORMANT_DAYS },
      )
      .getMany();
  }

  async disable(ids: string[], reason: string) {
    if (ids.length === 0) return;
    await this.devices.update(
      { id: In(ids), disabledAt: IsNull() },
      { disabledAt: new Date(), disabledReason: reason },
    );
  }
}
