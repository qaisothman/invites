import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

// Two probes, because they answer different questions:
//   live:  is the process healthy? If not, restart it.
//   ready: can it serve traffic right now? If not, stop sending it requests,
//          but don't restart it (a database blip would restart every pod).
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DataSource) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        code: 'db_unavailable',
        message: 'Database is not reachable',
      });
    }
    return { status: 'ok' };
  }
}
