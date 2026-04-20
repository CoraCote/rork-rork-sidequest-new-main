import { Controller, Get } from '@nestjs/common';
import { IngestionService } from './ingestion.service';

@Controller('ingestion')
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Get('status')
  getStatus() {
    return this.ingestionService.getStatus();
  }

  @Get('source-health')
  getSourceHealth() {
    return this.ingestionService.getSourceHealth();
  }
}
