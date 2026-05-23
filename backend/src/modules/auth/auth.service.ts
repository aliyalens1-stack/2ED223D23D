import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserRole } from '../../shared/enums';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel('User') private readonly userModel: Model<any>,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.userModel.findOne({
      email: dto.email.toLowerCase().trim(),
    });

    if (existing) {
      throw new BadRequestException('Email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.userModel.create({
      email: dto.email.toLowerCase().trim(),
      passwordHash,
      role: dto.role || UserRole.CUSTOMER,
      firstName: dto.firstName || '',
      lastName: dto.lastName || '',
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const user = await this.userModel.findOne({
      email: dto.email.toLowerCase().trim(),
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await bcrypt.compare(dto.password, user.passwordHash);

    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildAuthResponse(user);
  }

  async me(userId: string) {
    const user: any = await this.userModel.findById(userId).lean();

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      id: String(user._id),
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      isActive: user.isActive,
    };
  }

  private async buildAuthResponse(user: any) {
    const payload = {
      sub: String(user._id),
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: '7d',
    });

    return {
      accessToken,
      user: {
        id: String(user._id),
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    };
  }
}
