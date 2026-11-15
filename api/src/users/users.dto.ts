import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';
import { IsDisplayName } from './display-name';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Both fields may be left out, but not sent as null: the columns are NOT NULL.
const present = (_: object, value: unknown) => value !== undefined;

export class UpdateMeDto {
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @IsDisplayName()
  displayName?: string;

  @ValidateIf(present)
  @IsBoolean()
  invitationEmails?: boolean;
}

export class LookupUserQuery {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;
}
