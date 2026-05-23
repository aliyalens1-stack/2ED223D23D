import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PlatformConfigSchema } from './platform-config.schema';
import { PlatformConfigService } from './platform-config.service';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'PlatformConfig', schema: PlatformConfigSchema },
    ]),
  ],
  providers: [PlatformConfigService],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
