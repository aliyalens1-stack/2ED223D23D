import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServicesService } from './services.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get('categories')
  getCategories() {
    return this.servicesService.getCategories();
  }

  @Get('categories/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  getAllCategories() {
    return this.servicesService.getAllCategories();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('categories')
  createCategory(@Body() dto: any) {
    return this.servicesService.createCategory(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Put('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: any) {
    return this.servicesService.updateCategory(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.servicesService.deleteCategory(id);
  }

  @Get('all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  getAllServices() {
    return this.servicesService.getAllServices();
  }

  @Get()
  getServices(
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
  ) {
    return this.servicesService.getServices({ categoryId, search });
  }

  @Get(':id')
  getServiceById(@Param('id') id: string) {
    return this.servicesService.getServiceById(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post()
  createService(@Body() dto: any) {
    return this.servicesService.createService(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Put(':id')
  updateService(@Param('id') id: string, @Body() dto: any) {
    return this.servicesService.updateService(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  deleteService(@Param('id') id: string) {
    return this.servicesService.deleteService(id);
  }
}
