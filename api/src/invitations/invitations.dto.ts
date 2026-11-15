import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PageQuery } from '../common/pagination';
import { InvitationStatus } from './invitation.entity';

export class CreateInvitationDto {
  @IsUUID()
  inviteeId: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(280)
  message?: string;
}

export class ListInvitationsQuery extends PageQuery {
  @IsIn(['received', 'sent'])
  box: 'received' | 'sent' = 'received';

  @IsOptional()
  @IsEnum(InvitationStatus)
  status?: InvitationStatus;
}
