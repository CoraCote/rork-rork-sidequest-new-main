import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  constructor() {}
  getHealth() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
