import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, ValidateIf } from 'class-validator';
import { IsDisplayName } from './display-name';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// displayName may be left out, but not sent as null: the column is NOT NULL.
const present = (_: object, value: unknown) => value !== undefined;

export class UpdateMeDto {
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @IsDisplayName()
  displayName?: string;
}

export class LookupUserQuery {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;
}
