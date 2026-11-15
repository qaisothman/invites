import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';
import { IsDisplayName } from '../users/display-name';

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @Transform(lower)
  @IsEmail()
  @MaxLength(320)
  email: string;

  // Length only: composition rules push people to predictable passwords.
  @IsString()
  @Length(10, 128)
  password: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 80)
  @IsDisplayName()
  displayName: string;
}

export class LoginDto {
  @Transform(lower)
  @IsEmail()
  email: string;

  @IsString()
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @IsString()
  @Length(20, 200)
  refreshToken: string;
}
