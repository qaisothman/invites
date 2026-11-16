import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { NotificationsState, Platform } from './device.entity';

export class RegisterDeviceDto {
  @Matches(/^Expo(nent)?PushToken\[[\w-]+\]$/, {
    message: 'expoPushToken must look like ExponentPushToken[...]',
  })
  @MaxLength(255)
  expoPushToken: string;

  @IsEnum(Platform)
  platform: Platform;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;

  @IsOptional()
  @IsEnum(NotificationsState)
  notifications?: NotificationsState;
}
