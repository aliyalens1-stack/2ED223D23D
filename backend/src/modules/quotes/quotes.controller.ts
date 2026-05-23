import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { QuotesService } from './quotes.service';
import { QuickRequestService } from './quick-request.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { RespondQuoteDto } from './dto/respond-quote.dto';
import { QuickRequestDto } from './dto/quick-request.dto';

@Controller('quotes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuotesController {
  constructor(
    private readonly quotesService: QuotesService,
    private readonly quickRequestService: QuickRequestService,
  ) {}

  @Roles(UserRole.CUSTOMER)
  @Post()
  create(@Req() req: any, @Body() dto: CreateQuoteDto) {
    return this.quotesService.create(req.user.sub, dto);
  }

  @Roles(UserRole.CUSTOMER)
  @Get('my')
  myQuotes(@Req() req: any) {
    return this.quotesService.myQuotes(req.user.sub);
  }

  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @Get('incoming')
  incomingQuotes() {
    return this.quotesService.incomingQuotes();
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.quotesService.getById(id);
  }

  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @Post(':id/respond')
  respond(
    @Param('id') id: string,
    @Req() req: any,
    @Body() dto: RespondQuoteDto,
  ) {
    return this.quotesService.respond(id, req.user.sub, req.user.role, dto);
  }

  @Roles(UserRole.CUSTOMER)
  @Post(':id/accept/:responseId')
  accept(
    @Param('id') id: string,
    @Param('responseId') responseId: string,
    @Req() req: any,
  ) {
    return this.quotesService.accept(id, responseId, req.user.sub);
  }

  @Roles(UserRole.CUSTOMER)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Req() req: any) {
    return this.quotesService.cancel(id, req.user.sub);
  }

  // ===== QUICK REQUEST V5 =====

  /**
   * POST /quotes/quick
   * 1-tap заявка: нажал → заявка создана → мастера уже найдены
   */
  @Roles(UserRole.CUSTOMER)
  @Post('quick')
  quickRequest(@Req() req: any, @Body() dto: QuickRequestDto) {
    // Sprint 14: accept both `serviceType` (canonical) and `problem` (web-app alias).
    if (!dto.serviceType && dto.problem) {
      dto.serviceType = dto.problem as any;
    }
    return this.quickRequestService.createQuickRequest(req.user.sub, dto);
  }

  /**
   * GET /quotes/quick/types
   * Получить список типов быстрых заявок
   */
  @Get('quick/types')
  getQuickTypes() {
    return this.quickRequestService.getServiceTypes();
  }
}
