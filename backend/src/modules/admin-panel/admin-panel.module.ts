import { Module } from '@nestjs/common';
import { AdminPanelController } from './admin-panel.controller';

@Module({
  controllers: [AdminPanelController],
})
export class AdminPanelModule {}
