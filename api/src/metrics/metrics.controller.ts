import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

// Scraped by Prometheus. In production this path is reachable only from
// inside the private network (blocked at the load balancer), not by users.
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  scrape() {
    return this.metrics.registry.metrics();
  }
}
