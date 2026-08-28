import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@Controller('admin/dashboard')
@Roles(Role.admin)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  async overview(@Query() query: DashboardQueryDto) {
    return this.dashboard.overview(query.days);
  }
}
