import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DataSource) {}

  // For load balancers and uptime checks: 200 only when the database answers.
  @Get()
  async check() {
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
