import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Quota } from '../common/quota';
import { LoginDto, RefreshDto, RegisterDto } from './auth.dto';
import { AuthService } from './auth.service';
import { Public } from './decorators';

// Public. Sign-up and sign-in are tightly rate-limited per IP (the 'auth'
// quota), which slows down password guessing and credential stuffing.
// Refresh and sign-out carry a 256-bit random token and run on every app
// start, so they fall under the default limit.
@ApiTags('auth')
@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Quota('auth')
  register(@Body() dto: RegisterDto, @Headers('user-agent') ua?: string) {
    return this.auth.register(dto, ua);
  }

  @Post('login')
  @Quota('auth')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Headers('user-agent') ua?: string) {
    return this.auth.login(dto, ua);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Headers('user-agent') ua?: string) {
    return this.auth.refresh(dto.refreshToken, ua);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }
}
