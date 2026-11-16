import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, isUUID, Max, Min } from 'class-validator';

// Keyset ("cursor") pagination on (created_at, id). Unlike OFFSET, page 500
// costs the same as page 1, and rows inserted meanwhile don't shift pages.
export class PageQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`).toString(
    'base64url',
  );
}

// Exactly what toISOString() writes, so only a cursor this API issued passes.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function decodeCursor(raw?: string): Cursor | null {
  if (!raw) return null;
  const [iso = '', id = ''] = Buffer.from(raw, 'base64url')
    .toString()
    .split('|');
  const createdAt = new Date(iso);
  if (
    !ISO_INSTANT.test(iso) ||
    Number.isNaN(createdAt.getTime()) ||
    !isUUID(id)
  ) {
    throw new BadRequestException({
      code: 'invalid_cursor',
      message: 'Cursor is invalid',
    });
  }
  return { createdAt, id };
}

// The rows after the cursor, for a query on `table` aliased `alias` and
// ordered by (created_at, id) descending. The cursor's createdAt is a JS Date,
// which keeps milliseconds while Postgres keeps microseconds, so the boundary
// is the cursor row's own created_at, read back from the table; the cursor's
// copy is only the fallback for a row deleted in the meantime.
export function afterCursor(table: string, alias: string): string {
  return `(${alias}.created_at, ${alias}.id) < (coalesce((SELECT created_at FROM ${table} WHERE id = :id), :createdAt), :id)`;
}

// Fetch limit + 1 rows; the extra one only says whether there is a next page.
export function page<T extends Cursor>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}
