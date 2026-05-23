import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto, ConfirmPaymentDto, RefundPaymentDto } from './dto/payment.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';
import { StripeService } from './stripe.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly stripeService: StripeService,
  ) {}

  @Post('create')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create payment + Stripe intent for booking' })
  create(@Req() req: any, @Body() dto: CreatePaymentDto) {
    return this.paymentsService.create(req.user.sub, dto);
  }

  @Post(':id/confirm-mock')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm payment (mock mode — dev/staging only)' })
  confirmMock(@Req() req: any, @Param('id') id: string) {
    // R3: dev-guard. Block mock-confirm in production to prevent
    // unpaid bookings from being marked "paid" without real Stripe charge.
    const env = (process.env.ENV || process.env.NODE_ENV || 'dev').toLowerCase();
    const mockAllowed = env !== 'production' || process.env.PAYMENTS_ALLOW_MOCK === '1';
    if (!mockAllowed) {
      throw new (require('@nestjs/common').ForbiddenException)(
        'mock-confirm disabled in production — use real Stripe checkout',
      );
    }
    return this.paymentsService.confirmMock(req.user.sub, id);
  }

  @Post('webhook')
  @ApiOperation({ summary: 'Stripe webhook endpoint (no auth)' })
  async webhook(
    @Req() req: RawBodyRequest<any>,
    @Headers('stripe-signature') signature: string,
  ) {
    // Try to verify signature if Stripe is configured
    const rawBody = req.rawBody || req.body;
    if (signature) {
      const event = await this.stripeService.verifyWebhookSignature(
        rawBody,
        signature,
      );
      if (event) {
        await this.paymentsService.handleWebhook(event);
        return { received: true };
      }
    }

    // Fallback: accept unverified events (for mock/test mode)
    if (req.body && req.body.type) {
      await this.paymentsService.handleWebhook(req.body);
      return { received: true };
    }

    return { received: false, reason: 'Invalid webhook payload' };
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my payments' })
  getMyPayments(@Req() req: any) {
    return this.paymentsService.getMyPayments(req.user.sub);
  }

  @Get('booking/:bookingId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment by booking ID' })
  getByBooking(@Param('bookingId') bookingId: string) {
    return this.paymentsService.getByBooking(bookingId);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment by ID' })
  getById(@Param('id') id: string) {
    return this.paymentsService.getById(id);
  }

  @Get(':id/transactions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment transaction ledger' })
  getTransactions(@Param('id') id: string) {
    return this.paymentsService.getTransactions(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post(':id/refund')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refund payment (admin)' })
  refund(@Param('id') id: string, @Body() dto: RefundPaymentDto) {
    return this.paymentsService.refund(id, dto);
  }
}
